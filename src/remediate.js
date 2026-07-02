// ─────────────────────────────────────────────────────────────
// Remediation pass. Every FLAG in a report gets specific, VERIFIED fix
// options: what to change, by how much, and what each fix affects.
//
// Architecture — the model proposes, the engine verifies:
//   1. Claude (Fable 5, falling back to Opus 4.8) drafts up to 3 fix options
//      per flag, each carrying the engine metric it changes and a concrete
//      proposed value.
//   2. Every dimensional option is re-run through evaluateOrder() with the
//      proposed value patched in. Options are published ONLY if they provably
//      flip the flagged check to PASS without introducing a new flag — and
//      each is annotated with exactly which other checks it touched.
//   3. A deterministic baseline option (meet the cited threshold exactly) is
//      always computed and verified the same way, so every flag gets at least
//      one verified fix even with no ANTHROPIC_API_KEY (the model layer then
//      simply doesn't run — same graceful degradation as vision.js).
//
// Zero-dependency by design: raw fetch against the Anthropic Messages API,
// exactly like vision.js. Never blocks a report — run.js calls this in a
// try/catch and ships the report either way.
// ─────────────────────────────────────────────────────────────
import { config } from './config.js';
import { evaluateOrder, parseThreshold, STATUS, METRIC_LABELS } from './rules.js';

const API = 'https://api.anthropic.com/v1/messages';

// Metrics a homeowner can actually change on a plan (lotSqft is not one).
const ADJUSTABLE = ['sideSetbackFt', 'rearSetbackFt', 'distanceFt', 'heightFt', 'stories', 'aduSqft'];

export function remediationEnabled() {
  return Boolean(config.remediation.apiKey);
}

// ── Verification core ──────────────────────────────────────────
// Re-run the whole ruleset with one metric patched and diff the outcomes.
export function simulateFix(rules, order, metric, newValue) {
  const before = evaluateOrder(rules, order);
  const after = evaluateOrder(rules, { ...order, [metric]: newValue });
  const statusOf = (rows, req) => { const r = rows.find((x) => x.requirement === req); return r ? r.status : null; };
  const changes = [];
  for (const row of after.rows) {
    const b = statusOf(before.rows, row.requirement);
    if (b !== row.status) changes.push({ requirement: row.requirement, from: b, to: row.status });
  }
  const newFlags = changes.filter((c) => c.to === STATUS.FLAG).map((c) => c.requirement);
  return {
    changes,
    newFlags,
    clears: (req) => statusOf(after.rows, req) === STATUS.PASS,
  };
}

