// ─────────────────────────────────────────────────────────────
// Annex rules engine.
// Evaluates a normalized order against the cited rules pulled from
// the Airtable "Rules" table. Numeric rules get a real PASS/FLAG;
// conditional/contextual rules are surfaced as REVIEW so a human
// (you) can apply judgment. Nothing is silently dropped.
// ─────────────────────────────────────────────────────────────

export const STATUS = {
  PASS: 'PASS',
  FLAG: 'FLAG',
  REVIEW: 'REVIEW',
  NEEDS_INPUT: 'NEEDS INPUT',
};

const lc = (s) => (s || '').toString().toLowerCase();

// Which order metric a requirement maps to (keyword based, order matters).
const METRIC_MATCHERS = [
  { metric: 'sideSetbackFt', test: (r) => lc(r).includes('side setback') },
  { metric: 'rearSetbackFt', test: (r) => lc(r).includes('rear setback') },
  { metric: 'distanceFt', test: (r) => /distance|separation|from (the )?main|from (the )?primary/.test(lc(r)) },
  { metric: 'heightFt', test: (r) => lc(r).includes('height') },
  { metric: 'stories', test: (r) => lc(r).includes('stor') && !lc(r).includes('height') },
  { metric: 'aduSqft', test: (r) => /unit size|floor area|square footage|sq ?ft|size (limit|maximum|minimum)/.test(lc(r)) },
];

// Requirements that are inherently contextual — always REVIEW (no clean numeric self-check).
const ALWAYS_REVIEW = [
  'front setback', 'lot coverage', 'coverage', 'measurement basis', 'number of adu',
  'how many', 'owner occup', 'short-term rental', 'short term rental', 'fire', 'sprinkler',
  'utility', 'utilities', 'impact fee', 'fees', 'parking replacement', 'ministerial',
  'design', 'review timeline', 'application', 'permit', 'conversion', 'jadu', 'in-f',
];

function mapMetric(requirement) {
  const r = lc(requirement);
  for (const kw of ALWAYS_REVIEW) if (r.includes(kw)) return null;
  for (const m of METRIC_MATCHERS) if (m.test(requirement)) return m.metric;
  return null;
}

// ── Jurisdiction routing ───────────────────────────────────────
// California state ADU law (Cal. Gov. Code §663xx) applies in EVERY county.
// A rule whose citation names only a county applies just to that county.
// We infer this from the citation/requirement text — no extra data field needed.
const COUNTY_NAMES = ['Contra Costa', 'San Mateo', 'Alameda', 'Santa Clara'];
function ruleCounty(rule) {
  const cite = `${rule.citation || ''} ${rule.requirement || ''}`;
  // Anything citing state law (or a generic "[City]"/"Jurisdiction" checklist) applies everywhere.
  // Match real state markers only — "Gov. Code", a §66xxx section, or "state ADU".
  // (Avoid bare "cal" — it appears inside "loCAL".)
  if (/gov(ernment)?\.?\s*code|§\s*66\d{3}|state adu/i.test(cite)) return null;
  for (const c of COUNTY_NAMES) if (cite.toLowerCase().includes(c.toLowerCase())) return c;
  return null; // default: applies everywhere
}

