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

// -- the length floors and token rules INSIDE gates 2 and 3 ---------------
// The five headline gates each fail a named test when removed, but the discipline
// that makes gates 2 and 3 hard to satisfy by accident lives in their length floors
// and token counts. Each test below is red when exactly that floor or count is
// relaxed, so none of them can pass for free.

await ta('Tier-2 miss: a board slug too short to be evidence is not evidence', async () => {
  // "acm" is a substring of "acmetechnologies", so a bare containment test would
  // tie this board to the company. Three characters is an accident, not evidence:
  // MIN_SLUG_OVERLAP is what stands between this result and being emitted, since
  // the company is named in the title and snippet and the role matches exactly.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io/acm/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.88,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [tier2Lead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /greenhouse\.io/, 'a 3-character slug cannot pin an employer');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta('Tier-2 miss: a short company name cannot anchor a containment match', async () => {
  // The same floor from the other side. "Box" is a prefix of "Boxcryptor", a real
  // and different employer, and the snippet names Box, so every other gate passes.
  // The floor is the only thing that keeps a three-letter company name from
  // claiming every board whose slug happens to start with it.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Boxcryptor',
          url: 'https://boards.greenhouse.io/boxcryptor/jobs/4120',
          content: 'Boxcryptor is hiring a VP Marketing to compete with Box and Dropbox.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: 'Box', canonical: false },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /greenhouse\.io/, "a prefix is not the employer's board");
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Box'));
});

await ta('Tier-2 miss: one shared word of a two-word company is not corroboration', async () => {
  // Northstar Health is a different employer that shares a first word with
  // Northstar Technologies, and its board slug relates to the company under gate 2.
  // Only the rule that a multi-token company must match at least TWO of its tokens
  // separates them; matching "northstar" alone would emit the wrong employer.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'Job Application for VP Marketing at Northstar Health',
          url: 'https://boards.greenhouse.io/northstar-health/jobs/5150',
          content: 'Northstar Health is hiring a VP Marketing to lead brand.',
          score: 0.91,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: 'Northstar Technologies', canonical: false },
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /greenhouse\.io/, 'a shared first word is not the same employer');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Northstar Technologies'));
});

await ta('a company with no token long enough to corroborate never reaches Tavily', async () => {
  // "3M Co" leaves nothing usable: "co" is legal-entity noise and "3m" is too short
  // to identify an employer inside a page of prose. With nothing to corroborate a
  // hit against, the request is not worth making and the fallback stands.
  const ctx = makeCtx({ env: TAVILY_ENV, routes: { [TAVILY_KEY]: tavilyResponse([]) } });
  const [lead] = await resolveNetwork(ctx, [
    { title: 'VP Marketing', url: TRACKER, company: '3M Co', canonical: false },
  ]);
  assert.ok(
    !ctx.calls.some((u) => u.includes('api.tavily.com')),
    'no corroborating token means no search',
  );
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', '3M Co'));
});

await ta('a lead with no title never reaches Tavily', async () => {
  // Without a role there is nothing to score a result against, so gate 4 could
  // never be satisfied and the call would only spend quota.
  const ctx = makeCtx({ env: TAVILY_ENV, routes: { [TAVILY_KEY]: tavilyResponse([]) } });
  const [lead] = await resolveNetwork(ctx, [
    { title: '', url: TRACKER, company: 'Acme Technologies', canonical: false },
  ]);
  assert.ok(!ctx.calls.some((u) => u.includes('api.tavily.com')), 'no role means no search');
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.notEqual(lead.url, TRACKER);
});

