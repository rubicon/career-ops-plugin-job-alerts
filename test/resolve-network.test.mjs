// Unit tests for the network resolver (lib/resolve-network.mjs): Tier-1 ATS probes,
// Tier-2 Tavily search, and the live search-URL fallback.
// Hermetic: no network. A fake ctx.fetchJson returns captured public ATS response
// shapes (Greenhouse boards-api, Lever postings, Ashby public posting-api) and the
// captured Tavily Search response shape, and mirrors the engine's throw-on-non-2xx
// contract so a probe for a board that does not exist rejects with a 404, exactly as
// the guarded fetch would. The tests exercise real slug derivation, real
// request-building, and real title matching against those real shapes; they never
// assert that a stub was merely called.
//
// Optional live integration tests run only when RUN_LIVE_ATS / RUN_LIVE_TAVILY are
// set and are skipped otherwise, so CI stays zero-network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveNetwork, candidateSlugs, buildSearchUrl } from '../lib/resolve-network.mjs';

let pass = 0;
let fail = 0;
async function ta(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.stack || e.message}`);
  }
}
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.stack || e.message}`);
  }
}

// A tracking link (non-ATS host). Its host must NEVER appear in an emitted url.
const TRACKER = 'https://click.indeed.com/redirect?jk=ABC123';

// Build a fake ctx whose fetchJson maps a URL substring to a captured response. A
// URL with no matching route rejects with a 404, modeling the guarded fetch's
// throw-on-non-2xx contract for a board that does not exist. `calls` records the
// requested URLs; `requests` records the full { url, options } pair so a test can
// assert the real request contract (method, headers, body) that was built.
function makeCtx({ routes = {}, logs, env = {} } = {}) {
  const calls = [];
  const requests = [];
  async function fetchJson(url, options) {
    calls.push(url);
    requests.push({ url, options });
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) {
        const spec = typeof routes[key] === 'function' ? routes[key]() : routes[key];
        if (spec && spec.status && spec.status >= 300) {
          const err = new Error(`HTTP ${spec.status}`);
          err.status = spec.status;
          throw err;
        }
        return spec.json;
      }
    }
    const err = new Error('HTTP 404');
    err.status = 404;
    throw err;
  }
  const log = (...args) => {
    if (logs) logs.push(args.join(' '));
  };
  return { fetchJson, calls, requests, log, env };
}

// -- captured ATS response shapes (from the official public API docs) -----
// Greenhouse Job Board API: GET boards-api.greenhouse.io/v1/boards/{token}/jobs
// -> { jobs: [ { id, title, absolute_url, location: { name } } ], meta: { total } }
function greenhouseBoard() {
  return {
    json: {
      jobs: [
        {
          id: 4001,
          title: 'Software Engineer',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/4001',
          location: { name: 'Remote' },
        },
        {
          id: 4007,
          title: 'VP, Marketing',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/4007',
          location: { name: 'New York, NY' },
        },
      ],
      meta: { total: 2 },
    },
  };
}

// Lever Postings API: GET api.lever.co/v0/postings/{site}?mode=json
// -> [ { id, text, hostedUrl, applyUrl, categories: { location, team } } ]
function leverBoard() {
  return {
    json: [
      {
        id: 'a1',
        text: 'Head of Growth',
        hostedUrl: 'https://jobs.lever.co/acme/a1',
        applyUrl: 'https://jobs.lever.co/acme/a1/apply',
        categories: { location: 'San Francisco', team: 'Marketing' },
      },
      {
        id: 'b2',
        text: 'Chief Marketing Officer',
        hostedUrl: 'https://jobs.lever.co/acme/b2',
        applyUrl: 'https://jobs.lever.co/acme/b2/apply',
        categories: { location: 'Remote', team: 'Executive' },
      },
    ],
  };
}