// Does this rule apply to this order (by jurisdiction, ADU type + bedroom context)?
function ruleApplies(rule, order) {
  // Bookkeeping rows from the city-research pipeline never evaluate:
  // "Marker" records coverage; "Superseded" = state law overrides it.
  const ver = lc(rule.verification);
  if (ver === 'marker' || ver === 'superseded') return false;

  // Jurisdiction: the explicit column wins ("State" / "X County" / "City of Y");
  // blank rows keep the legacy citation-based county inference below.
  const j = (rule.jurisdiction || '').trim();
  if (j) {
    const jl = lc(j);
    if (jl !== 'state' && jl !== 'california') {
      const cityM = jl.match(/^city of (.+)$/);
      if (cityM) {
        if (lc(order.city).trim() !== cityM[1].trim()) return false;
      } else if (/county$/.test(jl)) {
        if (lc(order.county).trim() !== jl.replace(/\s*county$/, '').trim()) return false;
      } else if (jl !== lc(order.city).trim()) {
        // Unrecognized jurisdiction string: apply only on an exact city match.
        return false;
      }
    }
  } else {
    // Legacy: skip a county-specific rule when the order is in a different county.
    const rc = ruleCounty(rule);
    if (rc && lc(order.county) !== lc(rc)) return false;
  }

  const applies = (rule.appliesTo || []).map(lc);
  const type = lc(order.aduType);
  if (applies.length && !applies.includes('all')) {
    // If the order type is known, require a match. JADU/Conversion-only rules are skipped for standard new ADUs.
    const typeMatch = applies.some((a) => type && (a.includes(type) || type.includes(a)));
    if (type && !typeMatch) return false;
  }
  // Bedroom-scoped unit-size rules
  const req = lc(rule.requirement);
  if (/studio|1-?bed|one bed|1 bed/.test(req) && order.bedrooms != null && order.bedrooms > 1) return false;
  if (/2\+|2-?bed|two bed|multi-?bed|two or more/.test(req) && order.bedrooms != null && order.bedrooms < 2) return false;
  return true;
}

// Parse a threshold string like ">= 4 ft", "<= 16 ft (base)", "<= 1,200 sq ft".
export function parseThreshold(raw) {
  const s = lc(raw);
  if (!s) return { numeric: false, raw };
  // Multi-part thresholds ("800 sq ft / 16 ft / 4 ft") are too compound to auto-check.
  if ((s.match(/\d/g) || []).length && s.split('/').length > 1) return { numeric: false, raw };

  let op = null;
  if (/>=|≥|at least|minimum|no less than/.test(s)) op = '>=';
  else if (/<=|≤|up to|no more than|cannot exceed|max(imum)?|not exceed/.test(s)) op = '<=';
  else if (/>/.test(s)) op = '>';
  else if (/</.test(s)) op = '<';

  const numMatch = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!op || !numMatch) return { numeric: false, raw };

  let unit = null;
  if (/sq ?ft|square f/.test(s)) unit = 'sq ft';
  else if (/\bft\b|feet|'/.test(s)) unit = 'ft';
  else if (/stor/.test(s)) unit = 'stories';

  return { numeric: true, op, value: Number(numMatch[1]), unit, raw };
}

function compare(value, op, target) {
  switch (op) {
    case '>=': return value >= target;
    case '<=': return value <= target;
    case '>': return value > target;
    case '<': return value < target;
    case '=': return value === target;
    default: return null;
  }
}

const METRIC_LABELS = {
  sideSetbackFt: 'side setback',
  rearSetbackFt: 'rear setback',
  distanceFt: 'distance from main house',
  heightFt: 'height',
  stories: 'stories',
  aduSqft: 'ADU size',
};

function fmtValue(metric, v) {
  if (v == null) return '—';
  if (metric === 'aduSqft') return `${v} sq ft`;
  if (metric === 'stories') return `${v}`;
  // feet
  return `${v}'`.replace(".5'", "'-6\"");
}

