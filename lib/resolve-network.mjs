// Network resolution: the I/O half of canonical resolution. The pure classifier
// (lib/resolve-canonical.mjs) marks each lead canonical or needs-canonical without
// touching the network; this module takes the needs-canonical leads and resolves
// them in tiers. Anything no tier can resolve is emitted with a live
// {company, title} search-URL fallback, never the dead tracking link and never a
// fabricated posting URL (#8).
//
//   Tier 1  probe the public ATS job-board APIs by a slug guessed from the company
//   Tier 2  ask the Tavily Search API, only when TAVILY_API_KEY is set (#13)
//   Fallback  a live {company, title} search URL
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
//
// Tavily Search API, verified against the official reference
// (docs.tavily.com/documentation/api-reference/endpoint/search):
//  - POST https://api.tavily.com/search
//  - headers: `Authorization: Bearer {key}`, `Content-Type: application/json`
//  - body: { query, search_depth ("basic"|"advanced"|"fast"|"ultra-fast", default
//    "basic"), max_results (0..20, default 5), topic ("general"|"news"|"finance") }
//  - -> { query, results: [ { title, url, content, score, raw_content, ... } ],
//         response_time, request_id }
// The response `score` is deliberately NOT used as a gate: the docs state only that
// "higher is better" and decline to define a range or a universal threshold, so any
// hardcoded float here would be an invented contract. Acceptance is decided by the
// structural gates below, which are checkable against the URL itself.

import { ATS_HOST_RE } from './resolve-canonical.mjs';

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

// -- Tier 2 (Tavily) constants --------------------------------------------
const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_MAX_RESULTS = 10; // documented range is 0..20.
const TAVILY_SEARCH_DEPTH = 'basic';
const TAVILY_TOPIC = 'general';

// Wrapper words a search-result page title carries that an ATS `title` field does
// not ("Job Application for X at Y", "Careers at Y"). They are stripped, along with
// the company's own tokens, before the SAME symmetric title score Tier 1 uses is
// applied; otherwise the boilerplate would drag every real match below threshold.
const PAGE_TITLE_STOPWORDS = new Set([
  'job',
  'jobs',
  'application',
  'apply',
  'careers',
  'career',
  'opening',
  'openings',
  'posting',
  'postings',
  'position',
  'positions',
  'vacancy',
  'vacancies',
  'hiring',
  'at',
  'for',
  'the',
  'a',
  'an',
  'in',
  'of',
  'and',
  'to',
]);

// The shorter of a board slug and a company slug must be at least this long before
// a substring relation between them counts as evidence, so a two-letter accident
// ("co" inside "cocacola") can never tie a posting to the wrong employer.
const MIN_SLUG_OVERLAP = 4;

// A company token must be at least this long to corroborate a result, so filler
// words carry no weight.
const MIN_COMPANY_TOKEN = 3;

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
// (Tier 1 board probe, then Tier 2 Tavily search) or, failing both, to a live
// search-URL fallback. Already-canonical leads pass through untouched (no I/O). It
// returns a new array in input order and logs per-tier counts through ctx.log for
// transparency.
export async function resolveNetwork(ctx, leads) {
  const out = [];
  let viaAts = 0;
  let viaTavily = 0;
  let viaFallback = 0;
  let alreadyCanonical = 0;

  // Shared across every lead in one run so a rejected Tavily key costs one call,
  // not one per lead. Mirrors the LLM enrichment breaker in lib/extract-llm.mjs.
  const tavily = { disabled: false };

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
      continue;
    }
    // Tier 2 only ever sees a lead Tier 1 missed.
    const searched = await resolveViaTavily(ctx, lead, tavily);
    if (searched) {
      viaTavily++;
      out.push({
        ...lead,
        url: searched.url,
        canonical: true,
        status: 'canonical',
        resolvedVia: 'tavily',
      });
      continue;
    }
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

  logSummary(ctx, { viaAts, viaTavily, viaFallback, alreadyCanonical });
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

