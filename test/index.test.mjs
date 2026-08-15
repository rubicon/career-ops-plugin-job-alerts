// Unit tests for the source-adapter seam and the source-agnostic core skeleton.
// Hermetic: no network, no files. Run via `npm test` (after test/smoke.mjs).
// Exits non-zero on any failure so it gates the pipeline.
import assert from 'node:assert/strict';

import {
  KNOWN_SOURCES,
  requiredEnvFor,
  validateSourceEnv,
  createSource,
  trustedAuthservIdFor,
  declaredAuthservId,
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
// The gate's own parsing and trust rules are covered in test/dmarc.test.mjs.
// What matters here is the seam: which authserv-id each source declares as its
// receiving boundary, and that the gate is reachable with it.
t('gmail declares the authserv-id its receiving boundary stamps', () => {
  assert.equal(trustedAuthservIdFor('gmail', {}), 'mx.google.com');
});
t('ms365 has no default, so it refuses to run until the setting names one', () => {
  // Microsoft publishes no authserv-id for Exchange Online, and an unnamed
  // Authentication-Results field is one any sender can write. Rather than trust
  // one, or drop every message and look like an empty mailbox, the source
  // refuses with an error naming the setting that resolves it.
  assert.throws(() => trustedAuthservIdFor('ms365', {}), /authservId/);
  assert.throws(() => trustedAuthservIdFor('ms365', {}), /ms365/);
});
t('an authservId setting overrides the adapter default for either source', () => {
  const ctx = { settings: { authservId: 'mail.contoso.com' } };
  assert.equal(trustedAuthservIdFor('ms365', ctx), 'mail.contoso.com');
  assert.equal(trustedAuthservIdFor('gmail', ctx), 'mail.contoso.com');
});
t('a blank or whitespace-only authservId setting is not a configured id', () => {
  assert.equal(trustedAuthservIdFor('gmail', { settings: { authservId: '  ' } }), 'mx.google.com');
  assert.throws(() => trustedAuthservIdFor('ms365', { settings: { authservId: '  ' } }), /ms365/);
});
t('trustedAuthservIdFor rejects an unknown source', () => {
  assert.throws(() => trustedAuthservIdFor('imap', {}), /imap/);
});
t('an adapter that declares no trustedAuthservId is a plugin bug, not a weak default', () => {
  // The declaration is the seam that tells the gate which field to believe. A
  // module that omits it, or misspells it, must fail as the plugin bug it is
  // rather than resolve to anything the gate would act on.
  assert.throws(() => declaredAuthservId('gmail', {}), /trustedAuthservId/);
  assert.throws(() => declaredAuthservId('gmail', { trustedAuthservID: 'mx.google.com' }), /gmail/);
  assert.equal(declaredAuthservId('gmail', { trustedAuthservId: null }), null);
});
t('the declared gmail boundary id admits a real verdict and nothing else', () => {
  const authservId = trustedAuthservIdFor('gmail', {});
  const gate = (value) =>
    passesDmarc({ headers: { 'Authentication-Results': value } }, { authservId });
  assert.equal(gate('mx.google.com; spf=pass; dmarc=pass'), true);
  assert.equal(gate('mx.google.com; spf=pass; dmarc=fail'), false);
  assert.equal(gate('evil.tld; dmarc=pass'), false);
  assert.equal(passesDmarc({ headers: {} }, { authservId }), false);
});

// -- stage: extract -------------------------------------------------------
t('extract parses "{Role} at {Company}" and pairs it with every link', () => {
  const leads = extractLeads({
    subject: 'VP Marketing at Acme',
    body: 'See https://boards.greenhouse.io/acme/jobs/1 and https://jobs.lever.co/acme/2',
  });
  assert.equal(leads.length, 2);
  assert.equal(leads[0].title, 'VP Marketing');
  assert.equal(leads[0].company, 'Acme');
  assert.equal(leads[0].url, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(leads[1].url, 'https://jobs.lever.co/acme/2');
  assert.equal(leads[1].company, 'Acme');
});
t('extract strips a known alert prefix before matching "at"', () => {
  const leads = extractLeads({
    subject: 'Job Alert: Senior PM at Globex',
    body: 'https://boards.greenhouse.io/globex/jobs/9',
  });
  assert.equal(leads[0].title, 'Senior PM');
  assert.equal(leads[0].company, 'Globex');
});
t('extract truncates at a trailing " - " segment before matching "at"', () => {
  const leads = extractLeads({
    subject: 'VP Marketing at Acme - View job',
    body: 'https://boards.greenhouse.io/acme/jobs/1',
  });
  assert.equal(leads[0].title, 'VP Marketing');
  assert.equal(leads[0].company, 'Acme');
});
t('extract parses "{Company} is hiring a {Role}"', () => {
  const leads = extractLeads({
    subject: 'Globex is hiring a Senior Engineer',
    body: 'https://boards.greenhouse.io/globex/jobs/2',
  });
  assert.equal(leads[0].title, 'Senior Engineer');
  assert.equal(leads[0].company, 'Globex');
});
t('extract parses "N new {Role} jobs"', () => {
  const leads = extractLeads({
    subject: '3 new HR Coordinator jobs',
    body: 'https://boards.greenhouse.io/acme/jobs/3',
  });
  assert.equal(leads[0].title, 'HR Coordinator');
  assert.equal(leads[0].company, '');
});
t('extract falls back to the raw subject when no pattern matches', () => {
  const leads = extractLeads({
    subject: 'Weekly Digest',
    body: 'https://boards.greenhouse.io/acme/jobs/4',
  });
  assert.equal(leads[0].title, 'Weekly Digest');
  assert.equal(leads[0].company, '');
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
t('buildJobs shapes resolved leads and drops those missing title or url', () => {
  const jobs = buildJobs([
    { title: 'CMO', url: 'https://x/1', company: 'Acme', location: 'Remote', canonical: true },
    { title: '', url: 'https://x/2', canonical: true },
    { title: 'VP', url: '', canonical: true },
  ]);
  assert.deepEqual(jobs, [
    { title: 'CMO', url: 'https://x/1', company: 'Acme', location: 'Remote' },
  ]);
});
t('buildJobs never emits an unresolved lead still pointing at its tracker (#8)', () => {
  // A needs-canonical lead that reached buildJobs without a canonical URL or a
  // search fallback still carries its raw tracker; it must be dropped, not leaked.
  const jobs = buildJobs([
    { title: 'VP Marketing', url: 'https://click.indeed.com/redirect?jk=AAA', canonical: false },
    { title: 'VP Marketing', url: 'https://www.google.com/search?q=x', searchFallback: true },
    { title: 'CMO', url: 'https://boards.greenhouse.io/acme/jobs/9', canonical: true },
  ]);
  assert.equal(jobs.length, 2, 'only the search-fallback and canonical leads are emitted');
  for (const job of jobs) {
    assert.doesNotMatch(job.url, /indeed\.com/, 'the tracker url is never emitted');
  }
});

// -- ingest wiring against the fake in-memory MailSource ------------------
await ta('runIngest wires the selected source through the core to Job[]', async () => {
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
      body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
    },
    {
      id: 'b',
      subject: 'Unauthenticated spam',
      from: 'spoof@evil.example',
      headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=fail' },
      body: 'https://evil.example.com/x',
    },
  ]);
  const logs = [];
  const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV, log: (m) => logs.push(m) };
  const jobs = await runIngest(ctx, { createSource: () => fake });
  assert.equal(jobs.length, 1, 'only the DMARC-authenticated message yields a job');
  assert.deepEqual(jobs[0], {
    title: 'VP Marketing',
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    company: 'Acme',
    location: '',
  });
  assert.equal(fake.lastSinceDays, 14, 'default window of 14 days is passed to the source');
  // A drop must be visible: a fail-closed gate that silently discards every
  // message is indistinguishable from an empty mailbox otherwise.
  const dropped = logs.find((m) => /skipped 1 of 2/.test(m));
  assert.ok(dropped, `the skipped message is logged; got ${JSON.stringify(logs)}`);
  assert.match(dropped, /mx\.google\.com/, 'the log names the boundary the verdict must come from');
  assert.match(dropped, /authservId/, 'and points at the setting that changes it');
});

