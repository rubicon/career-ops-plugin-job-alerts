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

// -- posting vs listing ----------------------------------------------------
//
// The `postingPath` families need one more test than their host: does this URL
// point at ONE posting? It lives here, beside the row that declares the
// requirement, so the classifier and the network resolver apply the same rule to
// the same URL rather than one of them trusting the host alone. A lead's URL comes
// from a job alert, but an alert links to "see all jobs" and to saved searches as
// readily as to a posting, and a listing is the more damaging error because it
// outlives the role it was showing.

// A path segment identifying ONE posting: a requisition or job id. Three digits is
// the floor so a locale or a short counter is not mistaken for an id. Verified
// against both tenant platforms' public posting URLs -- Workday's
// `VP-Marketing_JR-10423` and iCIMS's `/jobs/44120/` both satisfy it, while their
// index and faceted-search paths do not.
const POSTING_ID_RE = /\d{3}/;

// ...except a calendar year, which dates an archive or an intake cohort rather than
// identifying a posting, and clears the digit floor on its own. It is excluded
// wherever it appears as a whole number in the segment -- `2026`, `2026-internships`,
// `summer-2026`, `class-of-2026` are the same thing said four ways -- and only as a
// whole number, so a requisition id that merely contains year-like digits (`JR-20264`)
// still counts.
const YEAR_RUN_RE = /(?<![0-9])(?:19|20)\d{2}(?![0-9])/g;

// -- how path vocabulary is read -------------------------------------------
//
// ONE TOKENIZATION, used by every vocabulary test here and in the network resolver.
// Comparing a word against a WHOLE segment recognizes `/search` and misses
// `/vp-marketing-search`, `/browse-vp-marketing`, `/jobs/page-1250` and
// `/SearchResults` -- the same words, written the way real URLs write them. A
// segment is therefore split into tokens on every non-alphanumeric run AND on a
// camel-case boundary, and the vocabulary is matched against those. An all-caps run
// glued to a word (`VPMarketing`) is left alone: separating it needs a dictionary,
// and guessing is what this module declines to do.
export function segmentTokens(segment) {
  return String(segment ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Words that say a URL is a search, a browse index, or a page of one. A facet number
// in such a path is a page or an offset, and nothing about its shape tells it from a
// requisition id -- so the shape is not what decides it, the path is.
export const INDEX_PATH_WORDS = new Set([
  'search',
  'results',
  'browse',
  'listing',
  'listings',
  'all',
  'page',
  'pages',
  'offset',
]);

// Words that say a URL is about jobs. Structural on their own (`/jobs/`, `/careers/`,
// `/job-openings/` say where in a site you are), and a CATEGORY marker when they name
// the thing itself. The network resolver reads both sets: this one as evidence a
// bespoke domain is talking about jobs at all, and both of them where it has to decide
// whether one path segment names a single posting. Both live here, beside the grammar
// they describe, because two copies of a list like this drift and the drift is
// invisible until a wrong URL is emitted.
export const JOB_PATH_WORDS = new Set([
  'careers',
  'career',
  'jobs',
  'job',
  'openings',
  'opening',
  'opportunities',
  'opportunity',
  'positions',
  'position',
  'vacancies',
  'vacancy',
  'roles',
  'role',
]);

// A page or offset facet: a number introduced by a pagination marker. Excluded from
// the posting-id test for the same reason a calendar year is -- it clears the digit
// floor without identifying anything -- and by the same means, so `/jobs/page-1250`
// and `/jobs/offset-1250` cannot buy a posting's standing with a page number.
const PAGINATION_RUN_RE = /(?<![a-z0-9])(?:pages?|offset)[-_]?\d+/gi;

// isPostingIdSegment: a path segment carrying a posting id rather than a year or a
// pagination facet.
export function isPostingIdSegment(segment) {
  return POSTING_ID_RE.test(
    String(segment ?? '')
      .replace(PAGINATION_RUN_RE, ' ')
      .replace(YEAR_RUN_RE, ' '),
  );
}

// looksLikeListingPath: the path itself says it serves a list, not a posting.
//
// A segment is a listing surface when EVERY one of its tokens is vocabulary and at
// least one of them is an index word: `search`, `search-results`, `SearchResults`,
// `all-openings`, `browse-jobs`. Both halves of that are load-bearing.
//
// Every token, because a segment carrying an ordinary noun is naming a thing, not
// describing a surface. "Search Engineer", "Paid Search Manager" and "Results
// Analyst" are roles, and both verified vendor grammars put a real role name in a
// path segment (`Search-Engineer_JR-10423`, `/jobs/44120/results-analyst/job`);
// reading the vocabulary word alone as a listing marker would send real postings to
// the search fallback. Position within the segment cannot separate the two -- the
// role word leads `Search-Engineer` and trails `Paid-Search-Manager`.
//
// At least one index word, because the job words are structural on their own: `jobs`
// and `job-openings` say where in a site you are, and iCIMS publishes `/jobs/{id}/`
// in every posting URL it serves.
//
// What this deliberately does NOT decide: `/browse-marketing/4400` has the same shape
// as `/search-engineer/44120` -- one vocabulary word, one ordinary noun, a number
// beside it -- and no rule reading only the URL can separate them. The employer class,
// which has the lead's own title to compare against, tightens this further on the one
// segment where it has no other evidence; see looksLikeEmployerPosting.
export function looksLikeListingPath(segments) {
  return (segments ?? []).some((segment) => {
    const tokens = segmentTokens(segment);
    if (tokens.length === 0) return false;
    if (!tokens.some((token) => INDEX_PATH_WORDS.has(token))) return false;
    return tokens.every((token) => INDEX_PATH_WORDS.has(token) || JOB_PATH_WORDS.has(token));
  });
}

// hasPostingId decides whether a URL on a `postingPath` family points at one
// posting. Both verified platforms put a numeric requisition or job id in the
// posting path and neither puts one in an index or a faceted-search path:
//   Workday  /en-US/{site}/job/{location}/{Role}_{JR-10423}
//   iCIMS    /jobs/{44120}/{role-slug}/job
export function hasPostingId(parsed) {
  if (!parsed) return false;
  const segments = pathSegments(parsed);
  if (segments.length < 2) return false;
  if (looksLikeListingPath(segments)) return false;
  return segments.some(isPostingIdSegment);
}

export function pathSegments(parsed) {
  return parsed.pathname.split('/').filter(Boolean);
}

// resolveCanonical returns the lead annotated with `canonical` (boolean) and
// `status` ('canonical' | 'needs-canonical'). The host decides which family a URL
// belongs to; a family that declares `postingPath` additionally requires the URL to
// be a posting, so a tenant index or faceted search is sent for resolution instead
// of being emitted -- and short-circuiting every tier -- on the strength of its host.
export function resolveCanonical(lead) {
  const parsed = parseUrl(lead?.url);
  const family = parsed ? canonicalHostFamily(parsed.hostname) : null;
  const canonical = family !== null && (family.postingPath !== true || hasPostingId(parsed));
  return { ...lead, canonical, status: canonical ? 'canonical' : 'needs-canonical' };
}

function parseUrl(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}
