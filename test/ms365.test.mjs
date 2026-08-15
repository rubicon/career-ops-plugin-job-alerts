// Unit tests for the Microsoft 365 MailSource adapter (lib/sources/ms365.mjs).
// Hermetic: no network. A fake ctx.fetch returns captured Microsoft Graph
// response shapes (a v2.0 token response, a /me/messages page with and without
// @odata.nextLink, and a single-message GET carrying internetMessageHeaders with
// Authentication-Results plus a body.content). The tests exercise the adapter's
// real request-building and response-mapping against those real shapes; they do
// not assert that a stub was merely called.
//
// The captured shapes come from the official Microsoft Graph v1.0 reference:
// list messages (value + @odata.nextLink), get message (Example 2 shows
// $select=internetMessageHeaders returning [{name,value}]), and the Microsoft
// identity platform refresh-token grant.
//
// An optional live integration test runs only when real MSGRAPH_* env vars are
// present and is skipped otherwise, so CI stays zero-network.
import assert from 'node:assert/strict';

import { create, requiredEnv, trustedAuthservId } from '../lib/sources/ms365.mjs';
import { passesDmarc } from '../lib/dmarc.mjs';

// The gate options this adapter's own declaration produces, so these tests
// exercise the real default rather than a literal restated here.
const DEFAULT_GATE = { authservId: trustedAuthservId };

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

const MS_ENV = {
  MSGRAPH_CLIENT_ID: '00001111-aaaa-2222-bbbb-3333cccc4444',
  MSGRAPH_REFRESH_TOKEN: 'refresh-OAAABAAAAiL9Kn2Z27Uubv',
};

// Build a fake fetch/ctx. `routes` maps a URL-substring to a response spec (or a
// function producing one, given the call index for that route). Every call is
// recorded so request shape can be asserted. Keys are matched in insertion
// order, so put the more specific path first.
function makeCtx({ env = MS_ENV, settings = {}, routes, logs }) {
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

// Mirror the engine's guardedFetch contract: throw on any non-2xx (an Error with
// a .status property and an `HTTP <status>: <snippet>` message), and return a
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

const TOKEN_PATH = '/oauth2/v2.0/token';
const COMMON_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LIST_PATH = '/v1.0/me/messages';

function tokenOk(access = 'access-token-abc') {
  return {
    json: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'https://graph.microsoft.com/Mail.Read',
      refresh_token: 'AwABAAAAvPM1KaPlrEqdFSBzjqfTGAMxZGUTdM0t4B4',
    },
  };
}

// A get-message fixture in the documented Graph shape: internetMessageHeaders as
// a [{name,value}] collection (only returned under $select) and body as an
// itemBody { contentType, content }.
function getFixture(
  id,
  {
    dmarc = 'pass',
    subject = 'VP Marketing at Acme',
    fromName = 'Indeed',
    fromAddress = 'alerts@indeed.com',
    body,
    headers,
    omitHeaders = false,
  } = {},
) {
  const content =
    body ?? `Top role >>> Apply now: https://boards.greenhouse.io/acme/jobs/${id} launch`;
  const internetMessageHeaders = headers ?? [
    { name: 'Received', value: 'from mx.indeed.com by outlook.com' },
    { name: 'MIME-Version', value: '1.0' },
    { name: 'Authentication-Results', value: `spf=pass; dkim=pass; dmarc=${dmarc}` },
    { name: 'Subject', value: subject },
  ];
  const json = {
    id,
    subject,
    from: { emailAddress: { name: fromName, address: fromAddress } },
    body: { contentType: 'text', content },
  };
  if (!omitHeaders) json.internetMessageHeaders = internetMessageHeaders;
  return { json };
}

// readHeaders drives the adapter over one message carrying exactly the given
// internetMessageHeaders collection, and returns the mapped record.
async function readHeaders(headers) {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1', { headers }),
      [LIST_PATH]: { json: { value: [{ id: 'm1' }] } },
    },
  });
  const [rec] = await create(ctx).listMessages(14);
  return rec;
}

// Read the $filter of a captured list call.
function filterOf(call) {
  return new URL(call.url).searchParams.get('$filter');
}

// The list calls are the ones on the collection path, not a per-message GET.
function listCallsOf(ctx) {
  return ctx.calls.filter((c) => /\/v1\.0\/me\/messages(\?|$)/.test(c.url));
}

