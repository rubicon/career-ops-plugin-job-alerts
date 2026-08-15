// Network resolution: the I/O half of canonical resolution. The pure classifier
// (lib/resolve-canonical.mjs) marks each lead canonical or needs-canonical without
// touching the network; this module takes the needs-canonical leads and resolves
// them in tiers. Anything no tier can resolve is emitted with a live
// {company, title} search-URL fallback, never the dead tracking link and never a
// fabricated posting URL (#8).
//
//   Tier 1  probe the public ATS job-board APIs by a slug guessed from the company
//   Tier 2  ask the Tavily Search API, only when TAVILY_API_KEY is set (#13), and
//           accept a shared-board, tenant-platform, or employer-domain posting (#22)
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
// Workday and iCIMS have no Tier-1 probe: their per-tenant hosts are dynamic and
// cannot be enumerated in manifest.allowedHosts. That bars PROBING them, not
// recognizing them, so Tier 2 can still accept their posting URLs (#22).
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

import {
  INDEX_PATH_WORDS,
  JOB_PATH_WORDS,
  canonicalHostFamily,
  hasPostingId,
  isPostingIdSegment,
  looksLikeListingPath,
  pathSegments,
  segmentTokens,
} from './resolve-canonical.mjs';

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

// -- Tier 2, employer-hosted postings (#22) --------------------------------

// A result on the employer's own domain must clear a HIGHER title bar than one on a
// vendor host. On a vendor host the tenant token has independently tied the posting
// to the employer, so the title only has to pick the right role among that
// employer's postings. On an employer domain the title is doing more of the work,
// and the residual error there is a real, adjacent role on the real employer's real
// site -- correct-looking in every way except being the wrong job. 0.75 rejects the
// one-extra-word neighbours ("VP Marketing Manager" for "VP Marketing", 0.667) that
// MATCH_THRESHOLD lets through.
const EMPLOYER_MATCH_THRESHOLD = 0.75;

// Host labels an employer puts its careers site behind. Recognized for two purposes:
// setting one aside when reading the registrant's identity label (careers.acme.com
// is still Acme), and as evidence that the host is about jobs at all.
const CAREERS_SUBDOMAINS = new Set([
  'careers',
  'career',
  'jobs',
  'job',
  'join',
  'work',
  'apply',
  'talent',
  'hiring',
  'recruiting',
]);

// Second-level labels that precede a two-letter country code in the country-code
// domains an employer is likely to use (acme.co.uk, acme.com.au, acme.ne.jp). This
// is a deliberately small allowlist of SHAPES, not a public-suffix list: a host
// whose shape is not recognized is declined, never guessed at.
const SECOND_LEVEL_SUFFIX_HEADS = new Set([
  'co',
  'com',
  'org',
  'net',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'go',
]);