// Ashby public Posting API: GET api.ashbyhq.com/posting-api/job-board/{name}
// -> { apiVersion, jobs: [ { title, location, jobUrl, applyUrl, isListed } ] }
function ashbyBoard() {
  return {
    json: {
      apiVersion: '1',
      jobs: [
        {
          title: 'VP of Marketing',
          location: 'Remote',
          jobUrl: 'https://jobs.ashbyhq.com/acme/1111-2222',
          applyUrl: 'https://jobs.ashbyhq.com/acme/1111-2222/application',
          isListed: true,
        },
        {
          title: 'Unlisted Confidential Role',
          location: 'Remote',
          jobUrl: 'https://jobs.ashbyhq.com/acme/9999-0000',
          isListed: false,
        },
      ],
    },
  };
}

// Tavily Search API: POST https://api.tavily.com/search
// Auth header: `Authorization: Bearer tvly-...`, body content type application/json.
// Request body: { query, search_depth, max_results, topic, ... }
// -> { query, results: [ { title, url, content, score, raw_content } ],
//      response_time, request_id }
// (docs.tavily.com/documentation/api-reference/endpoint/search)
function tavilyResponse(results) {
  return {
    json: {
      query: 'VP Marketing Acme Technologies careers job posting',
      results,
      response_time: 1.24,
      request_id: '4d1c9f6e-2a77-4f1b-9c33-8b0e5a1d7f42',
    },
  };
}

const GH_KEY = 'boards-api.greenhouse.io/v1/boards/acme/jobs';
const LEVER_KEY = 'api.lever.co/v0/postings/acme';
const ASHBY_KEY = 'api.ashbyhq.com/posting-api/job-board/acme';
const TAVILY_KEY = 'api.tavily.com/search';
const TAVILY_ENV = { TAVILY_API_KEY: 'tvly-dev-testkey000000000000000000000' };

// A Tier-2 lead: the board slug ("acmetech") is NOT derivable from the display name,
// so every Tier-1 probe misses and Tier 2 is the only path to the canonical posting.
function tier2Lead(title = 'VP Marketing') {
  return {
    title,
    url: TRACKER,
    company: 'Acme Technologies',
    location: '',
    canonical: false,
    status: 'needs-canonical',
  };
}

// -- slug derivation ------------------------------------------------------
t('candidateSlugs lowercases, strips punctuation, and drops legal suffixes', () => {
  assert.deepEqual(candidateSlugs('Acme, Inc.'), ['acme']);
  assert.deepEqual(candidateSlugs('Acme Corp'), ['acme']);
});
t('candidateSlugs offers joined, hyphenated, and first-word forms for multi-word names', () => {
  assert.deepEqual(candidateSlugs('Rippling People'), [
    'ripplingpeople',
    'rippling-people',
    'rippling',
  ]);
});
t('candidateSlugs returns nothing for an empty or punctuation-only company', () => {
  assert.deepEqual(candidateSlugs(''), []);
  assert.deepEqual(candidateSlugs('   '), []);
  assert.deepEqual(candidateSlugs(null), []);
});

// -- search-fallback URL --------------------------------------------------
t('buildSearchUrl produces a live Google careers search over title and company', () => {
  const url = buildSearchUrl('VP Marketing', 'Acme');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.google.com/search');
  assert.equal(u.searchParams.get('q'), '"VP Marketing" Acme careers');
});
t('buildSearchUrl never embeds a tracker and is always a real URL', () => {
  const url = buildSearchUrl('VP Marketing', 'Acme');
  assert.doesNotMatch(url, /indeed\.com/);
  assert.doesNotThrow(() => new URL(url));
});

