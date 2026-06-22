// ─────────────────────────────────────────────────────────────
// Photo intake ("picture magic"). Reads an uploaded site plan, floor plan,
// or hand sketch and extracts the same dimensions the rules engine reads.
//
// Zero-dependency by design: calls the Anthropic Messages API
// (https://api.anthropic.com/v1/messages) over Node's global fetch, exactly
// like airtable.js / email.js call their APIs. The project ships no SDKs and
// has no build step, so we use raw HTTP rather than @anthropic-ai/sdk.
//
// Strict JSON is guaranteed by forcing a single strict tool call: the model
// MUST return its reading as `record_plan_dimensions(...)`, validated against
// the schema below. A vision model reads printed plans, scanned PDFs, and
// handwriting far better than OCR — and can say "I can't read this" (value:
// null, low confidence) instead of guessing.
// ─────────────────────────────────────────────────────────────
import { config } from './config.js';

const API = 'https://api.anthropic.com/v1/messages';

// Per-field shape: a value (or null when illegible), a confidence, and a note
// describing what was read and where on the plan.
const FIELD = {
  type: 'object',
  additionalProperties: false,
  properties: {
    value: { type: ['number', 'null'], description: 'Numeric value in the field\'s unit (decimal feet, or square feet for areas). null if not legible.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    note: { type: 'string', description: 'What you read and where, e.g. "rear dimension line, 4\'-0\"". Empty string if nothing read.' },
  },
  required: ['value', 'confidence', 'note'],
};

const EXTRACT_TOOL = {
  name: 'record_plan_dimensions',
  description: 'Record the ADU dimensions read off the homeowner\'s plan image. Call exactly once.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      readable: { type: 'boolean', description: 'true if the image is legible enough to extract at least one dimension' },
      documentType: { type: 'string', enum: ['site plan', 'floor plan', 'hand sketch', 'mixed', 'other', 'unreadable'] },
      aduType: { type: ['string', 'null'], description: 'Detached, Attached, Conversion, JADU, or null if not indicated on the plan' },
      city: { type: ['string', 'null'], description: 'City/jurisdiction if shown in a title block, else null' },
      nearTransit: { type: ['boolean', 'null'], description: 'true/false only if the plan explicitly indicates transit proximity, else null' },
      heightFt: FIELD,
      stories: FIELD,
      aduSqft: FIELD,
      lotSqft: FIELD,
      bedrooms: FIELD,
      rearSetbackFt: FIELD,
      sideSetbackFt: FIELD,
      distanceFt: FIELD,
      needsConfirmation: {
        type: 'array',
        items: { type: 'string' },
        description: 'Field names (e.g. "sideSetbackFt") a human must confirm: anything below high confidence, ambiguous, inferred, or not actually drawn.',
      },
      summary: { type: 'string', description: 'One short paragraph for a human: what the plan shows and which numbers you could and could not read.' },
    },
    required: [
      'readable', 'documentType', 'aduType', 'city', 'nearTransit',
      'heightFt', 'stories', 'aduSqft', 'lotSqft', 'bedrooms',
      'rearSetbackFt', 'sideSetbackFt', 'distanceFt', 'needsConfirmation', 'summary',
    ],
  },
};

const SYSTEM =
  'You read homeowner ADU plans — site plans, floor plans, or hand sketches — and extract the exact ' +
  'dimensions an ADU permit pre-check needs. Report lengths/heights in DECIMAL FEET (convert 15\'6" to ' +
  '15.5) and areas in SQUARE FEET. Read ONLY what is actually drawn, dimensioned, or labeled; never infer ' +
  'a number that is not shown. If a value is missing, illegible, or ambiguous, set its value to null (or ' +
  'your best read at low/medium confidence) and add the field name to needsConfirmation. The homeowner ' +
  'verifies every number with us before anything is checked, so flagging uncertainty is correct and ' +
  'expected — guessing is not.';

export function visionEnabled() {
  return Boolean(config.vision.apiKey);
}

// Normalize whatever the "Plan photo" column holds into a single
// { url, type, filename } object (or null if there's no photo).
//
// Airtable Attachment fields come back as an array of attachment objects, but
// Softr's file-upload form field writes the uploaded file's URL as a plain
// STRING into the column. We accept both so the photo is detected and readable
// regardless of how the column is configured.
export function normalizePhoto(value) {
  if (Array.isArray(value)) {
    const a = value[0];
    return a && a.url ? { url: a.url, type: a.type || '', filename: a.filename || '' } : null;
  }
  if (typeof value === 'string') {
    const url = value.trim();
    if (/^https?:\/\//i.test(url)) {
      const filename = url.split('?')[0].split('/').pop() || '';
      return { url, type: '', filename };
    }
  }
  return null;
}

