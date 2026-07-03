// Annex freemium API — the public web service behind the /precheck page.
//   node src/server.js
//
// Two jobs:
//   GET  /api/summary?token=…   Free teaser: find the order the browser just
//                               created (by its Client token), read the plan
//                               photo if there is one, run the rules engine,
//                               return COUNTS + flag categories only.
//   POST /api/unlock            Verify a Stripe Checkout session (restricted
//                               read key), mark the order Paid, and generate +
//                               email the FULL report immediately, in-process.
//
// The poll worker (run.js --watch) stays authoritative: it sweeps Stripe for
// paid-but-closed-tab sessions, emails teasers to abandoners, and reclaims
// any order this service died on mid-generate ("Generating report" stale).
import http from 'node:http';
import { config, assertAirtableConfigured } from './config.js';
import { fetchRules, findOrderByField, updateOrderStatus, updateOrderFields } from './airtable.js';
import { normalizeOrder } from './parse.js';
import { evaluateOrder } from './rules.js';
import { buildTeaser, maskEmail } from './summary.js';
import { readPhotoIfNeeded, generateAndSendReport } from './pipeline.js';
import { getCheckoutSession, sessionPaid, stripeEnabled, isSessionIdShaped } from './stripe.js';
import { sendOwnerAlert } from './notify.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── Rules cache (rules change rarely; a 5-min cache keeps summaries fast) ──
let rulesCache = { at: 0, rules: null };
async function cachedRules() {
  if (!rulesCache.rules || Date.now() - rulesCache.at > 5 * 60 * 1000) {
    rulesCache = { at: Date.now(), rules: await fetchRules() };
  }
  return rulesCache.rules;
}

// ── Per-IP rate limit (in-memory; this is a single-instance service) ──
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60_000; }
  h.n++;
  hits.set(ip, h);
  if (hits.size > 5000) hits.clear(); // crude memory bound
  return h.n > 60;
}

// De-dupe concurrent summary work per token (page may poll while vision runs).
const inflight = new Map();

const TOKEN_RE = /^[a-z0-9][a-z0-9-]{15,63}$/i;