// -- requiredEnv ----------------------------------------------------------
await ta('requiredEnv lists the two MSGRAPH keys and no client secret', async () => {
  assert.deepEqual(requiredEnv, ['MSGRAPH_CLIENT_ID', 'MSGRAPH_REFRESH_TOKEN']);
});

// -- token request shape --------------------------------------------------
await ta('token exchange posts the public-client refresh-token grant', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);

  const tokenCall = ctx.calls.find((c) => c.url.includes(TOKEN_PATH));
  assert.ok(tokenCall, 'token endpoint was called');
  assert.equal(tokenCall.url, COMMON_TOKEN_URL, 'defaults to the common tenant');
  assert.equal(tokenCall.options.method, 'POST');
  assert.match(tokenCall.options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const params = new URLSearchParams(tokenCall.options.body);
  assert.equal(params.get('client_id'), MS_ENV.MSGRAPH_CLIENT_ID);
  assert.equal(params.get('refresh_token'), MS_ENV.MSGRAPH_REFRESH_TOKEN);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.match(params.get('scope'), /Mail\.Read/);
  // A public client must never send a secret; there is no MSGRAPH_CLIENT_SECRET
  // in requiredEnv and none may be invented here.
  assert.equal(params.get('client_secret'), null, 'no client_secret for a public client');
});

await ta('a tenant setting replaces the common tenant in the token URL', async () => {
  const ctx = makeCtx({
    settings: { tenant: 'contoso.onmicrosoft.com' },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  const tokenCall = ctx.calls.find((c) => c.url.includes(TOKEN_PATH));
  assert.equal(
    tokenCall.url,
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
  );
});

// -- list request shape ---------------------------------------------------
await ta('the message list filters by receivedDateTime derived from sinceDays', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: tokenOk('tok-xyz'), [LIST_PATH]: { json: { value: [] } } },
  });
  const before = Date.now();
  await create(ctx).listMessages(7);
  const after = Date.now();

  const listCall = listCallsOf(ctx)[0];
  assert.ok(listCall, 'the messages collection was requested');
  const filter = filterOf(listCall);
  const m = /^receivedDateTime ge (\S+)/.exec(filter);
  assert.ok(m, `filter starts with an unquoted receivedDateTime bound: ${filter}`);
  // OData DateTimeOffset literals are not quoted.
  assert.equal(m[1].includes("'"), false, 'the date literal is not quoted');
  const bound = Date.parse(m[1]);
  assert.ok(Number.isFinite(bound), 'the date literal parses');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  assert.ok(bound >= before - sevenDays - 5000, 'the bound is not older than the window');
  assert.ok(bound <= after - sevenDays + 5000, 'the bound is not newer than the window');
  assert.equal(listCall.options.headers.Authorization, 'Bearer tok-xyz');
});

await ta('the message list never sends $orderby (Graph InefficientFilter)', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  for (const call of listCallsOf(ctx)) {
    assert.equal(
      new URL(call.url).searchParams.get('$orderby'),
      null,
      'combining $filter with $orderby trips InefficientFilter on the messages endpoint',
    );
  }
});

