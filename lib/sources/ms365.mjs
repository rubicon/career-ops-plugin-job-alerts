// Microsoft 365 MailSource adapter. Reads job-alert messages over Microsoft
// Graph v1.0 using an Azure AD public-client refresh-token grant, and maps each
// message to the source-agnostic record { id, subject, from, headers, body } the
// core consumes.
//
// The core DMARC gate (lib/dmarc.mjs) reads message.headers as a plain-object
// map, so this adapter transforms Graph's internetMessageHeaders [{name,value}]
// collection into an object keyed by header name through the shared
// lib/headers.mjs encoding, which keeps every instance of a repeated name as its
// own entry, exactly like the Gmail adapter.
// internetMessageHeaders is returned only under an explicit $select, and the
// documented place to ask for it is the single-message GET, so listing is a
// two-step: page the collection for ids, then fetch each message with the FULL
// body and the headers. bodyPreview is deliberately not used; it is the first
// 255 characters of the body and would drop most posting links.
//
// Two Graph specifics drive the request shape:
//   - No $orderby. On the messages endpoint, combining $filter with $orderby
//     raises InefficientFilter ("The restriction or sort order is too complex
//     for this operation") unless the ordered properties also lead the filter.
//     The window is a date bound, so ordering buys nothing and is omitted.
//   - Paging follows @odata.nextLink verbatim. Graph documents that the entire
//     returned URL must be reused and that its $skiptoken must never be
//     extracted and rebuilt.
//
// Egress goes only through ctx.fetch (the engine applies manifest.allowedHosts
// and its SSRF guard). The engine's guarded fetch throws on any non-2xx response
// and returns a Response only on success, so this adapter does not inspect
// res.ok; a failed token exchange or message list rejects, and a failed
// per-message GET is caught, logged, and skipped so one bad message cannot lose
// the whole window. This module imports no node:http/node:net and calls no
// global fetch, and has no runtime dependencies.
//
// The Graph token-refresh and message-listing skeleton is derived from
// Schlaflied/career-ops-plugin-outlook-interviews @ ac70c74 (MIT), widened here
// to select the full body and internetMessageHeaders and to paginate.
// License: MIT.

import { headersToObject } from '../headers.mjs';

export const requiredEnv = ['MSGRAPH_CLIENT_ID', 'MSGRAPH_REFRESH_TOKEN'];

// The authserv-id this boundary stamps into Authentication-Results, which is
// what the DMARC gate reads the verdict from (RFC 7601 section 5: an MTA strips
// inbound fields bearing the id it uses, so only a field carrying that id can
// be attributed to the boundary).
//
// Microsoft does not publish one. "Anti-spam message headers" documents the
// header Exchange Online Protection stamps method by method -- `spf=`, `dkim=`,
// `dmarc=`, `compauth=` -- and every example given opens straight into `spf=`
// with no authserv-id ahead of it:
// https://learn.microsoft.com/en-us/defender-office-365/message-headers-eop-mdo
//
// So there is no default to declare, and null says exactly that: no answer, not
// a looser rule. Reading an unnamed field instead would be reading one any
// sender can write, since a field with no authserv-id gives the receiver nothing
// to strip and so can never be attributed to it.
//
// The tenant supplies the id through the `authservId` setting, taken from the
// Authentication-Results header of mail already in the mailbox; without it this
// source refuses to run rather than reading a verdict it cannot attribute.
export const trustedAuthservId = null;

const AUTH_BASE = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MESSAGES_URL = `${GRAPH_BASE}/me/messages`;
const SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access';
// internetMessageHeaders and body are both explicit here: the first is returned
// only under $select, the second is what the extraction stage reads.
const MESSAGE_SELECT = 'id,subject,from,body,internetMessageHeaders';
const DEFAULT_TENANT = 'common';
const DEFAULT_TOP = 100;
const MAX_TOP = 1000;
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
          // logged, not swallowed) so it cannot abort the whole window. Token
          // and list failures stay fatal, since nothing can proceed without
          // them.
          skipped++;
          logLine(ctx, `ms365: skipping message ${id}: ${err.message}`);
        }
      }
      if (skipped > 0) {
        logLine(ctx, `ms365: skipped ${skipped} of ${ids.length} message(s) that failed to fetch.`);
      }
      return records;
    },

    // archive is deferred for the same reason as the Gmail adapter's: moving a
    // message out of the inbox needs Mail.ReadWrite, a strictly wider delegated
    // scope than the Mail.Read listMessages runs on, and nothing in the current
    // ingest flow archives. Widening the consented scope for an unused code path
    // is a cost with no benefit, so it lands with append-before-archive.
    async archive(_id) {
      throw new Error(
        'ms365 archive is not implemented yet; it lands with append-before-archive ' +
          'and requires the broader Mail.ReadWrite scope.',
      );
    },
  };
}

function assertFetch(ctx) {
  if (typeof ctx?.fetch !== 'function') {
    throw new Error('ms365 adapter requires ctx.fetch (engine-provided, allowedHosts-guarded).');
  }
}