function corsHeaders(origin) {
  const allowed = config.api.corsOrigins.includes(origin) ? origin : config.api.corsOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

function send(res, status, body, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  res.end(JSON.stringify(body));
}

// Build the unlock URL for a specific order (token travels as
// client_reference_id so the webhook-less verify can find the order).
function unlockUrlFor(token, email) {
  const u = new URL(config.stripe.unlockLink);
  u.searchParams.set('client_reference_id', token);
  if (email) u.searchParams.set('prefilled_email', email);
  return u.toString();
}

// ── GET /api/summary ─────────────────────────────────────────
async function handleSummary(token) {
  const rec = await findOrderByField(config.freemium.tokenField, token);
  if (!rec) return { status: 404, body: { error: 'not_found' } }; // page retries — Softr write may lag
  const f = rec.fields || {};
  const status = (f.Status || '').toString().trim();
  const email = (f.Email || '').toString();

  // Already paid / delivered? Tell the page so it can show the right state.
  const done = [config.airtable.doneStatus, config.airtable.sentStatus, config.freemium.paidStatus, config.freemium.generatingStatus];
  const unlocked = done.includes(status);

  // Photo intake (once, cached in Extraction notes).
  let photoNote = null;
  try {
    const pr = await readPhotoIfNeeded(rec, log);
    if (pr.illegible) {
      try {
        await sendOwnerAlert(`Action needed: illegible plan photo on "${f.Name || rec.id}"`, [
          `Order ${rec.id} (${email || 'no email'}) uploaded a plan photo that couldn't be read reliably.`,
          'The summary asked them to type their numbers; follow up if the order stalls.',
        ]);
      } catch { /* best-effort */ }
      photoNote = 'unreadable';
    } else if (pr.read) {
      photoNote = 'read';
    } else if (pr.already) {
      photoNote = 'read';
    } else if (pr.keyless && f[config.airtable.photoField]) {
      photoNote = 'pending';
    }
  } catch (e) {
    log(`photo read failed for ${rec.id}: ${e.message}`);
    photoNote = 'pending'; // engine still runs on whatever text they typed
  }

  const rules = await cachedRules();
  const order = normalizeOrder(rec);
  const result = evaluateOrder(rules, order);
  const teaser = buildTeaser(order, result);

  // Move fresh orders to "Summary ready" (never clobber paid/held states).
  const movable = ['', config.freemium.newStatus, config.airtable.readingStatus, config.freemium.summaryReadyStatus];
  if (!unlocked && status !== config.airtable.needsConfirmationStatus && movable.includes(status)) {
    try { await updateOrderStatus(rec.id, config.freemium.summaryReadyStatus); }
    catch (e) { log(`status write failed for ${rec.id}: ${e.message}`); }
  }

  return {
    status: 200,
    body: {
      teaser,
      photo: photoNote,
      unlocked,
      email: maskEmail(email),
      unlockUrl: unlockUrlFor(token, email),
    },
  };
}

// ── POST /api/unlock ─────────────────────────────────────────
async function handleUnlock(sessionId, bodyToken) {
  if (!stripeEnabled()) return { status: 503, body: { error: 'verification_unavailable' } };
  if (!isSessionIdShaped(sessionId)) return { status: 400, body: { error: 'bad_session' } };

  let session;
  try { session = await getCheckoutSession(sessionId); }
  catch (e) { return { status: e.status === 404 ? 404 : 502, body: { error: 'session_lookup_failed' } }; }
  if (!sessionPaid(session)) return { status: 402, body: { error: 'not_paid' } };

  // Find the order: prefer the token Stripe carried, else the browser's token.
  const token = (session.client_reference_id || bodyToken || '').toString().trim();
  if (!TOKEN_RE.test(token)) return { status: 400, body: { error: 'no_order_reference' } };
  const rec = await findOrderByField(config.freemium.tokenField, token);
  if (!rec) return { status: 404, body: { error: 'order_not_found' } };

  // Anti-replay: one checkout session unlocks exactly one order.
  const prior = await findOrderByField(config.freemium.sessionField, sessionId);
  if (prior && prior.id !== rec.id) return { status: 409, body: { error: 'session_already_used' } };

  const f = rec.fields || {};
  const status = (f.Status || '').toString().trim();
  const already = [config.airtable.doneStatus, config.airtable.sentStatus].includes(status);
  const emailMasked = maskEmail(f.Email);
  if (already) return { status: 200, body: { ok: true, alreadyDelivered: true, email: emailMasked } };

  // Claim it, then generate + email the full report right now (async — the
  // page doesn't wait; the worker reclaims if this process dies mid-way).
  await updateOrderStatus(rec.id, config.freemium.generatingStatus, { [config.freemium.sessionField]: sessionId });
  (async () => {
    try {
      const rules = await cachedRules();
      // Held photo orders (illegible) can't produce a full report yet — mark
      // Paid and let the human flow resume; everything else generates now.
      if (status === config.airtable.needsConfirmationStatus) {
        await updateOrderStatus(rec.id, config.freemium.paidStatus, { [config.freemium.sessionField]: sessionId });
        await sendOwnerAlert(`Paid order is waiting on a number — "${f.Name || rec.id}"`, [
          `Order ${rec.id} paid (${sessionId}) but its plan photo was illegible.`,
          'Get the missing numbers from the customer, then set Status to "Confirmed".',
        ]);
        return;
      }
      const out = await generateAndSendReport(rec, rules, log);
      log(`✓ unlocked ${rec.id}: ${out.result.summary.flag} flag(s) → ${out.finalStatus}`);
    } catch (e) {
      log(`✗ unlock processing failed for ${rec.id}: ${e.message}`);
      // Put it back where the worker will retry it.
      try { await updateOrderStatus(rec.id, config.freemium.paidStatus); } catch { /* worker sweep will still find it */ }
    }
  })();

  return { status: 200, body: { ok: true, email: emailMasked } };
}

// ── HTTP plumbing ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true }, origin);
  if (rateLimited(ip)) return send(res, 429, { error: 'rate_limited' }, origin);

  try {
    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const token = (url.searchParams.get('token') || '').trim();
      if (!TOKEN_RE.test(token)) return send(res, 400, { error: 'bad_token' }, origin);
      // Coalesce concurrent polls for the same token.
      if (!inflight.has(token)) {
        inflight.set(token, handleSummary(token).finally(() => inflight.delete(token)));
      }
      const out = await inflight.get(token);
      return send(res, out.status, out.body, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/unlock') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { return send(res, 413, { error: 'too_large' }, origin); } }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad_json' }, origin); }
      const out = await handleUnlock((body.session_id || '').toString(), (body.token || '').toString());
      return send(res, out.status, out.body, origin);
    }
    return send(res, 404, { error: 'not_found' }, origin);
  } catch (e) {
    log(`500 ${url.pathname}: ${e.message}`);
    return send(res, 500, { error: 'internal' }, origin);
  }
});

assertAirtableConfigured();
server.listen(config.api.port, () => log(`Annex API listening on :${config.api.port}`));
