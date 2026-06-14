// Optional email delivery via Resend (https://resend.com). Zero-dependency.
// If RESEND_API_KEY is not set, sending is skipped gracefully.
import { config } from './config.js';

export function emailEnabled() {
  return Boolean(config.email.resendKey);
}

export async function sendReportEmail({ to, subject, text, html, attachmentName, attachmentHtml }) {
  if (!emailEnabled()) return { skipped: true };
  const body = {
    from: config.email.from,
    to: [to],
    subject,
    text,
    html,
  };
  if (config.email.replyTo) body.reply_to = config.email.replyTo;
  if (attachmentHtml) {
    body.attachments = [{
      filename: attachmentName || 'annex-report.html',
      content: Buffer.from(attachmentHtml, 'utf8').toString('base64'),
    }];
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
