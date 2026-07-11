// DMARC authenticity gate. Pure and fail-closed: inspects only the message's
// Authentication-Results header and performs no network lookups (the adapters and
// the engine own all I/O). A message with no parseable dmarc=pass is rejected.
//
// The fail-closed authenticity check is informed by the bundled career-ops gmail
// plugin (MIT).

// passesDmarc returns true only when the message carries an Authentication-Results
// header asserting dmarc=pass. Absent or failing results are rejected.
export function passesDmarc(message) {
  const results = headerValue(message?.headers, 'authentication-results');
  return /\bdmarc\s*=\s*pass\b/i.test(results);
}

// headerValue reads a header case-insensitively from a plain-object header map.
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return String(headers[key] ?? '');
  }
  return '';
}