// -- Tier-1 hit per ATS (canonical URL extracted, fuzzy title matched) -----
await ta(
  'Greenhouse hit: unique title match returns absolute_url and the posting location',
  async () => {
    const ctx = makeCtx({ routes: { [GH_KEY]: greenhouseBoard() } });
    const [lead] = await resolveNetwork(ctx, [
      {
        title: 'VP Marketing',
        url: TRACKER,
        company: 'Acme',
        location: '',
        canonical: false,
        status: 'needs-canonical',
      },
    ]);
    // The canonical url is the EXACT field from the real response, not fabricated.
    assert.equal(lead.url, 'https://boards.greenhouse.io/acme/jobs/4007');
    assert.equal(lead.canonical, true);
    assert.equal(lead.status, 'canonical');
    assert.equal(lead.resolvedVia, 'ats');
    // The matched posting's location is carried onto the lead.
    assert.equal(lead.location, 'New York, NY');
    // The tracker is gone.
    assert.notEqual(lead.url, TRACKER);
    assert.doesNotMatch(lead.url, /indeed\.com/);
  },
);

await ta('Lever hit: unique title match returns hostedUrl and the posting location', async () => {
  const ctx = makeCtx({ routes: { [LEVER_KEY]: leverBoard() } });
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'Chief Marketing Officer',
      url: TRACKER,
      company: 'Acme',
      location: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.equal(lead.url, 'https://jobs.lever.co/acme/b2');
  assert.equal(lead.canonical, true);
  assert.equal(lead.resolvedVia, 'ats');
  assert.equal(lead.location, 'Remote');
  assert.notEqual(lead.url, TRACKER);
});

await ta('Ashby hit: unique title match returns jobUrl and the posting location', async () => {
  const ctx = makeCtx({ routes: { [ASHBY_KEY]: ashbyBoard() } });
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'VP of Marketing',
      url: TRACKER,
      company: 'Acme',
      location: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.equal(lead.url, 'https://jobs.ashbyhq.com/acme/1111-2222');
  assert.equal(lead.canonical, true);
  assert.equal(lead.resolvedVia, 'ats');
  assert.equal(lead.location, 'Remote');
});

await ta('Ashby: an unlisted posting is never surfaced as the match', async () => {
  const ctx = makeCtx({ routes: { [ASHBY_KEY]: ashbyBoard() } });
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'Unlisted Confidential Role',
      url: TRACKER,
      company: 'Acme',
      location: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  // The only title match is unlisted, so it must not be emitted; falls back.
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /ashbyhq\.com/);
  assert.doesNotMatch(lead.url, /indeed\.com/);
});

// -- Tier-1 miss (probe 404s) -> live search fallback, never the tracker ---
await ta('miss: no board exists (every probe 404s) -> live search fallback', async () => {
  const ctx = makeCtx({ routes: {} }); // every fetchJson rejects with 404
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'VP Marketing',
      url: TRACKER,
      company: 'Acme',
      location: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(lead.searchFallback, true);
  assert.equal(lead.canonical, false);
  // The emitted url is the exact live search fallback, NEVER the tracker.
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme'));
  assert.notEqual(lead.url, TRACKER);
  assert.doesNotMatch(lead.url, /indeed\.com/);
  // The resolver probed at least the known ATS hosts before giving up.
  assert.ok(ctx.calls.some((u) => u.includes('boards-api.greenhouse.io')));
  assert.ok(ctx.calls.some((u) => u.includes('api.lever.co')));
  assert.ok(ctx.calls.some((u) => u.includes('api.ashbyhq.com')));
});

await ta('miss: board exists but no title matches -> search fallback, no fabrication', async () => {
  // Greenhouse board resolves (2xx) but holds no role resembling the lead title.
  const ctx = makeCtx({ routes: { [GH_KEY]: greenhouseBoard() } });
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'General Counsel',
      url: TRACKER,
      company: 'Acme',
      location: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  // No greenhouse posting URL was invented from a non-matching board.
  assert.doesNotMatch(lead.url, /greenhouse\.io/);
  assert.equal(lead.url, buildSearchUrl('General Counsel', 'Acme'));
});

