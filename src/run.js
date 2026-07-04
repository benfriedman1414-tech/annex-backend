// Annex backend — poll worker.
//   node src/run.js          process all pending orders once
//   node src/run.js --watch  keep polling Airtable for new orders
//
// Two order kinds share this loop (discriminated by the "Client token" field):
//   LEGACY  (no token)  — paid-first / manually created: full report immediately.
//   FREEMIUM (token)    — public /precheck flow: free teaser summary; the FULL
//                         report only after a VERIFIED Stripe payment. The API
//                         service (server.js) handles the live page + unlock;
//                         this worker is the safety net — it emails teasers to
//                         abandoners, sweeps Stripe for paid-but-closed-tab
//                         sessions, and reclaims stale in-flight orders.
import { config, assertAirtableConfigured } from './config.js';
import { fetchRules, fetchAllOrders, filterPending, updateOrderStatus } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { evaluateOrder } from './rules.js';
import { generateAndSendReport, readPhotoIfNeeded } from './pipeline.js';
import { buildTeaser, decideFreemiumStep } from './summary.js';
import { sendPhotoAck, sendOwnerAlert, sendTeaserEmail } from './notify.js';
import { buildSessionIndex, paymentFlag } from './payment.js';
import { stripeEnabled, listRecentSessions, sessionPaid } from './stripe.js';
import { updateOrderFields } from './airtable.js';
import { ensureCityCoverage, refreshStaleCities } from './cityrules.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// How many consecutive polls each order has sat at "Generating report" —
// after 5 sightings we assume the API service died mid-generate and reclaim.
const generatingSightings = new Map();

const ageMinutes = (rec) => (Date.now() - Date.parse(rec.createdTime || 0)) / 60_000;

function unlockUrlFor(token, email) {
  const u = new URL(config.stripe.unlockLink);
  u.searchParams.set('client_reference_id', token);
  if (email) u.searchParams.set('prefilled_email', email);
  return u.toString();
}

// ── Stripe sweep: unlock orders whose customer paid but never hit /unlocked ──
async function sweepStripeSessions(allOrders) {
  if (!stripeEnabled()) return 0;
  let swept = 0;
  try {
    const sessions = await listRecentSessions(100);
    const used = new Set(allOrders.map((r) => (r.fields?.[config.freemium.sessionField] || '').toString().trim()).filter(Boolean));
    const byToken = new Map(allOrders.map((r) => [((r.fields || {})[config.freemium.tokenField] || '').toString().trim(), r]).filter(([t]) => t));
    for (const s of sessions) {
      if (!sessionPaid(s) || !s.client_reference_id || used.has(s.id)) continue;
      const rec = byToken.get(s.client_reference_id.trim());
      if (!rec) continue;
      const status = (rec.fields?.Status || '').toString().trim();
      const doneish = [config.airtable.doneStatus, config.airtable.sentStatus, config.freemium.paidStatus, config.freemium.generatingStatus];
      if (doneish.includes(status) || (rec.fields?.[config.freemium.sessionField] || '').toString().trim()) continue;
      await updateOrderStatus(rec.id, config.freemium.paidStatus, { [config.freemium.sessionField]: s.id });
      rec.fields.Status = config.freemium.paidStatus;
      rec.fields[config.freemium.sessionField] = s.id;
      used.add(s.id);
      swept++;
      log(`$ swept paid session ${s.id} → order ${rec.id} marked ${config.freemium.paidStatus}`);
    }
  } catch (e) {
    log(`(stripe sweep skipped: ${e.message})`);
  }
  return swept;
}