// -- Tier 2: Tavily canonical search --------------------------------------
//
// resolveViaTavily asks Tavily for the employer's live posting and returns
// { url } only when a single result proves it is the right posting at the right
// employer. Returns null for every other outcome, which lets the caller emit the
// existing search-URL fallback.
//
// WHERE THE LINE IS DRAWN. A wrong canonical URL is worse than no canonical URL,
// because it looks correct: the human clicks it, reads a different role or a
// different employer, and has no signal anything went wrong, whereas a search-URL
// fallback is visibly a search. Tavily returns ranked open-web results with no
// structured job fields, so relevance alone cannot tell "Acme's VP Marketing
// posting" from "someone's VP Marketing posting that mentions Acme". Tier 2
// therefore accepts a result only when all four gates hold, and prefers the
// fallback whenever any of them is merely probable:
//
//   1. HOST. The result must live on a host that lib/resolve-canonical.mjs already
//      classifies as canonical (Greenhouse, Lever, Ashby), tested with the very
//      same exported regex. This is what makes `canonical: true` honest: the
//      classifier and the resolver cannot disagree about the URL Tier 2 emits. It
//      also rules out the aggregator and tracking-link hosts this plugin exists to
//      escape, and, via the regex's end anchor, lookalike domains.
//   2. EMPLOYER. The board slug in the URL path must be relatable to the company
//      name. Requiring equality would be pointless (Tier 1 already probes those
//      slugs), so a containment relation with a length floor is the evidence:
//      it accepts the real Tier-1 miss class (a board token that is a variant of
//      the display name, "acmetech" for "Acme Technologies") and rejects an
//      unrelated employer's board.
//   3. CORROBORATION. The company's own tokens must appear in the result's title
//      or snippet. Gate 2 alone would let "metabase" pass for "Meta"; this one
//      catches that, and the two together are much harder to satisfy by accident
//      than either is alone.
//   4. TITLE, AND UNIQUENESS. The role must clear the same symmetric Jaccard
//      threshold Tier 1 uses, and must be the only result that does. A tie is an
//      arbitrary pick, so it falls back, exactly as bestPosting does.
//
// The deliberate cost of gate 1 is that Tier 2 will not surface an employer-hosted
// careers page (Workday, iCIMS, a bespoke site). Those cannot be verified as a
// posting rather than an index or an article, they cannot be marked canonical
// without contradicting resolve-canonical.mjs, and lib/append.mjs only emits a lead
// that is canonical or an explicit search fallback. Widening that safety net to
// carry an unverifiable third class is not worth a dead-or-wrong link; those leads
// keep the honest search fallback.
async function resolveViaTavily(ctx, lead, breaker) {
  const apiKey = ctx?.env?.TAVILY_API_KEY;
  if (!apiKey || breaker.disabled) return null;

  const title = String(lead?.title ?? '').trim();
  const company = String(lead?.company ?? '').trim();
  // Without both, there is nothing to search for and nothing to corroborate a hit
  // against, so no request is worth making.
  if (title === '' || company === '') return null;
  const companySlugs = candidateSlugs(company);
  const companyTokens = significantCompanyTokens(company);
  if (companySlugs.length === 0 || companyTokens.length === 0) return null;

  let data;
  try {
    data = await ctx.fetchJson(TAVILY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: buildTavilyQuery(title, company),
        search_depth: TAVILY_SEARCH_DEPTH,
        max_results: TAVILY_MAX_RESULTS,
        topic: TAVILY_TOPIC,
      }),
    });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      breaker.disabled = true;
      logLine(ctx, `job-alerts: disabling Tavily resolution for this run (${err.status}).`);
    } else {
      logLine(ctx, `job-alerts: Tavily search failed for this lead (${err.message}).`);
    }
    return null;
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  return bestSearchResult(title, companySlugs, companyTokens, results);
}

// buildTavilyQuery phrases the lead as a natural search for the employer's own
// posting. It never carries the tracking link.
function buildTavilyQuery(title, company) {
  return `${title} ${company} careers job posting`;
}

