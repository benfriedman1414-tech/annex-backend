// Offline self-test — proves the engine + parser + report work WITHOUT Airtable.
//   node test/selftest.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOrder } from '../src/parse.js';
import { evaluateOrder, STATUS } from '../src/rules.js';
import { buildReportHtml } from '../src/report.js';
import { buildExtractionNotes } from '../src/vision.js';
import { remediateOrder, simulateFix } from '../src/remediate.js';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'reports');

// Representative slice of the real Airtable "Rules" table (formats preserved).
const RULES = [
  { requirement: 'Side setback', appliesTo: ['Detached', 'Attached'], rule: 'A city/county may not require more than a 4 ft side setback for an ADU.', threshold: '>= 4 ft', citation: 'Cal. Gov. Code §66314(d)(7)', fix: 'Shift the structure so the side setback is at least 4 ft, or use the conversion exemption.' },
  { requirement: 'Rear setback', appliesTo: ['Detached', 'Attached'], rule: 'A city/county may not require more than a 4 ft rear setback for an ADU.', threshold: '>= 4 ft', citation: 'Cal. Gov. Code §66314(d)(7)', fix: 'Shift the structure so the rear setback is at least 4 ft.' },
  { requirement: 'Front setback', appliesTo: ['Detached', 'Attached'], rule: 'Front setbacks follow the underlying zone, but cannot preclude an 800 sq ft ADU.', threshold: 'Per underlying zone', citation: 'Cal. Gov. Code §66314', fix: 'If the front setback blocks an 800 sq ft unit, the 800 sq ft envelope prevails.' },
  { requirement: 'Height - detached (base)', appliesTo: ['Detached'], rule: 'Detached ADU height is limited to 16 ft at base.', threshold: '<= 16 ft (base)', citation: 'Cal. Gov. Code §66314(d)(6)', fix: 'Lower the ridge to 16 ft, or qualify for the 18 ft transit/two-story allowance.' },
  { requirement: 'Height - transit / two-story', appliesTo: ['Detached'], rule: 'Up to 18 ft if within 1/2 mi of transit or on a multistory lot.', threshold: '<= 18 ft (if qualifying)', citation: 'Cal. Gov. Code §66314(d)(6)', fix: 'Confirm transit proximity to use the 18 ft allowance.' },
  { requirement: 'Height - attached', appliesTo: ['Attached'], rule: 'Attached ADU may be up to 25 ft or the main dwelling height.', threshold: '<= 25 ft', citation: 'Cal. Gov. Code §66314(d)(6)', fix: 'Match the primary dwelling height or 25 ft, whichever is lower per zone.' },
  { requirement: 'Unit size - studio / 1-bedroom', appliesTo: ['Detached', 'Attached'], rule: 'A studio or 1-bedroom ADU up to 850 sq ft must be allowed.', threshold: '850 sq ft must be allowed', citation: 'Cal. Gov. Code §66321', fix: 'Sizes up to 850 sq ft are protected for a 1-bedroom unit.' },
  { requirement: 'Unit size - 2+ bedrooms', appliesTo: ['Detached', 'Attached'], rule: 'A 2+ bedroom ADU up to 1,000 sq ft must be allowed; local max often 1,200.', threshold: '<= 1200 sq ft', citation: 'Cal. Gov. Code §66321', fix: 'Reduce floor area to the local maximum (commonly 1,200 sq ft).' },
  { requirement: 'Unit size - local maximum', appliesTo: ['Detached', 'Attached'], rule: 'Local maximum floor area for an ADU.', threshold: '<= 1200 sq ft', citation: 'Contra Costa Ord. §82-24', fix: 'Reduce ADU floor area to 1,200 sq ft or less.' },
  { requirement: 'Lot coverage', appliesTo: ['Detached', 'Attached'], rule: 'Local lot-coverage limits apply but cannot preclude an 800 sq ft ADU.', threshold: 'Per zone; cannot preclude 800 sq ft', citation: 'Cal. Gov. Code §66314', fix: 'If coverage blocks an 800 sq ft ADU, the state floor prevails.' },
  { requirement: 'Number of ADUs - single-family', appliesTo: ['Detached', 'Attached'], rule: 'A single-family lot may have one ADU plus one JADU.', threshold: '1 ADU + 1 JADU', citation: 'Cal. Gov. Code §66323', fix: 'Confirm only one ADU + one JADU are proposed.' },
  { requirement: 'Replacement parking', appliesTo: ['Detached', 'Attached'], rule: 'No replacement parking required within 1/2 mi of transit.', threshold: 'Exempt < 1/2 mi transit', citation: 'Cal. Gov. Code §66314(d)(10)', fix: 'Confirm transit proximity to claim the parking exemption.' },
];