// -- ambiguity and weak matches must fall back, never guess ---------------
await ta(
  'ambiguous match: two postings tie at the top score -> search fallback, no guess',
  async () => {
    // Both regional postings share exactly the two lead tokens, so they tie. Picking
    // either would be an arbitrary guess, so the resolver must fall back instead.
    const ctx = makeCtx({
      routes: {
        [GH_KEY]: {
          json: {
            jobs: [
              {
                id: 5001,
                title: 'VP Marketing, EMEA',
                absolute_url: 'https://boards.greenhouse.io/acme/jobs/5001',
                location: { name: 'London' },
              },
              {
                id: 5002,
                title: 'VP Marketing, Americas',
                absolute_url: 'https://boards.greenhouse.io/acme/jobs/5002',
                location: { name: 'New York, NY' },
              },
            ],
            meta: { total: 2 },
          },
        },
      },
    });
    const [lead] = await resolveNetwork(ctx, [
      {
        title: 'VP Marketing',
        url: TRACKER,
        company: 'Acme',
        canonical: false,
        status: 'needs-canonical',
      },
    ]);
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.doesNotMatch(lead.url, /greenhouse\.io/, 'no arbitrary posting URL is emitted on a tie');
    assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme'));
  },
);

await ta(
  'generic-title superset: a short lead inside a longer posting does not match',
  async () => {
    // "Marketing Manager" (2 tokens) sits inside "Senior Product Marketing Manager"
    // (4 tokens): Jaccard 2/4 = 0.5, below threshold. A symmetric measure refuses this
    // where pure containment would have scored a false 1.0.
    const ctx = makeCtx({
      routes: {
        [GH_KEY]: {
          json: {
            jobs: [
              {
                id: 6001,
                title: 'Senior Product Marketing Manager',
                absolute_url: 'https://boards.greenhouse.io/acme/jobs/6001',
                location: { name: 'Remote' },
              },
            ],
            meta: { total: 1 },
          },
        },
      },
    });
    const [lead] = await resolveNetwork(ctx, [
      {
        title: 'Marketing Manager',
        url: TRACKER,
        company: 'Acme',
        canonical: false,
        status: 'needs-canonical',
      },
    ]);
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.doesNotMatch(lead.url, /greenhouse\.io/, 'a weak partial overlap is not a hit');
    assert.equal(lead.url, buildSearchUrl('Marketing Manager', 'Acme'));
  },
);

// -- already-canonical passthrough (no I/O) --------------------------------
await ta('an already-canonical lead is passed through untouched with no fetch', async () => {
  const ctx = makeCtx({ routes: { [GH_KEY]: greenhouseBoard() } });
  const input = {
    title: 'VP, Marketing',
    url: 'https://boards.greenhouse.io/acme/jobs/4007',
    company: 'Acme',
    location: 'New York, NY',
    canonical: true,
    status: 'canonical',
  };
  const [lead] = await resolveNetwork(ctx, [input]);
  assert.equal(lead.url, input.url);
  assert.equal(lead.canonical, true);
  assert.equal(ctx.calls.length, 0, 'a canonical lead triggers no network probe');
});