// Both vocabularies together, read from segmentTokens like every other vocabulary
// test. This is the strictest reading of them and it is used in exactly one place:
// the employer class's FINAL segment, where that one segment is the whole of the
// evidence -- no requisition id, no vendor host -- so any word that could make it a
// CATEGORY of postings disqualifies it, wherever in the segment it sits.
// `/vp-marketing-jobs`, `/vp-marketing-opportunities`, `/browse-vp-marketing`,
// `/vp-marketing-search` and `/vp-marketing-jobs-2026` are all category pages, and
// none of them is a listing surface by the path-level rule, which requires the whole
// segment to be vocabulary.
const CATEGORY_PATH_WORDS = new Set([...INDEX_PATH_WORDS, ...JOB_PATH_WORDS]);

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
  let viaEmployer = 0;
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
    if (searched?.employerHosted) {
      viaEmployer++;
      out.push({
        ...lead,
        url: searched.url,
        canonical: false,
        employerCanonical: true,
        status: 'employer-canonical',
        resolvedVia: 'tavily-employer',
      });
      continue;
    }
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

  logSummary(ctx, { viaAts, viaTavily, viaEmployer, viaFallback, alreadyCanonical });
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
//   1. HOST OR DOMAIN IDENTITY. The result must be tied to the employer by
//      something other than the search ranking that produced it, because the
//      ranking is the very thing under test. Three ways, in descending strength:
//
//        a. SHARED BOARD (Greenhouse, Lever, Ashby). The host is a fixed vendor
//           suffix and the employer's board slug is the first path segment.
//        b. TENANT PLATFORM (Workday, iCIMS). The host is a fixed vendor suffix and
//           the employer's tenant is a host label. Because these platforms also
//           serve prominent index and faceted-search URLs, a result must ALSO carry
//           a posting id in its path (gate 5) to be a posting rather than a listing.
//        c. EMPLOYER DOMAIN (careers.acmetechnologies.com). No vendor suffix
//           exists, so the evidence is the domain's own identity label being the
//           company's name -- which comes from the lead, not from the result being
//           judged. A domain label is global rather than namespaced inside a trusted
//           vendor, so here EQUALITY against the WHOLE company name is required
//           where (a) and (b) accept a containment relation on a truncation; the
//           host must be a shape this module recognizes as a registrable domain; a
//           one-word company is declined entirely, because with one token this gate
//           and gate 3 become the same test; and gates 3 and 4 are both raised.
//
//      (a) and (b) are what lib/resolve-canonical.mjs classifies as canonical,
//      tested with its own exported table so the classifier and the resolver cannot
//      disagree about a URL Tier 2 marks `canonical`. All three exclude the
//      aggregator and tracking-link hosts this plugin exists to escape, and, via
//      each pattern's end anchor, lookalike domains.
//   2. EMPLOYER. The tenant token -- the board slug in the path for (a), the host
//      label for (b) -- must be relatable to the company name. Requiring equality
//      would be pointless for (a) (Tier 1 already probes those exact slugs), so a
//      containment relation with a length floor is the evidence: it accepts the
//      real Tier-1 miss class (a board token that is a variant of the display name,
//      "acmetech" for "Acme Technologies") and rejects an unrelated employer's
//      board. (c) does not use this gate; its 1c equality test is stricter.
//   3. CORROBORATION. The company's own tokens must appear in the result's title or
//      snippet. Gate 2 alone would let "metabase" pass for "Meta"; this one catches
//      that, and the two together are much harder to satisfy by accident than
//      either is alone. On a vendor host, two tokens suffice, because the tenant
//      token has already tied the posting to the employer. On an employer domain
//      corroboration is carrying that weight alone, so EVERY company token must
//      appear.
//   4. TITLE, AND UNIQUENESS. The role must clear the same symmetric Jaccard
//      threshold Tier 1 uses -- raised for (c), where a wrong-but-adjacent role on
//      the employer's real site is the most plausible remaining mistake -- and must
//      be the only result of its class that does. A tie is an arbitrary pick, so it
//      falls back, exactly as bestPosting does.
//   5. POSTING SHAPE, for (b) and (c) only. A shared board serves postings and
//      little else, but a tenant platform and a careers site both serve indexes,
//      faceted searches, and articles that a title match alone cannot distinguish
//      from a posting. A listing page is also the more damaging error, because it
//      outlives the role it was showing. A ROLE-SCOPED listing is the hardest of
//      them: it is about the right role at the right employer, so gates 2 to 4 all
//      hold, and only its URL says it is a category.
//
// PRECEDENCE. A host-classified result (a, b) is preferred over an employer-domain
// one (c) whenever both clear their gates, so the stronger evidence wins and the
// emitted lead carries `canonical` wherever it honestly can.
//
// WHAT THIS STILL DECLINES, on purpose:
//   - An employer domain whose label is not exactly the company's name: acmetech.com
//     or trynova.io for "Acme Technologies" / "Nova", and equally acme.com or
//     acme.tk, which is the same guess made shorter. Nothing here establishes that
//     such a domain belongs to that employer, and a relation short of equality on a
//     GLOBAL namespace is how a confident, wrong employer gets emitted.
//   - Any bespoke domain for a ONE-WORD company, whose name cannot carry this class
//     (see employerDomainSlugs).
//   - A host shape this module does not recognize as a registrable domain, which is
//     an allowlist of shapes and deliberately not a public-suffix list.
//   - A role-scoped listing ("/vp-marketing-jobs"), a faceted search, and a segment
//     dated by a calendar year rather than identified by a requisition id.
//   - A vendor whose tenant location and posting-URL shape have not been verified
//     from that vendor's own material. Adding one is a row in
//     CANONICAL_HOST_FAMILIES; guessing one is how a whole class silently breaks.
// Each of those keeps the honest search fallback.
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
  return bestSearchResult(
    title,
    companySlugs,
    employerDomainSlugs(company),
    companyTokens,
    results,
  );
}

