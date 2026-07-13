// Unit tests for the Tier-1 network resolver (lib/resolve-network.mjs).
// Hermetic: no network. A fake ctx.fetchJson returns captured public ATS response
// shapes (Greenhouse boards-api, Lever postings, Ashby public posting-api) and
// mirrors the engine's throw-on-non-2xx contract so a probe for a board that does
// not exist rejects with a 404, exactly as the guarded fetch would. The tests
// exercise real slug derivation, real request-building, and real title matching
// against those real shapes; they never assert that a stub was merely called.
//
// An optional live integration test runs only when RUN_LIVE_ATS is set and is
// skipped otherwise, so CI stays zero-network.
import assert from 'node:assert/strict';

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
// throw-on-non-2xx contract for a board that does not exist.
function makeCtx({ routes = {}, logs } = {}) {
  const calls = [];
  async function fetchJson(url) {
    calls.push(url);
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
  return { fetchJson, calls, log };
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

const GH_KEY = 'boards-api.greenhouse.io/v1/boards/acme/jobs';
const LEVER_KEY = 'api.lever.co/v0/postings/acme';
const ASHBY_KEY = 'api.ashbyhq.com/posting-api/job-board/acme';

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

console.log(`resolve-network.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
