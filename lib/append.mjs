// Final Job[] assembly. Pure and deterministic: shapes resolved leads into the
// { title, url, company, location } records the ingest hook returns. The plugin
// never writes files itself; the career-ops engine performs the actual append to
// the pipeline. Leads missing a usable title or url are dropped.

const str = (value) => String(value ?? '').trim();

// Contract (#8): buildJobs must never emit a Job whose url is a dead tracking link.
// The network resolver (lib/resolve-network.mjs) guarantees every emitted lead
// carries one of exactly three resolved forms; a lead that carries none of them
// still points at its raw tracker, so it is dropped here rather than leaked.
//
//   canonical === true         a posting on a host lib/resolve-canonical.mjs
//                              classifies as employer-canonical (a shared ATS
//                              board, or an employer's tenant on Workday/iCIMS).
//   employerCanonical === true a posting on the employer's OWN domain, which no
//                              host pattern can recognize, so Tier 2 proved it
//                              instead: the domain label is the company's own,
//                              the path denotes a single posting, and the company
//                              and role are corroborated (#22).
//   searchFallback === true    the honest live {company, title} search URL.
//
// The third class is named explicitly rather than folded into `canonical` for two
// reasons: re-running the pure classifier over an emitted lead must not contradict
// the flag it carries, and admitting resolved employer sites must not widen the net
// to "anything not obviously a tracker". Unresolved leads still reach the human as
// a live search URL, never the tracker.
//
// buildJobs returns the Job[] the engine will append.
export function buildJobs(leads) {
  return (leads ?? [])
    .filter((lead) => lead && str(lead.url) !== '' && str(lead.title) !== '')
    .filter(
      (lead) =>
        lead.canonical === true || lead.employerCanonical === true || lead.searchFallback === true,
    )
    .map((lead) => ({
      title: str(lead.title),
      url: str(lead.url),
      company: str(lead.company),
      location: str(lead.location),
    }));
}
