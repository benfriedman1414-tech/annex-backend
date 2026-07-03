// The full paid pipeline for one order: engine → remediation → HTML report →
// email → status writeback. Extracted from run.js so BOTH entry points share
// it: the worker (poll loop) and the API service (immediately after a
// verified unlock). Callers decide WHEN an order deserves this; this module
// only does the work.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { updateOrderStatus } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { evaluateOrder } from './rules.js';
import { buildReportHtml, buildEmailText } from './report.js';
import { sendReportEmail, emailEnabled } from './email.js';
import { remediateOrder } from './remediate.js';
import { updateOrderFields } from './airtable.js';
import { extractFromPhoto, visionEnabled, buildExtractionNotes, normalizePhoto } from './vision.js';

// Free-text columns the parser reads — fallback target if the
// "Extraction notes" column hasn't been added to Airtable.
const DETAIL_FIELDS = ['Concerns', 'ADU details', 'Your ADU details', 'Details', 'Message'];
const pickDetailsField = (fields) => DETAIL_FIELDS.find((k) => fields[k] != null) || 'Concerns';

// Read the order's plan photo into "Extraction notes" (once). Mutates
// rec.fields in memory so the caller's engine run sees the extraction.
// Returns { read, already, keyless, illegible, extraction }.
// Shared by the worker AND the API's on-demand summary path; callers own
// notifications and any status transitions beyond Reading/illegible-hold.
export async function readPhotoIfNeeded(rec, log = () => {}) {
  const f = rec.fields || {};
  const photo = normalizePhoto(f[config.airtable.photoField]);
  if (!photo) return { read: false };
  const notesFieldCfg = config.airtable.notesField;
  const existingNotes = (f[notesFieldCfg] || '').toString();
  if (/\[Read from plan photo/i.test(existingNotes)) return { read: false, already: true };
  if (!visionEnabled()) return { read: false, keyless: true };

  await updateOrderStatus(rec.id, config.airtable.readingStatus);
  const extraction = await extractFromPhoto(photo);
  const notes = buildExtractionNotes(extraction, config.vision.model);
  // Persist the extraction (tolerate a missing column).
  let notesField = notesFieldCfg;
  try {
    await updateOrderFields(rec.id, { [notesField]: notes });
  } catch (e) {
    if (/unknown field/i.test(e.message)) {
      notesField = pickDetailsField(f);
      const existing = (f[notesField] || '').toString();
      await updateOrderFields(rec.id, { [notesField]: existing ? `${existing}\n\n${notes}` : notes });
      log(`  (note: "${notesFieldCfg}" field missing — wrote extraction into "${notesField}")`);
    } else throw e;
  }
  if (extraction.readable === false) {
    await updateOrderStatus(rec.id, config.airtable.needsConfirmationStatus);
    return { read: false, illegible: true, extraction };
  }
  // Feed the extraction to the engine in THIS pass.
  f[notesField] = f[notesField] ? `${f[notesField]}\n\n${notes}` : notes;
  return { read: true, extraction };
}

export async function generateAndSendReport(rec, rules, log = () => {}) {
  const order = normalizeOrder(rec);
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
  fs.mkdirSync(config.reportsDir, { recursive: true });
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
  return { order, result, file, finalStatus };
}