// bestSearchResult applies the four acceptance gates and returns { url } for the
// single clear winner, or null when nothing clears the bar or two results tie.
function bestSearchResult(leadTitle, companySlugs, companyTokens, results) {
  const leadTokens = titleTokens(leadTitle);
  const byUrl = new Map();
  for (const result of results) {
    const url = typeof result?.url === 'string' ? result.url.trim() : '';
    if (url === '' || byUrl.has(url)) continue;

    // Gate 1: the host must be one resolve-canonical.mjs already calls canonical.
    const parsed = parseUrl(url);
    if (!parsed || !ATS_HOST_RE.test(parsed.hostname)) continue;

    // Gate 2: the board slug in the path must be relatable to the company.
    if (!slugRelated(firstPathSegment(parsed), companySlugs)) continue;

    // Gate 3: the company must actually appear in what Tavily returned.
    const resultTitle = String(result?.title ?? '');
    const haystack = `${resultTitle} ${String(result?.content ?? '')}`;
    if (!companyCorroborated(companyTokens, haystack)) continue;

    // Gate 4a: the role must clear Tier 1's own symmetric title threshold, once the
    // page-title boilerplate and the company name are out of the way.
    const score = titleScore(leadTokens, pageTitleTokens(resultTitle, companyTokens));
    if (score < MATCH_THRESHOLD) continue;

    byUrl.set(url, score);
  }

  // Gate 4b: a tie at the top is ambiguity, and an arbitrary pick among equally
  // good matches is a guess. Fall back instead.
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const [url, score] of byUrl) {
    if (score > bestScore) {
      bestScore = score;
      best = url;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (best && !tied) return { url: best };
  return null;
}

// significantCompanyTokens drops filler and legal-entity noise from a company name,
// leaving the tokens that can actually identify the employer.
function significantCompanyTokens(company) {
  return titleTokens(company).filter(
    (token) => token.length >= MIN_COMPANY_TOKEN && !LEGAL_SUFFIXES.has(token),
  );
}

// companyCorroborated requires the company's tokens to appear in the result text.
// A single-token company must match that token; a multi-token company must match at
// least two, so one common word in a long name cannot carry the decision alone.
function companyCorroborated(companyTokens, text) {
  const present = new Set(titleTokens(text));
  let matched = 0;
  for (const token of companyTokens) if (present.has(token)) matched++;
  return matched >= Math.min(2, companyTokens.length);
}

// slugRelated decides whether the board slug in a posting URL plausibly belongs to
// this company. Equality is not required (Tier 1 already probes the exact forms);
// a containment relation between the two, with a length floor on the shorter side,
// is the evidence that the board token is a variant of the display name.
function slugRelated(boardSlug, companySlugs) {
  const board = String(boardSlug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (board.length < MIN_SLUG_OVERLAP) return false;
  for (const slug of companySlugs) {
    const candidate = slug.replace(/[^a-z0-9]/g, '');
    if (candidate.length < MIN_SLUG_OVERLAP) continue;
    if (board.includes(candidate) || candidate.includes(board)) return true;
  }
  return false;
}

// pageTitleTokens reduces a search-result page title to the role tokens: the page
// boilerplate ("Job Application for ... at ...") and the company's own name are
// removed, so what remains can be compared with the same symmetric measure Tier 1
// applies to a clean ATS title field.
function pageTitleTokens(resultTitle, companyTokens) {
  const company = new Set(companyTokens);
  return titleTokens(resultTitle).filter(
    (token) => !PAGE_TITLE_STOPWORDS.has(token) && !company.has(token),
  );
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function firstPathSegment(parsed) {
  return parsed.pathname.split('/').filter(Boolean)[0] ?? '';
}

function logLine(ctx, message) {
  if (typeof ctx?.log === 'function') ctx.log(message);
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
function logSummary(ctx, { viaAts, viaTavily, viaFallback, alreadyCanonical }) {
  if (typeof ctx?.log !== 'function') return;
  ctx.log(
    `job-alerts: canonical resolution resolved ${viaAts} via ATS, ` +
      `${viaTavily} via Tavily, ${viaFallback} via search fallback ` +
      `(${alreadyCanonical} already canonical).`,
  );
}