function divider(t) { console.log('\n' + '─'.repeat(60) + '\n' + t); }
function showRows(result) {
  for (const r of result.rows) {
    console.log(`  [${r.status.padEnd(11)}] ${r.requirement.padEnd(30)} you:${String(r.yourValue).padEnd(9)} req:${r.threshold}`);
  }
  const s = result.summary;
  console.log(`  => ${s.pass} pass · ${s.flag} flag · ${s.review} review · ${s.needsInput} needs-input  (of ${s.total})`);
}

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  ✗ ASSERT FAILED: ' + msg); } else { console.log('  ✓ ' + msg); } }

// ── Test 1: structured order (the flagged-setback example) ──
divider('TEST 1 — structured order (Detached, 812 sqft 1BR, side setback 3 ft)');
const structured = normalizeOrder({
  id: 'recSTRUCT1',
  fields: { Name: 'Jordan Rivera', Email: 'jordan@example.com', City: 'Walnut Creek', 'ADU type': 'Detached',
    'Lot size sqft': 6000, 'ADU sqft': 812, Bedrooms: 1, 'Height ft': 15.5, Stories: 1,
    'Rear setback ft': 4, 'Side setback ft': 3, 'Near transit': 'Yes' },
});
const r1 = evaluateOrder(RULES, structured);
showRows(r1);
const side1 = r1.rows.find((r) => /side setback/i.test(r.requirement));
assert(side1 && side1.status === STATUS.FLAG, 'side setback (3 ft) is FLAGged against >= 4 ft');
const rear1 = r1.rows.find((r) => /rear setback/i.test(r.requirement));
assert(rear1 && rear1.status === STATUS.PASS, 'rear setback (4 ft) PASSes >= 4 ft');
const h1 = r1.rows.find((r) => /height - detached/i.test(r.requirement));
assert(h1 && h1.status === STATUS.PASS, 'height 15.5 ft PASSes <= 16 ft');
const size1 = r1.rows.find((r) => /1-bedroom/i.test(r.requirement));
assert(size1 && size1.status === STATUS.PASS, '812 sqft 1BR PASSes the 850 sqft protection');
assert(!r1.rows.some((r) => /attached/i.test(r.requirement)), 'attached-only rules are skipped for a Detached ADU');
assert(r1.summary.flag === 1, 'exactly 1 flag total');

// ── Test 2: free-text only order (no structured fields) ──
divider('TEST 2 — free-text order (numbers only in the Concerns box)');
const freeText = normalizeOrder({
  id: 'recFREE1',
  fields: { Name: 'Sam Lee', Email: 'sam@example.com',
    Concerns: "Detached ADU in Walnut Creek. Lot 6,000 sq ft. ADU 812 sq ft, 1 bedroom. Height 15'6\". Rear setback 4 ft, side setback 3 ft. There's a bus stop within 1/2 mile." },
});
console.log('  parsed:', JSON.stringify({ type: freeText.aduType, lot: freeText.lotSqft, adu: freeText.aduSqft, bed: freeText.bedrooms, ht: freeText.heightFt, rear: freeText.rearSetbackFt, side: freeText.sideSetbackFt, transit: freeText.nearTransit }));
assert(freeText.aduSqft === 812, 'parsed ADU size 812 from free text');
assert(freeText.bedrooms === 1, 'parsed 1 bedroom from free text');
assert(Math.abs(freeText.heightFt - 15.5) < 0.01, "parsed height 15'6\" -> 15.5 ft from free text");
assert(freeText.sideSetbackFt === 3, 'parsed side setback 3 ft from free text');
assert(freeText.aduType === 'Detached', 'parsed ADU type Detached from free text');
assert(freeText.city === 'Walnut Creek', `free-text city extracted ("${freeText.city}")`);
const r2 = evaluateOrder(RULES, freeText);
showRows(r2);
const side2 = r2.rows.find((r) => /side setback/i.test(r.requirement));
assert(side2 && side2.status === STATUS.FLAG, 'free-text order also FLAGs the side setback');