// logLine surfaces a diagnostic through the engine's redacting ctx.log, falling
// back to console.warn so a skip is never silent even if log is unavailable.
function logLine(ctx, message) {
  if (typeof ctx?.log === 'function') ctx.log(message);
  else console.warn(message);
}

// getAccessToken redeems the delegated refresh token at the Microsoft identity
// platform v2.0 token endpoint. This is a public client (a desktop/mobile app
// registration), which must not send a client secret, so none is read or sent.
async function getAccessToken(ctx) {
  const env = ctx?.env ?? {};
  const tenant = nonEmptyString(ctx?.settings?.tenant) ?? DEFAULT_TENANT;
  const res = await ctx.fetch(`${AUTH_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MSGRAPH_CLIENT_ID,
      refresh_token: env.MSGRAPH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }).toString(),
  });
  // A non-2xx response has already thrown inside ctx.fetch. A 2xx response with
  // no access_token is a real case the engine does not catch, so guard it here.
  const data = await res.json();
  if (!data?.access_token) {
    throw new Error('Microsoft Graph token exchange returned no access_token.');
  }
  return data.access_token;
}

// listMessageIds pages the message collection for the window, following
// @odata.nextLink until Graph stops returning one.
async function listMessageIds(ctx, token, sinceDays) {
  const maxPages = positiveInt(ctx?.settings?.maxPages, DEFAULT_MAX_PAGES);
  const top = Math.min(positiveInt(ctx?.settings?.maxResults, DEFAULT_TOP), MAX_TOP);
  const filter = buildFilter(sinceDays, ctx?.settings);

  // Only ids are needed here; the full body and headers come from the
  // per-message GET, which is the documented way to get internetMessageHeaders.
  let url =
    `${MESSAGES_URL}?$filter=${encodeURIComponent(filter)}` + `&$select=id&$top=${String(top)}`;

  const ids = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    for (const m of data?.value ?? []) {
      if (m?.id) ids.push(m.id);
    }
    const next = data?.['@odata.nextLink'];
    if (!next) return ids;
    url = assertGraphUrl(next);
  }
  // Reached the page cap with more pages available: fail loud rather than
  // silently under-reading the window. Narrow sinceDays or the sender filter, or
  // raise the maxPages setting.
  throw new Error(
    `Microsoft Graph message list exceeded the ${maxPages}-page cap; more results remain. ` +
      'Narrow the sinceDays window or the sender filter, or raise settings.maxPages.',
  );
}

// assertGraphUrl keeps @odata.nextLink from steering the next request, bearer
// token attached, at some other host. The engine's allowedHosts guard permits
// every host this plugin talks to, not just Graph, so this narrows it to the
// one host a message-collection continuation may legitimately point at.
function assertGraphUrl(next) {
  const url = String(next);
  if (!url.startsWith(`${GRAPH_BASE}/`)) {
    throw new Error(
      `Refusing to follow an @odata.nextLink outside ${GRAPH_BASE}: ${url.slice(0, 120)}`,
    );
  }
  return url;
}

// buildFilter constructs the OData $filter: a receivedDateTime lower bound from
// sinceDays plus an optional sender clause (one address, or an or-group).
// DateTimeOffset literals are unquoted; string literals are quoted, with an
// embedded quote escaped by doubling it.
function buildFilter(sinceDays, settings) {
  const clauses = [`receivedDateTime ge ${since(sinceDays)}`];
  const senders = normalizeSenders(settings?.sender);
  if (senders.length > 0) {
    const eq = senders.map((s) => `from/emailAddress/address eq '${odataQuote(s)}'`);
    clauses.push(eq.length === 1 ? eq[0] : `(${eq.join(' or ')})`);
  }
  return clauses.join(' and ');
}

function odataQuote(value) {
  return value.replace(/'/g, "''");
}

function normalizeSenders(sender) {
  const list = Array.isArray(sender) ? sender : sender == null ? [] : [sender];
  return list.map((s) => String(s).trim()).filter((s) => s !== '');
}

// since renders the ISO 8601 UTC instant Graph expects for a window that reaches
// back `daysBack` days.
function since(daysBack) {
  const days = positiveInt(daysBack, 14);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function getMessage(ctx, token, id) {
  const res = await ctx.fetch(
    `${MESSAGES_URL}/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        // Graph returns bodies as HTML by default. Asking for text keeps the
        // extraction stage reading prose and links rather than markup.
        Prefer: 'outlook.body-content-type="text"',
      },
    },
  );
  const data = await res.json();
  return {
    id: data?.id ?? id,
    subject: data?.subject ?? '',
    from: formatSender(data?.from),
    headers: headersToObject(data?.internetMessageHeaders),
    body: data?.body?.content ?? '',
  };
}

// formatSender renders Graph's structured recipient back into the RFC 5322 form
// the Gmail adapter's `from` already carries, so the record is provider-shaped
// the same way regardless of source.
function formatSender(recipient) {
  const name = String(recipient?.emailAddress?.name ?? '').trim();
  const address = String(recipient?.emailAddress?.address ?? '').trim();
  if (name && address) return `${name} <${address}>`;
  return address || name;
}

function nonEmptyString(value) {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
