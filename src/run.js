// Annex backend — main runner.
//   node src/run.js          process all pending orders once
//   node src/run.js --watch  keep polling Airtable for new orders
import fs from 'node:fs';
import path from 'node:path';
import { config, assertAirtableConfigured } from './config.js';
import { fetchRules, fetchPendingOrders, updateOrderStatus } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { evaluateOrder } from './rules.js';
import { buildReportHtml, buildEmailText } from './report.js';
import { sendReportEmail, emailEnabled } from './email.js';
import { extractFromPhoto, visionEnabled, buildExtractionNotes, normalizePhoto } from './vision.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Free-text columns the parser reads — used as a fallback target if the
// "Extraction notes" column hasn't been added to Airtable yet.
const DETAIL_FIELDS = ['Concerns', 'ADU details', 'Your ADU details', 'Details', 'Message'];
const pickDetailsField = (fields) => DETAIL_FIELDS.find((k) => fields[k] != null) || 'Concerns';

async function processOnce() {
  assertAirtableConfigured();
  const rules = await fetchRules();
  log(`Loaded ${rules.length} rules from Airtable.`);
  const pending = await fetchPendingOrders();
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
        continue;
      }
      try {
        await updateOrderStatus(rec.id, config.airtable.readingStatus);
        const extraction = await extractFromPhoto(photo);
        const notes = buildExtractionNotes(extraction, config.vision.model);
        try {
          await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus, { [config.airtable.notesField]: notes });
        } catch (e) {
          // "Extraction notes" column not added yet → fall back to the free-text details box.
          if (/unknown field/i.test(e.message)) {
            const detailsField = pickDetailsField(f);
            const existing = (f[detailsField] || '').toString();
            await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus, { [detailsField]: existing ? `${existing}\n\n${notes}` : notes });
            log(`  (note: "${config.airtable.notesField}" field missing — wrote extraction into "${detailsField}")`);
          } else throw e;
        }
        const flagged = extraction.needsConfirmation || [];
        log(`✎ ${orderName}: read ${extraction.documentType} → ${config.airtable.needsConfirmationStatus}${flagged.length ? ` · confirm: ${flagged.join(', ')}` : ' · read cleanly'}`);
      } catch (err) {
        log(`✗ ${orderName}: plan-photo read failed (${err.message}) — left at "${config.airtable.readingStatus}". Reset Status to re-try.`);
      }
      continue;
    }

    // Orders still awaiting human confirmation (or mid-read) are not checked yet.
    if (status === config.airtable.needsConfirmationStatus || status === config.airtable.readingStatus) {
      continue;
    }

    // ── Rules engine: text orders, and photo orders the homeowner has Confirmed ──
    const order = normalizeOrder(rec);
    try {
      const result = evaluateOrder(rules, order);
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