await ta(
  'Tier-2 hit: a legal suffix in the company name is not demanded of the result',
  async () => {
    // A posting page says "Acme", not "Acme Inc". Dropping legal-entity noise from the
    // corroboration tokens is what keeps that from reading as a one-of-two miss and
    // sending a correct, verified posting to the fallback.
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'Job Application for VP Marketing at Acme',
            url: 'https://boards.greenhouse.io/acmetech/jobs/7788',
            content: 'Acme is hiring a VP Marketing to lead brand and demand.',
            score: 0.87,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [
      { title: 'VP Marketing', url: TRACKER, company: 'Acme Inc', canonical: false },
    ]);
    assert.equal(lead.url, 'https://boards.greenhouse.io/acmetech/jobs/7788');
    assert.equal(lead.resolvedVia, 'tavily');
    assert.equal(lead.canonical, true);
  },
);

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

// == Tier 2, employer-hosted postings (#22) ================================
//
// Two further classes may be emitted, each under gates STRICTER than the shared-board
// ones above, never looser:
//
//   TENANT PLATFORMS (Workday, iCIMS). The employer holds a named tenant on a
//   platform whose host suffix is fixed, so the host still anchors identity. Unlike a
//   Greenhouse board, though, these platforms also serve prominent index and search
//   URLs, so a posting has to be told apart from a listing by its path.
//
//   BESPOKE EMPLOYER DOMAINS (careers.acme.com). No host suffix and no board slug, so
//   identity rests on the domain LABEL equalling a slug derived from the company name
//   -- a signal that comes from the lead, not from the search result being judged.
//   Because a domain label is global rather than namespaced inside a vendor,
//   equality is required where a board slug only needs a containment relation, and
//   corroboration and the title bar are both raised.

// An employer-hosted lead: no shared-board posting exists for it at all, so Tier 1
// misses and the only paths are a tenant platform, the employer's own site, or the
// fallback.
function employerLead(title = 'VP Marketing', company = 'Acme Technologies') {
  return { title, url: TRACKER, company, location: '', canonical: false };
}

// -- tenant platforms: hit ------------------------------------------------
await ta('Tier-2 hit: a Workday posting is emitted as canonical', async () => {
  const url =
    'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/job/Dallas-TX/VP-Marketing_JR-10423';
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing - Acme Technologies',
          url,
          content: 'Acme Technologies is hiring a VP Marketing in Dallas.',
          score: 0.88,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, url, 'the url is copied verbatim from the result');
  assert.equal(lead.canonical, true);
  assert.equal(lead.status, 'canonical');
  assert.equal(lead.resolvedVia, 'tavily');
  assert.notEqual(lead.url, TRACKER);
});

await ta('Tier-2 hit: an iCIMS posting is emitted as canonical', async () => {
  const url = 'https://careers-acmetech.icims.com/jobs/44120/vp-marketing/job';
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Acme Technologies Careers',
          url,
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, url);
  assert.equal(lead.canonical, true);
  assert.equal(lead.resolvedVia, 'tavily');
});

// -- tenant platforms: the posting-shape gate -----------------------------
await ta('Tier-2 miss: a Workday board index is not a posting', async () => {
  // Every other gate passes -- right tenant, right company, and a page title that
  // names the role. Only the requirement that the path carry a posting id keeps a
  // listing page, which shows many roles and outlives any one of them, from being
  // emitted as this lead's canonical URL.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing - Acme Technologies',
          url: 'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.92,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /myworkdayjobs\.com/, 'an index page is not a posting');
  assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
});

await ta("Tier-2 miss: another employer's Workday tenant is rejected", async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing - Acme Technologies',
          url: 'https://nimbus.wd5.myworkdayjobs.com/en-US/Nimbus_Careers/job/Dallas-TX/VP-Marketing_JR-10423',
          content: 'Acme Technologies alum joins Nimbus as VP Marketing.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /myworkdayjobs\.com/);
});

// -- bespoke employer domains: hit ----------------------------------------
await ta(
  "Tier-2 hit: the employer's own careers site is emitted as employer-canonical",
  async () => {
    const url = 'https://careers.acmetechnologies.com/jobs/vp-marketing';
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing | Careers at Acme Technologies',
            url,
            content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
            score: 0.84,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.url, url, 'the url is copied verbatim from the result');
    assert.equal(lead.employerCanonical, true);
    assert.equal(lead.status, 'employer-canonical');
    assert.equal(lead.resolvedVia, 'tavily-employer');
    // It is NOT claimed to be an ATS-classified canonical URL: the classifier and the
    // resolver still agree about what `canonical` means.
    assert.equal(lead.canonical, false);
    assert.notEqual(lead.url, TRACKER);
  },
);

