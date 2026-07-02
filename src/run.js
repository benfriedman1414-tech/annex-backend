// Annex backend — main runner. (flow: photo ack + owner alerts + payment flag)
//   node src/run.js          process all pending orders once
//   node src/run.js --watch  keep polling Airtable for new orders
import fs from 'node:fs';
import path from 'node:path';
import { config, assertAirtableConfigured } from './config.js';
import { fetchRules, fetchAllOrders, filterPending, updateOrderStatus, updateOrderFields } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { evaluateOrder } from './rules.js';
import { buildReportHtml, buildEmailText } from './report.js';
import { sendReportEmail, emailEnabled } from './email.js';
import { extractFromPhoto, visionEnabled, buildExtractionNotes, normalizePhoto } from './vision.js';
import { remediateOrder } from './remediate.js';
import { sendPhotoAck, sendOwnerAlert, notifyEnabled } from './notify.js';
import { buildSessionIndex, paymentFlag } from './payment.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Free-text columns the parser reads — used as a fallback target if the
// "Extraction notes" column hasn't been added to Airtable yet.
const DETAIL_FIELDS = ['Concerns', 'ADU details', 'Your ADU details', 'Details', 'Message'];
const pickDetailsField = (fields) => DETAIL_FIELDS.find((k) => fields[k] != null) || 'Concerns';