// -- the tracker is NEVER emitted, across a mixed batch --------------------
await ta('across a mixed batch, no emitted url is ever the dead tracking link', async () => {
  const ctx = makeCtx({ routes: { [GH_KEY]: greenhouseBoard() } });
  const leads = await resolveNetwork(ctx, [
    {
      title: 'VP Marketing at Acme',
      url: TRACKER,
      company: 'Acme',
      canonical: false,
      status: 'needs-canonical',
    },
    {
      title: 'General Counsel',
      url: TRACKER,
      company: 'Acme',
      canonical: false,
      status: 'needs-canonical',
    },
    {
      title: 'Chief People Officer',
      url: 'https://t.co/xyz',
      company: 'Nowhere',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  for (const lead of leads) {
    assert.notEqual(lead.url, TRACKER);
    assert.doesNotMatch(lead.url, /indeed\.com/);
    assert.doesNotMatch(lead.url, /t\.co/);
    assert.doesNotThrow(() => new URL(lead.url), 'every emitted url is a real URL');
  }
});

// -- per-tier counts are logged for transparency --------------------------
await ta('resolveNetwork logs per-tier resolution counts', async () => {
  const logs = [];
  const ctx = makeCtx({ routes: { [GH_KEY]: greenhouseBoard() }, logs });
  await resolveNetwork(ctx, [
    {
      title: 'VP Marketing at Acme',
      url: TRACKER,
      company: 'Acme',
      canonical: false,
      status: 'needs-canonical',
    },
    {
      title: 'General Counsel',
      url: TRACKER,
      company: 'Acme',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.ok(
    logs.some((l) => /ATS/i.test(l) && /search fallback/i.test(l)),
    'a summary line names both the ATS and search-fallback counts',
  );
});

// -- a needs-canonical lead with no company never touches the network ------
await ta('an empty-company lead falls back without any probe', async () => {
  const ctx = makeCtx({ routes: {} });
  const [lead] = await resolveNetwork(ctx, [
    {
      title: 'VP Marketing',
      url: TRACKER,
      company: '',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(ctx.calls.length, 0, 'no slug means no probe');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', ''));
});

// == Tier 2: Tavily canonical search ======================================
// Tier 2 sits between the Tier-1 ATS probe and the search-URL fallback. It runs
// only for a lead every Tier-1 probe missed, and only when TAVILY_API_KEY is set.

// -- the manifest must actually permit the egress Tier 2 needs -------------
t('manifest allows api.tavily.com and still requires no env', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
  // Without this host the engine blocks the Tier-2 call and the tier silently
  // never fires, so the manifest entry is part of the feature, not packaging.
  assert.ok(
    manifest.allowedHosts.includes('api.tavily.com'),
    'api.tavily.com must be in manifest.allowedHosts',
  );
  // TAVILY_API_KEY is optional: the plugin must never demand it.
  assert.deepEqual(manifest.requiredEnv, []);
});

// -- Tier-2 hit ------------------------------------------------------------
await ta('Tier-2 hit: Tavily pins the canonical ATS posting Tier 1 could not guess', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.8612,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  // The canonical url is the EXACT url field from the real response, not fabricated.
  assert.equal(lead.url, 'https://boards.greenhouse.io/acmetech/jobs/7788');
  assert.equal(lead.canonical, true);
  assert.equal(lead.status, 'canonical');
  assert.equal(lead.resolvedVia, 'tavily');
  // The tracker is gone.
  assert.notEqual(lead.url, TRACKER);
  assert.doesNotMatch(lead.url, /indeed\.com/);
  // Tier 1 was tried first and genuinely missed before Tier 2 ran.
  assert.ok(ctx.calls.some((u) => u.includes('boards-api.greenhouse.io')));
});

// -- the real Tavily request contract, built from the official docs --------
await ta('Tier-2 builds the documented Tavily POST request', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: { [TAVILY_KEY]: tavilyResponse([]) },
  });
  await resolveNetwork(ctx, [tier2Lead()]);

  const req = ctx.requests.find((r) => r.url.includes('api.tavily.com'));
  assert.ok(req, 'Tier 2 issued a Tavily request');
  assert.equal(req.url, 'https://api.tavily.com/search');
  assert.equal(req.options.method, 'POST');

  const headers = Object.fromEntries(
    Object.entries(req.options.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  assert.equal(headers.authorization, `Bearer ${TAVILY_ENV.TAVILY_API_KEY}`);
  assert.equal(headers['content-type'], 'application/json');

  const body = JSON.parse(req.options.body);
  assert.equal(typeof body.query, 'string');
  assert.ok(body.query.includes('VP Marketing'), 'the query carries the role title');
  assert.ok(body.query.includes('Acme Technologies'), 'the query carries the company');
  // max_results is documented as 0..20; anything else is a rejected request.
  assert.equal(typeof body.max_results, 'number');
  assert.ok(body.max_results >= 1 && body.max_results <= 20);
  assert.ok(['basic', 'advanced', 'fast', 'ultra-fast'].includes(body.search_depth));
  assert.ok(['general', 'news', 'finance'].includes(body.topic));
});

// -- optional key: absent means the tier never runs ------------------------
await ta('no TAVILY_API_KEY: Tier 2 never fires and the existing fallback stands', async () => {
  const ctx = makeCtx({ env: {}, routes: { [TAVILY_KEY]: tavilyResponse([]) } });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.ok(
    !ctx.calls.some((u) => u.includes('api.tavily.com')),
    'an absent key means no Tavily request at all',
  );
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(lead.searchFallback, true);
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
  assert.notEqual(lead.url, TRACKER);
});

// -- Tier 1 wins: Tier 2 must not run for a lead Tier 1 already resolved ---
await ta('a Tier-1 hit short-circuits Tier 2 entirely', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: { [GH_KEY]: greenhouseBoard(), [TAVILY_KEY]: tavilyResponse([]) },
  });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: 'Acme', canonical: false },
  ]);
  assert.equal(lead.resolvedVia, 'ats');
  assert.ok(
    !ctx.calls.some((u) => u.includes('api.tavily.com')),
    'Tier 2 is skipped when Tier 1 already pinned the posting',
  );
});