// -- bespoke employer domains: identity -----------------------------------
await ta(
  'Tier-2 miss: a lookalike domain that merely contains the company is rejected',
  async () => {
    // "acmetechnologies.jobs-mirror.example" puts the company name in a label the
    // employer does not own. Only the rule that the identity label sit on a host shape
    // recognizable as a registrable domain stands between this mirror and being
    // emitted; everything else about the result is right.
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing | Careers at Acme Technologies',
            url: 'https://acmetechnologies.jobs-mirror.example/careers/vp-marketing',
            content: 'Acme Technologies is hiring a VP Marketing.',
            score: 0.93,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.doesNotMatch(lead.url, /jobs-mirror/);
  },
);

await ta('Tier-2 miss: a domain merely similar to the company name is rejected', async () => {
  // A board slug only has to be relatable to the company, because it is namespaced
  // inside a vendor whose host is already trusted. A domain label is global:
  // acmetech.com and acmetechnologies.com are different registrations that may be
  // different owners, so here equality is the bar and containment is not enough.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetech.com/jobs/vp-marketing',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.91,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /acmetech\.com/);
});

await ta('Tier-2 miss: a bespoke careers index is not a posting', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetechnologies.com/jobs',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /acmetechnologies\.com/);
});

await ta('Tier-2 miss: a year in the path is not a posting id', async () => {
  // "/jobs/2026" clears the three-digit floor on its own while being an archive
  // listing, which is the worse error of the two: it outlives the role it was
  // showing, so the reader lands on something plausible and permanently wrong.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetechnologies.com/jobs/2026',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /acmetechnologies\.com/);
});

// -- bespoke employer domains: MORE corroboration than an ATS host --------
await ta('Tier-2 miss: a bespoke result must account for every company token', async () => {
  // Two of three tokens is enough on a trusted ATS host, where the board slug has
  // already tied the posting to the employer. On a bespoke domain the corroboration
  // is doing that work alone, so "Northstar Health" cannot stand in for "Northstar
  // Health Systems".
  //
  // The domain here is the employer's own full-name form, so the identity gate is
  // SATISFIED and corroboration is the only thing left to reject the result. Pointing
  // this at northstar.com instead would let the identity gate reject it first and the
  // test would pass without ever exercising the rule it names.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Northstar Health',
          url: 'https://careers.northstarhealthsystems.com/jobs/vp-marketing',
          content: 'Northstar Health is hiring a VP Marketing.',
          score: 0.9,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [
    employerLead('VP Marketing', 'Northstar Health Systems'),
  ]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /northstarhealthsystems\.com/);
});

await ta(
  'Tier-2 miss: a bespoke result must clear a higher title bar than an ATS one',
  async () => {
    // "VP Marketing Manager" against a "VP Marketing" lead scores 0.667: over the bar
    // a trusted ATS host uses, under the bespoke one. A different, more junior role at
    // the right employer is exactly the mistake that still looks correct to the reader.
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing Manager | Careers at Acme Technologies',
            url: 'https://careers.acmetechnologies.com/jobs/vp-marketing-manager',
            content: 'Acme Technologies is hiring a VP Marketing Manager.',
            score: 0.89,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.doesNotMatch(lead.url, /acmetechnologies\.com/);
  },
);

