// Final Job[] assembly. Pure and deterministic: shapes resolved leads into the
// { title, url, company, location } records the ingest hook returns. The plugin
// never writes files itself; the career-ops engine performs the actual append to
// the pipeline. Leads missing a usable title or url are dropped.

const str = (value) => String(value ?? '').trim();

// Contract (#8): buildJobs must never emit a Job whose url is a dead tracking link.
// The network resolver (lib/resolve-network.mjs) guarantees every emitted lead
// carries either a canonical ATS posting URL (`canonical === true`) or a live
// search-URL fallback (`searchFallback === true`); a lead that carries neither
// still points at its raw tracker, so it is dropped here rather than leaked. Unresolved
// leads therefore reach the human as a live search URL, never the tracker.
//
// buildJobs returns the Job[] the engine will append.
export function buildJobs(leads) {
  return (leads ?? [])
    .filter((lead) => lead && str(lead.url) !== '' && str(lead.title) !== '')
    .filter((lead) => lead.canonical === true || lead.searchFallback === true)
    .map((lead) => ({
      title: str(lead.title),
      url: str(lead.url),
      company: str(lead.company),
      location: str(lead.location),
    }));
}
