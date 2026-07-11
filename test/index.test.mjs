// Unit tests for the source-adapter seam and the source-agnostic core skeleton.
// Hermetic: no network, no files. Run via `npm test` (after test/smoke.mjs).
// Exits non-zero on any failure so it gates the pipeline.
import assert from 'node:assert/strict';

import {
  KNOWN_SOURCES,
  requiredEnvFor,
  validateSourceEnv,
  createSource,
} from '../lib/sources/registry.mjs';
import { passesDmarc } from '../lib/dmarc.mjs';
import { extractLeads } from '../lib/extract.mjs';
import { normalizeLead } from '../lib/normalize.mjs';
import { resolveCanonical } from '../lib/resolve-canonical.mjs';
import { dedup } from '../lib/dedup.mjs';
import { buildJobs } from '../lib/append.mjs';
import { runIngest } from '../lib/ingest.mjs';
import { createFakeSource } from './fake-source.mjs';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

const GMAIL_ENV = {
  GMAIL_CLIENT_ID: 'id',
  GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_REFRESH_TOKEN: 'refresh',
};
const MS365_ENV = {
  MSGRAPH_CLIENT_ID: 'id',
  MSGRAPH_REFRESH_TOKEN: 'refresh',
};

// -- required env: per-source knowledge -----------------------------------
t('requiredEnvFor lists the gmail keys', () => {
  assert.deepEqual(requiredEnvFor('gmail'), [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN',
  ]);
});
t('requiredEnvFor lists the ms365 keys', () => {
  assert.deepEqual(requiredEnvFor('ms365'), ['MSGRAPH_CLIENT_ID', 'MSGRAPH_REFRESH_TOKEN']);
});
t('KNOWN_SOURCES is exactly gmail and ms365', () => {
  assert.deepEqual([...KNOWN_SOURCES].sort(), ['gmail', 'ms365']);
});

// -- required env: validation (missing / present / partial) ---------------
t('gmail: all keys present passes', () => {
  assert.doesNotThrow(() => validateSourceEnv('gmail', GMAIL_ENV));
});
t('optional keys ANTHROPIC_API_KEY / TAVILY_API_KEY are never required', () => {
  // Absent: a valid source env with neither optional key still passes. If the impl
  // treated them as required this assertion would throw.
  assert.doesNotThrow(() =>
    validateSourceEnv('gmail', {
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'refresh',
    }),
  );
  // Present with junk values: still passes; they are not gates on validation.
  assert.doesNotThrow(() =>
    validateSourceEnv('gmail', {
      ...GMAIL_ENV,
      ANTHROPIC_API_KEY: 'junk-not-a-real-key',
      TAVILY_API_KEY: 'junk-not-a-real-key',
    }),
  );
  // Same for ms365: optional keys absent, validation still passes.
  assert.doesNotThrow(() =>
    validateSourceEnv('ms365', { MSGRAPH_CLIENT_ID: 'id', MSGRAPH_REFRESH_TOKEN: 'refresh' }),
  );
});
t('gmail: all keys missing names the source, every key, and .env', () => {
  assert.throws(
    () => validateSourceEnv('gmail', {}),
    (err) => {
      assert.match(err.message, /gmail/);
      assert.match(err.message, /GMAIL_CLIENT_ID/);
      assert.match(err.message, /GMAIL_CLIENT_SECRET/);
      assert.match(err.message, /GMAIL_REFRESH_TOKEN/);
      assert.match(err.message, /\.env/);
      return true;
    },
  );
});
t('gmail: partial names only the missing key, not the present ones', () => {
  assert.throws(
    () =>
      validateSourceEnv('gmail', {
        GMAIL_CLIENT_ID: 'id',
        GMAIL_CLIENT_SECRET: 'secret',
      }),
    (err) => {
      assert.match(err.message, /GMAIL_REFRESH_TOKEN/);
      assert.doesNotMatch(err.message, /GMAIL_CLIENT_ID/);
      assert.doesNotMatch(err.message, /GMAIL_CLIENT_SECRET/);
      return true;
    },
  );
});
t('gmail: empty-string value counts as missing', () => {
  assert.throws(
    () => validateSourceEnv('gmail', { ...GMAIL_ENV, GMAIL_REFRESH_TOKEN: '  ' }),
    /GMAIL_REFRESH_TOKEN/,
  );
});
t('ms365: both keys present passes', () => {
  assert.doesNotThrow(() => validateSourceEnv('ms365', MS365_ENV));
});
t('ms365: missing refresh token names it', () => {
  assert.throws(
    () => validateSourceEnv('ms365', { MSGRAPH_CLIENT_ID: 'id' }),
    (err) => {
      assert.match(err.message, /ms365/);
      assert.match(err.message, /MSGRAPH_REFRESH_TOKEN/);
      assert.doesNotMatch(err.message, /MSGRAPH_CLIENT_ID/);
      return true;
    },
  );
});
t('unknown source errors clearly and lists known sources', () => {
  assert.throws(
    () => validateSourceEnv('imap', GMAIL_ENV),
    (err) => {
      assert.match(err.message, /imap/);
      assert.match(err.message, /gmail/);
      assert.match(err.message, /ms365/);
      return true;
    },
  );
});
t('missing source errors clearly', () => {
  assert.throws(() => validateSourceEnv(undefined, {}), /source/);
});