// buildTavilyQuery phrases the lead as a natural search for the employer's own
// posting. It never carries the tracking link.
function buildTavilyQuery(title, company) {
  return `${title} ${company} careers job posting`;
}

// bestSearchResult applies the acceptance gates and returns the single clear winner
// as { url, employerHosted }, or null when nothing clears the bar or two results of
// the same class tie. Host-classified results are preferred over employer-domain
// ones: only when no vendor host survives is the weaker-evidence class consulted.
function bestSearchResult(leadTitle, companySlugs, employerSlugs, companyTokens, results) {
  const leadTokens = titleTokens(leadTitle);
  const hosted = new Map(); // vendor host (shared board or tenant platform)
  const employer = new Map(); // the employer's own domain

  for (const result of results) {
    const url = typeof result?.url === 'string' ? result.url.trim() : '';
    if (url === '') continue;
    const parsed = parseUrl(url);
    if (!parsed) continue;

    const resultTitle = String(result?.title ?? '');
    const haystack = `${resultTitle} ${String(result?.content ?? '')}`;
    const score = titleScore(leadTokens, pageTitleTokens(resultTitle, companyTokens));

    const family = canonicalHostFamily(parsed.hostname);
    if (family) {
      // Gate 2: the tenant token must be relatable to the company. A shared board
      // carries it in the first path segment; a per-employer tenant, in the host.
      const tenant = family.tenant === 'host' ? firstHostLabel(parsed) : firstPathSegment(parsed);
      if (!slugRelated(tenant, companySlugs)) continue;
      // Gate 5: a platform that also serves indexes must prove this is a posting.
      if (family.postingPath === true && !hasPostingId(parsed)) continue;
      // Gate 3, vendor strength: two of the company's tokens.
      if (!companyCorroborated(companyTokens, haystack)) continue;
      // Gate 4a, vendor strength: Tier 1's own symmetric title threshold.
      if (score < MATCH_THRESHOLD) continue;
      keepBest(hosted, url, score);
      continue;
    }

    // Gate 1c: the employer's own domain, identified from the company name rather
    // than from this result's ranking.
    if (!employerDomainOwns(parsed, employerSlugs)) continue;
    // Gate 5: a careers site serves indexes and articles too.
    if (!looksLikeEmployerPosting(parsed, leadTokens)) continue;
    // Gate 3, raised: EVERY company token, because no tenant token backs this up.
    if (!fullyCorroborated(companyTokens, haystack)) continue;
    // Gate 4a, raised: an adjacent role on the employer's real site is the most
    // plausible remaining mistake, and the least visible one.
    if (score < EMPLOYER_MATCH_THRESHOLD) continue;
    keepBest(employer, url, score);
  }

  // "Nothing in this class cleared the gates" and "two in this class cleared and
  // tied" are different states and must not share an answer. The first says the
  // stronger evidence is simply absent, which is what makes consulting the weaker
  // class honest. The second says the stronger evidence is present but does not
  // single out a URL -- and a class below is not a tie-breaker for the class above
  // it, so reading a tie as absence promotes a weaker-evidence result over the very
  // ambiguity that disqualified the stronger one.
  const hostedPick = topScorer(hosted);
  if (hostedPick.tied) return null;
  if (hostedPick.url !== null) return { url: hostedPick.url, employerHosted: false };
  const employerPick = topScorer(employer);
  if (employerPick.tied || employerPick.url === null) return null;
  return { url: employerPick.url, employerHosted: true };
}