// ── Test 3: missing number -> NEEDS INPUT ──
divider('TEST 3 — missing height -> NEEDS INPUT (not a false pass)');
const partial = normalizeOrder({ id: 'recPART1', fields: { Name: 'Pat Doe', 'ADU type': 'Detached', 'Side setback ft': 5, 'Rear setback ft': 5 } });
const r3 = evaluateOrder(RULES, partial);
const h3 = r3.rows.find((r) => /height - detached/i.test(r.requirement));
assert(h3 && h3.status === STATUS.NEEDS_INPUT, 'missing height is flagged NEEDS INPUT, never a silent pass');

// ── Test 4: photo intake — extraction notes round-trip into the engine ──
divider('TEST 4 — plan-photo extraction → "Extraction notes" → parsed by the engine');
const fakeExtraction = {
  readable: true, documentType: 'site plan', aduType: 'Detached', city: 'Walnut Creek', nearTransit: null,
  heightFt: { value: 15.5, confidence: 'high', note: 'ridge height callout' },
  stories: { value: 1, confidence: 'high', note: '' },
  aduSqft: { value: 812, confidence: 'high', note: 'floor area schedule' },
  lotSqft: { value: 6000, confidence: 'medium', note: 'lot dims 60x100' },
  bedrooms: { value: 1, confidence: 'high', note: '' },
  rearSetbackFt: { value: 4, confidence: 'high', note: 'rear dimension line' },
  sideSetbackFt: { value: 3, confidence: 'low', note: 'faint, hard to read' },
  distanceFt: { value: null, confidence: 'none', note: 'not shown' },
  needsConfirmation: ['sideSetbackFt', 'distanceFt'], summary: 'Detached ADU site plan.',
};
const notes = buildExtractionNotes(fakeExtraction, 'claude-opus-4-8');
const fromPhoto = normalizeOrder({ id: 'recPHOTO1', fields: { Name: 'Plan Upload', 'ADU type': 'Detached', 'Extraction notes': notes } });
console.log('  parsed-from-notes:', JSON.stringify({ adu: fromPhoto.aduSqft, bed: fromPhoto.bedrooms, ht: fromPhoto.heightFt, side: fromPhoto.sideSetbackFt, rear: fromPhoto.rearSetbackFt, lot: fromPhoto.lotSqft }));
assert(fromPhoto.aduSqft === 812, 'extraction notes → ADU size 812 (high confidence) read by the parser');
assert(Math.abs(fromPhoto.heightFt - 15.5) < 0.01, 'extraction notes → height 15.5 ft (high confidence) read by the parser');
assert(fromPhoto.lotSqft === 6000, 'extraction notes → lot 6000 sq ft (medium confidence, unflagged) still used');
assert(fromPhoto.bedrooms === 1, 'extraction notes → 1 bedroom read by the parser');
// AUTO-mode safety: the LOW-confidence side setback must be EXCLUDED — the
// engine asks for the number instead of risking a wrong verdict on a misread.
assert(fromPhoto.sideSetbackFt === null, 'low-confidence side setback is EXCLUDED from the parseable line (never fed to the engine)');
const r4 = evaluateOrder(RULES, fromPhoto);
const side4 = r4.rows.find((r) => /side setback/i.test(r.requirement));
assert(side4 && side4.status === STATUS.NEEDS_INPUT, 'unclear side setback → NEEDS INPUT (report asks the homeowner), never a wrong pass/flag');
const rear4 = r4.rows.find((r) => /rear setback/i.test(r.requirement));
assert(rear4 && rear4.status === STATUS.PASS, 'high-confidence rear setback (4 ft) still auto-PASSes');
assert(/Not read clearly — excluded from the check/.test(notes) && notes.includes('sideSetbackFt'), 'notes record which unclear fields were excluded');

