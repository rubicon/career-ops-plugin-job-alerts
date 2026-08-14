// Canonical-URL classification. Pure and deterministic: decides whether a lead's
// URL is already an employer-canonical ATS posting or still needs resolution. The
// network resolution tiers (Tier 1 ATS API lookup, Tier 2 Tavily search) are I/O
// owned by the ingest hook and land in their own issue; this module only
// classifies and never fetches, never fabricates a URL.

// Known applicant-tracking-system hosts whose posting URLs are already canonical.
// Workday is intentionally excluded (dynamic per-tenant hosts). The `$` anchor is
// load-bearing: it keeps a lookalike host such as greenhouse.io.example.com out.
// Exported so the network resolver's Tier-2 acceptance gate tests candidate URLs
// against this one definition of "canonical", rather than a second copy that could
// drift from it.
export const ATS_HOST_RE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/i;

// resolveCanonical returns the lead annotated with `canonical` (boolean) and
// `status` ('canonical' | 'needs-canonical').
export function resolveCanonical(lead) {
  const host = hostOf(lead?.url);
  const canonical = host !== '' && ATS_HOST_RE.test(host);
  return { ...lead, canonical, status: canonical ? 'canonical' : 'needs-canonical' };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}