async function processOnce() {
  assertAirtableConfigured();
  const rules = await fetchRules();
  log(`Loaded ${rules.length} rules from Airtable.`);
  const allOrders = await fetchAllOrders();
  await sweepStripeSessions(allOrders);
  const pending = filterPending(allOrders);
  const sessionIndex = buildSessionIndex(allOrders);
  log(`Found ${pending.length} order(s) to process.`);
  if (!pending.length) return 0;

  let done = 0;

  for (const rec of pending) {
    const f = rec.fields || {};
    const status = (f.Status || '').toString().trim();
    const orderName = f.Name || rec.id;
    const token = (f[config.freemium.tokenField] || '').toString().trim();
    const isFreemium = Boolean(token);
    const hasSession = Boolean((f[config.freemium.sessionField] || '').toString().trim());
    const unread = status === '' || status === config.airtable.newStatus;

    // ── Photo intake: read an unread plan photo once (both flows) ──
    if (unread) {
      try {
        const pr = await readPhotoIfNeeded(rec, log);
        if (pr.keyless) {
          // Keyless mode: queue the photo for a human (legacy behavior).
          const note = `Plan photo uploaded. Automatic reading is off (no ANTHROPIC_API_KEY). Read the dimensions off the photo, type them into the details box, then set Status to "${config.airtable.confirmedStatus}".`;
          try { await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus, { [config.airtable.notesField]: note }); }
          catch (e) { if (/unknown field/i.test(e.message)) await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus); else throw e; }
          log(`• ${orderName}: plan photo queued for manual reading → ${config.airtable.needsConfirmationStatus}.`);
          try {
            if (!isFreemium) await sendPhotoAck({ name: f.Name, email: f.Email });
            await sendOwnerAlert(`Action needed: read plan photo for "${orderName}"`, [
              `Order ${rec.id} (${f.Email || 'no email'}) uploaded a plan photo and is waiting.`,
              `Read the dimensions, type them into the details box, then set Status to "${config.airtable.confirmedStatus}".`,
            ]);
          } catch (e) { log(`  (notify failed: ${e.message})`); }
          continue;
        }
        if (pr.illegible) {
          try {
            await sendOwnerAlert(`Action needed: illegible plan photo on "${orderName}"`, [
              `Order ${rec.id} (${f.Email || 'no email'}) uploaded a plan photo that couldn't be read reliably.`,
              'Ask the customer to re-upload a clearer image or type their numbers, then set Status to "' + config.airtable.confirmedStatus + '".',
            ]);
          } catch (e) { log(`  (notify failed: ${e.message})`); }
          log(`✗ ${orderName}: photo illegible → ${config.airtable.needsConfirmationStatus} (owner alerted)`);
          continue;
        }
        if (pr.read) {
          const excluded = (pr.extraction.needsConfirmation || []);
          log(`✎ ${orderName}: read ${pr.extraction.documentType}${excluded.length ? ` · unclear (excluded): ${excluded.join(', ')}` : ' · read cleanly'}`);
          if (!isFreemium) {
            try {
              await sendPhotoAck({ name: f.Name, email: f.Email });
              await sendOwnerAlert(`FYI: photo order auto-processed — "${orderName}"`, [
                `Order ${rec.id} (${f.Email || 'no email'}) — plan photo read and checked automatically. No action needed.`,
                pr.extraction.summary || '',
                excluded.length ? `Unclear reads excluded from the check (report asks the customer): ${excluded.join(', ')}` : 'All fields read cleanly.',
              ]);
            } catch (e) { log(`  (notify failed: ${e.message})`); }
          }
        }
      } catch (err) {
        log(`✗ ${orderName}: plan-photo read failed (${err.message}) — left at "${config.airtable.readingStatus}". Reset Status to re-try.`);
        continue;
      }
    }

    // Orders awaiting human confirmation (or mid-read) are not checked yet —
    // EXCEPT a freemium order that has both been Confirmed and paid (below).
    if (status === config.airtable.readingStatus) continue;

    // ── Freemium lifecycle ──
    if (isFreemium) {
      const seen = (generatingSightings.get(rec.id) || 0) + (status === config.freemium.generatingStatus ? 1 : 0);
      generatingSightings.set(rec.id, status === config.freemium.generatingStatus ? seen : 0);
      let step = decideFreemiumStep({ status, ageMin: ageMinutes(rec), generatingSeen: seen }, config.freemium);
      // A held-then-Confirmed order processes only once it's actually paid.
      if (status === config.airtable.confirmedStatus) step = hasSession ? 'process' : 'wait';
      else if (status === config.airtable.needsConfirmationStatus) step = 'wait';

      if (step === 'wait') continue;
      if (step === 'summarize-email' || step === 'remind') {
        try {
          const order = normalizeOrder(rec);
          const result = evaluateOrder(rules, order);
          const teaser = buildTeaser(order, result);
          await sendTeaserEmail({ name: f.Name, email: f.Email, teaser, unlockUrl: unlockUrlFor(token, f.Email) });
          await updateOrderStatus(rec.id, config.freemium.summarySentStatus);
          log(`✉ ${orderName}: teaser summary emailed (${step}) — ${teaser.flag} flag(s), awaiting unlock`);
        } catch (e) {
          log(`✗ ${orderName}: teaser email failed (${e.message})`);
        }
        continue;
      }
      // step === 'process' → fall through to the full paid pipeline.
      log(`$ ${orderName}: paid — generating full report`);
    } else {
      if (status === config.airtable.needsConfirmationStatus) continue;
      // Legacy payment-linkage anomaly check (flag-only, never blocks).
      const order = normalizeOrder(rec);
      const payFlag = paymentFlag({ session: order.stripeSession, orderId: order.id, index: sessionIndex });
      if (payFlag) {
        log(`  ⚠ payment: ${payFlag}`);
        try { await updateOrderFields(order.id, { 'Payment flag': payFlag }); }
        catch (e) { if (!/unknown field/i.test(e.message)) throw e; }
        try {
          await sendOwnerAlert(`Payment check: "${order.name || order.id}"`, [
            payFlag,
            `Order ${order.id} · ${order.email || 'no email'} · processed normally — verify the payment in Stripe.`,
          ]);
        } catch (e) { log(`  (alert failed: ${e.message})`); }
      }
    }

    // ── Full pipeline: engine → remediation → report → email → status ──
    try {
      const out = await generateAndSendReport(rec, rules, log);
      const s = out.result.summary;
      log(`✓ ${orderName}: ${s.pass} pass · ${s.flag} flag · ${s.review} review · ${s.needsInput} needs-input`);
      done++;
    } catch (err) {
      log(`✗ ${orderName}: ${err.message}`);
    }
  }

  // ── City-rules research (AFTER all orders, so it never delays a report) ──
  // New city seen in an order → one research job drafts Pending rules + a
  // coverage marker; stale cities get a ~90-day drift re-check (alert-only).
  try { await ensureCityCoverage(allOrders, rules, log); } catch (e) { log(`(city coverage skipped: ${e.message})`); }
  try { await refreshStaleCities(rules, log); } catch (e) { log(`(city refresh skipped: ${e.message})`); }

  return done;
}

// Keep the free-tier API service warm (it serves the live summary page).
async function pingApi() {
  if (!config.api.url) return;
  try { await fetch(`${config.api.url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(10_000) }); }
  catch { /* best-effort */ }
}

async function main() {
  const watch = process.argv.includes('--watch');
  if (!watch) {
    const n = await processOnce();
    log(`Done. ${n} report(s) generated.`);
    return;
  }
  log(`Watch mode: polling every ${config.pollSeconds}s. Ctrl+C to stop.`);
  // Re-entrancy guard: a slow pass (e.g. a 2-5 min city-research call) must
  // not overlap the next interval tick — skip ticks while one is running.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pingApi();
      try { await processOnce(); } catch (e) { log('Error:', e.message); }
    } finally { running = false; }
  };
  await tick();
  setInterval(tick, config.pollSeconds * 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