// The minimal value that satisfies a flagged row's threshold.
function deterministicTarget(row) {
  const parsed = parseThreshold(row.thresholdRaw);
  if (parsed.numeric) {
    const step = parsed.unit === 'ft' ? 0.5 : 1;
    switch (parsed.op) {
      case '>=': return parsed.value;
      case '<=': return parsed.value;
      case '>': return parsed.value + step;
      case '<': return parsed.value - step;
      default: return null;
    }
  }
  // Protected-size rows render their threshold as "≤ N sq ft guaranteed".
  const m = (row.threshold || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const fmt = (metric, v) => {
  if (v == null) return '—';
  if (metric === 'aduSqft') return `${Number(v).toLocaleString('en-US')} sq ft`;
  if (metric === 'stories') return `${v} ${v === 1 ? 'story' : 'stories'}`;
  return `${v} ft`;
};

function amountLabel(metric, from, to) {
  if (from == null) return `set to ${fmt(metric, to)}`;
  const d = Math.round((to - from) * 100) / 100;
  const sign = d > 0 ? '+' : '−';
  const mag = Math.abs(d);
  const unit = metric === 'aduSqft' ? ' sq ft' : metric === 'stories' ? '' : ' ft';
  return `${fmt(metric, from)} → ${fmt(metric, to)} (${sign}${metric === 'aduSqft' ? mag.toLocaleString('en-US') : mag}${unit})`;
}

// Verified rule-level effects, in plain English.
function effectsLabel(row, sim) {
  const others = sim.changes.filter((c) => c.requirement !== row.requirement);
  if (!others.length) return 'verified: clears this flag · no other checks affected';
  const bits = others.map((c) => `${c.requirement} ${c.from || '—'}→${c.to}`);
  return `verified: clears this flag · also changes: ${bits.join('; ')}`;
}

// Plain-language build impact for the baseline (model options carry their own).
const BASE_IMPACT = {
  sideSetbackFt: (d) => `Shift the unit (or pull that wall in) ${d} from the side property line. Reduces buildable width on that side — recheck floor area, and remember eaves/gutters often count toward the setback.`,
  rearSetbackFt: (d) => `Shift the unit (or pull that wall in) ${d} from the rear property line. Reduces buildable depth — recheck floor area and the distance to the main house.`,
  distanceFt: (d) => `Move the unit ${d} further from the main dwelling. Recheck the rear/side setbacks on the side you move toward.`,
  heightFt: () => 'Lower the plate height or flatten the roof pitch to the limit. Affects interior ceiling height and any loft space.',
  stories: () => 'Redesign to a single story within the same footprint rules. Major layout change — floor area moves to one level.',
  aduSqft: () => 'Reduce the conditioned floor area to the limit. Affects room count/layout; often the smallest room or a closet absorbs the cut.',
};

function baselineOption(rules, order, row) {
  if (!row.metric || !ADJUSTABLE.includes(row.metric)) return null;
  const target = deterministicTarget(row);
  const current = order[row.metric];
  if (target == null || !Number.isFinite(target) || target === current) return null;
  const sim = simulateFix(rules, order, row.metric, target);
  if (!sim.clears(row.requirement) || sim.newFlags.length) return null;
  const label = METRIC_LABELS[row.metric] || row.metric;
  return {
    title: `Meet the ${label} requirement exactly`,
    change: `Change the ${label} to ${fmt(row.metric, target)} — the minimum that satisfies the cited standard.`,
    metric: row.metric,
    proposedValue: target,
    amount: amountLabel(row.metric, current, target),
    buildImpact: (BASE_IMPACT[row.metric] || (() => ''))(amountLabel(row.metric, current, target)),
    effects: effectsLabel(row, sim),
    verified: true,
    effort: 'minor',
  };
}

// ── Model layer (Fable 5 → Opus 4.8) ──────────────────────────
const FIX_TOOL = {
  name: 'propose_fixes',
  description: 'Record remediation options for each flagged requirement. Call exactly once, covering every flag.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fixes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            requirement: { type: 'string', description: 'EXACT requirement text of the flagged row this addresses (copy it verbatim).' },
            options: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string', description: 'Short option name a homeowner understands, e.g. "Shift the unit 1 ft off the side line".' },
                  change: { type: 'string', description: 'Specifically what to change on the plans, in plain English. One or two sentences.' },
                  metric: { type: 'string', enum: [...ADJUSTABLE, ''], description: 'The engine metric this option changes. Empty string ONLY for a procedural option (e.g. documenting a transit exemption).' },
                  proposedValue: { type: ['number', 'null'], description: 'The new numeric value for that metric (decimal feet / sq ft / stories). Required when metric is set; null for procedural options.' },
                  buildImpact: { type: 'string', description: 'What this change affects on the actual build: space, layout, cost direction, other dimensions to recheck.' },
                  effort: { type: 'string', enum: ['minor', 'moderate', 'major'] },
                },
                required: ['title', 'change', 'metric', 'proposedValue', 'buildImpact', 'effort'],
              },
            },
          },
          required: ['requirement', 'options'],
        },
      },
    },
    required: ['fixes'],
  },
};

const SYSTEM =
  'You are the remediation engine for Annex, an ADU plan pre-check service. For each FLAGGED requirement ' +
  'you propose up to 3 concrete fix options a homeowner could take to their designer. Ground rules: ' +
  '(1) Every dimensional option MUST set `metric` and a concrete `proposedValue` that satisfies the cited ' +
  'threshold — your numbers are machine-verified against the full ruleset and unverifiable options are ' +
  'discarded, so be exact. (2) The FIRST option per flag must be the minimal change. (3) Use the order\'s ' +
  'other dimensions to make options specific (e.g., if the rear setback has slack, moving the unit is viable). ' +
  '(4) Procedural options (metric="") are allowed only when a real alternative compliance path exists, e.g. ' +
  'a transit-distance height/parking allowance — phrase them as "confirm X with your jurisdiction". ' +
  '(5) Plain English, no jargon, never promise approval, never call this legal or architectural advice.';

