// In-batch deduplication. Pure and deterministic: collapses leads whose URLs
// normalize to the same host-and-path key, keeping the first occurrence. No
// network and no cross-run history (the engine owns persisted dedup). Leads whose
// URL does not parse are left untouched rather than dropped.

// dedupKey normalizes a URL to a comparison key: lowercased host without a leading
// www., the path without a trailing slash, and the query string. The query is kept
// so two distinct tracking redirects that share host and path but differ only in
// their query (e.g. ?jk=AAA vs ?jk=BBB) stay distinct and neither job is dropped.
// Returns '' for an unparseable URL.
export function dedupKey(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`.toLowerCase();
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