await ta('the message list requests a bounded page size with $top', async () => {
  const ctx = makeCtx({
    settings: { maxResults: 50 },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  assert.equal(new URL(listCallsOf(ctx)[0].url).searchParams.get('$top'), '50');
});

await ta('$top is clamped to the documented 1-1000 range', async () => {
  const ctx = makeCtx({
    settings: { maxResults: 5000 },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  assert.equal(
    new URL(listCallsOf(ctx)[0].url).searchParams.get('$top'),
    '1000',
    'Graph documents $top for messages within 1 and 1000',
  );
});

await ta('a single sender setting adds a from/emailAddress/address clause', async () => {
  const ctx = makeCtx({
    settings: { sender: 'alerts@indeed.com' },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  const filter = filterOf(listCallsOf(ctx)[0]);
  assert.match(filter, /^receivedDateTime ge \S+ and /);
  assert.match(filter, /from\/emailAddress\/address eq 'alerts@indeed\.com'/);
});

await ta('a list of senders becomes an or-group inside the filter', async () => {
  const ctx = makeCtx({
    settings: { sender: ['a@x.com', 'b@y.com'] },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  const filter = filterOf(listCallsOf(ctx)[0]);
  assert.match(
    filter,
    /\(from\/emailAddress\/address eq 'a@x\.com' or from\/emailAddress\/address eq 'b@y\.com'\)/,
  );
});

await ta('a sender containing a single quote is escaped by doubling it', async () => {
  const ctx = makeCtx({
    settings: { sender: "o'brien@x.com" },
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  await create(ctx).listMessages(14);
  const filter = filterOf(listCallsOf(ctx)[0]);
  assert.match(filter, /eq 'o''brien@x\.com'/, 'OData escapes a quote by doubling it');
});

// -- per-message GET request shape ----------------------------------------
await ta('each message is fetched with the FULL body and internetMessageHeaders', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1'),
      [LIST_PATH]: { json: { value: [{ id: 'm1' }] } },
    },
  });
  await create(ctx).listMessages(14);

  const getCall = ctx.calls.find((c) => c.url.includes(`${LIST_PATH}/m1`));
  assert.ok(getCall, 'the single-message endpoint was called');
  const select = new URL(getCall.url).searchParams.get('$select').split(',');
  assert.ok(select.includes('body'), '$select asks for the full body');
  assert.ok(
    select.includes('internetMessageHeaders'),
    'internetMessageHeaders is only returned under $select',
  );
  assert.equal(
    select.includes('bodyPreview'),
    false,
    'bodyPreview is the 255-character truncation and would lose posting links',
  );
  assert.match(
    getCall.options.headers.Prefer,
    /outlook\.body-content-type="text"/,
    'ask Graph for a text body instead of the HTML default',
  );
});

// -- mapping to the MailSource record -------------------------------------
await ta('maps a message to { id, subject, from, headers-as-object, body }', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1'),
      [LIST_PATH]: { json: { value: [{ id: 'm1' }] } },
    },
  });
  const [rec] = await create(ctx).listMessages(14);

  assert.equal(rec.id, 'm1');
  assert.equal(rec.subject, 'VP Marketing at Acme');
  assert.equal(rec.from, 'Indeed <alerts@indeed.com>');
  // headers must be a plain object map, not Graph's [{name,value}] collection,
  // with one array of instance values under each name.
  assert.equal(Array.isArray(rec.headers), false);
  assert.equal(typeof rec.headers, 'object');
  assert.deepEqual(rec.headers['Authentication-Results'], ['spf=pass; dkim=pass; dmarc=pass']);
  assert.match(rec.body, /https:\/\/boards\.greenhouse\.io\/acme\/jobs\/m1/);
});

await ta('a sender with no display name maps to the bare address', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1', { fromName: '' }),
      [LIST_PATH]: { json: { value: [{ id: 'm1' }] } },
    },
  });
  const [rec] = await create(ctx).listMessages(14);
  assert.equal(rec.from, 'alerts@indeed.com');
});