async function processOnce() {
  assertAirtableConfigured();
  const rules = await fetchRules();
  log(`Loaded ${rules.length} rules from Airtable.`);
  const allOrders = await fetchAllOrders();
  const pending = filterPending(allOrders);
  const sessionIndex = buildSessionIndex(allOrders);
  log(`Found ${pending.length} order(s) to process.`);
  if (!pending.length) return 0;

  fs.mkdirSync(config.reportsDir, { recursive: true });
  let done = 0;

  for (const rec of pending) {
    const f = rec.fields || {};
    const status = (f.Status || '').toString().trim();
    const orderName = f.Name || rec.id;
    const photo = normalizePhoto(f[config.airtable.photoField]);
    const hasPhoto = !!photo;
    const unread = status === '' || status === config.airtable.newStatus;

    // ── Photo intake: read an unread plan photo, then HOLD for confirmation ──
    // (We never run the check on photo-derived numbers until a human confirms.)
    if (hasPhoto && unread) {
      if (!visionEnabled()) {
        // Keyless mode: queue the photo for a human to read (once), instead of
        // re-skipping it every poll. Auto-reading turns on when ANTHROPIC_API_KEY is set.
        const note = `Plan photo uploaded. Automatic reading is off (no ANTHROPIC_API_KEY). Read the dimensions off the photo, type them into the details box, then set Status to "${config.airtable.confirmedStatus}".`;
        try {
          await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus, { [config.airtable.notesField]: note });
        } catch (e) {
          if (/unknown field/i.test(e.message)) await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus);
          else throw e;
        }
        log(`• ${orderName}: plan photo queued for manual reading → ${config.airtable.needsConfirmationStatus}. (Set ANTHROPIC_API_KEY to auto-read.)`);
        try {
          await sendPhotoAck({ name: f.Name, email: f.Email });
          await sendOwnerAlert(`Action needed: read plan photo for "${orderName}"`, [
            `Order ${rec.id} (${f.Email || 'no email'}) uploaded a plan photo and is waiting.`,
            `Read the dimensions, type them into the details box, then set Status to "${config.airtable.confirmedStatus}".`,
          ]);
        } catch (e) { log(`  (notify failed: ${e.message})`); }
        continue;
      }
      // AUTO mode: read the photo and run the check immediately — no human
      // hold. Safety: vision only feeds the engine values it read reliably
      // (see vision.js `usable`); unclear reads become NEEDS INPUT rows in
      // the report instead of wrong verdicts. Illegible uploads still hold.
      try {
        await updateOrderStatus(rec.id, config.airtable.readingStatus);
        const extraction = await extractFromPhoto(photo);
        const notes = buildExtractionNotes(extraction, config.vision.model);
        // Persist the extraction for the record (tolerate a missing column).
        let notesField = config.airtable.notesField;
        try {
          await updateOrderFields(rec.id, { [notesField]: notes });
        } catch (e) {
          if (/unknown field/i.test(e.message)) {
            notesField = pickDetailsField(f);
            const existing = (f[notesField] || '').toString();
            await updateOrderFields(rec.id, { [notesField]: existing ? `${existing}\n\n${notes}` : notes });
            log(`  (note: "${config.airtable.notesField}" field missing — wrote extraction into "${notesField}")`);
          } else throw e;
        }
        if (extraction.readable === false) {
          // Failure path only: an unreadable image can't produce a useful
          // report — hold it and tell the owner to follow up.
          await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus);
          try {
            await sendOwnerAlert(`Action needed: illegible plan photo on "${orderName}"`, [
              `Order ${rec.id} (${f.Email || 'no email'}) uploaded a plan photo that couldn't be read reliably.`,
              'Ask the customer to re-upload a clearer image or type their numbers, then set Status to "' + config.airtable.confirmedStatus + '".',
            ]);
          } catch (e) { log(`  (notify failed: ${e.message})`); }
          log(`✗ ${orderName}: photo illegible → ${config.airtable.needsConfirmationStatus} (owner alerted)`);
          continue;
        }
        // Feed the extraction to the engine in THIS pass.
        f[notesField] = f[notesField] ? `${f[notesField]}\n\n${notes}` : notes;
        const excluded = (extraction.needsConfirmation || []);
        log(`✎ ${orderName}: read ${extraction.documentType} → auto-processing${excluded.length ? ` · unclear (excluded): ${excluded.join(', ')}` : ' · read cleanly'}`);
        try {
          await sendPhotoAck({ name: f.Name, email: f.Email });
          await sendOwnerAlert(`FYI: photo order auto-processed — "${orderName}"`, [
            `Order ${rec.id} (${f.Email || 'no email'}) — plan photo read and checked automatically. No action needed.`,
            extraction.summary || '',
            excluded.length ? `Unclear reads excluded from the check (report asks the customer): ${excluded.join(', ')}` : 'All fields read cleanly.',
          ]);
        } catch (e) { log(`  (notify failed: ${e.message})`); }
        // NO `continue` — fall through to the rules engine below.
      } catch (err) {
        log(`✗ ${orderName}: plan-photo read failed (${err.message}) — left at "${config.airtable.readingStatus}". Reset Status to re-try.`);
        continue;
      }
    }

    // Orders still awaiting human confirmation (or mid-read) are not checked yet.
    if (status === config.airtable.needsConfirmationStatus || status === config.airtable.readingStatus) {
      continue;
    }

    // ── Rules engine: text orders, and photo orders the homeowner has Confirmed ──
    const order = normalizeOrder(rec);
    try {
      // Payment linkage: flag suspicious orders (missing/duplicate Stripe
      // session), alert the owner — and process the order regardless.
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
      const result = evaluateOrder(rules, order);
      // Remediation pass: attach verified fix options to every FLAG row.
      // Best-effort — a remediation failure never blocks the report.
      try {
        const rem = await remediateOrder(rules, order, result);
        if (rem.flags) log(`  ↳ remediation: ${rem.options} verified fix option(s) for ${rem.flags} flag(s)${rem.model ? ` · ${rem.model}` : ' · deterministic only'}`);
      } catch (e) {
        log(`  ↳ remediation skipped (${e.message})`);
      }
      const html = buildReportHtml(order, result);

      const safeName = (order.name || order.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const file = path.join(config.reportsDir, `${safeName}-${order.id}.html`);
      fs.writeFileSync(file, html, 'utf8');

      let finalStatus = config.airtable.doneStatus;
      if (emailEnabled() && order.email) {
        await sendReportEmail({
          to: order.email,
          subject: `Your Annex ADU pre-check — ${result.summary.flag} flag(s) to address`,
          text: buildEmailText(order, result),
          html,
          attachmentName: `annex-pre-check-${safeName}.html`,
          attachmentHtml: html,
        });
        finalStatus = config.airtable.sentStatus;
        log(`  → emailed ${order.email}`);
      }

      await updateOrderStatus(order.id, finalStatus);
      log(`✓ ${order.name || order.id}: ${result.summary.pass} pass · ${result.summary.flag} flag · ${result.summary.review} review · ${result.summary.needsInput} needs-input  →  ${path.relative(config.root, file)}`);
      done++;
    } catch (err) {
      log(`✗ ${order.name || order.id}: ${err.message}`);
    }
  }
  return done;
}

async function main() {
  const watch = process.argv.includes('--watch');
  if (!watch) {
    const n = await processOnce();
    log(`Done. ${n} report(s) generated.`);
    return;
  }
  log(`Watch mode: polling every ${config.pollSeconds}s. Ctrl+C to stop.`);
  // run immediately, then on interval
  const tick = async () => { try { await processOnce(); } catch (e) { log('Error:', e.message); } };
  await tick();
  setInterval(tick, config.pollSeconds * 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
