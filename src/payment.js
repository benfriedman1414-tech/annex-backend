// ─────────────────────────────────────────────────────────────
// Payment linkage check (fail-safe by design: it can FLAG an order,
// it can never block one — a legit payer must never be denied a report
// because a URL parameter got lost).
//
// How the linkage works: the Stripe Payment Links redirect to the intake
// form with ?session_id={CHECKOUT_SESSION_ID}; the form carries that into
// the order's "Stripe session" column. Each real payment produces exactly
// one unguessable cs_… id, so:
//   • an order REUSING a session id someone already submitted  → flagged
//   • an order with NO session id (link shared around the paywall) → flagged
//     — but only once the funnel is "armed" (some order has ever carried a
//     session id). Before that, the column/form may simply not exist yet,
//     so flagging everything would be pure noise.
// Flags are written to the order's "Payment flag" column and alerted to the
// owner; processing continues normally either way.
//
// (Honest limit: without a Stripe API key we verify presence + uniqueness,
// not authenticity. Webhook reconciliation is the volume-era upgrade.)
// ─────────────────────────────────────────────────────────────

// Map every session id seen across ALL orders → the record ids carrying it.
export function buildSessionIndex(records) {
  const index = new Map();
  for (const rec of records) {
    const f = rec.fields || {};
    const s = (f['Stripe session'] ?? f['Stripe session id'] ?? f['session_id'] ?? '').toString().trim();
    if (!s) continue;
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(rec.id);
  }
  return index;
}

// '' when the order looks fine; otherwise a short reason for the flag.
export function paymentFlag({ session, orderId, index }) {
  const s = (session || '').toString().trim();
  if (s) {
    const holders = (index.get(s) || []).filter((id) => id !== orderId);
    if (holders.length) return `DUPLICATE Stripe session (also on ${holders.join(', ')}) — possible link reuse`;
    return '';
  }
  const armed = index.size > 0; // some order has carried a session → capture works
  if (armed) return 'NO Stripe session — payment unverified (form reached without paying?)';
  return '';
}