await ta('runIngest refuses to open the mailbox with no boundary id to trust', async () => {
  // ms365 has no default authserv-id, so a run with the setting unset cannot
  // attribute any verdict. That has to stop the run before the mailbox is read:
  // reading it and then failing every message would spend the network round
  // trips only to look like an empty inbox.
  let listed = false;
  const fake = {
    async listMessages() {
      listed = true;
      return [];
    },
  };
  const ctx = { settings: { source: 'ms365' }, env: MS365_ENV };
  await assert.rejects(() => runIngest(ctx, { createSource: () => fake }), /authservId/);
  assert.equal(listed, false, 'the mailbox is never listed');
});

await ta('runIngest runs ms365 once the authservId setting names the boundary', async () => {
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': ['mail.contoso.com; spf=pass; dmarc=pass'] },
      body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
    },
  ]);
  const ctx = {
    settings: { source: 'ms365', authservId: 'mail.contoso.com' },
    env: MS365_ENV,
  };
  const jobs = await runIngest(ctx, { createSource: () => fake });
  assert.equal(jobs.length, 1);
});

await ta('runIngest logs nothing about DMARC when every message is authenticated', async () => {
  const logs = [];
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
      body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
    },
  ]);
  const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV, log: (m) => logs.push(m) };
  await runIngest(ctx, { createSource: () => fake });
  assert.deepEqual(
    logs.filter((m) => /dmarc/i.test(m)),
    [],
  );
});