// -- classes that stay on the fallback ------------------------------------
await ta(
  'Tier-2 miss: an employer platform outside the verified table keeps the fallback',
  async () => {
    // SmartRecruiters is a real ATS whose posting URLs are probably resolvable, but its
    // tenant location and posting-path shape have not been verified here, so it is not
    // in the table and a guess is not made on its behalf.
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing | Acme Technologies',
            url: 'https://jobs.smartrecruiters.com/AcmeTechnologies/744000012345678',
            content: 'Acme Technologies is hiring a VP Marketing.',
            score: 0.9,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback');
    assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'));
  },
);

// -- precedence and reporting ---------------------------------------------
await ta('a host-classified posting wins over a bespoke one in the same response', async () => {
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetechnologies.com/jobs/vp-marketing',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.95,
          raw_content: null,
        },
        {
          title: 'Job Application for VP Marketing at Acme Technologies',
          url: 'https://boards.greenhouse.io/acmetech/jobs/7788',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.4,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, 'https://boards.greenhouse.io/acmetech/jobs/7788');
  assert.equal(lead.canonical, true);
  assert.equal(lead.resolvedVia, 'tavily');
});

await ta('resolveNetwork reports the employer-site count alongside the other tiers', async () => {
  const logs = [];
  const ctx = makeCtx({
    env: TAVILY_ENV,
    logs,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetechnologies.com/jobs/vp-marketing',
          content: 'Acme Technologies is hiring a VP Marketing.',
          score: 0.88,
          raw_content: null,
        },
      ]),
    },
  });
  await resolveNetwork(ctx, [employerLead(), employerLead('General Counsel')]);
  assert.ok(
    logs.some((l) => /employer/i.test(l) && /search fallback/i.test(l)),
    'a summary line names the employer-site count',
  );
});

// -- bespoke employer domains: the label must be the WHOLE company name ---
//
// `candidateSlugs` offers a first-word form so Tier 1 can PROBE a board named after
// it; a wrong guess there costs a 404. Reusing that set as the domain-identity gate
// turned the stated rule -- "the label EQUALS a slug derived from the company name"
// -- into equality against a TRUNCATION of it, which is the very "guess dressed as
// evidence" the equality bar exists to refuse, and on a global namespace rather than
// inside a trusted vendor. The identity gate uses the full-name forms only.

await ta(
  'Tier-2 miss: a domain label that is only the company first word is rejected',
  async () => {
    // Every other gate passes. "acme.tk" is a two-label registrable host whose label
    // is a common word any registrant could hold; nothing here ties it to Acme
    // Technologies, and the shorter, more collision-prone label must not be accepted
    // where the longer, more specific "acmetech.com" is already declined.
    for (const url of [
      'https://careers.acme.tk/jobs/vp-marketing',
      'https://acme.xyz/careers/vp-marketing',
      'https://careers.acme.com/jobs/vp-marketing',
    ]) {
      const ctx = makeCtx({
        env: TAVILY_ENV,
        routes: {
          [TAVILY_KEY]: tavilyResponse([
            {
              title: 'VP Marketing | Careers at Acme Technologies',
              url,
              content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
              score: 0.93,
              raw_content: null,
            },
          ]),
        },
      });
      const [lead] = await resolveNetwork(ctx, [employerLead()]);
      assert.equal(lead.resolvedVia, 'search-fallback', url);
      assert.equal(lead.url, buildSearchUrl('VP Marketing', 'Acme Technologies'), url);
    }
  },
);

await ta('Tier-2 hit: the hyphenated full-name form of the domain label is accepted', async () => {
  // Both forms derived from the WHOLE company name are legitimate registrations of
  // the same name, so both satisfy equality; only the truncation does not.
  const url = 'https://careers.acme-technologies.com/jobs/vp-marketing';
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url,
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.86,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, url);
  assert.equal(lead.employerCanonical, true);
  assert.equal(lead.resolvedVia, 'tavily-employer');
});

