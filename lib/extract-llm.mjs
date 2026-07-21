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
