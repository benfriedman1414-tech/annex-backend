// Zero-dependency Stripe client for payment VERIFICATION only.
//
// Uses a RESTRICTED API key (Checkout Sessions: read) — never the account
// secret key, never committed; it lives only in the host's env vars. This
// backend never creates charges: customers pay through Stripe Payment Links,
// and we verify the resulting Checkout Session before unlocking a report.
import { config } from './config.js';

const API = 'https://api.stripe.com/v1';

export function stripeEnabled() {
  return Boolean(config.stripe.apiKey);
}

// Checkout session ids are cs_live_/cs_test_ + base62. Reject anything else
// before it reaches the Stripe API.
export function isSessionIdShaped(id) {
  return /^cs_(live|test)_[A-Za-z0-9]{10,}$/.test(String(id || ''));
}

async function stripeGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${config.stripe.apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Stripe: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function getCheckoutSession(id) {
  if (!isSessionIdShaped(id)) throw new Error('Stripe: malformed session id');
  return stripeGet(`/checkout/sessions/${encodeURIComponent(id)}`);
}

// Has this session actually been paid? `no_payment_required` covers 100%-off
// promotion codes and $0 trials — Stripe marks those complete without a charge.
export function sessionPaid(session) {
  return Boolean(
    session &&
    session.status === 'complete' &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
  );
}

// Recent completed sessions — the worker sweeps these so a customer who paid
// but closed the tab before the redirect still gets unlocked automatically.
export async function listRecentSessions(limit = 100) {
  const data = await stripeGet(`/checkout/sessions?limit=${Math.min(100, limit)}&status=complete`);
  return data.data || [];
}
