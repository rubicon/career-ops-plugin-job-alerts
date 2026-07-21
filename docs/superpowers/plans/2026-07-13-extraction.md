# Extraction Implementation Plan (issue #10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every URL `lib/extract.mjs` finds in an authenticated message into a
real `{title, company, location}` lead, via a pure per-message regex baseline that
always runs, plus an optional single Anthropic-REST call per message that enriches
those fields when `ANTHROPIC_API_KEY` is present. No role filtering is added
anywhere in this plugin.

**Architecture:** `lib/extract.mjs` stays pure and gains subject-pattern parsing
(one derived `{title, company}` per message, applied to every URL found in it). A
new I/O module, `lib/extract-llm.mjs`, takes one message plus the leads
`extract.mjs` already produced for it, makes one Anthropic call, and overwrites
only the fields the model can confidently answer for a URL that is already on the
list; it can never introduce a URL. `lib/ingest.mjs` wires the two together in a
per-message loop with a circuit breaker shared across the run.

**Tech Stack:** Plain Node.js (`node:assert/strict` for tests), no runtime
dependencies, `ctx.fetchJson` for the one network call, `node --test`-free custom
`t`/`ta` harness already used by every test file in this repo.

## Global Constraints

- No runtime dependencies. Only relative imports and Node built-ins.
- Egress only via `ctx.fetch`/`ctx.fetchJson`/`ctx.fetchText`. Never `node:http`,
  `node:net`, or global `fetch`.
- `manifest.requiredEnv` stays `[]`. `ANTHROPIC_API_KEY` is optional; its absence
  must never throw, only skip enrichment.
- No em-dashes, no emojis, anywhere (code, comments, docs, commits).
- No AI-authorship trailers in any commit or file.
- Signed commits only (`git commit -S`); never `--no-verify`.
- Match the file's surrounding style: single quotes, 2-space indent, no
  semicolon-omission changes, `node:assert/strict`.
- `npm test` must stay green and pristine after every task.
- Credit sources precisely: the `"{Role} at {Company}"` pattern is from the
  bundled career-ops `gmail` plugin's `_helpers.mjs` `parseRoleAtCompany` (MIT);
  the three other subject forms are from
  `Schlaflied/career-ops-plugin-linkedin-alerts`'s `parseSubject` @ `de54949`
  (MIT). Do not attribute all four patterns to one source.

---

### Task 1: Pure subject-pattern parsing in `lib/extract.mjs`

**Files:**

- Modify: `lib/extract.mjs` (currently 17 lines, gives every URL in a message the
  raw subject as `title` and blank `company`)
- Modify: `test/index.test.mjs:186-194` (the `extract pulls each link...` test
  block asserts the OLD raw-subject behavior and must be updated to the new
  parsed output)