// -- registry: source selection -------------------------------------------
t('createSource(gmail) returns a MailSource', () => {
  const src = createSource('gmail', {});
  assert.equal(typeof src.listMessages, 'function');
  assert.equal(typeof src.archive, 'function');
});
t('createSource(ms365) returns a MailSource', () => {
  const src = createSource('ms365', {});
  assert.equal(typeof src.listMessages, 'function');
});
t('createSource(unknown) throws', () => {
  assert.throws(() => createSource('imap', {}), /imap/);
});

// -- stage: dmarc (fail closed) -------------------------------------------
t('dmarc pass header passes', () => {
  assert.equal(passesDmarc({ headers: { 'authentication-results': 'mx; dmarc=pass' } }), true);
});
t('dmarc header casing is ignored', () => {
  assert.equal(passesDmarc({ headers: { 'Authentication-Results': 'mx; dmarc=PASS' } }), true);
});
t('dmarc fail does not pass', () => {
  assert.equal(passesDmarc({ headers: { 'authentication-results': 'mx; dmarc=fail' } }), false);
});
t('dmarc missing header fails closed', () => {
  assert.equal(passesDmarc({ headers: {} }), false);
  assert.equal(passesDmarc({}), false);
});

// -- stage: extract -------------------------------------------------------
t('extract pulls each link and pairs it with the subject', () => {
  const leads = extractLeads({
    subject: 'VP Marketing at Acme',
    body: 'See https://boards.greenhouse.io/acme/jobs/1 and https://jobs.lever.co/acme/2',
  });
  assert.equal(leads.length, 2);
  assert.equal(leads[0].title, 'VP Marketing at Acme');
  assert.equal(leads[0].url, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(leads[1].url, 'https://jobs.lever.co/acme/2');
});
t('extract with no links returns nothing', () => {
  assert.deepEqual(extractLeads({ subject: 'x', body: 'no links here' }), []);
});

// -- stage: normalize -----------------------------------------------------
t('normalize trims and coerces fields to strings', () => {
  assert.deepEqual(normalizeLead({ title: '  CMO ', url: ' https://x/1 ', company: null }), {
    title: 'CMO',
    url: 'https://x/1',
    company: '',
    location: '',
  });
});

// -- stage: resolve-canonical (pure classifier) ---------------------------
t('resolve-canonical marks a known ATS host canonical', () => {
  const r = resolveCanonical({ url: 'https://boards.greenhouse.io/acme/jobs/1' });
  assert.equal(r.canonical, true);
  assert.equal(r.status, 'canonical');
});
t('resolve-canonical flags an unknown host needs-canonical', () => {
  const r = resolveCanonical({ url: 'https://click.indeed.com/redirect?x=1' });
  assert.equal(r.canonical, false);
  assert.equal(r.status, 'needs-canonical');
});

// -- stage: dedup ---------------------------------------------------------
t('dedup collapses www and trailing-slash variants of the same url', () => {
  const out = dedup([
    { url: 'https://boards.greenhouse.io/acme/jobs/1' },
    { url: 'https://www.boards.greenhouse.io/acme/jobs/1/' },
    { url: 'https://jobs.lever.co/acme/2' },
  ]);
  assert.equal(out.length, 2);
});
t('dedup keeps redirects that share host+path but differ only in query', () => {
  // Two distinct job postings behind the same tracking endpoint. Dropping either
  // would lose a real job, so both must survive; the exact-duplicate collapses.
  const out = dedup([
    { url: 'https://click.indeed.com/redirect?jk=AAA' },
    { url: 'https://click.indeed.com/redirect?jk=BBB' },
    { url: 'https://click.indeed.com/redirect?jk=AAA' },
  ]);
  assert.equal(out.length, 2, 'jk=AAA and jk=BBB both kept; the duplicate jk=AAA collapses');
});

// -- stage: append (Job[] assembly) ---------------------------------------
t('buildJobs shapes leads and drops those missing title or url', () => {
  const jobs = buildJobs([
    { title: 'CMO', url: 'https://x/1', company: 'Acme', location: 'Remote' },
    { title: '', url: 'https://x/2' },
    { title: 'VP', url: '' },
  ]);
  assert.deepEqual(jobs, [
    { title: 'CMO', url: 'https://x/1', company: 'Acme', location: 'Remote' },
  ]);
});

// -- ingest wiring against the fake in-memory MailSource ------------------
await ta('runIngest wires the selected source through the core to Job[]', async () => {
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': 'mx; dmarc=pass' },
      body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
    },
    {
      id: 'b',
      subject: 'Unauthenticated spam',
      from: 'spoof@evil.example',
      headers: { 'authentication-results': 'mx; dmarc=fail' },
      body: 'https://evil.example.com/x',
    },
  ]);
  const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
  const jobs = await runIngest(ctx, { createSource: () => fake });
  assert.equal(jobs.length, 1, 'only the DMARC-authenticated message yields a job');
  assert.deepEqual(jobs[0], {
    title: 'VP Marketing at Acme',
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    company: '',
    location: '',
  });
  assert.equal(fake.lastSinceDays, 14, 'default window of 14 days is passed to the source');
});

