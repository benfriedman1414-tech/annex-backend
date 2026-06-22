// Normalize an Airtable Orders record into the shape the rules engine wants.
// Prefers structured fields; falls back to parsing the free-text "Concerns"
// box (which is what the live /start form collects for the beta).

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// "15'6\"" / "15 ft 6 in" / "15.5" -> 15.5 (decimal feet)
function feet(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const fi = s.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)?\s*(?:"|in|inch)?/i);
  if (fi && fi[2] != null) return Number(fi[1]) + Number(fi[2]) / 12;
  return num(v);
}

// Pull a measurement out of free text, e.g. "rear setback 4 ft", "812 sq ft adu".
function grab(text, patterns) {
  const t = (text || '').toLowerCase();
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const raw = m[1];
      const fi = raw.match(/(\d+(?:\.\d+)?)\s*'?\s*(\d+(?:\.\d+)?)?/);
      if (fi && fi[2] != null && /'/.test(raw)) return Number(fi[1]) + Number(fi[2]) / 12;
      return Number(raw.replace(/[^0-9.]/g, ''));
    }
  }
  return null;
}

export function normalizeOrder(record) {
  const f = record.fields || {};
  // Concatenate every free-text source (so a photo order's "Extraction notes"
  // and any typed "Concerns" are both searched, not just the first present).
  const free = [f['Concerns'], f['ADU details'], f['Your ADU details'], f['Details'], f['Message'], f['Extraction notes']]
    .filter(Boolean).join('\n');

  const aduTypeRaw = (f['ADU type'] || '').toString();
  let aduType = aduTypeRaw;
  if (!aduType && /detached/i.test(free)) aduType = 'Detached';
  else if (!aduType && /attached/i.test(free)) aduType = 'Attached';
  else if (!aduType && /conversion/i.test(free)) aduType = 'Conversion';
  else if (!aduType && /jadu/i.test(free)) aduType = 'JADU';

  const nearTransitRaw = (f['Near transit'] || '').toString();
  let nearTransit = null;
  if (/yes|true|within|near|<.*mi|half mile|1\/2 mi/i.test(nearTransitRaw)) nearTransit = true;
  else if (/no|false|not/i.test(nearTransitRaw)) nearTransit = false;
  else if (/near transit|by transit|half mile|1\/2 mile|bus stop|bart|rail/i.test(free)) nearTransit = true;

  return {
    id: record.id,
    name: f['Name'] || '',
    email: f['Email'] || '',
    city: f['City'] || grab(free, [/in ([a-z ]+?)(?:,|\.|$)/]) || '',
    address: f['Address'] || '',
    aduType: aduType || 'Detached',
    status: f['Status'] || '',
    concerns: free,

    lotSqft: num(f['Lot size sqft']) ?? grab(free, [/lot[^0-9]{0,12}(\d[\d,\.]*)\s*(?:sq ?ft|sf)/, /(\d[\d,\.]*)\s*(?:sq ?ft|sf)\s*lot/]),
    aduSqft: num(f['ADU sqft']) ?? grab(free, [/adu[^0-9]{0,14}(\d[\d,\.]*)\s*(?:sq ?ft|sf)/, /(\d[\d,\.]*)\s*(?:sq ?ft|sf)\s*adu/, /unit[^0-9]{0,12}(\d[\d,\.]*)\s*(?:sq ?ft|sf)/]),
    bedrooms: num(f['Bedrooms']) ?? grab(free, [/(\d+)\s*(?:bed|br\b|bedroom)/, /(studio)/]),
    heightFt: feet(f['Height ft']) ?? grab(free, [/height[^0-9]{0,12}(\d+(?:\.\d+)?\s*'?\s*\d*"?)/, /(\d+(?:\.\d+)?\s*'?\s*\d*"?)\s*(?:tall|high|height)/]),
    stories: num(f['Stories']) ?? grab(free, [/(\d+)\s*(?:stor|level)/]),
    rearSetbackFt: feet(f['Rear setback ft']) ?? grab(free, [/rear[^0-9]{0,14}(\d+(?:\.\d+)?\s*'?\s*\d*"?)/]),
    sideSetbackFt: feet(f['Side setback ft']) ?? grab(free, [/side[^0-9]{0,14}(\d+(?:\.\d+)?\s*'?\s*\d*"?)/]),
    distanceFt: feet(f['Distance from main house ft']) ?? grab(free, [/(?:distance|separation|from (?:the )?(?:main|primary))[^0-9]{0,16}(\d+(?:\.\d+)?\s*'?\s*\d*"?)/]),
    nearTransit,
  };
}