await ta(
  "runIngest gates on the selected source's receiving boundary, not on any pass",
  async () => {
    // Both messages assert dmarc=pass. Only one of them is attributable to the
    // boundary the gmail source declares; the other asserts it about itself, and
    // a repeat cannot speak for the boundary either.
    const fake = createFakeSource([
      {
        id: 'a',
        subject: 'VP Marketing at Acme',
        from: 'alerts@indeed.com',
        headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
        body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
      },
      {
        id: 'b',
        subject: 'CFO at Globex',
        from: 'spoof@evil.example',
        headers: {
          'authentication-results':
            'mx.google.com; spf=fail; dmarc=fail\nmx.google.com.evil.tld; dmarc=pass',
        },
        body: 'Apply: https://boards.greenhouse.io/globex/jobs/999',
      },
    ]);
    const logs = [];
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV, log: (m) => logs.push(m) };
    const jobs = await runIngest(ctx, { createSource: () => fake });
    assert.equal(jobs.length, 1, 'only the boundary-authenticated message yields a job');
    assert.equal(jobs[0].company, 'Acme');
    assert.ok(
      logs.some((m) => /skipped 1 of 2/.test(m)),
      'the unattributable message is reported, not silently dropped',
    );
  },
);

await ta('runIngest enriches leads via the LLM when ANTHROPIC_API_KEY is present', async () => {
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
      body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
    },
  ]);
  const ctx = {
    settings: { source: 'gmail' },
    env: { ...GMAIL_ENV, ANTHROPIC_API_KEY: 'test-key' },
  };
  const enrichLeads = async (_ctx, _message, leads) =>
    leads.map((lead) => ({ ...lead, title: 'VP of Marketing', location: 'Remote' }));
  const jobs = await runIngest(ctx, { createSource: () => fake, enrichLeads });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'VP of Marketing');
  assert.equal(jobs[0].location, 'Remote');
});

await ta(
  'runIngest calls enrichLeads for the no-key path and its unchanged return value flows to Job[]',
  async () => {
    // A spy stands in for deps.enrichLeads (the same seam the LLM-enrichment test
    // above overrides) and returns its `leads` argument unchanged, simulating the
    // real no-key short-circuit in lib/extract-llm.mjs. This proves runIngest
    // actually dispatches through the enrichLeads call site for the no-key path,
    // not just that the pipeline produces the right output regardless of wiring.
    const fake = createFakeSource([
      {
        id: 'a',
        subject: 'VP Marketing at Acme',
        from: 'alerts@indeed.com',
        headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
        body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
      },
    ]);
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
    const calls = [];
    const enrichLeads = async (spyCtx, message, leads, breaker) => {
      calls.push({ ctx: spyCtx, message, leads, breaker });
      return leads;
    };
    const jobs = await runIngest(ctx, { createSource: () => fake, enrichLeads });
    assert.equal(calls.length, 1, 'enrichLeads is called once for the one authenticated message');
    assert.equal(calls[0].ctx, ctx, 'ctx is passed through unchanged');
    assert.equal(calls[0].message.id, 'a', 'the authenticated message is passed through');
    assert.deepEqual(
      calls[0].leads,
      extractLeads(calls[0].message),
      'the leads argument is exactly what extractLeads produces for this message',
    );
    assert.equal(typeof calls[0].breaker, 'object', 'a shared breaker object is passed through');
    assert.deepEqual(jobs, [
      {
        title: 'VP Marketing',
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        company: 'Acme',
        location: '',
      },
    ]);
  },
);

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

// Enforce the never-dead-link contract (#8) through the whole pipeline: a lead
// behind a non-ATS tracking link is emitted with a LIVE search-URL fallback, never
// the tracker. This fake ctx has no ctx.fetchJson, so the ATS probe's attempt
// throws and is caught as a miss (lib/resolve-network.mjs's generic catch), which
// keeps this hermetic regardless of whether extraction derived a company.
await ta(
  'runIngest emits a live search fallback for a tracker lead, never the tracker (#8)',
  async () => {
    const fake = createFakeSource([
      {
        id: 'a',
        subject: 'VP Marketing at Acme',
        from: 'alerts@indeed.com',
        headers: { 'authentication-results': 'mx.google.com; spf=pass; dmarc=pass' },
        body: 'Apply: https://click.indeed.com/redirect?jk=XYZ',
      },
    ]);
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
    const jobs = await runIngest(ctx, { createSource: () => fake });
    assert.equal(jobs.length, 1, 'the authenticated lead is preserved for the human');
    assert.doesNotMatch(
      jobs[0].url,
      /click\.indeed\.com/,
      'the dead tracking link is never emitted',
    );
    assert.match(
      jobs[0].url,
      /^https:\/\/www\.google\.com\/search\?q=/,
      'a live search URL replaces it',
    );
  },
);

await ta(
  'runIngest emits zero jobs for an empty mailbox, and the adapters stay guarded',
  async () => {
    const fake = createFakeSource([]);
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
    const jobs = await runIngest(ctx, { createSource: () => fake });
    assert.deepEqual(jobs, [], 'no messages means no jobs');

    // Both adapters are implemented, but with an empty ctx neither has ctx.fetch
    // or credentials, so neither can reach the network or produce a live job in
    // this hermetic test.
    await assert.rejects(() => createSource('gmail', {}).listMessages(14), /ctx\.fetch/);
    await assert.rejects(() => createSource('ms365', {}).listMessages(14), /ctx\.fetch/);
  },
);

console.log(`index.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