- Modify: `test/index.test.mjs:265-294` (the `runIngest wires the selected
source...` test's final `assert.deepEqual` asserts `title: 'VP Marketing at
Acme'`, `company: ''`; after this task the same input yields `title: 'VP
Marketing'`, `company: 'Acme'`)
- Modify: `test/index.test.mjs` around the `runIngest emits a live search
fallback...` test (currently around line 325-352): its leading comment says
  "Extraction does not yet produce a company, so the ATS probe finds no slug and
  the lead falls back without any network call" -- this becomes stale once this
  task lands (extraction WILL produce `company: 'Acme'` from that fixture's
  subject) and must be corrected

**Interfaces:**

- Produces: `extractLeads(message)` keeps its exact signature and still returns
  `{ title, url, company, location }[]`, one entry per URL found in the message
  body, but `title`/`company` are now derived per-message from the subject
  instead of always being `{title: rawSubject, company: ''}`.

- [ ] **Step 1: Write the failing tests in `test/index.test.mjs`**

Replace the existing `// -- stage: extract` block (currently lines 186-194) with:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/daxdavis/Developer/github.com/rubicon/career-ops-plugin-job-alerts/worktrees/dev-10-extraction && node test/index.test.mjs`
Expected: `FAIL extract parses "{Role} at {Company}"...` (and similar) because
`lib/extract.mjs` does not parse the subject yet. The two other affected tests
(`runIngest wires the selected source...`) also fail at this point; that is
expected and fixed in Step 5.

- [ ] **Step 3: Implement the parsing in `lib/extract.mjs`**

Replace the full file with:

```js
// Role extraction from an authenticated message. Pure and deterministic: this is
// the regex baseline that pulls candidate posting links from the body and pairs
// each with a title and company derived from the subject line. The optional LLM
// enrichment path is I/O (lib/extract-llm.mjs) and is orchestrated by the ingest
// hook, not here.
//
// The "{Role} at {Company}" pattern (with alert-prefix stripping and " - "/" | "
// truncation) is ported from the bundled career-ops gmail plugin's
// _helpers.mjs parseRoleAtCompany (MIT). The remaining three subject forms are
// ported from Schlaflied/career-ops-plugin-linkedin-alerts's parseSubject
// @ de54949 (MIT).

const URL_RE = /https?:\/\/[^\s"'<>()\]]+/gi;

const ALERT_PREFIX_RE =
  /^(re|fwd|new match|job alert|alert|match|notification|alert for|daily alert for):\s*/i;

// parseRoleAtCompany matches "{Role} at {Company}", after stripping a known
// alert-email prefix and truncating at a trailing " - "/" | " segment.
function parseRoleAtCompany(subject) {
  let clean = subject.replace(ALERT_PREFIX_RE, '').trim();
  clean = clean.split(/\s+[-|]\s+/)[0].trim();
  const match = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (!match) return null;
  const title = match[1].trim();
  const company = match[2].trim();
  if (!title || !company || title.length >= 100 || company.length >= 100) return null;
  return { title, company };
}

// parseLinkedinStyle matches the three subject forms linkedin-alerts recognizes:
// "{Company} is hiring a {Role}", "new jobs for you: {Role}, ...", and
// "N new {Role} jobs".
function parseLinkedinStyle(subject) {
  let m = subject.match(/^(.+?) is hiring (?:a |an )?(.+)$/i);
  if (m) return { company: m[1].trim(), title: m[2].trim() };

  m = subject.match(/new (?:\w+ )?jobs? for you:?\s*(.+)$/i);
  if (m) return { company: '', title: m[1].trim().split(',')[0].trim() };

  m = subject.match(/^\d+ new (.+?) jobs?/i);
  if (m) return { company: '', title: m[1].trim() };

  return null;
}

// parseSubjectFields tries each pattern in order, falling back to the raw
// subject as the title with no company when nothing matches.
function parseSubjectFields(subject) {
  const s = String(subject ?? '').trim();
  if (s === '') return { title: '', company: '' };
  return parseRoleAtCompany(s) ?? parseLinkedinStyle(s) ?? { title: s, company: '' };
}

// extractLeads returns one raw lead per link found in the message body, all
// sharing the same subject-derived title and company.
export function extractLeads(message) {
  const body = String(message?.body ?? '');
  const subject = String(message?.subject ?? '').trim();
  const { title, company } = parseSubjectFields(subject);
  const urls = body.match(URL_RE) ?? [];
  return urls.map((url) => ({ title, url, company, location: '' }));
}
```

- [ ] **Step 4: Run the extract tests to verify they pass**

Run: `node test/index.test.mjs`
Expected: the new `extract ...` tests pass. The two `runIngest ...` tests still
fail (expected; fixed next).

- [ ] **Step 5: Update the two affected `runIngest` tests and the stale comment**

In `test/index.test.mjs`, in the `runIngest wires the selected source through the
core to Job[]` test, change:

```js
assert.deepEqual(jobs[0], {
  title: 'VP Marketing at Acme',
  url: 'https://boards.greenhouse.io/acme/jobs/123',
  company: '',
  location: '',
});
```

to:

```js
assert.deepEqual(jobs[0], {
  title: 'VP Marketing',
  url: 'https://boards.greenhouse.io/acme/jobs/123',
  company: 'Acme',
  location: '',
});
```

In the same file, find the comment immediately above the `runIngest emits a live
search fallback for a tracker lead, never the tracker (#8)` test:

```js
// Enforce the never-dead-link contract (#8) through the whole pipeline: a lead
// behind a non-ATS tracking link is emitted with a LIVE search-URL fallback, never
// the tracker. Extraction does not yet produce a company, so the ATS probe finds no
// slug and the lead falls back without any network call, which keeps this hermetic.
```

Replace it with:

```js
// Enforce the never-dead-link contract (#8) through the whole pipeline: a lead
// behind a non-ATS tracking link is emitted with a LIVE search-URL fallback, never
// the tracker. This fake ctx has no ctx.fetchJson, so the ATS probe's attempt
// throws and is caught as a miss (lib/resolve-network.mjs's generic catch), which
// keeps this hermetic regardless of whether extraction derived a company.
```

- [ ] **Step 6: Run the full suite to verify everything passes**

Run: `npm test`
Expected: `smoke ok: ingest`, `index.test: <N> passed, 0 failed` (N is 2 higher
than before this task: 5 new extract tests added, 2 replaced in place), `gmail.test`
and `resolve-network.test` unchanged and green.

- [ ] **Step 7: Format and commit**

Run: `npm run format:check` (fix with `npm run format` if it fails, then re-run
`npm test`).

```bash
git add lib/extract.mjs test/index.test.mjs
git commit -S -m "feat(extract): parse title and company from the subject line"
```

---

### Task 2: `lib/extract-llm.mjs` (new I/O module) with tests

**Files:**

- Create: `lib/extract-llm.mjs`
- Create: `test/extract-llm.test.mjs`

**Interfaces:**

- Consumes: a lead shape `{ title, url, company, location }` (from
  `extractLeads`, Task 1). `ctx.fetchJson(url, options)` (engine-provided;
  throws on any non-2xx with an `Error` whose `.status` is the HTTP status,
  exactly like every other adapter in this repo). `ctx.log(...args)` (optional;
  guard with `typeof ctx?.log === 'function'`).
- Produces: `enrichLeads(ctx, message, leads, breaker = {})` -> `Promise<leads>`
  (same shape, some fields possibly overwritten). `breaker` is a plain mutable
  object; this module may set `breaker.disabled = true` on it. Task 3 creates one
  `breaker` per `runIngest` call and threads it through every message.

- [ ] **Step 1: Write the failing tests in `test/extract-llm.test.mjs`**

Create the file:

```js
// Unit tests for the optional LLM extraction enrichment (lib/extract-llm.mjs).
// Hermetic: no network. A fake ctx.fetchJson returns captured Anthropic Messages
// API response shapes and mirrors the engine's throw-on-non-2xx contract, exactly
// like test/gmail.test.mjs and test/resolve-network.test.mjs. The tests exercise
// real request-building and real response-parsing against those shapes; they do
// not assert that a stub was merely called.
//
// An optional live integration test runs only when a real ANTHROPIC_API_KEY is
// present and is skipped otherwise, so CI stays zero-network.
import assert from 'node:assert/strict';

import { enrichLeads } from '../lib/extract-llm.mjs';

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

const LEADS = [
  {
    title: 'VP Marketing',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    company: 'Acme',
    location: '',
  },
  { title: 'VP Marketing', url: 'https://jobs.lever.co/acme/2', company: 'Acme', location: '' },
];
const MESSAGE = { subject: '2 new VP Marketing jobs', body: 'See the two roles below.' };

// A text-response envelope shaped exactly like the real Anthropic Messages API.
function textResponse(jsonArrayText) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: jsonArrayText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

// Build a fake ctx. `impl` receives (url, options) and returns a response object,
// or throws an Error with `.status` to model the engine's throw-on-non-2xx
// contract for ctx.fetchJson.
function makeCtx({ env = {}, impl, logs } = {}) {
  const calls = [];
  async function fetchJson(url, options) {
    calls.push({ url, options });
    return impl(url, options);
  }
  const log = (...args) => {
    if (logs) logs.push(args.join(' '));
  };
  return { env, fetchJson, calls, log };
}

await ta(
  'no ANTHROPIC_API_KEY: returns the leads unchanged and never calls fetchJson',
  async () => {
    const ctx = makeCtx({ env: {}, impl: () => assert.fail('must not call fetchJson') });
    const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
    assert.deepEqual(result, LEADS);
    assert.equal(ctx.calls.length, 0);
  },
);

await ta('empty leads: returns immediately and never calls fetchJson', async () => {
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () => assert.fail('must not call fetchJson'),
  });
  const result = await enrichLeads(ctx, MESSAGE, [], {});
  assert.deepEqual(result, []);
  assert.equal(ctx.calls.length, 0);
});

await ta(
  'builds the correct request: endpoint, headers, model, and the known url list',
  async () => {
    const ctx = makeCtx({
      env: { ANTHROPIC_API_KEY: 'sk-test-123' },
      impl: () => textResponse('[]'),
    });
    await enrichLeads(ctx, MESSAGE, LEADS, {});
    assert.equal(ctx.calls.length, 1);
    const { url, options } = ctx.calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.headers['x-api-key'], 'sk-test-123');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.match(body.messages[0].content, /https:\/\/boards\.greenhouse\.io\/acme\/jobs\/1/);
    assert.match(body.messages[0].content, /https:\/\/jobs\.lever\.co\/acme\/2/);
  },
);

await ta("a confident match overwrites the matched lead's fields", async () => {
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () =>
      textResponse(
        JSON.stringify([
          {
            url: 'https://boards.greenhouse.io/acme/jobs/1',
            title: 'VP of Marketing',
            company: 'Acme Corp',
            location: 'Remote',
          },
        ]),
      ),
  });
  const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
  assert.deepEqual(result[0], {
    title: 'VP of Marketing',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    company: 'Acme Corp',
    location: 'Remote',
  });
  assert.deepEqual(
    result[1],
    LEADS[1],
    'the lead the model did not answer for keeps its baseline fields',
  );
});

await ta('a field the model omits keeps the regex baseline for that field', async () => {
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () =>
      textResponse(
        JSON.stringify([
          {
            url: 'https://boards.greenhouse.io/acme/jobs/1',
            title: '',
            company: '',
            location: 'Austin, TX',
          },
        ]),
      ),
  });
  const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
  assert.equal(result[0].title, 'VP Marketing', 'empty title from the model keeps the baseline');
  assert.equal(result[0].company, 'Acme', 'empty company from the model keeps the baseline');
  assert.equal(result[0].location, 'Austin, TX', 'a real location from the model is applied');
});

await ta('an invented url not in the known list is discarded, never trusted', async () => {
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () =>
      textResponse(
        JSON.stringify([
          {
            url: 'https://not-a-real-lead.example/999',
            title: 'Fake',
            company: 'Fake',
            location: '',
          },
        ]),
      ),
  });
  const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
  assert.deepEqual(result, LEADS, 'no lead was touched by the invented url');
});

await ta('a duplicate url in the response: the first entry wins', async () => {
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () =>
      textResponse(
        JSON.stringify([
          {
            url: 'https://boards.greenhouse.io/acme/jobs/1',
            title: 'First',
            company: 'Acme',
            location: '',
          },
          {
            url: 'https://boards.greenhouse.io/acme/jobs/1',
            title: 'Second',
            company: 'Acme',
            location: '',
          },
        ]),
      ),
  });
  const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
  assert.equal(result[0].title, 'First');
});

await ta('malformed JSON in the response: falls back to the baseline and logs', async () => {
  const logs = [];
  const ctx = makeCtx({
    env: { ANTHROPIC_API_KEY: 'key' },
    impl: () => textResponse('not json at all'),
    logs,
  });
  const result = await enrichLeads(ctx, MESSAGE, LEADS, {});
  assert.deepEqual(result, LEADS);
  assert.ok(logs.some((l) => /extract/i.test(l)));
});

await ta(
  'a non-2xx failure: falls back to the baseline and logs, does not trip the breaker',
  async () => {
    const logs = [];
    const breaker = {};
    const ctx = makeCtx({
      env: { ANTHROPIC_API_KEY: 'key' },
      impl: () => {
        const err = new Error('HTTP 500: internal error');
        err.status = 500;
        throw err;
      },
      logs,
    });
    const result = await enrichLeads(ctx, MESSAGE, LEADS, breaker);
    assert.deepEqual(result, LEADS);
    assert.equal(breaker.disabled, undefined, 'a transient failure does not trip the breaker');
    assert.ok(logs.length >= 1);
  },
);

await ta(
  'a 401 trips the breaker; the next message in the same run skips the call entirely',
  async () => {
    const logs = [];
    const breaker = {};
    let calls = 0;
    const ctx = makeCtx({
      env: { ANTHROPIC_API_KEY: 'bad-key' },
      impl: () => {
        calls++;
        const err = new Error('HTTP 401: invalid x-api-key');
        err.status = 401;
        throw err;
      },
      logs,
    });
    const first = await enrichLeads(ctx, MESSAGE, LEADS, breaker);
    assert.deepEqual(first, LEADS);
    assert.equal(breaker.disabled, true);
    const second = await enrichLeads(ctx, MESSAGE, LEADS, breaker);
    assert.deepEqual(second, LEADS);
    assert.equal(calls, 1, 'the breaker prevented a second network attempt');
  },
);

// -- optional live integration (skipped without a real ANTHROPIC_API_KEY) --
await ta('live: real Anthropic round-trip (skipped without ANTHROPIC_API_KEY)', async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  SKIP live Anthropic integration: set ANTHROPIC_API_KEY to run it');
    return;
  }
  const ctx = {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    fetchJson: async (url, options) => {
      const res = await fetch(url, options);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  };
  const leads = [
    {
      title: 'Engineer',
      url: 'https://boards.greenhouse.io/example/jobs/1',
      company: 'Example',
      location: '',
    },
  ];
  const result = await enrichLeads(ctx, MESSAGE, leads, {});
  assert.equal(result.length, 1);
  assert.equal(result[0].url, leads[0].url);
});

console.log(`extract-llm.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/extract-llm.test.mjs`
Expected: `Cannot find module '../lib/extract-llm.mjs'` (the module does not exist
yet).

- [ ] **Step 3: Implement `lib/extract-llm.mjs`**

```js
// Optional LLM extraction enrichment. I/O: makes at most one Anthropic Messages
// API call per authenticated message, only when ANTHROPIC_API_KEY is present. The
// pure regex baseline (lib/extract.mjs) is the unconditional source of every url
// this module is allowed to touch: it never introduces a url, it only overwrites
// title/company/location for a url that is already on the list, and only when it
// returns something for that url.
//
// Egress goes only through ctx.fetchJson (the engine applies manifest.allowedHosts
// and its SSRF guard, and throws on any non-2xx response). This module imports no
// node:http/node:net and calls no global fetch, and has no runtime dependencies.
//
// Request/response contract verified against the official Anthropic API
// reference (platform.claude.com/docs/en/api/messages), not invented.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const BODY_CAP = 8000;

const SYSTEM_PROMPT =
  'You extract job posting fields from a job-alert email. Return ONLY a JSON ' +
  'array of objects {"url","title","company","location"}. Include an entry only ' +
  'for a url from the exact list given below, copied verbatim. Never invent or ' +
  'modify a url. If you cannot confidently determine a field, use an empty ' +
  'string rather than guessing. Output only the JSON array, no prose.';

// enrichLeads enriches leads for one message with at most one Anthropic call.
// `breaker` is a plain object shared across every message in one ingest run; this
// function may set `breaker.disabled = true` on it after a 401/403, after which
// every subsequent call in that run returns its input unchanged without a network
// attempt.
export async function enrichLeads(ctx, message, leads, breaker = {}) {
  if (!Array.isArray(leads) || leads.length === 0) return leads;
  const apiKey = ctx?.env?.ANTHROPIC_API_KEY;
  if (!apiKey) return leads;
  if (breaker.disabled) return leads;

  let text;
  try {
    text = await callAnthropic(ctx, apiKey, message, leads);
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      breaker.disabled = true;
      logLine(
        ctx,
        `job-alerts: disabling LLM extraction for this run (${err.status}): ${err.message}`,
      );
    } else {
      logLine(
        ctx,
        `job-alerts: LLM extraction failed for this message, using the regex baseline: ${err.message}`,
      );
    }
    return leads;
  }

  const enrichments = parseEnrichments(text, leads);
  if (enrichments.size === 0 && text.trim() !== '[]') {
    logLine(
      ctx,
      'job-alerts: LLM extraction returned no usable entries, using the regex baseline.',
    );
  }
  return mergeEnrichments(leads, enrichments);
}

async function callAnthropic(ctx, apiKey, message, leads) {
  const urls = leads.map((lead) => lead.url);
  const userContent =
    `URLs:\n${urls.map((u) => `- ${u}`).join('\n')}\n\n` +
    `Email subject: ${String(message?.subject ?? '')}\n\n` +
    `Email body:\n${String(message?.body ?? '').slice(0, BODY_CAP)}`;

  const data = await ctx.fetchJson(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  return (data?.content ?? []).map((block) => block?.text ?? '').join('');
}

// parseEnrichments extracts the first JSON array in the response text (the model
// is asked for only a JSON array, but this stays defensive against stray prose),
// then keeps only entries whose url is a member of the known set, first entry
// wins on a duplicate url.
function parseEnrichments(text, leads) {
  const known = new Set(leads.map((lead) => lead.url));
  const parsed = firstJsonArray(text);
  const byUrl = new Map();
  if (!Array.isArray(parsed)) return byUrl;
  for (const entry of parsed) {
    const url = entry?.url;
    if (typeof url !== 'string' || !known.has(url) || byUrl.has(url)) continue;
    byUrl.set(url, {
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      company: typeof entry.company === 'string' ? entry.company.trim() : '',
      location: typeof entry.location === 'string' ? entry.location.trim() : '',
    });
  }
  return byUrl;
}

function firstJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// mergeEnrichments overwrites only the fields an enrichment actually answered; an
// empty-string field from the model keeps that lead's existing (regex-baseline)
// value.
function mergeEnrichments(leads, byUrl) {
  return leads.map((lead) => {
    const enrichment = byUrl.get(lead.url);
    if (!enrichment) return lead;
    return {
      ...lead,
      title: enrichment.title || lead.title,
      company: enrichment.company || lead.company,
      location: enrichment.location || lead.location,
    };
  });
}

function logLine(ctx, message) {
  if (typeof ctx?.log === 'function') ctx.log(message);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/extract-llm.test.mjs`
Expected: `extract-llm.test: 11 passed, 0 failed` and the live test prints
`SKIP live Anthropic integration: set ANTHROPIC_API_KEY to run it`.

- [ ] **Step 5: Add the new test file to `package.json`'s test script**

In `package.json`, change:

```json
    "test": "node test/smoke.mjs && node test/index.test.mjs && node test/gmail.test.mjs && node test/resolve-network.test.mjs",
```

to:

```json
    "test": "node test/smoke.mjs && node test/index.test.mjs && node test/gmail.test.mjs && node test/resolve-network.test.mjs && node test/extract-llm.test.mjs",
```

- [ ] **Step 6: Run the full suite and format check**

Run: `npm test`
Expected: all five test files pass, pristine output, both live tests SKIP.

Run: `npm run format:check`
Expected: clean (fix with `npm run format` if not, then re-run `npm test`).

- [ ] **Step 7: Commit**

```bash
git add lib/extract-llm.mjs test/extract-llm.test.mjs package.json
git commit -S -m "feat(extract): add optional Anthropic LLM enrichment with a circuit breaker"
```

---

### Task 3: Wire `extract-llm` into `lib/ingest.mjs`

**Files:**

- Modify: `lib/ingest.mjs`
- Modify: `manifest.json` (`allowedHosts`)
- Modify: `test/index.test.mjs` (add two new `runIngest`-level tests)

**Interfaces:**

- Consumes: `enrichLeads(ctx, message, leads, breaker)` from Task 2.
- Produces: `runIngest(ctx, deps)` keeps its existing signature; `deps` gains an
  optional `enrichLeads` override (same injectable-dependency pattern already
  used for `createSource`, `validateSourceEnv`, `resolveNetwork`).

- [ ] **Step 1: Write the failing tests in `test/index.test.mjs`**

Add these two tests directly after the `runIngest wires the selected source
through the core to Job[]` test:

```js
await ta('runIngest enriches leads via the LLM when ANTHROPIC_API_KEY is present', async () => {
  const fake = createFakeSource([
    {
      id: 'a',
      subject: 'VP Marketing at Acme',
      from: 'alerts@indeed.com',
      headers: { 'authentication-results': 'mx; dmarc=pass' },
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
  'runIngest produces baseline-only results end to end with no ANTHROPIC_API_KEY',
  async () => {
    // Uses the REAL default enrichLeads (no deps override): this is an end-to-end
    // wiring check, not a re-test of enrichLeads' own no-key-skip logic (already
    // proven directly against the real module in test/extract-llm.test.mjs, the
    // one place that can assert ctx.fetchJson is never even attempted).
    const fake = createFakeSource([
      {
        id: 'a',
        subject: 'VP Marketing at Acme',
        from: 'alerts@indeed.com',
        headers: { 'authentication-results': 'mx; dmarc=pass' },
        body: 'Apply: https://boards.greenhouse.io/acme/jobs/123',
      },
    ]);
    const ctx = { settings: { source: 'gmail' }, env: GMAIL_ENV };
    const jobs = await runIngest(ctx, { createSource: () => fake });
    assert.equal(jobs[0].title, 'VP Marketing');
    assert.equal(jobs[0].company, 'Acme');
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/index.test.mjs`
Expected: both new tests FAIL because `runIngest` does not yet accept or call an
`enrichLeads` dependency.

- [ ] **Step 3: Wire `enrichLeads` into `lib/ingest.mjs`**

Replace the full file with:

```js
// Ingest wiring: selects the mail source, validates its env fail-fast, then runs
// the source-agnostic core (DMARC gate, extract, optional LLM enrichment,
// normalize, canonical classification, network resolution, dedup, assembly) and
// returns Job[].
//
// This module owns all I/O ordering; the core stages it calls are pure except
// resolveNetwork and enrichLeads, which are I/O and take ctx directly. Egress
// happens only through ctx.fetch / ctx.fetchJson / ctx.fetchText inside those
// modules and inside a mail source adapter.

import {
  createSource as defaultCreateSource,
  validateSourceEnv as defaultValidateSourceEnv,
} from './sources/registry.mjs';
import { passesDmarc } from './dmarc.mjs';
import { extractLeads } from './extract.mjs';
import { enrichLeads as defaultEnrichLeads } from './extract-llm.mjs';
import { normalizeLead } from './normalize.mjs';
import { resolveCanonical } from './resolve-canonical.mjs';
import { resolveNetwork as defaultResolveNetwork } from './resolve-network.mjs';
import { dedup } from './dedup.mjs';
import { buildJobs } from './append.mjs';

const DEFAULT_WINDOW_DAYS = 14;

// runIngest wires the configured source through the core. Dependencies are
// injectable so the wiring can be tested against a fake in-memory MailSource.
export async function runIngest(ctx, deps = {}) {
  const createSource = deps.createSource ?? defaultCreateSource;
  const validateSourceEnv = deps.validateSourceEnv ?? defaultValidateSourceEnv;
  const resolveNetwork = deps.resolveNetwork ?? defaultResolveNetwork;
  const enrichLeads = deps.enrichLeads ?? defaultEnrichLeads;

  const source = ctx?.settings?.source;
  const env = ctx?.env ?? {};

  // Fail fast: validate the selected source and its env before any mailbox work.
  validateSourceEnv(source, env);

  const mail = createSource(source, ctx);
  const sinceDays = windowDays(ctx?.settings?.sinceDays);
  const messages = (await mail.listMessages(sinceDays)) ?? [];

  const authenticated = messages.filter(passesDmarc);

  // One optional LLM call per authenticated message, never more. A circuit
  // breaker shared across the loop stops further attempts for the rest of this
  // run after a 401/403, without ever aborting the run itself.
  const breaker = {};
  const perMessageLeads = [];
  for (const message of authenticated) {
    const baseline = extractLeads(message);
    const enriched = await enrichLeads(ctx, message, baseline, breaker);
    perMessageLeads.push(enriched);
  }

  const classified = perMessageLeads.flat().map(normalizeLead).map(resolveCanonical);
  // Tier-1 network resolution turns every needs-canonical lead into either a
  // canonical ATS posting URL or a live {company, title} search-URL fallback, so no
  // dead tracking link ever reaches buildJobs (#8). Already-canonical leads pass
  // through untouched.
  const resolved = await resolveNetwork(ctx, classified);
  return buildJobs(dedup(resolved));
}

function windowDays(setting) {
  const n = Number(setting);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_DAYS;
}
```

- [ ] **Step 4: Add `api.anthropic.com` to `manifest.json`'s `allowedHosts`**

Change:

```json
  "allowedHosts": [
    "oauth2.googleapis.com",
    "gmail.googleapis.com",
    "boards-api.greenhouse.io",
    "api.lever.co",
    "api.ashbyhq.com"
  ],
```

to:

```json
  "allowedHosts": [
    "oauth2.googleapis.com",
    "gmail.googleapis.com",
    "boards-api.greenhouse.io",
    "api.lever.co",
    "api.ashbyhq.com",
    "api.anthropic.com"
  ],
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npm test`
Expected: `smoke ok: ingest`, all five test files pass, pristine output, both
live tests SKIP.

- [ ] **Step 6: Format check and commit**

Run: `npm run format:check` (fix with `npm run format` if needed, then re-run
`npm test`).

```bash
git add lib/ingest.mjs manifest.json test/index.test.mjs
git commit -S -m "feat(ingest): wire optional LLM extraction enrichment into the pipeline"
```

---

### Task 4: Docs: role-agnostic language and `ANTHROPIC_API_KEY` documentation

**Files:**

- Modify: `CLAUDE.md:10`
- Modify: `README.md:27-28`
- Modify: `skill.md:16`, `skill.md:30`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Fix `CLAUDE.md`**

Change (line 8-12, the "What this project is" paragraph):

```markdown
career-ops-plugin-job-alerts is a [career-ops](https://github.com/santifer/career-ops)
plugin with the `ingest` hook. It reads job-alert emails from Gmail or Microsoft
365, verifies sender authenticity (DMARC), extracts marketing-leadership roles, and
resolves board tracking links to the employer's canonical posting before returning
`Job[]` to the pipeline. See `ARCHITECTURE.md` for layout and data flow.
```

to:

```markdown
career-ops-plugin-job-alerts is a [career-ops](https://github.com/santifer/career-ops)
plugin with the `ingest` hook. It reads job-alert emails from Gmail or Microsoft
365, verifies sender authenticity (DMARC), extracts every posting it finds, and
resolves board tracking links to the employer's canonical posting before returning
`Job[]` to the pipeline. The plugin does not filter by role: the alert
subscription itself and career-ops's own downstream pipeline evaluate already do
that job. See `ARCHITECTURE.md` for layout and data flow.
```

- [ ] **Step 2: Fix `README.md`**

Change (in the "What it does" list):

```markdown
- **Extracts** marketing-leadership roles. Primary path is LLM extraction via the
  Anthropic API; without a key it falls back to regex and subject-line parsing.
```

to:

```markdown
- **Extracts** every posting it finds, with no role filter of its own: the alert
  subscription and career-ops's own downstream pipeline evaluate already narrow
  what you see. Primary path is a small LLM call (`claude-haiku-4-5-20251001`)
  per authenticated email via the Anthropic API; without a key, or if a call
  fails, it falls back to deterministic subject-line and regex parsing.
```

- [ ] **Step 3: Fix `skill.md`**

Change (in the "What it does" section):

```markdown
Reads job-alert emails from a Gmail or Microsoft 365 mailbox, verifies the sender
is authentic (DMARC fail-closed), extracts marketing-leadership roles, and resolves
board tracking links to the employer's canonical posting before returning them to
the pipeline. It never submits anything; it only produces leads you review.
```

to:

```markdown
Reads job-alert emails from a Gmail or Microsoft 365 mailbox, verifies the sender
is authentic (DMARC fail-closed), extracts every posting it finds, and resolves
board tracking links to the employer's canonical posting before returning them to
the pipeline. It never submits anything; it only produces leads you review. It
does not filter by role: your alert subscription and career-ops's own downstream
pipeline evaluate already do that.
```

And change (in the "What it produces" section):

```markdown
`Job[]` where each job is `{ title, url, company, location }`. `url` is the
resolved canonical posting when resolution succeeds; a lead that cannot be resolved
is flagged `needs-canonical` rather than kept as a dead tracking link. Roles are
filtered to marketing leadership.
```

to:

```markdown
`Job[]` where each job is `{ title, url, company, location }`. `url` is the
resolved canonical posting when resolution succeeds; a lead that cannot be resolved
gets a live search-URL fallback rather than a dead tracking link. Title and
company come from a small LLM call when `ANTHROPIC_API_KEY` is set, or from
deterministic subject-line parsing otherwise; every posting found is returned,
with no role filter of its own.
```

- [ ] **Step 4: Add `ANTHROPIC_API_KEY` to skill.md's optional-key table if not already accurate**

Confirm the existing "Optional for either source" table in `skill.md` already
lists `ANTHROPIC_API_KEY` correctly (it does, from issue #2's work); no change
needed there beyond the two sections above. Read the file after Steps 1-3 to
confirm no other "marketing" reference remains:

Run: `grep -rn "marketing-leadership\|filtered to marketing" CLAUDE.md README.md skill.md`
Expected: no output.

- [ ] **Step 5: Run the full suite and format check**

Run: `npm test && npm run format:check`
Expected: unaffected, still green (docs-only change).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md skill.md
git commit -S -m "docs: describe extraction as role-agnostic, document the extraction model"
```

---

### Task 5: Final verification and draft PR

**Files:** None (verification and repo-mechanics only).

- [ ] **Step 1: Run the complete test suite one more time**

Run: `npm test`
Expected: `smoke ok: ingest`, and every one of `index.test`, `gmail.test`,
`resolve-network.test`, `extract-llm.test` passing with 0 failures, pristine
output, both live tests printing their SKIP line.

- [ ] **Step 2: Run format check and confirm no em-dashes were introduced**

Run: `npm run format:check`
Expected: clean.

Run: `git grep -nP '\xe2\x80\x94' -- $(git ls-files)`
Expected: no output (no em-dashes in any tracked file).

- [ ] **Step 3: Confirm every commit on the branch is signed**

Run: `git log --format='%h %G? %s' main..HEAD`
Expected: every line's second field is `G`.

- [ ] **Step 4: Push and open the draft PR**

```bash
git push
gh pr create --draft \
  --title "feat(extract): LLM-enriched, role-agnostic extraction" \
  --body "Implements issue #10: docs/superpowers/specs/2026-07-13-extraction-design.md.

Adds subject-pattern parsing to the pure lib/extract.mjs baseline (ported from
the bundled gmail plugin's parseRoleAtCompany and linkedin-alerts' parseSubject,
both MIT, credited in the file header), plus an optional lib/extract-llm.mjs
that makes one Anthropic call per authenticated message to enrich fields when
ANTHROPIC_API_KEY is set, with a circuit breaker on repeated auth failures. No
role filtering is added: that is the alert subscription's job and career-ops's
own downstream pipeline evaluate.

Verified: npm test green and pristine (smoke, index.test, gmail.test,
resolve-network.test, extract-llm.test), format:check clean, no em-dashes,
every commit signed.

Closes #10"
```

- [ ] **Step 5: Report status**

The PR is a draft. It is not marked ready and not merged; that decision belongs
to Dax. Report the PR URL and the final test output.
