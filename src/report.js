// Generate a self-contained HTML report mirroring the live site's
// dark/emerald "pre-check report" design. Opens/prints to PDF cleanly.
import { STATUS } from './rules.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BADGE = {
  [STATUS.PASS]: 'pass',
  [STATUS.FLAG]: 'flag',
  [STATUS.REVIEW]: 'review',
  [STATUS.NEEDS_INPUT]: 'input',
};

export function buildReportHtml(order, result, opts = {}) {
  const date = opts.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const { rows, summary } = result;
  const typeLabel = (order.aduType || 'ADU').toUpperCase();

  // Jurisdiction label — California state law always applies; the county adds local standards.
  const county = order.county || '';
  const jLabel = order.city && county ? `${order.city}, ${county} County`
    : county ? `${county} County`
      : order.city ? order.city
        : 'California — local jurisdiction to confirm';

  const verdictBits = [];
  if (summary.pass) verdictBits.push(`${summary.pass} PASS`);
  if (summary.flag) verdictBits.push(`${summary.flag} FLAG${summary.flag > 1 ? 'S' : ''}`);
  if (summary.review) verdictBits.push(`${summary.review} REVIEW`);
  if (summary.needsInput) verdictBits.push(`${summary.needsInput} NEEDS INPUT`);
  const verdict = verdictBits.join(' · ');

  const rowHtml = rows.map((r) => `
      <tr>
        <td class="req">${esc(r.requirement)}</td>
        <td class="cite mono">${esc(r.citation)}</td>
        <td class="val mono">${esc(r.yourValue)}</td>
        <td class="thr mono">${esc(r.threshold)}</td>
        <td class="badge-cell"><span class="badge ${BADGE[r.status]}">${esc(r.status)}</span></td>
      </tr>`).join('');

  const flags = rows.filter((r) => r.status === STATUS.FLAG);
  const flagsHtml = flags.length ? `
    <div class="notes">
      <h3>What to fix</h3>
      ${flags.map((r, i) => `
        <div class="note">
          <span class="note-tag mono">FLAG №${i + 1}</span>
          <p><strong>${esc(r.requirement)}</strong> — your ${esc(r.yourValue)} vs required ${esc(r.threshold)}.
          ${r.fix ? esc(r.fix) : 'Adjust to meet the cited requirement before submitting.'}
          <span class="mono cite">${esc(r.citation)}</span></p>
        </div>`).join('')}
    </div>` : '';

  const reviews = rows.filter((r) => r.status === STATUS.REVIEW || r.status === STATUS.NEEDS_INPUT);
  const reviewHtml = reviews.length ? `
    <div class="notes review-notes">
      <h3>Items to confirm</h3>
      ${reviews.map((r) => `
        <div class="note">
          <span class="note-tag mono ${r.status === STATUS.NEEDS_INPUT ? 'tag-input' : 'tag-review'}">${esc(r.status)}</span>
          <p><strong>${esc(r.requirement)}</strong> — ${esc(r.ruleText || r.thresholdRaw || 'Confirm against your local jurisdiction.')}
          ${r.status === STATUS.NEEDS_INPUT ? ' <em>(send us this number and we’ll check it.)</em>' : ''}
          <span class="mono cite">${esc(r.citation)}</span></p>
        </div>`).join('')}
    </div>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Annex Pre-Check Report — ${esc(order.name || 'ADU')}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Sora:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
:root{--void:#0A1411;--surface:#101D18;--card:#13231D;--emerald:#1BE89F;--emerald-soft:#8CFAD2;--emerald-glow:rgba(27,232,159,.22);--mist:#F4FCF8;--muted:#A6BFB3;--line:rgba(27,232,159,.24);--flag:#FFC83D;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:radial-gradient(1200px 600px at 50% -120px,#12241D,var(--void) 60%);color:var(--mist);font-family:'Sora',sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;padding:40px 20px;min-height:100vh}
.mono{font-family:'JetBrains Mono',monospace}
.wrap{max-width:860px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.5),0 0 70px rgba(27,232,159,.06)}
.head{padding:30px 34px 24px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:10px;font-family:'JetBrains Mono',monospace;font-size:14px;letter-spacing:.06em;color:#fff;margin-bottom:18px}
.brand svg{display:block;filter:drop-shadow(0 0 8px var(--emerald-glow))}
h1{font-family:'Instrument Serif',serif;font-weight:400;font-size:34px;line-height:1.1;color:#fff;margin-bottom:6px}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--emerald);text-shadow:0 0 16px var(--emerald-glow)}
.meta{display:flex;flex-wrap:wrap;gap:8px 26px;margin-top:16px;font-size:13px;color:var(--muted)}
.meta b{color:var(--mist);font-weight:500}
.verdict-bar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding:16px 34px;background:rgba(27,232,159,.05);border-bottom:1px solid var(--line)}
.verdict-bar .label{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.08em;color:var(--muted)}
.verdict{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--emerald);text-shadow:0 0 14px var(--emerald-glow)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:14px 18px;font-size:13.5px;vertical-align:top}
th{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)}
td{border-bottom:1px solid rgba(255,255,255,.06)}
td.req{color:#fff;font-weight:500}
td.cite,td.thr{color:var(--muted);font-size:12px}
td.val{color:var(--mist)}
.badge{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;padding:5px 9px;border-radius:4px;font-weight:500;white-space:nowrap}
.badge.pass{background:rgba(27,232,159,.16);color:var(--emerald);border:1px solid rgba(27,232,159,.4)}
.badge.flag{background:rgba(255,200,61,.14);color:var(--flag);border:1px solid rgba(255,200,61,.4)}
.badge.review{background:rgba(166,191,179,.12);color:var(--muted);border:1px solid rgba(166,191,179,.3)}
.badge.input{background:rgba(70,210,255,.12);color:#7fdcff;border:1px solid rgba(70,210,255,.3)}
.notes{padding:22px 34px;border-top:1px solid var(--line);background:var(--surface)}
.notes h3{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.note{padding:12px 0;border-top:1px solid rgba(255,255,255,.06)}
.note:first-of-type{border-top:none}
.note p{color:var(--muted);font-size:14px}
.note strong{color:#fff;font-weight:500}
.note .cite{display:block;margin-top:5px;color:var(--flag);font-size:11.5px}
.review-notes .note .cite{color:var(--muted)}
.note-tag{display:inline-block;font-size:10px;letter-spacing:.08em;padding:3px 8px;border-radius:3px;margin-bottom:6px;background:rgba(255,200,61,.14);color:var(--flag);border:1px solid rgba(255,200,61,.35)}
.note-tag.tag-review{background:rgba(166,191,179,.12);color:var(--muted);border-color:rgba(166,191,179,.3)}
.note-tag.tag-input{background:rgba(70,210,255,.12);color:#7fdcff;border-color:rgba(70,210,255,.3)}
.foot{padding:22px 34px 26px;border-top:1px solid var(--line)}
.foot p{font-size:11.5px;line-height:1.6;color:#7A8F85}
.sig{margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted)}
@media print{body{background:#0A1411;padding:0}.card{box-shadow:none;border:none;border-radius:0}}
</style></head>
<body><div class="wrap"><div class="card">
  <div class="head">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 22 22" fill="none"><circle cx="4" cy="17" r="2" fill="#1BE89F"/><circle cx="11" cy="6" r="2" fill="#1BE89F"/><circle cx="18" cy="13" r="2" fill="#1BE89F"/><path d="M4 17L11 6L18 13" stroke="#1BE89F" stroke-width="1" opacity=".6"/></svg>
      ANNEX
    </div>
    <span class="eyebrow">ADU Plan Pre-Check Report</span>
    <h1>${esc(order.name || 'Your ADU pre-check')}</h1>
    <div class="meta">
      <span>Type: <b>${esc(order.aduType || '—')}</b></span>
      <span>Jurisdiction: <b>${esc(jLabel)}</b></span>
      <span>Date: <b>${esc(date)}</b></span>
      <span>Requirements checked: <b>${summary.total}</b></span>
    </div>
  </div>
  <div class="verdict-bar">
    <span class="label mono">PRE-CHECK RESULT · ${esc(typeLabel)} ADU</span>
    <span class="verdict">${esc(verdict || 'No requirements evaluated')}</span>
  </div>
  <table>
    <thead><tr><th>Requirement</th><th>Cited to</th><th>Your value</th><th>Required</th><th>Result</th></tr></thead>
    <tbody>${rowHtml}</tbody>
  </table>
  ${flagsHtml}
  ${reviewHtml}
  <div class="foot">
    <p>Annex provides an informational pre-check against published California state ADU law and applicable local (county/city) requirements, current as of the report date. It is not a building department, does not issue approvals or permits, and is not legal, architectural, or engineering advice. The determinations of your local jurisdiction govern.</p>
    <p class="sig">ANNEX ✦ Northern California · hello@annexadu.com</p>
  </div>
</div></div></body></html>`;
}

// Plain-text summary used for the email body.
export function buildEmailText(order, result) {
  const { summary } = result;
  return [
    `Hi ${order.name || 'there'},`,
    ``,
    `Your Annex ADU pre-check is ready.`,
    ``,
    `Result: ${summary.pass} pass, ${summary.flag} flag(s), ${summary.review} to review${summary.needsInput ? `, ${summary.needsInput} needing a number from you` : ''}.`,
    ``,
    `Your full report (every requirement, cited to code, with what to change) is attached / below.`,
    ``,
    `— Annex`,
  ].join('\n');
}
