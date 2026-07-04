// ─────────────────────────────────────────────────────────────
// City-rules research pipeline ("Claude researches, the engine
// trusts only what's verified").
//
// City ordinances are what actually bind inside city limits (county ADU
// rules govern only unincorporated land) — but live-fetching regs per
// order would gamble the product's core promise on retrieval quality.
// So instead: the FIRST time an order arrives for a city we've never
// researched, one web-search-enabled model call reads that city's
// CURRENT municipal ADU ordinance and DRAFTS rule rows into the Airtable
// Rules table marked Verification="Pending". Pending rows can only ever
// surface as REVIEW (see rules.js) — they never PASS/FLAG until a human
// flips them to "Verified". A "Marker" row records that the city was
// researched (+ when + sources), so research runs once per city, ever;
// a ~90-day refresh re-checks the source and ALERTS on drift (it never
// silently rewrites verified rules).
// ─────────────────────────────────────────────────────────────
import { config } from './config.js';
import { createRules, updateRuleFields } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { sendOwnerAlert } from './notify.js';

const API = 'https://api.anthropic.com/v1/messages';

export function cityResearchEnabled() {
  return Boolean(config.vision.apiKey);
}

const RULES_TOOL = {
  name: 'record_city_rules',
  description: 'Record the objective, checkable ADU standards found in this city\'s CURRENT municipal code. Call exactly once, after your research is complete.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'true if a current, city-specific ADU ordinance (or ADU standards) was located' },
      summary: { type: 'string', description: '1-3 sentences: what was found, where, and how current it appears to be' },
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs actually consulted (municipal code sections, city ADU pages, HCD letters)' },
      rules: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            requirement: { type: 'string', description: 'Short name, e.g. "Unit size - local maximum" or "Height - detached (local)"' },
            rule: { type: 'string', description: 'One-sentence plain-language statement of the standard' },
            threshold: { type: 'string', description: 'Machine-checkable form where possible, e.g. "<= 1,000 sq ft", ">= 4 ft". Free text if inherently contextual.' },
            citation: { type: 'string', description: 'Exact municipal code section, e.g. "Berkeley Mun. Code §23.306.040(C)"' },
            sourceUrl: { type: 'string', description: 'URL of the code section this came from' },
            appliesTo: { type: 'array', items: { type: 'string', enum: ['Detached', 'Attached', 'Conversion', 'JADU', 'All'] } },
            fix: { type: 'string', description: 'Common fix if the standard is missed (short)' },
            possiblyPreempted: { type: 'boolean', description: 'true if this local standard appears stricter than what current CA state ADU law (Gov. Code §66310-66342) allows cities to enforce' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['requirement', 'rule', 'threshold', 'citation', 'appliesTo', 'possiblyPreempted', 'confidence'],
        },
      },
    },
    required: ['found', 'summary', 'sources', 'rules'],
  },
};

const SYSTEM = [
  'You are a California ADU code researcher for Annex, an ADU plan pre-check service.',
  'Research ONE city\'s CURRENT municipal ADU standards using web search. Priorities:',
  '1. The city\'s own municipal code (codelibrary/municode/qcode or the city site) — confirm you are reading the CURRENT version, not a superseded PDF.',
  '2. The city\'s official ADU page (often summarizes current objective standards).',
  '3. HCD findings/letters about this city, if any (they signal which local standards are unenforceable).',
  'Record ONLY city-specific, objective standards that a homeowner\'s plan can be checked against (local size caps, lot-coverage numbers, height allowances beyond state minimums, separation distances, parking specifics, owner-occupancy, short-term-rental limits).',
  'Do NOT record standards that merely restate uniform California state law (4 ft side/rear setbacks, 850/1000 sq ft protections, 16 ft base height, ministerial 60-day review) — the engine already checks state law everywhere.',
  'CA state law preempts stricter local rules: if a local standard demands more than state law lets cities require (e.g. side setback > 4 ft, height allowance < 16 ft), still record it but set possiblyPreempted=true.',
  'Be conservative: if you cannot find a citable current source for a number, leave it out. Wrong numbers are far worse than missing ones — every row you record will be re-verified by a human before it can affect a customer verdict.',
  'Finish by calling record_city_rules exactly once.',
].join('\n');

