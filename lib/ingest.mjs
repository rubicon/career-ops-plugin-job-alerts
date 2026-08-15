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
  trustedAuthservIdFor as defaultTrustedAuthservIdFor,
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
  const trustedAuthservIdFor = deps.trustedAuthservIdFor ?? defaultTrustedAuthservIdFor;

  const source = ctx?.settings?.source;
  const env = ctx?.env ?? {};

  // Fail fast: validate the selected source and its env before any mailbox work.
  validateSourceEnv(source, env);

  // The DMARC gate honours a verdict only from the field the receiving boundary
  // stamped, so it needs that boundary's authserv-id, which is the selected
  // source's knowledge (or the user's, via the authservId setting). Resolve it
  // here, alongside the env: a source with no id to attribute a verdict to would
  // fail every message it read, so the mailbox round trips are spent only to
  // arrive at something indistinguishable from an empty inbox.
  const authservId = trustedAuthservIdFor(source, ctx);

  const mail = createSource(source, ctx);
  const sinceDays = windowDays(ctx?.settings?.sinceDays);
  const messages = (await mail.listMessages(sinceDays)) ?? [];

  const authenticated = messages.filter((message) => passesDmarc(message, { authservId }));
  const unauthenticated = messages.length - authenticated.length;
  if (unauthenticated > 0) {
    // A drop is a real outcome, not an empty mailbox: say so, and name the
    // boundary the verdict had to come from, so a mailbox whose mail arrives
    // through a different one is diagnosable instead of just looking quiet.
    logLine(
      ctx,
      `job-alerts: skipped ${unauthenticated} of ${messages.length} message(s) with no ` +
        `dmarc=pass from ${authservId}. Set the authservId setting if your mail arrives ` +
        'through a different boundary.',
    );
  }

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

// logLine surfaces a diagnostic through the engine's redacting ctx.log, falling
// back to console.warn so the message is never silent even if log is
// unavailable. Mirrors the adapters' own skip logging.
function logLine(ctx, message) {
  if (typeof ctx?.log === 'function') ctx.log(message);
  else console.warn(message);
}

function windowDays(setting) {
  const n = Number(setting);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_DAYS;
}