// Evaluate one rule against the order (raw). Returns a result row, or null if N/A.
function evaluateRuleCore(rule, order) {
  if (!ruleApplies(rule, order)) return null;

  const base = {
    requirement: rule.requirement,
    citation: rule.citation || '',
    ruleText: rule.rule || '',
    fix: rule.fix || '',
    thresholdRaw: rule.threshold || '',
  };

  const metric = mapMetric(rule.requirement);
  const parsed = parseThreshold(rule.threshold);

  // Special case: "must be allowed / protected" unit-size floors (state guarantees an allowance).
  // These often have no operator (e.g. "850 sq ft must be allowed"), so pull the number directly.
  const isProtectedSize =
    metric === 'aduSqft' && /allow|protect|guarantee|must/.test(lc(rule.threshold));
  if (isProtectedSize) {
    const m = lc(rule.threshold).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    const protectedVal = m ? Number(m[1]) : null;
    if (protectedVal != null) {
      const v = order.aduSqft;
      if (v == null) return { ...base, metric, yourValue: '—', threshold: `${protectedVal} sq ft protected`, status: STATUS.NEEDS_INPUT };
      const ok = v <= protectedVal;
      return {
        ...base, metric,
        yourValue: fmtValue('aduSqft', v),
        threshold: `≤ ${protectedVal} sq ft guaranteed`,
        status: ok ? STATUS.PASS : STATUS.REVIEW,
      };
    }
  }

  if (metric && parsed.numeric) {
    const v = order[metric];
    if (v == null || Number.isNaN(v)) {
      return { ...base, metric, yourValue: '—', threshold: `${parsed.op} ${parsed.value}${parsed.unit ? ' ' + parsed.unit : ''}`, status: STATUS.NEEDS_INPUT };
    }
    const ok = compare(v, parsed.op, parsed.value);
    return {
      ...base, metric,
      yourValue: fmtValue(metric, v),
      threshold: `${parsed.op} ${parsed.value}${parsed.unit ? ' ' + parsed.unit : ''}`,
      status: ok ? STATUS.PASS : STATUS.FLAG,
    };
  }

  // Everything else is surfaced for human judgment, still cited.
  return { ...base, metric, yourValue: '—', threshold: rule.threshold || '—', status: STATUS.REVIEW };
}

// Is this rule a LOCAL standard (city/county), vs uniform state law?
function isLocalRule(rule) {
  const j = lc(rule.jurisdiction || '').trim();
  if (j) return j !== 'state' && j !== 'california';
  return Boolean(ruleCounty(rule));
}

// Evaluate one rule with the city-pipeline safety gates applied:
//  1. State-preemption clamp — a local rule demanding more than CA state law
//     lets cities require (side/rear setback > 4 ft, height allowance < 16 ft)
//     can never FLAG/PASS a customer; it surfaces as REVIEW with a
//     "state law controls" note. Belt-and-braces even for Verified rows.
//  2. Pending gate — rules drafted by the city researcher but not yet
//     human-verified can only ever REVIEW. This is what keeps the
//     "never a confident wrong answer" guarantee intact.
export function evaluateRule(rule, order) {
  const row = evaluateRuleCore(rule, order);
  if (!row) return null;

  if (isLocalRule(rule) && row.metric && (row.status === STATUS.FLAG || row.status === STATUS.PASS)) {
    const parsed = parseThreshold(rule.threshold);
    if (parsed.numeric) {
      const preempted =
        ((row.metric === 'sideSetbackFt' || row.metric === 'rearSetbackFt') && parsed.op === '>=' && parsed.value > 4) ||
        (row.metric === 'heightFt' && (parsed.op === '<=' || parsed.op === '<') && parsed.value < 16);
      if (preempted) {
        return {
          ...row,
          status: STATUS.REVIEW,
          ruleText: `${row.ruleText ? row.ruleText + ' ' : ''}[Local standard appears stricter than current CA state law allows — state law controls (Cal. Gov. Code §66314). Verify with your planner.]`,
        };
      }
    }
  }

  if (lc(rule.verification) === 'pending') {
    return {
      ...row,
      status: STATUS.REVIEW,
      yourValue: '—',
      ruleText: `${row.ruleText ? row.ruleText + ' ' : ''}[Local standard drafted from the municipal code — pending Annex verification; confirm with your planner.]`,
    };
  }
  return row;
}

// Run the whole ruleset. Returns { rows, summary }.
export function evaluateOrder(rules, order) {
  const rows = [];
  for (const rule of rules) {
    const res = evaluateRule(rule, order);
    if (res) rows.push(res);
  }
  // Sort: flags first, then needs-input, then review, then pass.
  const rank = { [STATUS.FLAG]: 0, [STATUS.NEEDS_INPUT]: 1, [STATUS.REVIEW]: 2, [STATUS.PASS]: 3 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]));

  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.status === STATUS.PASS).length,
    flag: rows.filter((r) => r.status === STATUS.FLAG).length,
    review: rows.filter((r) => r.status === STATUS.REVIEW).length,
    needsInput: rows.filter((r) => r.status === STATUS.NEEDS_INPUT).length,
  };
  return { rows, summary };
}

export { METRIC_LABELS };
