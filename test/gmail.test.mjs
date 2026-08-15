// Unit tests for the Gmail MailSource adapter (lib/sources/gmail.mjs).
// Hermetic: no network. A fake ctx.fetch returns captured Gmail API response
// shapes (token, messages.list with and without nextPageToken, messages.get with
// an Authentication-Results header and a multipart base64url body). The tests
// exercise the adapter's real request-building and response-parsing against those
// real shapes; they do not assert that a stub was merely called.
//
// An optional live integration test runs only when real GMAIL_* env vars are
// present and is skipped otherwise, so CI stays zero-network.
import assert from 'node:assert/strict';

import { create, requiredEnv, trustedAuthservId } from '../lib/sources/gmail.mjs';
import { passesDmarc } from '../lib/dmarc.mjs';

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

const GMAIL_ENV = {
  GMAIL_CLIENT_ID: 'client-id-123',
  GMAIL_CLIENT_SECRET: 'client-secret-456',
  GMAIL_REFRESH_TOKEN: 'refresh-789',
};

// Encode a string to base64url the way Gmail delivers body part data.
function toB64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

// Build a fake fetch/ctx. `routes` maps a URL-substring to a response spec (or a
// function producing one, given the call index for that route). Every call is
// recorded so request shape can be asserted.
function makeCtx({ env = GMAIL_ENV, settings = {}, routes, logs }) {
  const calls = [];
  const routeCounts = {};
  async function fetchImpl(url, options = {}) {
    calls.push({ url, options });
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) {
        const n = routeCounts[key] ?? 0;
        routeCounts[key] = n + 1;
        const spec = typeof routes[key] === 'function' ? routes[key](n) : routes[key];
        return respond(spec);
      }
    }
    throw new Error(`no fake route for ${url}`);
  }
  const log = (...args) => {
    if (logs) logs.push(args.join(' '));
  };
  return { env, settings, fetch: fetchImpl, calls, log };
}

// Mirror the engine's guardedFetch contract: throw on any non-2xx (an Error with a
// .status property and an `HTTP <status>: <snippet>` message), and return a
// Response-like object (only json()/text(), the surface the adapter uses) on 2xx.
function respond({ ok = true, status = 200, json = undefined, text = undefined }) {
  if (!ok) {
    const snippet = (text ?? (json === undefined ? '' : JSON.stringify(json))).slice(0, 300);
    const err = new Error(snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`);
    err.status = status;
    throw err;
  }
  return {
    async json() {
      return json;
    },
    async text() {
      if (text !== undefined) return text;
      return json === undefined ? '' : JSON.stringify(json);
    },
  };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LIST_PATH = '/gmail/v1/users/me/messages';

function tokenOk(access = 'access-token-abc') {
  return { json: { access_token: access, expires_in: 3599, token_type: 'Bearer' } };
}

// A messages.get fixture: multipart, with an Authentication-Results header
// carrying dmarc=pass and a base64url-encoded plain-text body part.
function getFixture(
  id,
  { dmarc = 'pass', subject = 'VP Marketing at Acme', from = 'alerts@indeed.com', body } = {},
) {
  const plain =
    body ?? `Top role >>> Apply now: https://boards.greenhouse.io/acme/jobs/${id} launch`;
  return {
    json: {
      id,
      payload: {
        headers: [
          { name: 'Delivered-To', value: 'me@example.com' },
          { name: 'Subject', value: subject },
          { name: 'From', value: from },
          { name: 'Authentication-Results', value: `mx.google.com; spf=pass; dmarc=${dmarc}` },
        ],
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: toB64Url(plain) } },
          {
            mimeType: 'text/html',
            body: {
              data: toB64Url(
                `<html><a href="https://boards.greenhouse.io/acme/jobs/${id}">apply</a></html>`,
              ),
            },
          },
        ],
      },
    },
  };
}

