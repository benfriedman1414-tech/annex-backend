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
    `We're reading the dimensions off your drawings now. Your full report — every requirement cited to code, with verified fix options for anything flagged — will arrive at this address shortly. Nothing else is needed from you.`,
    '',
    `If any dimension isn't legible on your drawings, we never guess: your report will mark exactly which number to send us, and we'll re-run that check.`,
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

// Freemium teaser email — the free summary + unlock link, sent to customers
// who submitted the form but haven't paid (either they never opened the
// summary page, or they saw it and left). Same rule as the on-page teaser:
// counts + flag categories only, never thresholds/citations/fixes.
export async function sendTeaserEmail({ name, email, teaser, unlockUrl }) {
  if (!notifyEnabled() || !email) return { skipped: true };
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const where = [teaser.city, teaser.county && `${teaser.county} County`].filter(Boolean).join(', ') || 'your area';
  const flagLine = teaser.flag > 0
    ? `⚠ ${teaser.flag} flag${teaser.flag === 1 ? '' : 's'}: ${teaser.flagged.map((x) => x.category).join(', ')}`
    : '✓ No numeric flags on the numbers you gave us';
  const lines = [
    `Hi ${first},`,
    '',
    `Here's the summary of your Annex ADU pre-check for ${where} — we checked your numbers against ${teaser.checked} cited requirements:`,
    '',
    `  ✓ ${teaser.pass} passed`,
    `  ${flagLine}`,
    teaser.review ? `  • ${teaser.review} need a professional's judgment (we cite each one)` : '',
    teaser.needsInput ? `  • ${teaser.needsInput} need a number you didn't provide` : '',
    teaser.seriousNote ? `` : '',
    teaser.seriousNote ? `Note: ${teaser.seriousNote}` : '',
    '',
    `Your full report unlocks the exact requirement, code citation, and your number vs. the limit for every check — plus engine-verified fix options for anything flagged.`,
    '',
    `Unlock your full report ($99): ${unlockUrl}`,
    '',
    `Your answers are saved — the link above picks up right where you left off.`,
    '',
    '— Annex · annexadu.com',
  ].filter((l) => l !== '');
  const text = lines.join('\n');
  return sendReportEmail({
    to: email,
    subject: `Your ADU pre-check summary — ${teaser.checked} rules checked${teaser.flag ? `, ${teaser.flag} flag${teaser.flag === 1 ? '' : 's'}` : ''}`,
    text,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.65;color:#222">${
      lines.map((l) => l.startsWith('Unlock your full report')
        ? `<p style="margin:18px 0"><a href="${unlockUrl}" style="background:#059669;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Unlock your full report — $99</a></p>`
        : `<p style="margin:0 0 10px">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')
    }</div>`,
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
