// Shared header-map encoding for the source-adapter seam.
//
// Every adapter hands the core `headers` as a plain-object map, but RFC 5322
// header names legitimately repeat (Received, and often more than one
// Authentication-Results). So each key holds an array of instance values, one
// entry per occurrence of that name, in the order the provider returned them.
// First-seen casing wins for the key, and lookup is case-insensitive.
//
// The array is the point. RFC 5322 also folds a single field across lines, and a
// continuation line is recognised by the whitespace it starts with -- so text
// that begins with whitespace reads as a continuation of whatever came before
// it. Encoding the instances as one joined string leaves those two boundaries
// indistinguishable on the way back out: the reader cannot tell "this line
// continues the field above" from "this is where the next instance starts", and
// an instance opening with whitespace ends up appended to the instance above it,
// carrying that instance's authserv-id with it. Keeping instances in an array
// removes the ambiguity at the root rather than guarding against it: a fold is
// resolved inside one instance and can never reach across two.
//
// lib/dmarc.mjs depends on that separation, since it has to see every
// Authentication-Results instance on its own to find the one the receiving
// boundary stamped.

// headersToObject turns a provider's [{name,value}] header collection into the
// plain-object map the core reads: { name: [instance, ...] }.
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
      map[h.name] = [value];
    } else {
      map[existing].push(value);
    }
  }
  return map;
}

// headerValue reads a header case-insensitively. It is the reader for the
// single-instance headers (Subject, From); repeats are joined with "\n" so a
// caller sees them rather than silently reading the first. Anything that has to
// tell the instances apart uses headerFields. Returns '' when absent.
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return instanceValues(headers[key]).join('\n');
  }
  return '';
}

// headerFields returns one entry per header instance, unfolded. Every case
// variant of the name contributes, so no instance can hide behind a key that
// differs only in casing, and empty instances are dropped. One instance is one
// field: folding is resolved within it and never between two of them.
export function headerFields(headers, name) {
  if (!headers || typeof headers !== 'object') return [];
  const target = name.toLowerCase();
  const fields = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    for (const instance of instanceValues(headers[key])) {
      const field = unfold(instance);
      if (field !== '') fields.push(field);
    }
  }
  return fields;
}

// instanceValues reads a map entry as the list of instances it holds. A bare
// string is the single-instance shape a hand-built message uses; it carries no
// instance boundary of its own, so it is exactly one instance.
function instanceValues(entry) {
  if (Array.isArray(entry)) return entry.map((v) => String(v ?? ''));
  return [String(entry ?? '')];
}

// unfold collapses the line structure of one instance back into the single
// logical field it is: RFC 5322 folding puts a line break and its following
// whitespace where a space belongs.
function unfold(value) {
  return String(value)
    .replace(/[\r\n]+[ \t]*/g, ' ')
    .trim();
}
