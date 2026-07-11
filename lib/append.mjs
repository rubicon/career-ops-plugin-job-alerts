// Final Job[] assembly. Pure and deterministic: shapes resolved leads into the
// { title, url, company, location } records the ingest hook returns. The plugin
// never writes files itself; the career-ops engine performs the actual append to
// the pipeline. Leads missing a usable title or url are dropped.

const str = (value) => String(value ?? '').trim();

// TODO(#7): buildJobs must not emit a Job whose url has status !== 'canonical' (a
// dead tracking link). Enforce when canonical resolution lands.
//
// buildJobs returns the Job[] the engine will append.
export function buildJobs(leads) {
  return (leads ?? [])
    .filter((lead) => lead && str(lead.url) !== '' && str(lead.title) !== '')
    .map((lead) => ({
      title: str(lead.title),
      url: str(lead.url),
      company: str(lead.company),
      location: str(lead.location),
    }));
}