// Expected Gmail after: date string for a window, computed independently.
function expectedAfter(sinceDays) {
  const d = new Date();
  d.setDate(d.getDate() - sinceDays);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// -- requiredEnv ----------------------------------------------------------
await ta('requiredEnv lists the three Gmail keys', async () => {
  assert.deepEqual(requiredEnv, ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
});

// -- token request shape --------------------------------------------------
await ta('token exchange posts the refresh-token grant from ctx.env', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [LIST_PATH]: { json: { messages: [] } },
    },
  });
  await create(ctx).listMessages(14);

  const tokenCall = ctx.calls.find((c) => c.url === TOKEN_URL);
  assert.ok(tokenCall, 'token endpoint was called');
  assert.equal(tokenCall.options.method, 'POST');
  assert.match(tokenCall.options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const params = new URLSearchParams(tokenCall.options.body);
  assert.equal(params.get('client_id'), GMAIL_ENV.GMAIL_CLIENT_ID);
  assert.equal(params.get('client_secret'), GMAIL_ENV.GMAIL_CLIENT_SECRET);
  assert.equal(params.get('refresh_token'), GMAIL_ENV.GMAIL_REFRESH_TOKEN);
  assert.equal(params.get('grant_type'), 'refresh_token');
});

// -- messages.list request shape ------------------------------------------
await ta('messages.list builds after: from sinceDays and sends the bearer token', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk('tok-xyz'),
      [LIST_PATH]: { json: { messages: [] } },
    },
  });
  await create(ctx).listMessages(7);

  const listCall = ctx.calls.find((c) => c.url.includes(LIST_PATH));
  assert.ok(listCall, 'list endpoint was called');
  const u = new URL(listCall.url);
  assert.equal(u.searchParams.get('q'), `after:${expectedAfter(7)}`);
  assert.ok(u.searchParams.get('maxResults'), 'maxResults is set');
  assert.equal(listCall.options.headers.Authorization, 'Bearer tok-xyz');
});

await ta('a single sender setting adds a from: filter', async () => {
  const ctx = makeCtx({
    settings: { sender: 'alerts@indeed.com' },
    routes: { [TOKEN_URL]: tokenOk(), [LIST_PATH]: { json: { messages: [] } } },
  });
  await create(ctx).listMessages(14);
  const listCall = ctx.calls.find((c) => c.url.includes(LIST_PATH));
  const q = new URL(listCall.url).searchParams.get('q');
  assert.match(q, /from:alerts@indeed\.com/);
  assert.match(q, new RegExp(`after:${expectedAfter(14).replace(/\//g, '\\/')}`));
});

await ta('a list of senders becomes a Gmail OR group', async () => {
  const ctx = makeCtx({
    settings: { sender: ['a@x.com', 'b@y.com'] },
    routes: { [TOKEN_URL]: tokenOk(), [LIST_PATH]: { json: { messages: [] } } },
  });
  await create(ctx).listMessages(14);
  const q = new URL(ctx.calls.find((c) => c.url.includes(LIST_PATH)).url).searchParams.get('q');
  assert.match(q, /\{from:a@x\.com from:b@y\.com\}/);
});

// -- mapping to the MailSource record -------------------------------------
await ta('maps a message to { id, subject, from, headers-as-object, decoded body }', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1'),
      [LIST_PATH]: { json: { messages: [{ id: 'm1' }] } },
    },
  });
  const [rec] = await create(ctx).listMessages(14);

  assert.equal(rec.id, 'm1');
  assert.equal(rec.subject, 'VP Marketing at Acme');
  assert.equal(rec.from, 'alerts@indeed.com');
  // headers must be a plain object map, not Gmail's [{name,value}] array.
  assert.equal(Array.isArray(rec.headers), false);
  assert.equal(typeof rec.headers, 'object');
  assert.equal(rec.headers['Authentication-Results'], 'mx.google.com; spf=pass; dmarc=pass');
  // decoded body survived base64url decoding across parts and keeps the URL.
  assert.match(rec.body, /https:\/\/boards\.greenhouse\.io\/acme\/jobs\/m1/);
});

await ta('the fixture body data really is base64url (contains - or _)', async () => {
  // Guards the test itself: the plain part must exercise the -/_ replacement.
  const data = getFixture('m1').json.payload.parts[0].body.data;
  assert.match(data, /[-_]/, 'fixture data uses base64url alphabet');
});

