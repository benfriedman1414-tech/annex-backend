// Zero-dependency Airtable REST client (Node 18+ global fetch).
import { config } from './config.js';

const API = 'https://api.airtable.com/v0';

function headers() {
  return { Authorization: `Bearer ${config.airtable.apiKey}`, 'Content-Type': 'application/json' };
}

const pick = (fields, keys) => {
  for (const k of keys) if (fields[k] != null && fields[k] !== '') return fields[k];
  return undefined;
};
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

async function listAll(table) {
  const url = new URL(`${API}/${config.airtable.baseId}/${encodeURIComponent(table)}`);
  url.searchParams.set('pageSize', '100');
  let records = [];
  let offset;
  do {
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Airtable ${table} read failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

// Return normalized rule objects from the Rules table.
export async function fetchRules() {
  const records = await listAll(config.airtable.rulesTable);
  return records.map((rec) => {
    const f = rec.fields || {};
    return {
      id: rec.id,
      requirement: pick(f, ['Requirement', 'Name', 'Rule name']) || '',
      appliesTo: asArray(pick(f, ['Applies to', 'Applies To', 'Type'])),
      rule: pick(f, ['Rule', 'Description', 'Summary']) || '',
      threshold: pick(f, ['Threshold', 'Limit', 'Value', 'Standard']) || '',
      citation: pick(f, ['Code citation', 'Citation', 'Code', 'Source']) || '',
      fix: pick(f, ['Common fix', 'Fix', 'How to fix', 'Remedy']) || '',
      // City-rules pipeline: explicit jurisdiction ("State" / "X County" /
      // "City of Y"), verification state (Pending/Verified/Superseded/Marker;
      // blank = grandfathered-verified), and the research date stamp.
      jurisdiction: pick(f, ['Jurisdiction']) || '',
      verification: pick(f, ['Verification']) || '',
      lastChecked: pick(f, ['Last checked']) || '',
      sourceUrl: pick(f, ['Source URL']) || '',
    };
  }).filter((r) => r.requirement);
}

// Create rule rows (the city-research drafter). Airtable caps 10 per request.
// Returns the created records (id + fields) so the auto-verifier can act on them.
export async function createRules(rows) {
  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.rulesTable)}`;
  const created = [];
  for (let i = 0; i < rows.length; i += 10) {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ typecast: true, records: rows.slice(i, i + 10).map((fields) => ({ fields })) }),
    });
    if (!res.ok) throw new Error(`Airtable rules create failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    created.push(...(data.records || []));
  }
  return created;
}

// Patch fields on a Rules row (e.g. the coverage marker's "Last checked").
export async function updateRuleFields(recordId, fields) {
  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.rulesTable)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ typecast: true, fields }),
  });
  if (!res.ok) throw new Error(`Airtable rule update failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Every order record (used for the payment-session index) — one fetch that
// fetchPendingOrders/filterPending derive from, so a poll costs one listing.
export async function fetchAllOrders() {
  return listAll(config.airtable.ordersTable);
}

// Which of these records still need processing.
export function filterPending(records) {
  const { newStatus, doneStatus, sentStatus } = config.airtable;
  return records.filter((rec) => {
    const status = (rec.fields?.Status || '').toString().trim();
    if (status === doneStatus || status === sentStatus) return false; // already done
    if (newStatus) return status === newStatus; // explicit "new" gate
    return true; // otherwise: anything not already done is fair game
  });
}

// Return raw order records that still need processing.
export async function fetchPendingOrders() {
  return filterPending(await fetchAllOrders());
}

// Find a single order by an exact field value (used for the freemium
// "Client token" and the Stripe-session anti-replay check).
export async function findOrderByField(fieldName, value) {
  const url = new URL(`${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.ordersTable)}`);
  // Escape double quotes for filterByFormula's string literal.
  const safe = String(value).replace(/"/g, '\\"');
  url.searchParams.set('filterByFormula', `{${fieldName}}="${safe}"`);
  url.searchParams.set('maxRecords', '2');
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Airtable lookup failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.records || [])[0] || null;
}

export async function updateOrderStatus(recordId, status, extraFields = {}) {
  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.ordersTable)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers(),
    // typecast: true lets Airtable auto-create new single-select options (the
    // photo-intake statuses) and coerce values to the column type on write.
    body: JSON.stringify({ typecast: true, fields: { Status: status, ...extraFields } }),
  });
  if (!res.ok) throw new Error(`Airtable status update failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Patch arbitrary fields WITHOUT touching Status (e.g. the "Payment flag").
export async function updateOrderFields(recordId, fields) {
  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.ordersTable)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ typecast: true, fields }),
  });
  if (!res.ok) throw new Error(`Airtable field update failed: ${res.status} ${await res.text()}`);
  return res.json();
}
