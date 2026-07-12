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

import { create, requiredEnv } from '../lib/sources/gmail.mjs';
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
function makeCtx({ env = GMAIL_ENV, settings = {}, routes }) {
  const calls = [];
  const routeCounts = {};
  async function fetchImpl(url, options = {}) {
    calls.push({ url, options });
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) {
        const n = routeCounts[key] ?? 0;
        routeCounts[key] = n + 1;
        const spec = typeof routes[key] === 'function' ? routes[key](n) : routes[key];
        return makeResponse(spec);
      }
    }
    throw new Error(`no fake route for ${url}`);
  }
  return { env, settings, fetch: fetchImpl, calls };
}

function makeResponse({ ok = true, status = 200, json = undefined, text = undefined }) {
  return {
    ok,
    status,
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
  assert.equal(passesDmarc(byId.pass1), true, 'dmarc=pass survives into headers');
  assert.equal(passesDmarc(byId.fail1), false, 'dmarc=fail is rejected by the gate');
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

// -- error paths ----------------------------------------------------------
await ta('a non-ok token response throws a clear error', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: { ok: false, status: 400, text: 'invalid_grant' },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /token/i);
      assert.match(err.message, /400/);
      return true;
    },
  );
});

await ta('a token response without access_token throws a clear error', async () => {
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

await ta('a non-ok messages.list response throws a clear error', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [LIST_PATH]: { ok: false, status: 500, text: 'backend error' },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /list/i);
      assert.match(err.message, /500/);
      return true;
    },
  );
});

await ta('a non-ok messages.get response throws a clear error naming the id', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_URL]: tokenOk(),
      [`${LIST_PATH}/bad`]: { ok: false, status: 404, text: 'not found' },
      [LIST_PATH]: { json: { messages: [{ id: 'bad' }] } },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /bad/);
      assert.match(err.message, /404/);
      return true;
    },
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