await ta('the mapped headers object satisfies the real DMARC gate', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [`${LIST_PATH}/pass1`]: getFixture('pass1', { dmarc: 'pass' }),
      [`${LIST_PATH}/fail1`]: getFixture('fail1', { dmarc: 'fail' }),
      [LIST_PATH]: { json: { messages: [{ id: 'pass1' }, { id: 'fail1' }] } },
    },
  });
  const recs = await create(ctx).listMessages(14);
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  const options = { authservId: trustedAuthservId };
  assert.equal(passesDmarc(byId.pass1, options), true, 'dmarc=pass survives into headers');
  assert.equal(passesDmarc(byId.fail1, options), false, 'dmarc=fail is rejected by the gate');
});

await ta('the declared authserv-id is the Gmail receiving boundary', async () => {
  assert.equal(trustedAuthservId, 'mx.google.com');
});

await ta('a repeated Authentication-Results cannot overwrite the boundary field', async () => {
  // Gmail returns the full RFC 5322 header set, in which a name may repeat: the
  // boundary stamps its own Authentication-Results and delivers whatever copies
  // the message already carried. Every instance must survive the mapping, or the
  // gate cannot find the one that counts -- and the verdict must come from that
  // one whichever position it lands in.
  const both = (first, second) => ({
    json: {
      id: 'm1',
      payload: {
        headers: [
          { name: 'Subject', value: 'VP Marketing at Acme' },
          { name: 'Authentication-Results', value: first },
          { name: 'Authentication-Results', value: second },
        ],
        body: { data: toB64Url('https://boards.greenhouse.io/acme/jobs/m1') },
      },
    },
  });
  const read = async (fixture) => {
    const ctx = makeCtx({
      routes: {
        [TOKEN_URL]: tokenOk(),
        [`${LIST_PATH}/m1`]: fixture,
        [LIST_PATH]: { json: { messages: [{ id: 'm1' }] } },
      },
    });
    const [rec] = await create(ctx).listMessages(14);
    return rec;
  };
  const options = { authservId: trustedAuthservId };

  const forgedFirst = await read(
    both('mx.google.com.evil.tld; dmarc=pass', 'mx.google.com; spf=fail; dmarc=fail'),
  );
  assert.match(forgedFirst.headers['Authentication-Results'], /evil\.tld/);
  assert.match(forgedFirst.headers['Authentication-Results'], /dmarc=fail/);
  assert.equal(passesDmarc(forgedFirst, options), false, 'the boundary said fail');

  const forgedLast = await read(
    both('mx.google.com; spf=pass; dmarc=pass', 'evil.tld; dmarc=fail'),
  );
  assert.equal(passesDmarc(forgedLast, options), true, 'the boundary said pass');
});

// -- pagination -----------------------------------------------------------
await ta('follows nextPageToken across pages and fetches every id', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [`${LIST_PATH}/a`]: getFixture('a'),
      [`${LIST_PATH}/b`]: getFixture('b'),
      [`${LIST_PATH}/c`]: getFixture('c'),
      [LIST_PATH]: (n) =>
        n === 0
          ? { json: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'PAGE2' } }
          : { json: { messages: [{ id: 'c' }] } },
    },
  });
  const recs = await create(ctx).listMessages(14);
  assert.deepEqual(recs.map((r) => r.id).sort(), ['a', 'b', 'c']);
  // The second list call must carry the pageToken from the first response.
  const listCalls = ctx.calls.filter(
    (c) => c.url.includes(LIST_PATH) && !/\/messages\/[abc]\b/.test(c.url),
  );
  assert.equal(listCalls.length, 2, 'two list pages were requested');
  assert.equal(new URL(listCalls[1].url).searchParams.get('pageToken'), 'PAGE2');
});

await ta('an empty mailbox returns no records and fetches no messages', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_URL]: tokenOk(), [LIST_PATH]: { json: {} } },
  });
  const recs = await create(ctx).listMessages(14);
  assert.deepEqual(recs, []);
  assert.equal(
    ctx.calls.some((c) => /\/messages\/[^?]/.test(c.url)),
    false,
    'no messages.get calls for an empty list',
  );
});