// Build the image/document content block from an Airtable attachment object
// ({ url, type, filename, ... }). PDFs go in as a document block; images as an
// image block. Bytes are fetched and base64-encoded so we don't depend on the
// attachment URL being reachable from Anthropic's side.
async function mediaBlock(att) {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`could not download plan photo (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  const mime = (att.type || '').toLowerCase();
  const name = (att.filename || att.url || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  // Softr writes only a URL (no MIME), so fall back to the file extension.
  const byExt = name.endsWith('.png') ? 'image/png'
    : name.endsWith('.webp') ? 'image/webp'
      : name.endsWith('.gif') ? 'image/gif'
        : (name.endsWith('.jpg') || name.endsWith('.jpeg')) ? 'image/jpeg' : '';
  const media_type = supported.includes(mime) ? mime : (byExt || 'image/jpeg');
  return { type: 'image', source: { type: 'base64', media_type, data } };
}

// Read one attachment and return the validated extraction object.
export async function extractFromPhoto(attachment) {
  if (!visionEnabled()) throw new Error('ANTHROPIC_API_KEY is not set — photo reading is disabled.');
  const media = await mediaBlock(attachment);
  const body = {
    model: config.vision.model,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [{
      role: 'user',
      content: [media, { type: 'text', text: 'Extract every ADU dimension you can read from this plan. Flag anything uncertain for confirmation.' }],
    }],
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': config.vision.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic vision call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input) throw new Error('vision model returned no structured extraction');
  return toolUse.input;
}

const num = (x, k) => {
  const v = x[k] && x[k].value;
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
};

// Render the extraction as the text written to the order's "Extraction notes".
// The FIRST line is a normalized, machine-parseable sentence in exactly the
// phrasings parse.js already recognizes (so the engine reads the numbers from
// it with no schema dependency). The rest is a human-readable per-field
// breakdown with confidence + what must be confirmed.
export function buildExtractionNotes(x, model) {
  const parts = [];
  if (x.aduType) parts.push(`${x.aduType} ADU.`);
  const adu = num(x, 'aduSqft'); if (adu != null) parts.push(`ADU ${adu} sq ft.`);
  const bed = num(x, 'bedrooms'); if (bed != null) parts.push(`${bed} bedroom.`);
  const ht = num(x, 'heightFt'); if (ht != null) parts.push(`Height ${ht} ft.`);
  const st = num(x, 'stories'); if (st != null) parts.push(`${st} story.`);
  const side = num(x, 'sideSetbackFt'); if (side != null) parts.push(`Side setback ${side} ft.`);
  const rear = num(x, 'rearSetbackFt'); if (rear != null) parts.push(`Rear setback ${rear} ft.`);
  const dist = num(x, 'distanceFt'); if (dist != null) parts.push(`Distance from main house ${dist} ft.`);
  const lot = num(x, 'lotSqft'); if (lot != null) parts.push(`Lot ${lot} sq ft.`);
  if (x.city) parts.push(`City: ${x.city}.`);
  const parseable = parts.join(' ');

  const LABELS = {
    aduSqft: 'ADU size', bedrooms: 'Bedrooms', heightFt: 'Height', stories: 'Stories',
    sideSetbackFt: 'Side setback', rearSetbackFt: 'Rear setback',
    distanceFt: 'Distance from main house', lotSqft: 'Lot size',
  };
  const lines = Object.keys(LABELS).map((k) => {
    const f = x[k];
    if (!f) return null;
    const v = f.value == null ? '—' : f.value;
    return `  ${LABELS[k]}: ${v} (${f.confidence})${f.note ? ` — ${f.note}` : ''}`;
  }).filter(Boolean);

  const confirm = (x.needsConfirmation || []);
  const date = new Date().toISOString().slice(0, 10);
  return [
    parseable,
    '',
    `[Read from plan photo by Annex vision · ${model} · ${date}]`,
    x.summary || '',
    x.readable === false ? 'NOTE: image was not legible enough to read reliably — homeowner should re-upload or type the numbers.' : '',
    'Fields read (value · confidence):',
    ...lines,
    confirm.length
      ? `Confirm before running the check: ${confirm.join(', ')}`
      : 'All fields read at high confidence — review and confirm.',
  ].filter((s) => s !== '').join('\n');
}