async function callModel(model, body, { forceTool, withFallbacks }) {
  const headers = {
    'x-api-key': config.vision.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const payload = { ...body, model };
  if (forceTool) payload.tool_choice = { type: 'tool', name: RULES_TOOL.name };
  if (withFallbacks) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-06-01';
    payload.fallbacks = [{ model: config.remediation.fallbackModel }];
  }
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`city research call failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Research one city. Returns the validated record_city_rules payload.
export async function researchCity(city, county) {
  if (!cityResearchEnabled()) throw new Error('ANTHROPIC_API_KEY is not set');
  const user = [
    `City: ${city}${county ? `, ${county} County` : ''}, California (San Francisco Bay Area).`,
    'Find this city\'s current, city-specific objective ADU standards and record them.',
  ].join('\n');
  const body = {
    max_tokens: 16000,
    system: SYSTEM,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
      RULES_TOOL,
    ],
    messages: [{ role: 'user', content: user }],
  };
  // Fable 5 first (web search + adaptive thinking); tool_choice must stay auto
  // so the model can actually search before recording. Fallback: Opus 4.8.
  let data;
  try {
    data = await callModel(config.remediation.model, body, { forceTool: false, withFallbacks: true });
    if (data.stop_reason === 'refusal') throw new Error('model declined');
    if (!(data.content || []).some((b) => b.type === 'tool_use' && b.name === RULES_TOOL.name)) throw new Error('no tool call');
  } catch (e) {
    data = await callModel(config.remediation.fallbackModel, body, { forceTool: false, withFallbacks: false });
  }
  const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === RULES_TOOL.name);
  if (!call) throw new Error('research produced no record_city_rules call');
  const out = call.input || {};
  out.rules = Array.isArray(out.rules) ? out.rules : [];
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const titleCase = (s) => (s || '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Persist drafted rules + the coverage marker. Every drafted row is
// Verification="Pending" — the engine will only ever REVIEW it.
export async function writeCityRules(city, county, research) {
  const jur = `City of ${titleCase(city)}`;
  const rows = (research.rules || []).map((r) => ({
    Requirement: r.requirement,
    'Applies to': (r.appliesTo && r.appliesTo.length ? r.appliesTo : ['All']).join(', '),
    Rule: r.rule + (r.possiblyPreempted ? ' [drafter note: appears stricter than current CA state law allows — likely preempted]' : ''),
    Threshold: r.threshold,
    'Code citation': r.citation,
    'Common fix': r.fix || '',
    Jurisdiction: jur,
    Verification: 'Pending',
    'Last checked': today(),
  }));
  rows.push({
    Requirement: `City research: ${titleCase(city)}`,
    Rule: `${research.summary || ''} Sources: ${(research.sources || []).join(' · ')}`.trim(),
    Jurisdiction: jur,
    Verification: 'Marker',
    'Last checked': today(),
  });
  await createRules(rows);
  return rows.length - 1; // drafted rule count (marker excluded)
}

// ── Coverage sweep (called by the worker after each poll) ──────
// One research per new city; capped per poll; never blocks order flow.
const attempted = new Set(); // process-lifetime guard against retry storms

export function coveredCities(rules) {
  const map = new Map(); // lowercased city -> marker rule
  for (const r of rules) {
    if ((r.verification || '').toLowerCase() !== 'marker') continue;
    const m = (r.jurisdiction || '').match(/^city of (.+)$/i);
    if (m) map.set(m[1].trim().toLowerCase(), r);
  }
  return map;
}

export async function ensureCityCoverage(allOrders, rules, log = () => {}, maxPerPoll = 2) {
  if (!cityResearchEnabled()) return 0;
  const covered = coveredCities(rules);
  // Candidate cities from current orders (need a recognized county so the
  // researcher has real context; skips gibberish city strings).
  const wanted = new Map();
  for (const rec of allOrders) {
    const o = normalizeOrder(rec);
    const c = (o.city || '').trim().toLowerCase();
    if (!c || c.length < 3 || !o.county) continue;
    if (covered.has(c) || attempted.has(c)) continue;
    wanted.set(c, { city: titleCase(c), county: o.county });
  }
  let done = 0;
  for (const [key, { city, county }] of wanted) {
    if (done >= maxPerPoll) break;
    attempted.add(key);
    try {
      log(`⌕ researching city ADU standards: ${city} (${county} County)…`);
      const research = await researchCity(city, county);
      const n = await writeCityRules(city, county, research);
      log(`⌕ ${city}: ${n} draft rule(s) written (Pending verification)`);
      try {
        await sendOwnerAlert(`New city researched: ${city} — ${n} draft rule(s) to verify`, [
          `A customer order arrived for ${city} (${county} County), which had no city-level rules yet.`,
          research.found === false ? 'NOTE: no city-specific ADU ordinance was confidently located — review the marker row.' : `${n} draft rule(s) were written to the Rules table with Verification = "Pending".`,
          'Until you verify them, they appear in reports as cited REVIEW items only — never PASS/FLAG.',
          'To activate: open the Rules table, eyeball each citation against its source, and set Verification to "Verified" (or "Superseded" for anything state law overrides).',
          `Sources: ${(research.sources || []).slice(0, 4).join(' · ')}`,
        ]);
      } catch (e) { log(`  (alert failed: ${e.message})`); }
      done++;
    } catch (e) {
      log(`⌕ ${city}: research failed (${e.message}) — will not retry this process`);
    }
  }
  return done;
}

// ── ~90-day refresh: re-research covered cities, alert on drift ──
const REFRESH_DAYS = 90;
let lastRefreshCheck = 0;

export async function refreshStaleCities(rules, log = () => {}) {
  if (!cityResearchEnabled()) return 0;
  // Check at most once per day per process.
  if (Date.now() - lastRefreshCheck < 24 * 3600 * 1000) return 0;
  lastRefreshCheck = Date.now();
  const covered = coveredCities(rules);
  const cutoff = Date.now() - REFRESH_DAYS * 24 * 3600 * 1000;
  for (const [key, marker] of covered) {
    const checked = Date.parse(marker.lastChecked || '') || 0;
    if (checked > cutoff) continue;
    const city = titleCase(key);
    try {
      log(`⌕ refresh: re-checking ${city} (last checked ${marker.lastChecked || 'unknown'})`);
      const research = await researchCity(city, '');
      // Diff drafted thresholds against ALL existing rows for this city.
      const existing = rules.filter((r) => (r.jurisdiction || '').toLowerCase() === `city of ${key}` && (r.verification || '').toLowerCase() !== 'marker');
      const oldByReq = new Map(existing.map((r) => [(r.requirement || '').toLowerCase(), r.threshold || '']));
      const diffs = [];
      for (const nr of research.rules || []) {
        const old = oldByReq.get((nr.requirement || '').toLowerCase());
        if (old === undefined) diffs.push(`NEW: ${nr.requirement} — ${nr.threshold} (${nr.citation})`);
        else if ((old || '').trim() !== (nr.threshold || '').trim()) diffs.push(`CHANGED: ${nr.requirement} — was "${old}", source now says "${nr.threshold}" (${nr.citation})`);
      }
      if (diffs.length) {
        await sendOwnerAlert(`City rules drift: ${city} — ${diffs.length} difference(s) found`, [
          `The ${REFRESH_DAYS}-day re-check of ${city} found differences vs. the stored rules. NOTHING was changed automatically.`,
          ...diffs.slice(0, 8),
          'Review the sources and update the Rules table if the change is real.',
        ]);
        log(`⌕ refresh: ${city} — ${diffs.length} drift(s), owner alerted`);
      } else {
        log(`⌕ refresh: ${city} — no drift`);
      }
      await updateRuleFields(marker.id, { 'Last checked': today() });
      return 1; // one city per day is plenty
    } catch (e) {
      log(`⌕ refresh: ${city} failed (${e.message})`);
    }
  }
  return 0;
}