await ta('a runaway pageToken loop is capped with a clear error', async () => {
  const ctx = makeCtx({
    settings: { maxPages: 3 },
    routes: {
      [TOKEN_URL]: tokenOk(),
      // Always returns a nextPageToken: without a cap this would loop forever.
      [LIST_PATH]: { json: { messages: [{ id: 'x' }], nextPageToken: 'MORE' } },
      [`${LIST_PATH}/x`]: getFixture('x'),
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /page/i);
      return true;
    },
  );
});

// -- error paths (the engine's ctx.fetch throws on non-2xx) ---------------
// The engine's guardedFetch rejects on any non-2xx response with an Error whose
// message is `HTTP <status>: <snippet>` and whose .status is the code. The adapter
// never sees a Response with ok === false, so a failed token exchange or
// messages.list simply propagates that rejection; the fake mirrors that contract.
await ta('a failed token exchange (non-2xx) rejects with the HTTP status', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: { ok: false, status: 400, text: 'invalid_grant' },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /400/);
      return true;
    },
  );
});

await ta('a 2xx token response without access_token throws the adapter error', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_URL]: { json: { token_type: 'Bearer' } } },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /access_token/);
      return true;
    },
  );
});

await ta('a failed messages.list (non-2xx) rejects with the HTTP status', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [LIST_PATH]: { ok: false, status: 500, text: 'backend error' },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /500/);
      return true;
    },
  );
});

// Per-message resilience: one unreadable message is skipped and logged, not fatal.
await ta('a message that fails to fetch is skipped and logged; others survive', async () => {
  const logs = [];
  const ctx = makeCtx({
    logs,
    routes: {
      [TOKEN_URL]: tokenOk(),
      [`${LIST_PATH}/good1`]: getFixture('good1'),
      [`${LIST_PATH}/bad`]: { ok: false, status: 500, text: 'boom' },
      [`${LIST_PATH}/good2`]: getFixture('good2'),
      [LIST_PATH]: { json: { messages: [{ id: 'good1' }, { id: 'bad' }, { id: 'good2' }] } },
    },
  });
  const recs = await create(ctx).listMessages(14);
  assert.deepEqual(
    recs.map((r) => r.id).sort(),
    ['good1', 'good2'],
    'the two readable messages are returned',
  );
  assert.equal(
    recs.some((r) => r.id === 'bad'),
    false,
    'the unreadable message is absent, not a null/partial record',
  );
  assert.ok(
    logs.some((l) => l.includes('bad') && /skip/i.test(l)),
    'the skip is logged and names the message id',
  );
  assert.ok(
    logs.some((l) => /skipped 1 of 3/.test(l)),
    'a one-line summary count is logged',
  );
});

await ta('listMessages without ctx.fetch throws a clear error', async () => {
  await assert.rejects(
    () => create({ env: GMAIL_ENV }).listMessages(14),
    (err) => {
      assert.match(err.message, /ctx\.fetch/);
      return true;
    },
  );
});

// -- archive (deferred to #9) --------------------------------------------
await ta('archive is a documented not-implemented until #9', async () => {
  await assert.rejects(
    () => create(makeCtx({ routes: {} })).archive('m1'),
    (err) => {
      assert.match(err.message, /not implemented/i);
      assert.match(err.message, /gmail\.modify/);
      return true;
    },
  );
});

// -- optional live integration (skipped unless real creds present) --------
await ta('live: Gmail API round-trip (skipped without GMAIL_* creds)', async () => {
  const haveCreds =
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN;
  if (!haveCreds) {
    console.log(
      '  SKIP live Gmail integration: set GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN to run it',
    );
    return;
  }
  const { fetch: nodeFetch } = globalThis;
  const ctx = {
    env: {
      GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
      GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
    },
    settings: {
      sender: process.env.GMAIL_TEST_SENDER || undefined,
      maxResults: 5,
    },
    fetch: (url, opts) => nodeFetch(url, opts),
  };
  const recs = await create(ctx).listMessages(Number(process.env.GMAIL_TEST_SINCE_DAYS || 7));
  assert.ok(Array.isArray(recs), 'live listMessages returns an array');
  for (const r of recs) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.headers, 'object');
    assert.equal(Array.isArray(r.headers), false);
  }
  console.log(`  live Gmail integration ok: ${recs.length} message(s) mapped`);
});

console.log(`gmail.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
