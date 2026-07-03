// ─────────────────────────────────────────────────────────────
// Freemium teaser — the FREE summary a customer sees right after
// submitting the intake form, before paying.
//
// Design rule (CarFax pattern): the teaser is PROOF OF COVERAGE, never
// substance. It shows how many rules were checked, for which jurisdiction,
// and the pass/flag/review/needs-input COUNTS — plus the CATEGORY of each
// flag ("side setback") — but never the threshold, the citation, the
// customer's own value next to the limit, or the fix. Those are the paid
// product. Keep it factual; no fear-mongering (legal guardrails).
// ─────────────────────────────────────────────────────────────
import { METRIC_LABELS } from './rules.js';

// A FLAG can only come from the numeric path, so flagged rows always carry a
// metric. Map it to a human category without leaking the rule's specifics.
function flagCategory(row) {
  const label = METRIC_LABELS[row.metric];
  if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  // Defensive fallback: first few words of the requirement name only.
  return (row.requirement || 'Requirement').split(/\s+/).slice(0, 3).join(' ');
}

// Is this flag measured against a California state-law minimum (vs local)?
const isStateCitation = (c) => /gov(?:ernment)?\.?\s*code|§\s*66\d{3}/i.test(c || '');

// Build the teaser payload from a full engine result. Everything in here is
// safe to show (and email) unpaid.
export function buildTeaser(order, result) {
  const { summary, rows } = result;
  const flaggedRows = rows.filter((r) => r.status === 'FLAG');
  const flagged = flaggedRows.map((r) => ({
    category: flagCategory(r),
    state: isStateCitation(r.citation),
  }));
  const stateFlags = flagged.filter((f) => f.state).length;
  return {
    city: order.city || '',
    county: order.county || '',
    checked: summary.total,
    pass: summary.pass,
    flag: summary.flag,
    review: summary.review,
    needsInput: summary.needsInput,
    flagged,
    // One factual severity line, or null.
    seriousNote: stateFlags > 0
      ? `${stateFlags === 1 ? 'One flag is' : `${stateFlags} flags are`} measured against a California state-law minimum.`
      : null,
  };
}

// Mask an email for display on the /unlocked page ("b•••@gmail.com").
export function maskEmail(email) {
  const m = String(email || '').match(/^(.)(.*)(@.+)$/);
  return m ? `${m[1]}•••${m[3]}` : '';
}

// ── Freemium lifecycle decision (pure, unit-testable) ────────
// Given a freemium order's status + age, what should the WORKER do this poll?
//   'summarize-email'  compute teaser + send teaser email (never opened the page)
//   'remind'           send the teaser email (opened page, never paid)
//   'process'          run the full paid pipeline (report + email)
//   'wait'             nothing this poll
export function decideFreemiumStep({ status, ageMin, generatingSeen = 0 }, cfg) {
  const s = (status || '').trim();
  if (s === cfg.paidStatus) return 'process';
  // In-flight on the API service; reclaim only if it's clearly stale.
  if (s === cfg.generatingStatus) return generatingSeen >= 5 ? 'process' : 'wait';
  if (s === '' || s === cfg.newStatus) return ageMin >= cfg.teaserDelayMin ? 'summarize-email' : 'wait';
  if (s === cfg.summaryReadyStatus) return ageMin >= cfg.reminderDelayMin ? 'remind' : 'wait';
  // Summary sent / Needs confirmation / Reading photo / done states: leave alone.
  return 'wait';
}