await ta('runIngest fails fast on missing env before constructing the source', async () => {
  let constructed = false;
  const ctx = { settings: { source: 'gmail' }, env: {} };
  await assert.rejects(
    () =>
      runIngest(ctx, {
        createSource: () => {
          constructed = true;
          return createFakeSource([]);
        },
      }),
    (err) => {
      assert.match(err.message, /gmail/);
      assert.match(err.message, /GMAIL_CLIENT_ID/);
      return true;
    },
  );
  assert.equal(constructed, false, 'the source is never constructed when env validation fails');
});

await ta('runIngest honors an explicit sinceDays setting', async () => {
  const fake = createFakeSource([]);
  const ctx = { settings: { source: 'gmail', sinceDays: 30 }, env: GMAIL_ENV };
  await runIngest(ctx, { createSource: () => fake });
  assert.equal(fake.lastSinceDays, 30);
});

// Pin today's behavior so the known limitation cannot silently widen before #7.
// Invariant (#7): buildJobs must never emit a Job whose url has status !==
// 'canonical' (a dead tracking link). Until #7 lands canonical resolution, the
// skeleton emits no jobs at all, so it emits zero dead links.
await ta(
  'runIngest emits zero jobs today, so zero dead tracking links (#7 invariant)',
  async () => {
    // An empty mailbox yields no jobs.
    const fake = createFakeSource([]);
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
    const jobs = await runIngest(ctx, { createSource: () => fake });
    assert.deepEqual(jobs, [], 'no messages means no jobs and no dead links');

    // The real gmail/ms365 stub adapters cannot emit anything today: their
    // listMessages throws not-implemented, so no live path can produce a job.
    await assert.rejects(() => createSource('gmail', {}).listMessages(14), /not implemented/);
    await assert.rejects(() => createSource('ms365', {}).listMessages(14), /not implemented/);
  },
);

console.log(`index.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