// ── Test 5: remediation pass — verified fix options on every flag ──
divider('TEST 5 — remediation: flags get verified fix options (offline, deterministic path)');
config.remediation.apiKey = ''; // force the no-model path: this test must never hit the network
const sim = simulateFix(RULES, structured, 'sideSetbackFt', 4);
assert(sim.clears('Side setback'), 'simulateFix: side setback 3→4 ft provably clears the flag');
assert(sim.newFlags.length === 0, 'simulateFix: the 4 ft fix introduces no new flags');
assert(sim.changes.length === 1 && sim.changes[0].requirement === 'Side setback', 'simulateFix: no other checks change');
const rem = await remediateOrder(RULES, structured, r1);
assert(rem.flags === 1 && rem.model === null, 'remediateOrder ran deterministically on 1 flag (no API key)');
const sideFix = r1.rows.find((r) => /side setback/i.test(r.requirement));
assert(Array.isArray(sideFix.fixes) && sideFix.fixes.length >= 1, 'flagged row carries at least one fix option');
const opt = sideFix.fixes[0];
assert(opt.verified === true, 'the baseline fix option is engine-verified');
assert(opt.metric === 'sideSetbackFt' && opt.proposedValue === 4, 'baseline proposes exactly the 4 ft threshold');
assert(/3 ft → 4 ft/.test(opt.amount), `amount label shows what to change and by how much ("${opt.amount}")`);
assert(/no other checks affected/i.test(opt.effects), 'effects state the fix touches nothing else (verified)');
const remHtml = buildReportHtml(structured, r1);
assert(remHtml.includes('FIX OPTIONS — VERIFIED AGAINST YOUR FULL CHECK'), 'report renders the verified fix-options block');
assert(remHtml.includes('3 ft → 4 ft'), 'report shows the concrete change amount');

// ── Test 6: payment linkage — flag-only, fail-safe ──
divider('TEST 6 — payment linkage: session index + flags (never blocks)');
const { buildSessionIndex, paymentFlag } = await import('../src/payment.js');
const ORDERS = [
  { id: 'recA', fields: { Name: 'Paid A', 'Stripe session': 'cs_live_AAA' } },
  { id: 'recB', fields: { Name: 'Reuser', 'Stripe session': 'cs_live_AAA' } },
  { id: 'recC', fields: { Name: 'No Session', Concerns: 'whatever' } },
];
const idx = buildSessionIndex(ORDERS);
assert(idx.get('cs_live_AAA').length === 2, 'session index counts both holders of a session');
assert(paymentFlag({ session: 'cs_live_AAA', orderId: 'recB', index: idx }).includes('DUPLICATE'), 'reused session is flagged as duplicate');
assert(paymentFlag({ session: 'cs_live_ZZZ', orderId: 'recX', index: idx }) === '', 'a fresh unique session passes clean');
assert(paymentFlag({ session: '', orderId: 'recC', index: idx }).includes('NO Stripe session'), 'missing session is flagged once the funnel is armed');
assert(paymentFlag({ session: '', orderId: 'recC', index: buildSessionIndex([]) }) === '', 'missing session is NOT flagged before any session has ever been seen (unarmed = quiet)');

