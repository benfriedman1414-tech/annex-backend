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

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