// -- false-positive discipline: prefer the fallback over a wrong hit -------
await ta('Tier-2 miss: aggregator results are never accepted as canonical', async () => {
  // The whole point of the plugin is escaping aggregator/tracking links, so a
  // result that is one cannot be the answer no matter how relevant it looks.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing at Acme Technologies | LinkedIn',
          url: 'https://www.linkedin.com/jobs/view/3912345678',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.94,
          raw_content: null,
        },
        {
          title: 'VP Marketing - Acme Technologies - Indeed.com',
          url: 'https://www.indeed.com/viewjob?jk=ZZZ999',
          content: 'Acme Technologies VP Marketing role.',
          score: 0.91,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
  assert.doesNotMatch(lead.url, /linkedin\.com/);
  assert.doesNotMatch(lead.url, /indeed\.com/);
});

await ta('Tier-2 miss: an aggregator is rejected on its host alone', async () => {
  // This result clears every OTHER gate: the path starts with the company's own
  // board slug, the company is named in the title and snippet, and the role matches
  // exactly. Only the host gate stands between it and being emitted as canonical,
  // so this is what proves that gate carries its own weight.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing at Acme Technologies',
          url: 'https://www.ziprecruiter.com/acmetech/vp-marketing',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.95,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /ziprecruiter\.com/);
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta('Tier-2 miss: a lookalike ATS domain is rejected', async () => {
  // "boards.greenhouse.io.jobs-mirror.example" merely CONTAINS a canonical host.
  // Every other gate passes, so this proves the host regex is anchored and that a
  // suffix-lookalike cannot impersonate a canonical board.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io.jobs-mirror.example/acmetech/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.93,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /jobs-mirror/);
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta("Tier-2 miss: the right company named on someone else's board is rejected", async () => {
  // A page on Globex's board that names Acme Technologies and the exact role: an
  // agency listing, a partner post, a cross-post. Host, corroboration and title all
  // pass, so only the board-slug gate can reject it. Emitting Globex's URL for an
  // Acme role would be precisely the confident-but-wrong hit this tier must avoid.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://jobs.lever.co/globex/9f2a1b',
          content: 'Acme Technologies is hiring a VP Marketing. Apply through Globex.',
          score: 0.92,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /lever\.co/, "another employer's board is never the answer");
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta('Tier-2 miss: a lookalike company on a real ATS board is rejected', async () => {
  // "metabase" contains "meta", so the slug relation alone would pass. Only the
  // corroboration gate notices that nothing here actually names Meta, which is what
  // proves that gate is load-bearing rather than decorative.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Metabase',
          url: 'https://boards.greenhouse.io/metabase/jobs/4242',
          content: 'Metabase is hiring a VP Marketing to lead the team.',
          score: 0.89,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: 'Meta', canonical: false },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(
    lead.url,
    /greenhouse\.io/,
    'a name that merely contains the company is not the company',
  );
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Meta'));
});

await ta('Tier-2 miss: a matching title on ANOTHER employer board is rejected', async () => {
  // The single most dangerous false positive: right role, right shape, wrong
  // company. Nothing about the URL ties it to the lead's employer.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Globex Industries',
          url: 'https://jobs.lever.co/globex/9f2a1b',
          content: 'Globex Industries is hiring a VP Marketing.',
          score: 0.88,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /lever\.co/, 'no other employer posting is emitted');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta('Tier-2 miss: the right employer but a more senior sibling role is rejected', async () => {
  // Same symmetric title discipline as Tier 1: "Marketing Manager" inside
  // "Senior Product Marketing Manager" is a weak partial overlap, not a match,
  // even though the company and the board are both correct.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for Senior Product Marketing Manager at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/7799',
          content: 'Acme Technologies is hiring a Senior Product Marketing Manager.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead('Marketing Manager')]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /greenhouse\.io/, 'a weak partial overlap is not a hit');
  assert.equal(lead.url, buildSearchUrl('Marketing Manager', 'Acme Technologies'));
});

await ta('Tier-2 miss: two equally good results tie, so nothing is guessed', async () => {
  // Both regional postings clear every gate and score identically. Picking either
  // would be an arbitrary guess, so the resolver falls back instead.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing, EMEA at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/8001',
          content: 'Acme Technologies VP Marketing EMEA.',
          score: 0.87,
          raw_content: null,
        },
        {
          title: 'Job Application for VP Marketing, Americas at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/8002',
          content: 'Acme Technologies VP Marketing Americas.',
          score: 0.86,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /greenhouse\.io/, 'no arbitrary posting URL is emitted on a tie');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta(
  'Tier-2 miss: an empty or shapeless Tavily response falls back, never crashes',
  async () => {
    for (const spec of [tavilyResponse([]), { json: {} }, { json: { results: null } }]) {
      const ctx = makeCtx({ env: TAVILY_ENV, routes: { [TAVILY_KEY]: spec } });
      const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
      assert.equal(lead.resolvedVia, 'search-fallback');
      assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
    }
  },
);

// -- Tavily failures degrade, never abort the run --------------------------
await ta('a Tavily 401 disables the tier for the run instead of retrying per lead', async () => {
  const logs = [];
  const ctx = makeCtx({ env: TAVILY_ENV, logs, routes: { [TAVILY_KEY]: { status: 401 } } });
  const leads = await resolveNetwork(ctx, [tier2Lead(), tier2Lead('Head of Growth')]);
  const tavilyCalls = ctx.calls.filter((u) => u.includes('api.tavily.com'));
  assert.equal(tavilyCalls.length, 1, 'a rejected key is not re-tried for every lead');
  for (const lead of leads) {
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.notEqual(lead.url, TRACKER);
  }
  assert.ok(
    logs.some((l) => /401/.test(l)),
    'the run says why the tier stopped',
  );
});

await ta('a transient Tavily error falls back for that lead and keeps trying', async () => {
  const ctx = makeCtx({ env: TAVILY_ENV, routes: { [TAVILY_KEY]: { status: 429 } } });
  const leads = await resolveNetwork(ctx, [tier2Lead(), tier2Lead('Head of Growth')]);
  const tavilyCalls = ctx.calls.filter((u) => u.includes('api.tavily.com'));
  assert.equal(tavilyCalls.length, 2, 'a rate-limit is not a permanent shutdown');
  for (const lead of leads) assert.equal(lead.resolvedVia, 'search-fallback');
});

// -- no company means nothing to corroborate a hit against -----------------
await ta('an empty-company lead never reaches Tavily', async () => {
  const ctx = makeCtx({ env: TAVILY_ENV, routes: { [TAVILY_KEY]: tavilyResponse([]) } });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: '', canonical: false },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(ctx.calls.length, 0, 'no company means no probe and no search');
});

// -- the tracker is still never emitted with Tier 2 enabled ----------------
await ta('with Tier 2 enabled, no emitted url is ever the dead tracking link', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.86,
          raw_content: null,
        },
      ]),
    },
  });
  const leads = await resolveNetwork(ctx, [
    tier2Lead(),
    tier2Lead('General Counsel'),
    {
      title: 'Chief People Officer',
      url: 'https://t.co/xyz',
      company: 'Nowhere',
      canonical: false,
    },
  ]);
  for (const lead of leads) {
    assert.notEqual(lead.url, TRACKER);
    assert.doesNotMatch(lead.url, /indeed\.com/);
    assert.doesNotMatch(lead.url, /t\.co/);
    assert.doesNotThrow(() => new URL(lead.url), 'every emitted url is a real URL');
  }
});

