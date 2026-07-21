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