await ta('Tier-2 miss: a single-word company is never resolved to a bespoke domain', async () => {
  // For a one-word company the full-name form and the first-word form are the same
  // string, so the identity gate degenerates: "the label equals the whole company
  // name" and "every company token is corroborated" become the same single-token
  // test, and the two gates that are meant to be independent stop being so. A
  // one-word label on a global namespace is exactly what an unrelated registrant of
  // the same common word holds, so this class keeps the honest search fallback.
  for (const [company, url] of [
    ['Nova', 'https://careers.nova.io/jobs/vp-marketing'],
    ['Northstar', 'https://careers.northstar.com/jobs/vp-marketing'],
  ]) {
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: `VP Marketing | Careers at ${company}`,
            url,
            content: `${company} is hiring a VP Marketing to lead brand and demand.`,
            score: 0.94,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead('VP Marketing', company)]);
    assert.equal(lead.resolvedVia, 'search-fallback', url);
    assert.equal(lead.url, buildSearchUrl('VP Marketing', company), url);
  }
});

// -- bespoke employer domains: the recognized host shapes ----------------
//
// The allowlist of host SHAPES stands in for a public-suffix list. Each branch of it
// decides real URLs, so each gets a test that fails when the branch is removed.

await ta('Tier-2 hit: a country-code employer domain is recognized (label.xx.yy)', async () => {
  // Without the second-level-head branch this host reads as three labels and is
  // declined, so a UK employer's own careers site never resolves.
  const url = 'https://careers.acmetechnologies.co.uk/jobs/vp-marketing';
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url,
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.87,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, url);
  assert.equal(lead.employerCanonical, true);
});

await ta('Tier-2 miss: a two-part suffix outside the allowlist is declined', async () => {
  // "zz" is not a recognized second-level head, and "london" is not a two-letter
  // country code. Both are shapes this module does not read as registrable, so both
  // are declined rather than guessed at -- which is what the allowlist is for.
  for (const url of [
    'https://careers.acmetechnologies.zz.uk/jobs/vp-marketing',
    'https://careers.acmetechnologies.co.london/jobs/vp-marketing',
  ]) {
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing | Careers at Acme Technologies',
            url,
            content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
            score: 0.93,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback', url);
  }
});

await ta('Tier-2 hit: a www-prefixed employer domain is recognized', async () => {
  // Without the leading-www strip this host reads as three labels, "www" is not a
  // recognized second-level head, and the employer's own posting is declined.
  const url = 'https://www.acmetechnologies.com/careers/vp-marketing';
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url,
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.85,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.url, url);
  assert.equal(lead.employerCanonical, true);
});

// -- bespoke employer domains: a role-scoped LISTING is not a posting ----
//
// A job word is never a role word. The result-title normalization already drops it,
// so a page titled "VP Marketing Jobs" scores a perfect match against a "VP
// Marketing" lead; the path normalization counted the same word toward the role, so
// a category page cleared the posting-shape gate by carrying the very word that
// marks it as a category. Both normalizations now agree that it carries no role
// evidence, and in a path segment it is affirmative evidence of a category.

await ta('Tier-2 miss: a role-scoped listing page is not a posting', async () => {
  for (const url of [
    'https://careers.acmetechnologies.com/vp-marketing-jobs',
    'https://careers.acmetechnologies.com/jobs/vp-marketing-openings',
    'https://acmetechnologies.com/careers/vp-marketing-careers',
  ]) {
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing Jobs | Careers at Acme Technologies',
            url,
            content: 'Browse all VP Marketing openings at Acme Technologies.',
            score: 0.94,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback', url);
    assert.doesNotMatch(lead.url, /acmetechnologies\.com/, url);
  }
});

await ta('Tier-2 miss: one shared role word in the final segment is not a posting', async () => {
  // "/marketing" under a careers host shares a single token with the lead title,
  // which names a section rather than a posting. The two-token floor is the only
  // thing between it and being emitted; at one token it would be accepted.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://careers.acmetechnologies.com/marketing',
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.92,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /acmetechnologies\.com/);
});