// ── Test 7: freemium — teaser withholds the product, lifecycle gates correctly ──
divider('TEST 7 — freemium: teaser content + lifecycle decisions + stripe shapes');
const { buildTeaser, decideFreemiumStep, maskEmail } = await import('../src/summary.js');
const teaser = buildTeaser(structured, r1);
assert(teaser.checked === r1.summary.total && teaser.flag === 1 && teaser.pass === r1.summary.pass, 'teaser counts mirror the engine summary');
assert(teaser.flagged.length === 1 && /side setback/i.test(teaser.flagged[0].category), 'flag category names the metric ("side setback")');
const teaserJson = JSON.stringify(teaser);
assert(!/66314|Gov\. Code|§/.test(teaserJson), 'teaser leaks NO citations');
assert(!/4 ?ft|>=|<=/.test(teaserJson), 'teaser leaks NO thresholds');
assert(!teaserJson.includes('"3'), 'teaser leaks NO customer values');
assert(!/fix|shift the structure/i.test(teaserJson), 'teaser leaks NO fix text');
assert(teaser.seriousNote && /state-law minimum/.test(teaser.seriousNote), 'state-law flag produces the factual severity note');
assert(maskEmail('ben@x.com') === 'b•••@x.com', 'email masking works');
const FCFG = config.freemium;
assert(decideFreemiumStep({ status: '', ageMin: 2 }, FCFG) === 'wait', 'fresh unopened order: wait (page may still load it)');
assert(decideFreemiumStep({ status: '', ageMin: 15 }, FCFG) === 'summarize-email', 'unopened after 10 min: compute + email the teaser');
assert(decideFreemiumStep({ status: FCFG.summaryReadyStatus, ageMin: 20 }, FCFG) === 'wait', 'saw summary 20 min ago: not yet');
assert(decideFreemiumStep({ status: FCFG.summaryReadyStatus, ageMin: 50 }, FCFG) === 'remind', 'saw summary 50 min ago, unpaid: reminder email');
assert(decideFreemiumStep({ status: FCFG.summarySentStatus, ageMin: 500 }, FCFG) === 'wait', 'already reminded: never nag twice');
assert(decideFreemiumStep({ status: FCFG.paidStatus, ageMin: 1 }, FCFG) === 'process', 'Paid: full report pipeline');
assert(decideFreemiumStep({ status: FCFG.generatingStatus, ageMin: 9, generatingSeen: 1 }, FCFG) === 'wait', 'API mid-generate: hands off');
assert(decideFreemiumStep({ status: FCFG.generatingStatus, ageMin: 60, generatingSeen: 6 }, FCFG) === 'process', 'stale Generating (5+ polls): worker reclaims');
const { isSessionIdShaped, sessionPaid } = await import('../src/stripe.js');
assert(isSessionIdShaped('cs_live_a1B2c3D4e5F6g7H8'), 'real-shaped session id accepted');
assert(!isSessionIdShaped('cs_live_x; DROP TABLE') && !isSessionIdShaped('foo'), 'malformed session ids rejected');
assert(sessionPaid({ status: 'complete', payment_status: 'paid' }), 'complete+paid session verifies');
assert(sessionPaid({ status: 'complete', payment_status: 'no_payment_required' }), '100%-promo ($0) session verifies');
assert(!sessionPaid({ status: 'complete', payment_status: 'unpaid' }), 'unpaid session rejected');
assert(!sessionPaid({ status: 'open', payment_status: 'paid' }), 'incomplete session rejected');