async function callModel(model, body, { forceTool, withFallbacks }) {
  const headers = {
    'x-api-key': config.remediation.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const payload = { ...body, model };
  if (forceTool) payload.tool_choice = { type: 'tool', name: FIX_TOOL.name };
  if (withFallbacks) {
    // Server-side refusal fallback (Fable 5): a declined request is transparently
    // re-served by Opus 4.8 inside the same call.
    headers['anthropic-beta'] = 'server-side-fallback-2026-06-01';
    payload.fallbacks = [{ model: config.remediation.fallbackModel }];
  }
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`remediation call failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function llmProposals(order, flagRows, allRows) {
  const jLabel = order.city && order.county ? `${order.city}, ${order.county} County` : order.county ? `${order.county} County` : order.city || 'California';
  const orderDims = Object.fromEntries(ADJUSTABLE.concat('lotSqft', 'bedrooms').map((k) => [k, order[k] ?? null]));
  const user = [
    `Jurisdiction: ${jLabel}. ADU type: ${order.aduType}. Near transit: ${order.nearTransit == null ? 'unknown' : order.nearTransit}.`,
    `Order dimensions (decimal ft / sq ft): ${JSON.stringify(orderDims)}`,
    '',
    'FLAGGED requirements (propose fixes for each):',
    ...flagRows.map((r) => `- requirement: ${JSON.stringify(r.requirement)} · your value: ${r.yourValue} · required: ${r.threshold} · rule: ${r.ruleText} · cited: ${r.citation}`),
    '',
    'Other checked requirements on this order (context for side-effects — do not propose fixes for these):',
    ...allRows.filter((r) => r.status !== STATUS.FLAG).map((r) => `- ${r.requirement}: ${r.status}${r.yourValue !== '—' ? ` (${r.yourValue} vs ${r.threshold})` : ''}`),
    '',
    'Call propose_fixes exactly once with options for every flagged requirement.',
  ].join('\n');

  const body = {
    max_tokens: 3000,
    system: SYSTEM,
    tools: [FIX_TOOL],
    messages: [{ role: 'user', content: user }],
  };
  // Note: no `thinking` param — Fable 5 is adaptive-thinking-only and rejects
  // explicit thinking config; Opus 4.8 defaults are fine too.

  let data, modelUsed;
  try {
    // Fable 5 first: tool_choice auto (thinking is always on), refusal fallback enabled.
    modelUsed = config.remediation.model;
    data = await callModel(modelUsed, body, { forceTool: false, withFallbacks: true });
    if (data.stop_reason === 'refusal') throw new Error('model declined');
    if (!(data.content || []).some((b) => b.type === 'tool_use')) throw new Error('no tool call');
  } catch (e) {
    // Any failure (model unavailable on this account, refusal, no tool call)
    // → one retry on the fallback model with the proven forced-tool shape.
    modelUsed = config.remediation.fallbackModel;
    data = await callModel(modelUsed, body, { forceTool: true, withFallbacks: false });
  }
  if (data.stop_reason === 'refusal') return { fixes: [], modelUsed };
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.fixes)) return { fixes: [], modelUsed };
  return { fixes: toolUse.input.fixes, modelUsed };
}

// ── Assembly: verify every proposal, attach `fixes` to each FLAG row ──
export async function remediateOrder(rules, order, result) {
  const flagRows = result.rows.filter((r) => r.status === STATUS.FLAG);
  if (!flagRows.length) return { flags: 0, options: 0, model: null };

  let proposals = [], modelUsed = null;
  if (remediationEnabled()) {
    try {
      const out = await llmProposals(order, flagRows, result.rows);
      proposals = out.fixes;
      modelUsed = out.modelUsed;
    } catch (e) {
      // Model layer is best-effort; the deterministic baseline below still ships.
      proposals = [];
    }
  }

  let total = 0;
  for (const row of flagRows) {
    const options = [];
    const seen = new Set();

    // Model options for this flag, machine-verified before publication.
    const match = proposals.find((f) => f.requirement === row.requirement)
      || proposals.find((f) => (f.requirement || '').toLowerCase().includes(row.requirement.toLowerCase().slice(0, 20)));
    for (const o of (match && Array.isArray(match.options) ? match.options : [])) {
      if (options.length >= 3) break;
      if (o.metric && ADJUSTABLE.includes(o.metric) && Number.isFinite(o.proposedValue)) {
        const key = `${o.metric}:${o.proposedValue}`;
        if (seen.has(key) || o.proposedValue === order[o.metric]) continue;
        const sim = simulateFix(rules, order, o.metric, o.proposedValue);
        if (!sim.clears(row.requirement) || sim.newFlags.length) continue; // failed verification → discard
        seen.add(key);
        options.push({
          title: o.title, change: o.change, metric: o.metric, proposedValue: o.proposedValue,
          amount: amountLabel(o.metric, order[o.metric], o.proposedValue),
          buildImpact: o.buildImpact, effects: effectsLabel(row, sim), verified: true,
          effort: o.effort || 'moderate',
        });
      } else if (!o.metric && !options.some((x) => !x.verified)) {
        // One procedural alternative max, clearly labeled unverified.
        options.push({
          title: o.title, change: o.change, metric: null, proposedValue: null, amount: '',
          buildImpact: o.buildImpact, effects: 'alternative path — confirm with your jurisdiction', verified: false,
          effort: o.effort || 'minor',
        });
      }
    }

    // Deterministic baseline (always verified) — added unless the model already proposed it.
    const base = baselineOption(rules, order, row);
    if (base && !seen.has(`${base.metric}:${base.proposedValue}`)) {
      options.unshift(base);
    }

    // Verified options first, minimal change first.
    options.sort((a, b) => (b.verified - a.verified) || (Math.abs((a.proposedValue ?? 0) - (order[a.metric] ?? 0)) - Math.abs((b.proposedValue ?? 0) - (order[b.metric] ?? 0))));
    row.fixes = options.slice(0, 3);
    total += row.fixes.length;
  }
  return { flags: flagRows.length, options: total, model: modelUsed };
}
