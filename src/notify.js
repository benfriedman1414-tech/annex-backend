// ─────────────────────────────────────────────────────────────
// Flow notifications (Resend, best-effort — a notification failure must
// never block order processing; callers wrap these in try/catch).
//
// Two gaps these close:
//   1. Photo orders used to go SILENT between upload and the report (the
//      human-confirmation hold can take hours) — the customer now gets an
//      immediate acknowledgment.
//   2. The owner had to notice "Needs confirmation" rows in Airtable on
//      their own — they now get an action-needed email, plus alerts when
//      an order's payment linkage looks wrong.
// ─────────────────────────────────────────────────────────────
import { config } from './config.js';
import { sendReportEmail, emailEnabled } from './email.js';

export function notifyEnabled() {
  return emailEnabled();
}

// Immediate acknowledgment to a customer whose plan photo was received.
export async function sendPhotoAck({ name, email }) {
  if (!notifyEnabled() || !email) return { skipped: true };
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const text = [
    `Hi ${first},`,
    '',
    `We've received your plans — your Annex ADU pre-check is underway.`,
    '',
    `We're reading the dimensions off your drawings now. Your full report — every requirement cited to code, with verified fix options for anything flagged — will arrive at this address within 24 hours. Nothing else is needed from you.`,
    '',
    `If we can't read a dimension clearly, we'll reply here to confirm it with you first (better a question than a wrong number).`,
    '',
    '— Annex · annexadu.com',
  ].join('\n');
  return sendReportEmail({
    to: email,
    subject: 'We’ve got your plans — your Annex pre-check is underway',
    text,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222">${text.split('\n').map((l) => l ? `<p style="margin:0 0 12px">${l}</p>` : '').join('')}</div>`,
  });
}

// Action-needed / anomaly alerts to the owner inbox.
export async function sendOwnerAlert(subject, lines) {
  if (!notifyEnabled()) return { skipped: true };
  const text = [...lines, '', '— Annex backend'].join('\n');
  return sendReportEmail({
    to: config.notify.owner,
    subject: `[Annex] ${subject}`,
    text,
    html: `<div style="font-family:monospace;font-size:13.5px;line-height:1.7;color:#222">${text.split('\n').map((l) => l ? `<p style="margin:0 0 8px">${l}</p>` : '').join('')}</div>`,
  });
}