// ── Test 8: city-rules pipeline — jurisdiction match + safety gates ──
divider('TEST 8 — city rules: jurisdiction routing, Pending gate, preemption clamp, markers');
// structured order is Walnut Creek, Contra Costa County (side setback 3 ft).
const CITY_RULES = [
  // Verified city rule for the ORDER's city — should evaluate numerically (FLAG at 900 < 812? no: <= 900 passes 812).
  { requirement: 'Unit size - city maximum', appliesTo: ['Detached'], rule: 'Local max floor area.', threshold: '<= 900 sq ft', citation: 'Walnut Creek Mun. Code §10-2.3.204', fix: 'Reduce floor area.', jurisdiction: 'City of Walnut Creek', verification: 'Verified' },
  // Same rule for a DIFFERENT city — must not apply at all.
  { requirement: 'Unit size - city maximum', appliesTo: ['Detached'], rule: 'Local max floor area.', threshold: '<= 700 sq ft', citation: 'Concord Mun. Code §18.200.180', fix: '', jurisdiction: 'City of Concord', verification: 'Verified' },
  // PENDING city rule that would numerically FLAG (850 < 812 is false → would PASS; use <= 800 so it would FLAG) — must be forced to REVIEW.
  { requirement: 'Lot coverage - city cap', appliesTo: ['Detached'], rule: 'City caps ADU size on small lots.', threshold: '<= 800 sq ft', citation: 'Walnut Creek Mun. Code §10-2.3.205', fix: '', jurisdiction: 'City of Walnut Creek', verification: 'Pending' },
  // Verified but PREEMPTED: city demands a 5 ft side setback; state caps what cities may require at 4 ft.
  { requirement: 'Side setback - city standard', appliesTo: ['Detached'], rule: 'City requires a larger side yard.', threshold: '>= 5 ft', citation: 'Walnut Creek Mun. Code §10-2.3.206', fix: '', jurisdiction: 'City of Walnut Creek', verification: 'Verified' },
  // Bookkeeping rows — must never evaluate.
  { requirement: 'City research: Walnut Creek', rule: 'sources…', threshold: '', citation: '', fix: '', jurisdiction: 'City of Walnut Creek', verification: 'Marker' },
  { requirement: 'Height - old city limit', appliesTo: ['Detached'], rule: 'Superseded by state law.', threshold: '<= 14 ft', citation: 'Walnut Creek Mun. Code (pre-2020)', fix: '', jurisdiction: 'City of Walnut Creek', verification: 'Superseded' },
];
const r8 = evaluateOrder(RULES.concat(CITY_RULES), structured);
const cityMax = r8.rows.filter((r) => /city maximum/i.test(r.requirement));
assert(cityMax.length === 1 && /Walnut Creek/.test(cityMax[0].citation), 'only the ORDER city\'s rule applies (Concord\'s is skipped)');
assert(cityMax[0].status === STATUS.PASS && cityMax[0].yourValue === '812 sq ft', 'a VERIFIED city rule evaluates numerically (812 ≤ 900 → PASS)');
const pend = r8.rows.find((r) => /city cap/i.test(r.requirement));
assert(pend && pend.status === STATUS.REVIEW, 'a PENDING city rule can only ever REVIEW (812 vs ≤800 would have flagged)');
assert(/pending Annex verification/i.test(pend.ruleText), 'pending rows carry the verification note in the report text');
const clamp = r8.rows.find((r) => /side setback - city/i.test(r.requirement));
assert(clamp && clamp.status === STATUS.REVIEW, 'a local setback demand above the 4 ft state cap is clamped to REVIEW (never FLAG)');
assert(/state law controls/i.test(clamp.ruleText), 'the clamp explains that state law controls');
assert(!r8.rows.some((r) => /City research:|old city limit/i.test(r.requirement)), 'Marker and Superseded rows never evaluate');
const wrongCity = evaluateOrder(RULES.concat(CITY_RULES), normalizeOrder({ id: 'recX', fields: { Name: 'Elsewhere', City: 'Concord', 'ADU type': 'Detached', 'ADU sqft': 812, Bedrooms: 1 } }));
const ccMax = wrongCity.rows.filter((r) => /city maximum/i.test(r.requirement));
assert(ccMax.length === 1 && /Concord/.test(ccMax[0].citation) && ccMax[0].status === STATUS.FLAG, 'a Concord order gets CONCORD\'s rule (812 > 700 → FLAG)');

// ── Write a sample report so we can eyeball the design ──
fs.mkdirSync(outDir, { recursive: true });
const sampleFile = path.join(outDir, 'SAMPLE-report.html');
fs.writeFileSync(sampleFile, buildReportHtml(structured, r1), 'utf8');
divider('OUTPUT');
console.log('  Sample report written: ' + path.relative(path.resolve(__dirname, '..'), sampleFile));

divider(failures === 0 ? '✅ ALL TESTS PASSED' : `❌ ${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
