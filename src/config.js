// Minimal zero-dependency .env loader + config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load .env (if present) into process.env without overwriting real env vars.
function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const config = {
  root,
  airtable: {
    apiKey: env('AIRTABLE_API_KEY'),
    baseId: env('AIRTABLE_BASE_ID', 'appaa8u2MVRT4obQP'),
    rulesTable: env('AIRTABLE_RULES_TABLE', 'Rules'),
    ordersTable: env('AIRTABLE_ORDERS_TABLE', 'Orders'),
    newStatus: env('ORDERS_NEW_STATUS', ''),
    doneStatus: env('ORDERS_DONE_STATUS', 'Report ready'),
    sentStatus: env('ORDERS_SENT_STATUS', 'Report sent'),
  },
  email: {
    resendKey: env('RESEND_API_KEY'),
    from: env('FROM_EMAIL', 'Annex <hello@example.com>'),
    replyTo: env('REPLY_TO_EMAIL'),
  },
  reportsDir: path.resolve(root, env('REPORTS_DIR', './reports')),
  pollSeconds: Number(env('POLL_SECONDS', '120')) || 120,
};

export function assertAirtableConfigured() {
  if (!config.airtable.apiKey) {
    throw new Error(
      'AIRTABLE_API_KEY is not set. Copy .env.example to .env and add your Airtable token ' +
      '(https://airtable.com/create/tokens — scopes: data.records:read, data.records:write, add the Annex base).'
    );
  }
}
