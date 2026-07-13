// Tier-1 network resolution: the I/O half of canonical resolution. The pure
// classifier (lib/resolve-canonical.mjs) marks each lead canonical or
// needs-canonical without touching the network; this module takes the
// needs-canonical leads and probes public ATS job-board APIs to pin each one to
// the employer's canonical live posting. Anything it cannot resolve is emitted
// with a live {company, title} search-URL fallback, never the dead tracking link
// and never a fabricated posting URL (#8).
//
// Egress goes only through ctx.fetchJson (the engine applies manifest.allowedHosts
// and its SSRF guard). The guarded fetch throws on any non-2xx response, so a probe
// for a board that does not exist rejects with a 404; that is a normal miss and is
// caught here, not a crash. This module imports no node:http/node:net and calls no
// global fetch.
//
// Public ATS endpoints and response shapes verified against official docs:
//  - Greenhouse Job Board API: GET boards-api.greenhouse.io/v1/boards/{token}/jobs
//    -> { jobs: [ { title, absolute_url, ... } ] }   (canonical = absolute_url)
//  - Lever Postings API: GET api.lever.co/v0/postings/{site}?mode=json
//    -> [ { text, hostedUrl, ... } ]                  (title = text, canonical = hostedUrl)
//  - Ashby public Posting API: GET api.ashbyhq.com/posting-api/job-board/{name}
//    -> { jobs: [ { title, jobUrl, isListed, ... } ] } (canonical = jobUrl)
// Workday is out of scope: its per-tenant hosts are dynamic and cannot be listed in
// manifest.allowedHosts.

// Trailing company words that are legal-entity noise, not part of the board slug.
const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'group',
  'holdings',
]);

// A title match needs at least this Jaccard similarity between the lead and posting
// title token sets, plus at least two shared tokens, so neither a single generic word
// nor a loose partial overlap counts as a match.
const MATCH_THRESHOLD = 0.6;

// Each ATS: how to build the board URL from a slug, pull the postings array from the
// response, and read a posting's title, canonical URL, and location. Location field
// names are the ones verified in each ATS's real response shape (Greenhouse
// location.name, Lever categories.location, Ashby location). `includePosting` filters
// postings that must not be surfaced publicly.
const ATS_PROBES = [
  {
    name: 'greenhouse',
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    postings: (data) => (Array.isArray(data?.jobs) ? data.jobs : []),
    title: (p) => p?.title,
    canonicalUrl: (p) => p?.absolute_url,
    location: (p) => p?.location?.name,
  },
  {
    name: 'lever',
    url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    postings: (data) => (Array.isArray(data) ? data : []),
    title: (p) => p?.text,
    canonicalUrl: (p) => p?.hostedUrl,
    location: (p) => p?.categories?.location,
  },
  {
    name: 'ashby',
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    postings: (data) => (Array.isArray(data?.jobs) ? data.jobs : []),
    title: (p) => p?.title,
    canonicalUrl: (p) => p?.jobUrl,
    location: (p) => p?.location,
    // An unlisted Ashby posting must not be shown publicly.
    includePosting: (p) => p?.isListed !== false,
  },
];

// resolveNetwork resolves each needs-canonical lead to a canonical ATS posting URL
// (Tier 1) or, failing that, to a live search-URL fallback. Already-canonical leads
// pass through untouched (no I/O). It returns a new array in input order and logs
// per-tier counts through ctx.log for transparency.
export async function resolveNetwork(ctx, leads) {
  const out = [];
  let viaAts = 0;
  let viaFallback = 0;
  let alreadyCanonical = 0;

  for (const lead of leads ?? []) {
    if (lead?.canonical === true) {
      alreadyCanonical++;
      out.push({ ...lead, resolvedVia: 'ats-canonical' });
      continue;
    }
    const hit = await resolveViaAts(ctx, lead);
    if (hit) {
      viaAts++;
      out.push({
        ...lead,
        url: hit.url,
        location: pickLocation(hit.location, lead?.location),
        canonical: true,
        status: 'canonical',
        resolvedVia: 'ats',
      });
    } else {
      viaFallback++;
      out.push({
        ...lead,
        url: buildSearchUrl(lead?.title, lead?.company),
        canonical: false,
        status: 'needs-canonical',
        searchFallback: true,
        resolvedVia: 'search-fallback',
      });
    }
  }

  logSummary(ctx, { viaAts, viaFallback, alreadyCanonical });
  return out;
}

