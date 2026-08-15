// Shared header-map encoding for the source-adapter seam.
//
// Every adapter hands the core `headers` as a plain-object map, but RFC 5322
// header names legitimately repeat (Received, and often more than one
// Authentication-Results). A plain object cannot hold two values under one key,
// so this module fixes one encoding for every adapter: repeated instances of a
// name are joined with "\n", first-seen casing wins, and lookup is
// case-insensitive.
//
// The join is not cosmetic. lib/dmarc.mjs has to see every Authentication-Results
// instance separately to find the one the receiving boundary stamped, so an
// adapter that overwrites on a repeat destroys the only field that carries any
// weight. Reading is the inverse: `headerFields` splits on "\n" and re-joins
// continuation lines, so a folded field comes back as one field and two
// instances come back as two.

// headersToObject turns a provider's [{name,value}] header collection into the
// plain-object map the core reads.
export function headersToObject(headers) {
  const map = {};
  if (!Array.isArray(headers)) return map;
  const byLowerName = new Map();
  for (const h of headers) {
    if (!h || typeof h.name !== 'string') continue;
    const value = String(h.value ?? '');
    const lower = h.name.toLowerCase();
    const existing = byLowerName.get(lower);
    if (existing === undefined) {
      byLowerName.set(lower, h.name);
      map[h.name] = value;
    } else {
      map[existing] = `${map[existing]}\n${value}`;
    }
  }
  return map;
}

// headerValue reads a header case-insensitively, returning every instance as
// stored (repeats still "\n"-joined). Returns '' when the header is absent.
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return String(headers[key] ?? '');
  }
  return '';
}

// headerFields returns one entry per header instance: the "\n"-joined value is
// split, and any RFC 5322 continuation line (one starting with whitespace) is
// folded back into the instance above it. Empty instances are dropped. Every
// case variant of the name contributes, so no instance can hide behind a key
// that differs only in casing.
export function headerFields(headers, name) {
  if (!headers || typeof headers !== 'object') return [];
  const target = name.toLowerCase();
  const fields = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    for (const line of String(headers[key] ?? '').split(/\r?\n/)) {
      if (fields.length > 0 && /^[ \t]/.test(line)) {
        fields[fields.length - 1] += ` ${line.trim()}`;
      } else {
        fields.push(line);
      }
    }
  }
  return fields.map((f) => f.trim()).filter((f) => f !== '');
}
