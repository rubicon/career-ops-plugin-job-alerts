// In-batch deduplication. Pure and deterministic: collapses leads whose URLs
// normalize to the same host-and-path key, keeping the first occurrence. No
// network and no cross-run history (the engine owns persisted dedup). Leads whose
// URL does not parse are left untouched rather than dropped.

// dedupKey normalizes a URL to a comparison key: lowercased host without a leading
// www., plus the path without a trailing slash. Returns '' for an unparseable URL.
export function dedupKey(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    return '';
  }
}

// dedup returns the leads with same-key duplicates removed, preserving order.
export function dedup(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads ?? []) {
    const key = dedupKey(lead?.url);
    if (key !== '' && seen.has(key)) continue;
    if (key !== '') seen.add(key);
    out.push(lead);
  }
  return out;
}