// keepBest records a url's score, keeping the highest when the same url arrives more
// than once. Tavily can return one page twice, and the two occurrences carry
// different page titles; overwriting would let the weaker of them decide, which
// either demotes the right posting below another result or manufactures a tie out of
// one posting's two descriptions. The url is one posting either way, so the best
// evidence for it is what stands.
function keepBest(byUrl, url, score) {
  const seen = byUrl.get(url);
  if (seen === undefined || score > seen) byUrl.set(url, score);
}

// topScorer reports the highest-scoring url in a class AND whether the top score is
// shared, and leaves what to do about it to the caller. Reporting a tie as "no url"
// is exactly the conflation above: the caller has to tell an empty class from a tied
// one, so this returns the state rather than a verdict.
function topScorer(byUrl) {
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
  return { url: best, tied };
}

// employerDomainOwns decides whether a URL sits on a domain the company itself
// plausibly registered. Two conditions, both necessary:
//
//   - the host, after at most one leading careers-style label is set aside, is a
//     shape this module recognizes as a registrable domain: `label.tld`, or
//     `label.xx.yy` where `xx` is one of the second-level heads that precede a
//     two-letter country code. This is an allowlist of shapes, NOT a public-suffix
//     list; a host it does not recognize is declined rather than guessed at, which
//     is what keeps acmetechnologies.jobs-mirror.example from reading as "acme-
//     technologies owns this".
//   - that identity label EQUALS a slug built from the WHOLE company name. A board
//     slug only needs a containment relation because it is namespaced inside a
//     vendor whose host is already trusted; a domain label is global, so
//     acmetech.com and acmetechnologies.com may be entirely different owners and
//     containment would be a guess dressed as evidence -- and so, with more force,
//     would equality against a TRUNCATION of the name. `candidateSlugs` offers the
//     first word so Tier 1 can probe a board named after it, where a wrong guess
//     costs a 404; here a wrong guess is emitted to the reader as the employer's own
//     site, so employerDomainSlugs supplies the full-name forms only.
function employerDomainOwns(parsed, employerSlugs) {
  if (employerSlugs.length === 0) return false;
  const label = registrableIdentityLabel(parsed.hostname);
  if (label === null) return false;
  return employerSlugs.some((slug) => slug === label);
}

// employerDomainSlugs returns the domain labels that ARE this company's name: the
// joined and hyphen-joined forms of every significant word, in that order. No
// truncation, and nothing for a one-word company.
//
// A one-word company is declined outright, and the reason is not that the rule is
// violated -- for "Nova" the full-name form IS "nova", so `nova.io` satisfies it
// exactly. It is that the gates stop being independent. Identity asks "is the label
// the company's name" and corroboration asks "does every company token appear"; with
// one token those are the same question asked twice, so the defence in depth the
// bespoke class is built on collapses to a single common word on a global namespace
// -- which is precisely what an unrelated registrant of that word holds. There is no
// honest second signal to substitute: a length floor on the label would be an
// invented threshold, and a TLD allowlist would be the public-suffix list this module
// deliberately refuses to guess at. So this class keeps the search fallback, and a
// one-word employer resolves through its shared board or tenant platform or not at all.
function employerDomainSlugs(company) {
  const words = companyWords(company);
  if (words.length < 2) return [];
  const forms = [words.join(''), words.join('-')];
  return forms.filter((form, i) => form.length >= 2 && forms.indexOf(form) === i);
}