// resolveViaAts derives candidate board slugs from the company and probes each ATS
// for the posting whose title matches the lead. Returns { url, ats, location } on the
// first match, or null. A probe that rejects (404 for a missing board, or any other
// fetch error) is treated as a miss for that slug and ATS, never a crash.
async function resolveViaAts(ctx, lead) {
  const slugs = candidateSlugs(lead?.company);
  const leadTitle = lead?.title;
  for (const slug of slugs) {
    for (const ats of ATS_PROBES) {
      try {
        const data = await ctx.fetchJson(ats.url(slug));
        const include = ats.includePosting ?? (() => true);
        const postings = ats.postings(data).filter(include);
        const posting = bestPosting(leadTitle, postings, ats.title);
        if (posting) {
          const url = ats.canonicalUrl(posting);
          if (typeof url === 'string' && url.trim() !== '') {
            return { url, ats: ats.name, location: ats.location(posting) };
          }
        }
      } catch {
        // Board absent (404) or any transient probe error: a miss for this
        // slug+ATS. Try the next one rather than failing the whole ingest.
      }
    }
  }
  return null;
}

// bestPosting returns the single posting whose title most clearly matches the lead
// title at or above MATCH_THRESHOLD. It returns null when nothing clears the bar OR
// when two or more postings tie at the top score: an arbitrary pick among equally
// good matches is a confident guess, and an honest search fallback is safer than a
// wrong canonical URL.
function bestPosting(leadTitle, postings, getTitle) {
  const leadTokens = titleTokens(leadTitle);
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const posting of postings) {
    const score = titleScore(leadTokens, titleTokens(getTitle(posting)));
    if (score > bestScore) {
      bestScore = score;
      best = posting;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  if (best && !tied && bestScore >= MATCH_THRESHOLD) return best;
  return null;
}

// titleTokens normalizes a title to lowercase alphanumeric tokens.
function titleTokens(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// titleScore is the Jaccard similarity of the two title token sets (shared tokens
// over their union). It returns 0 unless at least two tokens are shared, so a lone
// generic word cannot match. A symmetric measure keeps a short lead title from
// scoring a perfect match against a longer, more specific posting (e.g. "Marketing
// Manager" against "Senior Product Marketing Manager" scores 0.5, not 1.0).
function titleScore(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (shared < 2) return 0;
  const union = a.size + b.size - shared;
  return shared / union;
}

// candidateSlugs derives the board-slug guesses to probe from a company name:
// lowercased, punctuation stripped, trailing legal-entity suffixes dropped, then
// offered as the joined, hyphenated, and first-word forms (deduped, order kept).
export function candidateSlugs(company) {
  const cleaned = String(company ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (cleaned === '') return [];

  let words = cleaned.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words = words.slice(0, -1);
  }
  if (words.length === 0) return [];

  const forms = [words.join(''), words.join('-'), words[0]];
  const seen = new Set();
  const out = [];
  for (const form of forms) {
    if (form.length >= 2 && !seen.has(form)) {
      seen.add(form);
      out.push(form);
    }
  }
  return out;
}

// pickLocation prefers the matched posting's location and falls back to the lead's
// own location when the posting carries none.
function pickLocation(postingLocation, leadLocation) {
  const fromPosting = String(postingLocation ?? '').trim();
  if (fromPosting !== '') return fromPosting;
  return String(leadLocation ?? '').trim();
}

// buildSearchUrl returns a live Google careers search for the role, the honest
// fallback for a lead that could not be pinned to a canonical posting. It never
// carries the tracking link.
export function buildSearchUrl(title, company) {
  const t = String(title ?? '').trim();
  const c = String(company ?? '').trim();
  const terms = [];
  if (t !== '') terms.push(`"${t}"`);
  if (c !== '') terms.push(c);
  terms.push('careers');
  return `https://www.google.com/search?q=${encodeURIComponent(terms.join(' '))}`;
}

// logSummary reports per-tier counts through the engine's redacting ctx.log when
// available, so a run is transparent about how each lead was resolved.
function logSummary(ctx, { viaAts, viaFallback, alreadyCanonical }) {
  if (typeof ctx?.log !== 'function') return;
  ctx.log(
    `job-alerts: canonical resolution resolved ${viaAts} via ATS, ` +
      `${viaFallback} via search fallback (${alreadyCanonical} already canonical).`,
  );
}
