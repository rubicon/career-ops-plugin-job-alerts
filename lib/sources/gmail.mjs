// Gmail MailSource adapter. Reads job-alert messages over the Gmail REST API
// using an OAuth refresh-token grant, and maps each message to the source-agnostic
// record { id, subject, from, headers, body } the core consumes.
//
// The core DMARC gate (lib/dmarc.mjs) reads message.headers as a plain-object map,
// so this adapter transforms Gmail's payload.headers [{name,value}] array into an
// object keyed by header name (preserving Authentication-Results) and decodes the
// base64url body recursively across parts.
//
// Egress goes only through ctx.fetch (the engine applies manifest.allowedHosts and
// its SSRF guard). This module imports no node:http/node:net and calls no global
// fetch, and has no runtime dependencies.
//
// The OAuth-REST approach (token exchange, messages.list, messages.get, base64url
// decode) is informed by Schlaflied/career-ops-plugin-linkedin-alerts (MIT) and by
// the recursive body decode in the bundled career-ops gmail plugin _helpers.mjs
// (MIT). License: MIT.

export const requiredEnv = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_PAGES = 25;

export function create(ctx) {
  return {
    async listMessages(sinceDays) {
      assertFetch(ctx);
      const token = await getAccessToken(ctx);
      const ids = await listMessageIds(ctx, token, sinceDays);
      const records = [];
      for (const id of ids) {
        records.push(await getMessage(ctx, token, id));
      }
      return records;
    },

    // archive is deferred to #9 (resilient append-before-archive). It needs the
    // gmail.modify scope (messages.modify to remove the INBOX label), a wider scope
    // than the gmail.readonly used by listMessages, so it is not implemented here.
    async archive(_id) {
      throw new Error(
        'gmail archive is not implemented yet; it lands with #9 (append-before-archive) ' +
          'and requires the broader gmail.modify scope.',
      );
    },
  };
}

function assertFetch(ctx) {
  if (typeof ctx?.fetch !== 'function') {
    throw new Error('gmail adapter requires ctx.fetch (engine-provided, allowedHosts-guarded).');
  }
}

async function getAccessToken(ctx) {
  const env = ctx?.env ?? {};
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Gmail token exchange failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  if (!data?.access_token) {
    throw new Error('Gmail token exchange returned no access_token.');
  }
  return data.access_token;
}

async function listMessageIds(ctx, token, sinceDays) {
  const q = buildQuery(sinceDays, ctx?.settings);
  const maxResults = String(positiveInt(ctx?.settings?.maxResults, DEFAULT_MAX_RESULTS));
  const maxPages = positiveInt(ctx?.settings?.maxPages, DEFAULT_MAX_PAGES);

  const ids = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ q, maxResults });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await ctx.fetch(`${GMAIL_BASE}/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail messages.list failed (${res.status}): ${await safeText(res)}`);
    }
    const data = await res.json();
    for (const m of data?.messages ?? []) {
      if (m?.id) ids.push(m.id);
    }
    pageToken = data?.nextPageToken;
    if (!pageToken) return ids;
  }
  // Reached the page cap with more pages available: fail loud rather than silently
  // under-reading the window. Narrow sinceDays or the sender filter, or raise the
  // maxPages setting.
  throw new Error(
    `Gmail messages.list exceeded the ${maxPages}-page cap; more results remain. ` +
      'Narrow the sinceDays window or the sender filter, or raise settings.maxPages.',
  );
}

async function getMessage(ctx, token, id) {
  const res = await ctx.fetch(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail messages.get failed for ${id} (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  const payload = data?.payload ?? {};
  const headers = headersToObject(payload.headers);
  return {
    id,
    subject: headerValue(headers, 'subject'),
    from: headerValue(headers, 'from'),
    headers,
    body: decodeBody(payload),
  };
}

// buildQuery constructs the Gmail search query: an after: bound from sinceDays plus
// an optional from: filter (single sender, or an OR group for a list of senders).
function buildQuery(sinceDays, settings) {
  const parts = [`after:${gmailDate(sinceDays)}`];
  const senders = normalizeSenders(settings?.sender);
  if (senders.length === 1) {
    parts.push(`from:${senders[0]}`);
  } else if (senders.length > 1) {
    parts.push(`{${senders.map((s) => `from:${s}`).join(' ')}}`);
  }
  return parts.join(' ');
}

function normalizeSenders(sender) {
  const list = Array.isArray(sender) ? sender : sender == null ? [] : [sender];
  return list.map((s) => String(s).trim()).filter((s) => s !== '');
}

// gmailDate renders the YYYY/MM/DD date Gmail's after: operator expects for a
// window that reaches back `daysBack` days.
function gmailDate(daysBack) {
  const days = positiveInt(daysBack, 14);
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// headersToObject turns Gmail's [{name,value}] header array into a plain-object map
// keyed by the header name (original casing preserved), so the core DMARC gate can
// read message.headers as an object.
function headersToObject(headers) {
  const map = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h.name === 'string') map[h.name] = h.value ?? '';
    }
  }
  return map;
}

function headerValue(map, name) {
  const target = name.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === target) return map[key];
  }
  return '';
}

// decodeBody recursively decodes a Gmail payload's base64url body parts to text,
// concatenating every part (text/plain and text/html) so no candidate link is lost.
function decodeBody(payload) {
  if (!payload) return '';
  let body = '';
  if (payload.body?.data) {
    const b64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    body += Buffer.from(b64, 'base64').toString('utf8');
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) body += decodeBody(part);
  }
  return body;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
