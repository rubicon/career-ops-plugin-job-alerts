// Gmail MailSource adapter. Reads job-alert messages over the Gmail REST API
// using an OAuth refresh-token grant, and maps each message to the source-agnostic
// record { id, subject, from, headers, body } the core consumes.
//
// The core DMARC gate (lib/dmarc.mjs) reads message.headers as a plain-object map,
// so this adapter transforms Gmail's payload.headers [{name,value}] array into an
// object keyed by header name (via the shared lib/headers.mjs encoding, which
// preserves every instance of a repeated name) and decodes the base64url body
// recursively across parts.
//
// Egress goes only through ctx.fetch (the engine applies manifest.allowedHosts and
// its SSRF guard). The engine's guarded fetch throws on any non-2xx response and
// returns a Response only on success, so this adapter does not inspect res.ok; a
// failed token exchange or messages.list rejects, and a failed per-message
// messages.get is caught, logged, and skipped so one bad message cannot lose the
// whole window. This module imports no node:http/node:net and calls no global
// fetch, and has no runtime dependencies.
//
// The OAuth-REST approach (token exchange, messages.list, messages.get, base64url
// decode) is informed by Schlaflied/career-ops-plugin-linkedin-alerts (MIT) and by
// the recursive body decode in the bundled career-ops gmail plugin _helpers.mjs
// (MIT). License: MIT.

import { headersToObject, headerValue } from '../headers.mjs';

export const requiredEnv = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

// The authserv-id Gmail's inbound boundary stamps into Authentication-Results.
// It is the receiving MX, and per RFC 7601 section 5 that MTA strips inbound
// fields already bearing it, which is what makes a surviving `mx.google.com`
// field the one worth reading. The DMARC gate matches it whole; every other
// field in the message, including a repeat the sender supplied, is ignored.
// Override with the `authservId` setting if mail reaches the mailbox through a
// different boundary.
export const trustedAuthservId = 'mx.google.com';

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
      let skipped = 0;
      for (const id of ids) {
        try {
          records.push(await getMessage(ctx, token, id));
        } catch (err) {
          // Per-message resilience: a single unreadable message is skipped (and
          // logged, not swallowed) so it cannot abort the whole window. Token and
          // messages.list failures stay fatal, since nothing can proceed without
          // them.
          skipped++;
          logLine(ctx, `gmail: skipping message ${id}: ${err.message}`);
        }
      }
      if (skipped > 0) {
        logLine(ctx, `gmail: skipped ${skipped} of ${ids.length} message(s) that failed to fetch.`);
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

// logLine surfaces a diagnostic through the engine's redacting ctx.log, falling
// back to console.warn so a skip is never silent even if log is unavailable.
function logLine(ctx, message) {
  if (typeof ctx?.log === 'function') ctx.log(message);
  else console.warn(message);
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
  // A non-2xx response has already thrown inside ctx.fetch. A 2xx response with no
  // access_token is a real case the engine does not catch, so guard it here.
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

// decodeBody recursively decodes a Gmail payload's base64url body parts to text,
// concatenating every part (text/plain and text/html) so no candidate link is lost.
// Sibling parts are joined with a newline so a link at the end of one part cannot
// merge into the start of the next part's text.
function decodeBody(payload) {
  if (!payload) return '';
  const chunks = [];
  if (payload.body?.data) {
    const b64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    chunks.push(Buffer.from(b64, 'base64').toString('utf8'));
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const decoded = decodeBody(part);
      if (decoded) chunks.push(decoded);
    }
  }
  return chunks.join('\n');
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
