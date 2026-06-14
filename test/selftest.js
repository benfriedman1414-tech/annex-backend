// Offline self-test — proves the engine + parser + report work WITHOUT Airtable.
//   node test/selftest.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOrder } from '../src/parse.js';
import { evaluateOrder, STATUS } from '../src/rules.js';
import { buildReportHtml } from '../src/report.js';

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

// ── Write a sample report so we can eyeball the design ──
fs.mkdirSync(outDir, { recursive: true });
const sampleFile = path.join(outDir, 'SAMPLE-report.html');
fs.writeFileSync(sampleFile, buildReportHtml(structured, r1), 'utf8');
divider('OUTPUT');
console.log('  Sample report written: ' + path.relative(path.resolve(__dirname, '..'), sampleFile));

divider(failures === 0 ? '✅ ALL TESTS PASSED' : `❌ ${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
