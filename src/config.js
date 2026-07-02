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
    // Photo-intake lifecycle (Part 2): New → Reading photo → Needs confirmation → Confirmed → Report ready/sent
    readingStatus: env('ORDERS_READING_STATUS', 'Reading photo'),
    needsConfirmationStatus: env('ORDERS_NEEDS_CONFIRMATION_STATUS', 'Needs confirmation'),
    confirmedStatus: env('ORDERS_CONFIRMED_STATUS', 'Confirmed'),
    photoField: env('ORDERS_PHOTO_FIELD', 'Plan photo'),
    notesField: env('ORDERS_NOTES_FIELD', 'Extraction notes'),
  },
  email: {
    resendKey: env('RESEND_API_KEY'),
    from: env('FROM_EMAIL', 'Annex <hello@example.com>'),
    replyTo: env('REPLY_TO_EMAIL'),
  },
  // Photo intake ("picture magic") — vision extraction via the Anthropic API.
  // Leave ANTHROPIC_API_KEY blank to disable photo reading (text orders still work).
  vision: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('VISION_MODEL', 'claude-opus-4-8'),
  },
  // Remediation pass — model-proposed, engine-verified fix options for every FLAG.
  // Shares ANTHROPIC_API_KEY; without it, flags still get the deterministic
  // verified baseline fix (meet-the-threshold), just not the richer options.
  remediation: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('REMEDIATION_MODEL', 'claude-fable-5'),
    fallbackModel: env('REMEDIATION_FALLBACK_MODEL', 'claude-opus-4-8'),
  },
  // Flow notifications (photo acks + owner action/anomaly alerts).
  notify: {
    owner: env('OWNER_EMAIL', 'hello@annexadu.com'),
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