await ta('Tier-2 miss: a bare job-word path on a bare domain is not a posting', async () => {
  // The single path segment is the job word itself. It can be neither a posting id
  // nor a role slug, so it is a careers index -- the case the removed
  // `segments.length < 2` guard was written for, still declined without it.
  const ctx = makeCtx({
    env: TAVILY_ENV,
    routes: {
      [TAVILY_KEY]: tavilyResponse([
        {
          title: 'VP Marketing | Careers at Acme Technologies',
          url: 'https://acmetechnologies.com/jobs',
          content: 'Acme Technologies is hiring a VP Marketing to lead brand and demand.',
          score: 0.92,
          raw_content: null,
        },
      ]),
    },
  });
  const [lead] = await resolveNetwork(ctx, [employerLead()]);
  assert.equal(lead.resolvedVia, 'search-fallback');
  assert.doesNotMatch(lead.url, /acmetechnologies\.com/);
});

// -- posting ids: a year anywhere, and a faceted search ------------------
//
// The digit floor tells a requisition id from a locale or a short counter. Two
// classes of path segment clear it without being a posting: one carrying a calendar
// year, and a numeric facet under a path that says it is a search. Excluding a BARE
// year segment covered one literal of the first class and none of the second.

await ta('Tier-2 miss: a year anywhere in a segment is not a posting id', async () => {
  for (const url of [
    'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/2026-Internships',
    'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/summer-2026',
    'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/class-of-2026',
  ]) {
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'Marketing Intern - Acme',
            url,
            content: 'Acme is hiring a Marketing Intern.',
            score: 0.91,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead('Marketing Intern', 'Acme')]);
    assert.equal(lead.resolvedVia, 'search-fallback', url);
    assert.doesNotMatch(lead.url, /myworkdayjobs\.com/, url);
  }
});

await ta(
  'Tier-2 hit: a requisition id that merely contains year-like digits still counts',
  async () => {
    // The exclusion must remove a calendar year, not any four digits that resemble
    // one: "JR-20264" is a requisition number and "10423" is the shape both vendors
    // publish. Narrowing to the class must not swallow the class it protects.
    for (const url of [
      'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/job/Dallas-TX/VP-Marketing_JR-20264',
      'https://careers-acmetech.icims.com/jobs/44120/vp-marketing/job',
    ]) {
      const ctx = makeCtx({
        env: TAVILY_ENV,
        routes: {
          [TAVILY_KEY]: tavilyResponse([
            {
              title: 'VP Marketing - Acme Technologies',
              url,
              content: 'Acme Technologies is hiring a VP Marketing in Dallas.',
              score: 0.88,
              raw_content: null,
            },
          ]),
        },
      });
      const [lead] = await resolveNetwork(ctx, [employerLead()]);
      assert.equal(lead.url, url, url);
      assert.equal(lead.canonical, true, url);
      assert.equal(lead.resolvedVia, 'tavily', url);
    }
  },
);

await ta('Tier-2 miss: a faceted search is not a posting, whatever its digits', async () => {
  // A path that says it is a search is a listing however many digits its facet
  // carries; a page or offset number is indistinguishable from a requisition id by
  // shape, so the shape is not what decides it.
  for (const url of [
    'https://careers-acmetech.icims.com/jobs/search/1250',
    'https://acmetech.wd5.myworkdayjobs.com/en-US/AcmeTech_Careers/search/results/4400',
    // The same rule on the employer's own domain, where the final segment is a role
    // slug and would otherwise clear the two-token floor on its own.
    'https://careers.acmetechnologies.com/jobs/search/vp-marketing',
  ]) {
    const ctx = makeCtx({
      env: TAVILY_ENV,
      routes: {
        [TAVILY_KEY]: tavilyResponse([
          {
            title: 'VP Marketing - Acme Technologies',
            url,
            content: 'Acme Technologies is hiring a VP Marketing.',
            score: 0.9,
            raw_content: null,
          },
        ]),
      },
    });
    const [lead] = await resolveNetwork(ctx, [employerLead()]);
    assert.equal(lead.resolvedVia, 'search-fallback', url);
  }
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