// -- per-tier counts stay transparent -------------------------------------
await ta('resolveNetwork reports the Tavily count alongside the other tiers', async () => {
  const logs = [];
  const ctx = makeCtx({
    env: TAVILY_ENV,
    logs,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.86,
          raw_content: null,
        },
      ]),
    },
  });
  await resolveNetwork(ctx, [tier2Lead(), tier2Lead('General Counsel')]);
  assert.ok(
    logs.some((l) => /tavily/i.test(l) && /search fallback/i.test(l)),
    'a summary line names the Tavily and search-fallback counts',
  );
});

// -- optional live integration (skipped unless RUN_LIVE_ATS is set) -------
await ta('live: real ATS round-trip (skipped without RUN_LIVE_ATS)', async () => {
  if (!process.env.RUN_LIVE_ATS) {
    console.log('  SKIP live ATS integration: set RUN_LIVE_ATS=1 to run it');
    return;
  }
  const { fetch: nodeFetch } = globalThis;
  const ctx = {
    fetchJson: async (url) => {
      const res = await nodeFetch(url);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    log: (...a) => console.log(...a),
  };
  // Greenhouse publishes a public demo/board token; resolve a well-known role.
  const [lead] = await resolveNetwork(ctx, [
    {
      title: process.env.LIVE_ATS_TITLE || 'Engineer',
      url: TRACKER,
      company: process.env.LIVE_ATS_COMPANY || 'greenhouse',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.ok(['ats', 'search-fallback'].includes(lead.resolvedVia));
  assert.notEqual(lead.url, TRACKER);
  assert.doesNotThrow(() => new URL(lead.url));
  console.log(`  live ATS resolution ok: resolvedVia=${lead.resolvedVia} url=${lead.url}`);
});

// -- optional live Tavily round-trip (skipped unless RUN_LIVE_TAVILY is set) --
await ta('live: real Tavily round-trip (skipped without RUN_LIVE_TAVILY)', async () => {
  if (!process.env.RUN_LIVE_TAVILY || !process.env.TAVILY_API_KEY) {
    console.log('  SKIP live Tavily: set RUN_LIVE_TAVILY=1 and TAVILY_API_KEY to run it');
    return;
  }
  const { fetch: nodeFetch } = globalThis;
  const ctx = {
    env: { TAVILY_API_KEY: process.env.TAVILY_API_KEY },
    fetchJson: async (url, options) => {
      const res = await nodeFetch(url, options);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    log: (...a) => console.log(...a),
  };
  // Every Tier-1 probe for this company misses, so the live call exercises Tier 2.
  const [lead] = await resolveNetwork(ctx, [
    {
      title: process.env.LIVE_TAVILY_TITLE || 'Software Engineer',
      url: TRACKER,
      company: process.env.LIVE_TAVILY_COMPANY || 'Acme Technologies',
      canonical: false,
      status: 'needs-canonical',
    },
  ]);
  assert.ok(['ats', 'tavily', 'search-fallback'].includes(lead.resolvedVia));
  assert.notEqual(lead.url, TRACKER);
  assert.doesNotThrow(() => new URL(lead.url));
  console.log(`  live Tavily ok: resolvedVia=${lead.resolvedVia} url=${lead.url}`);
});

console.log(`resolve-network.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