await ta('the mapped headers object satisfies the real DMARC gate', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/pass1`]: getFixture('pass1', { dmarc: 'pass' }),
      [`${LIST_PATH}/fail1`]: getFixture('fail1', { dmarc: 'fail' }),
      [LIST_PATH]: { json: { value: [{ id: 'pass1' }, { id: 'fail1' }] } },
    },
  });
  const recs = await create(ctx).listMessages(14);
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.equal(passesDmarc(byId.pass1, DEFAULT_GATE), true, 'dmarc=pass survives into headers');
  assert.equal(passesDmarc(byId.fail1, DEFAULT_GATE), false, 'dmarc=fail is rejected by the gate');
});

await ta('the adapter declares no authserv-id, because Microsoft publishes none', async () => {
  // The documented Exchange Online header opens straight into `spf=`, with no
  // authserv-id ahead of it, so there is no name to match on by default. A
  // tenant whose boundary does stamp one sets the `authservId` setting.
  assert.equal(trustedAuthservId, null);
});

await ta('repeated Authentication-Results all survive the mapping', async () => {
  // Graph returns the full RFC 5322 header set, in which a name may repeat: the
  // boundary stamps its own Authentication-Results and delivers whatever copies
  // the message already carried. Last-wins would destroy the field the DMARC
  // gate has to read, so every instance is kept as its own array entry.
  const rec = await readHeaders([
    { name: 'Authentication-Results', value: 'mail.contoso.com; spf=pass; dkim=pass; dmarc=pass' },
    { name: 'Authentication-Results', value: 'compauth=pass reason=100' },
  ]);
  assert.deepEqual(rec.headers['Authentication-Results'], [
    'mail.contoso.com; spf=pass; dkim=pass; dmarc=pass',
    'compauth=pass reason=100',
  ]);
});

await ta('the configured boundary field decides, whatever a repeat claims', async () => {
  // Two Authentication-Results with conflicting verdicts: one from the
  // configured receiving boundary, one from an authserv-id that is not it (and
  // that merely contains its name). Only the boundary's own field can be
  // attributed to the receiver, so its verdict stands in both directions and
  // position never decides.
  const gate = { authservId: 'mail.contoso.com' };

  const boundaryFails = await readHeaders([
    { name: 'Authentication-Results', value: 'mail.contoso.com; spf=fail; dmarc=fail' },
    { name: 'Authentication-Results', value: 'mail.contoso.com.evil.tld; dmarc=pass' },
  ]);
  assert.equal(passesDmarc(boundaryFails, gate), false, 'a repeat cannot overturn a fail');

  const boundaryPasses = await readHeaders([
    { name: 'Authentication-Results', value: 'evil.tld; dmarc=fail' },
    { name: 'Authentication-Results', value: 'mail.contoso.com; spf=pass; dmarc=pass' },
  ]);
  assert.equal(passesDmarc(boundaryPasses, gate), true, 'a repeat cannot suppress a pass');
});

await ta('two unnamed Authentication-Results are ambiguous and fail closed', async () => {
  // With no authserv-id to match on, nothing separates the boundary's own field
  // from a second copy that also omits one, so the gate refuses to guess.
  const rec = await readHeaders([
    { name: 'Authentication-Results', value: 'spf=fail; dkim=fail; dmarc=fail' },
    { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' },
  ]);
  assert.equal(passesDmarc(rec, DEFAULT_GATE), false);
});

await ta('a message with no internetMessageHeaders fails the DMARC gate closed', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/m1`]: getFixture('m1', { omitHeaders: true }),
      [LIST_PATH]: { json: { value: [{ id: 'm1' }] } },
    },
  });
  const [rec] = await create(ctx).listMessages(14);
  assert.deepEqual(rec.headers, {}, 'headers is an empty map, never undefined');
  assert.equal(passesDmarc(rec, DEFAULT_GATE), false);
});