// registrableIdentityLabel returns the label that identifies the registrant, or null
// when the host is not a shape this module recognizes.
function registrableIdentityLabel(hostname) {
  let labels = String(hostname ?? '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  if (labels[0] === 'www') labels = labels.slice(1);
  if (labels.length > 2 && CAREERS_SUBDOMAINS.has(labels[0])) labels = labels.slice(1);

  if (labels.length === 2) return labels[0];
  if (labels.length === 3 && SECOND_LEVEL_SUFFIX_HEADS.has(labels[1]) && labels[2].length === 2) {
    return labels[0];
  }
  return null;
}

// looksLikeEmployerPosting decides whether a URL on the employer's own domain
// denotes ONE posting rather than a careers index, a search, or an article. The
// employer must be talking about jobs at all (a careers-style subdomain or a
// job-word path segment), and the final segment must identify a specific posting:
// either a posting id, or enough of the role's own words that it cannot be a list.
//
// There is no separate guard for a single job-word segment on a bare domain
// ("acmetechnologies.com/jobs"). Reaching that case means the path is one segment
// long and that segment carries a job word, since a bare domain gets here only via
// jobWordInPath; a job word carries no digits, so it is not a posting id, and it is
// rejected below as a category word. The guard could never change the outcome.
function looksLikeEmployerPosting(parsed, leadTokens) {
  const segments = pathSegments(parsed);
  if (segments.length === 0) return false;
  // A path that says it serves a list is a list, whatever else it carries.
  if (looksLikeListingPath(segments)) return false;
  const careersHost = CAREERS_SUBDOMAINS.has(firstHostLabel(parsed));
  const jobWordInPath = segments.some((segment) =>
    segmentTokens(segment).some((token) => JOB_PATH_WORDS.has(token)),
  );
  if (!careersHost && !jobWordInPath) return false;

  const last = segments[segments.length - 1];
  if (isPostingIdSegment(last)) return true;
  // The final segment has to name the posting, and a vocabulary word in it names a
  // CATEGORY of postings ("vp-marketing-jobs", "vp-marketing-opportunities") rather
  // than one. This is the strictest reading of the vocabulary, and it belongs here:
  // with no posting id and no vendor host, this segment is the whole of the
  // evidence, so a word that could make it a category disqualifies it wherever it
  // sits -- where looksLikeListingPath, which also judges vendor paths that carry a
  // requisition id, only reads a word that brackets a segment.
  //
  // A vocabulary word is also never a role word: pageTitleTokens already drops it
  // from the result title, so a page titled "VP Marketing Jobs" scores a perfect
  // match against a "VP Marketing" lead -- while counting the same word here as one
  // of the role's own words let the category page clear this gate by carrying the
  // very word that marks it as a category.
  const lastTokens = segmentTokens(last);
  if (lastTokens.some((token) => CATEGORY_PATH_WORDS.has(token))) return false;
  const roleTokens = new Set(lastTokens);
  let shared = 0;
  for (const token of new Set(leadTokens)) if (roleTokens.has(token)) shared++;
  return shared >= 2;
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

// fullyCorroborated is the raised bar an employer domain must clear: every one of
// the company's significant tokens has to appear. "Northstar Health" is enough to
// corroborate on a board slug that already says northstar-technologies; on
// northstar.com it is exactly the ambiguity that would emit the wrong employer.
function fullyCorroborated(companyTokens, text) {
  const present = new Set(titleTokens(text));
  return companyTokens.every((token) => present.has(token));
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
  return pathSegments(parsed)[0] ?? '';
}

function firstHostLabel(parsed) {
  const labels = parsed.hostname.toLowerCase().split('.').filter(Boolean);
  return labels[0] === 'www' ? (labels[1] ?? '') : (labels[0] ?? '');
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

// companyWords reduces a company name to the words a slug is built from:
// lowercased, ampersands spelled out, punctuation collapsed, trailing legal-entity
// suffixes dropped.
function companyWords(company) {
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
  return words;
}

// candidateSlugs derives the board-slug guesses to probe from a company name,
// offered as the joined, hyphenated, and first-word forms (deduped, order kept).
// The first-word form is a guess, and it is safe HERE because a wrong guess is a
// 404 from a board API. It is not safe as a domain-identity test -- see
// employerDomainSlugs.
export function candidateSlugs(company) {
  const words = companyWords(company);
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
function logSummary(ctx, { viaAts, viaTavily, viaEmployer, viaFallback, alreadyCanonical }) {
  if (typeof ctx?.log !== 'function') return;
  ctx.log(
    `job-alerts: canonical resolution resolved ${viaAts} via ATS, ` +
      `${viaTavily} via Tavily, ${viaEmployer} via an employer site, ` +
      `${viaFallback} via search fallback (${alreadyCanonical} already canonical).`,
  );
}
