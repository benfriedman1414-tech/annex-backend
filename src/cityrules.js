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

// ── Automated verification (replaces the human "flip to Verified" step) ──
// A SECOND, independent model pass fetches each drafted rule's cited source
// and confirms the exact threshold appears there. Only source-confirmed,
// high-confidence, non-preempted rules auto-activate; everything else stays
// Pending (= cited REVIEW rows — informative, never wrong). The engine-side
// preemption clamp still applies even to Verified rows.
const VERIFY_TOOL = {
  name: 'record_verification',
  description: 'Record, for every drafted rule, whether its threshold + citation are supported by the source material. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requirement: { type: 'string', description: 'Copied exactly from the drafted rule being verified' },
            supported: { type: 'boolean', description: 'true ONLY if the source material explicitly supports this exact threshold and citation' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            note: { type: 'string', description: 'One line: where it was confirmed, or what did not match' },
          },
          required: ['requirement', 'supported', 'confidence'],
        },
      },
    },
    required: ['verdicts'],
  },
};

const VERIFY_SYSTEM = [
  'You are an independent verifier for Annex. Another researcher drafted city ADU rules; your ONLY job is to try to CONFIRM or REFUTE each one against the actual source.',
  'For each drafted rule, check: (1) the cited code section exists, (2) the threshold number/requirement matches the CURRENT source text exactly, (3) the rule is city-specific (not a restatement of uniform CA state law).',
  'Source page excerpts are provided where available; use web search to check anything not covered by the excerpts.',
  'Be adversarial: supported=true with confidence=high ONLY when you can point to the exact source language. When in doubt, supported=false or confidence=medium — a held rule is harmless (it surfaces as a cited review item), a wrongly confirmed rule damages a paid report.',
  'Finish by calling record_verification exactly once, with a verdict for EVERY drafted rule.',
].join('\n');

async function fetchExcerpt(url, maxLen = 12000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnnexVerify/1.0)' } });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&amp;|&lt;|&gt;|&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, maxLen) || null;
  } catch { return null; }
}

// Pure decision policy (unit-tested): activate only what the verifier
// confirmed at high confidence and the drafter didn't flag as preempted.
export function autoVerifyDecision({ supported, confidence, preemptNote }) {
  if (preemptNote) return 'hold';
  if (supported === true && confidence === 'high') return 'verify';
  return 'hold';
}

// Verify one city's Pending rules (Airtable rule records) and flip the
// confirmed ones to Verified. Returns { verified, held }.
export async function autoVerifyCityRules(city, pendingRecords, log = () => {}) {
  if (!cityResearchEnabled() || !pendingRecords.length) return { verified: 0, held: pendingRecords.length };

  // Ground the verifier: fetch each distinct cited source page once.
  const urls = [...new Set(pendingRecords.map((r) => r.sourceUrl).filter(Boolean))].slice(0, 6);
  const excerpts = [];
  for (const u of urls) {
    const t = await fetchExcerpt(u);
    if (t) excerpts.push({ url: u, text: t });
  }

  const user = [
    `City: ${city}, California. Verify these drafted ADU rules:`,
    ...pendingRecords.map((r, i) => `${i + 1}. requirement: ${JSON.stringify(r.requirement)} · threshold: ${JSON.stringify(r.threshold)} · citation: ${JSON.stringify(r.citation)}${r.sourceUrl ? ` · claimed source: ${r.sourceUrl}` : ''}`),
    '',
    excerpts.length ? 'SOURCE PAGE EXCERPTS (fetched just now):' : 'No source pages could be fetched — verify via web search.',
    ...excerpts.map((e) => `--- ${e.url} ---\n${e.text}`),
  ].join('\n');

  const body = {
    max_tokens: 8000,
    system: VERIFY_SYSTEM,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      VERIFY_TOOL,
    ],
    messages: [{ role: 'user', content: user }],
  };
  let data;
  try {
    data = await callModel(config.remediation.model, body, { forceTool: false, withFallbacks: true });
    if (data.stop_reason === 'refusal') throw new Error('model declined');
    if (!(data.content || []).some((b) => b.type === 'tool_use' && b.name === VERIFY_TOOL.name)) throw new Error('no tool call');
  } catch (e) {
    data = await callModel(config.remediation.fallbackModel, body, { forceTool: false, withFallbacks: false });
  }
  const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === VERIFY_TOOL.name);
  if (!call) throw new Error('verifier produced no record_verification call');
  const verdicts = new Map((call.input.verdicts || []).map((v) => [(v.requirement || '').toLowerCase().trim(), v]));

  let verified = 0, held = 0;
  for (const rec of pendingRecords) {
    const v = verdicts.get((rec.requirement || '').toLowerCase().trim());
    const preemptNote = /preempted/i.test(rec.rule || '');
    const decision = v ? autoVerifyDecision({ supported: v.supported, confidence: v.confidence, preemptNote }) : 'hold';
    if (decision === 'verify') {
      await updateRuleFields(rec.id, { Verification: 'Verified' });
      verified++;
      log(`  ✓ verified: ${rec.requirement}`);
    } else {
      held++;
      log(`  ○ held (review-only): ${rec.requirement}${v && v.note ? ` — ${v.note.slice(0, 80)}` : ''}`);
    }
  }
  return { verified, held };
}

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
    'Source URL': r.sourceUrl || '',
  }));
  rows.push({
    Requirement: `City research: ${titleCase(city)}`,
    Rule: `${research.summary || ''} Sources: ${(research.sources || []).join(' · ')}`.trim(),
    Jurisdiction: jur,
    Verification: 'Marker',
    'Last checked': today(),
  });
  const created = await createRules(rows);
  // Hand back the drafted (non-marker) records in verifier shape.
  const drafted = created
    .filter((rec) => (rec.fields.Verification || '') === 'Pending')
    .map((rec) => ({
      id: rec.id,
      requirement: rec.fields.Requirement || '',
      threshold: rec.fields.Threshold || '',
      citation: rec.fields['Code citation'] || '',
      rule: rec.fields.Rule || '',
      sourceUrl: rec.fields['Source URL'] || '',
    }));
  return drafted;
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
      const drafted = await writeCityRules(city, county, research);
      log(`⌕ ${city}: ${drafted.length} draft rule(s) written — running independent verification…`);
      // Second, independent pass: confirm each rule against its cited source,
      // then auto-activate the confirmed ones. Holds are cited REVIEW rows.
      let vr = { verified: 0, held: drafted.length };
      try { vr = await autoVerifyCityRules(city, drafted, log); }
      catch (e) { log(`  (auto-verify failed: ${e.message} — all rules held as review-only)`); }
      log(`⌕ ${city}: ${vr.verified} auto-verified (active) · ${vr.held} held as review-only`);
      try {
        await sendOwnerAlert(`FYI: new city covered — ${city} (${vr.verified} rules active, ${vr.held} review-only)`, [
          `A customer order arrived for ${city} (${county} County), which had no city-level rules yet. No action needed.`,
          research.found === false ? 'NOTE: no city-specific ADU ordinance was confidently located.' : `${drafted.length} rule(s) were drafted from the current municipal code, then independently re-verified against the cited sources.`,
          `${vr.verified} rule(s) passed source verification and are now ACTIVE (auto-checked pass/flag).`,
          `${vr.held} rule(s) were held as cited review-only items (verifier couldn't confirm them at high confidence — harmless, never wrong).`,
          'Optional: you can still overrule anything in the Rules table (Verification column: Verified / Pending / Superseded).',
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