// -- pagination -----------------------------------------------------------
await ta('follows @odata.nextLink across pages and fetches every id', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/a`]: getFixture('a'),
      [`${LIST_PATH}/b`]: getFixture('b'),
      [`${LIST_PATH}/c`]: getFixture('c'),
      [LIST_PATH]: (n) =>
        n === 0
          ? {
              json: {
                value: [{ id: 'a' }, { id: 'b' }],
                '@odata.nextLink': `${GRAPH_BASE}/me/messages?$skiptoken=RFNwdAIAAQAAAD8`,
              },
            }
          : { json: { value: [{ id: 'c' }] } },
    },
  });
  const recs = await create(ctx).listMessages(14);
  assert.deepEqual(
    recs.map((r) => r.id).sort(),
    ['a', 'b', 'c'],
    'every id across both pages was fetched',
  );
  const listCalls = listCallsOf(ctx);
  assert.equal(listCalls.length, 2, 'two list pages were requested');
  // The nextLink URL must be used verbatim; Graph says not to rebuild it.
  assert.equal(
    listCalls[1].url,
    `${GRAPH_BASE}/me/messages?$skiptoken=RFNwdAIAAQAAAD8`,
    'the second page uses the entire @odata.nextLink URL as returned',
  );
  assert.equal(listCalls[1].options.headers.Authorization, 'Bearer access-token-abc');
});

await ta('an @odata.nextLink pointing off the Graph host is refused', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [LIST_PATH]: {
        json: {
          value: [],
          '@odata.nextLink': 'https://api.anthropic.com/v1/messages?$skiptoken=x',
        },
      },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /nextLink/i);
      return true;
    },
  );
  assert.equal(
    ctx.calls.some((c) => c.url.includes('api.anthropic.com')),
    false,
    'the off-host nextLink is never requested, bearer token and all',
  );
});

await ta('an empty mailbox returns no records and fetches no messages', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: { value: [] } } },
  });
  const recs = await create(ctx).listMessages(14);
  assert.deepEqual(recs, []);
  assert.equal(
    ctx.calls.some((c) => /\/v1\.0\/me\/messages\/[^?]/.test(c.url)),
    false,
    'no single-message GETs for an empty page',
  );
});

await ta('a response with no value array returns no records', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: tokenOk(), [LIST_PATH]: { json: {} } },
  });
  assert.deepEqual(await create(ctx).listMessages(14), []);
});

await ta('a runaway nextLink loop is capped with a clear error', async () => {
  const ctx = makeCtx({
    settings: { maxPages: 3 },
    routes: {
      [TOKEN_PATH]: tokenOk(),
      // Always returns a nextLink: without a cap this would loop forever.
      [`${LIST_PATH}/x`]: getFixture('x'),
      [LIST_PATH]: {
        json: {
          value: [{ id: 'x' }],
          '@odata.nextLink': `${GRAPH_BASE}/me/messages?$skiptoken=MORE`,
        },
      },
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
await ta('a failed token exchange (non-2xx) rejects with the HTTP status', async () => {
  const ctx = makeCtx({
    routes: { [TOKEN_PATH]: { ok: false, status: 400, text: 'invalid_grant' } },
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
    routes: { [TOKEN_PATH]: { json: { token_type: 'Bearer' } } },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.match(err.message, /access_token/);
      return true;
    },
  );
});

await ta('a failed message list (non-2xx) rejects with the HTTP status', async () => {
  const ctx = makeCtx({
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [LIST_PATH]: { ok: false, status: 429, text: 'too many requests' },
    },
  });
  await assert.rejects(
    () => create(ctx).listMessages(14),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /429/);
      return true;
    },
  );
});

await ta('a message that fails to fetch is skipped and logged; others survive', async () => {
  const logs = [];
  const ctx = makeCtx({
    logs,
    routes: {
      [TOKEN_PATH]: tokenOk(),
      [`${LIST_PATH}/good1`]: getFixture('good1'),
      [`${LIST_PATH}/bad`]: { ok: false, status: 500, text: 'boom' },
      [`${LIST_PATH}/good2`]: getFixture('good2'),
      [LIST_PATH]: { json: { value: [{ id: 'good1' }, { id: 'bad' }, { id: 'good2' }] } },
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
    () => create({ env: MS_ENV }).listMessages(14),
    (err) => {
      assert.match(err.message, /ctx\.fetch/);
      return true;
    },
  );
});

// -- archive (deferred, same judgment call as the Gmail adapter) ----------
await ta('archive is a documented not-implemented', async () => {
  await assert.rejects(
    () => create(makeCtx({ routes: {} })).archive('m1'),
    (err) => {
      assert.match(err.message, /not implemented/i);
      assert.match(err.message, /Mail\.ReadWrite/);
      return true;
    },
  );
});

// -- optional live integration (skipped unless real creds present) --------
await ta('live: Microsoft Graph round-trip (skipped without MSGRAPH_* creds)', async () => {
  const haveCreds = process.env.MSGRAPH_CLIENT_ID && process.env.MSGRAPH_REFRESH_TOKEN;
  if (!haveCreds) {
    console.log('  SKIP live Graph integration: set MSGRAPH_CLIENT_ID/REFRESH_TOKEN to run it');
    return;
  }
  const { fetch: nodeFetch } = globalThis;
  const ctx = {
    env: {
      MSGRAPH_CLIENT_ID: process.env.MSGRAPH_CLIENT_ID,
      MSGRAPH_REFRESH_TOKEN: process.env.MSGRAPH_REFRESH_TOKEN,
    },
    settings: {
      tenant: process.env.MSGRAPH_TENANT || undefined,
      sender: process.env.MSGRAPH_TEST_SENDER || undefined,
      maxResults: 5,
    },
    // Mirror the engine's throw-on-non-2xx contract so the live path exercises
    // the same code as the hermetic tests.
    fetch: async (url, opts) => {
      const res = await nodeFetch(url, opts);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    },
  };
  const recs = await create(ctx).listMessages(Number(process.env.MSGRAPH_TEST_SINCE_DAYS || 7));
  assert.ok(Array.isArray(recs), 'live listMessages returns an array');
  for (const r of recs) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.headers, 'object');
    assert.equal(Array.isArray(r.headers), false);
  }
  console.log(`  live Graph integration ok: ${recs.length} message(s) mapped`);
});

console.log(`ms365.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
