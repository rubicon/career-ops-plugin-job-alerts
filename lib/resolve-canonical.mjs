// Canonical-URL classification. Pure and deterministic: decides whether a lead's
// URL is already an employer-canonical posting or still needs resolution. The
// network resolution tiers (Tier 1 ATS API lookup, Tier 2 Tavily search) are I/O
// owned by the ingest hook; this module only classifies and never fetches, never
// fabricates a URL.

// The host families whose posting URLs are already employer-canonical. Two kinds,
// because Tier 2 has to treat them differently once it is choosing among search
// results rather than reading a lead:
//
//   tenant: 'path'  a SHARED BOARD. The employer registers a slug and the vendor
//                   serves every posting under it, so the slug in the first path
//                   segment identifies the employer, and every URL on the board is
//                   a posting rather than a listings page.
//   tenant: 'host'  a PER-EMPLOYER TENANT. The employer's own name is a host label
//                   (acme.wd5.myworkdayjobs.com, careers-acme.icims.com), so the
//                   host identifies the employer -- but these platforms also serve
//                   prominent index and faceted-search URLs, so `postingPath` marks
//                   that a posting must additionally be told apart from a listing.
//
// The `$` anchor on every pattern is load-bearing: it keeps a lookalike host such
// as greenhouse.io.example.com or myworkdayjobs.com.mirror.example out.
//
// Workday and iCIMS were previously excluded because Tier 1 cannot PROBE their
// per-tenant hosts -- they cannot be enumerated in manifest.allowedHosts. That is a
// fact about the ATS APIs, not about the URL: a Workday posting URL is as canonical
// as a Greenhouse one, and classifying it otherwise sent a perfectly good posting
// round the network only to come back as a search fallback (#22).
//
// Exported so the network resolver decides Tier-2 acceptance against this one
// definition of "canonical" rather than a second copy that could drift from it.
// Adding a family is one row -- but only once that vendor's tenant location and
// posting-URL shape have actually been verified, never from memory.
export const CANONICAL_HOST_FAMILIES = Object.freeze([
  Object.freeze({ name: 'greenhouse', re: /(^|\.)greenhouse\.io$/i, tenant: 'path' }),
  Object.freeze({ name: 'lever', re: /(^|\.)lever\.co$/i, tenant: 'path' }),
  Object.freeze({ name: 'ashby', re: /(^|\.)ashbyhq\.com$/i, tenant: 'path' }),
  Object.freeze({
    name: 'workday',
    re: /(^|\.)myworkdayjobs\.com$/i,
    tenant: 'host',
    postingPath: true,
  }),
  Object.freeze({ name: 'icims', re: /(^|\.)icims\.com$/i, tenant: 'host', postingPath: true }),
]);

// canonicalHostFamily returns the family a hostname belongs to, or null.
export function canonicalHostFamily(hostname) {
  const host = String(hostname ?? '');
  if (host === '') return null;
  return CANONICAL_HOST_FAMILIES.find((family) => family.re.test(host)) ?? null;
}

// resolveCanonical returns the lead annotated with `canonical` (boolean) and
// `status` ('canonical' | 'needs-canonical'). Classification is by host alone, as
// it has always been: a lead's URL comes from a job alert, which links to a
// posting. The posting-vs-listing distinction is enforced where the risk actually
// lives, in Tier 2, which picks among open-web search results.
export function resolveCanonical(lead) {
  const canonical = canonicalHostFamily(hostOf(lead?.url)) !== null;
  return { ...lead, canonical, status: canonical ? 'canonical' : 'needs-canonical' };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}
