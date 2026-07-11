// Ingest wiring: selects the mail source, validates its env fail-fast, then runs
// the source-agnostic core (DMARC gate, extract, normalize, canonical
// classification, dedup, assembly) and returns Job[].
//
// This module owns all I/O ordering; the core stages it calls are pure. Egress,
// when the real adapters land, happens only through ctx.fetch / ctx.fetchJson /
// ctx.fetchText inside the adapter.

import {
  createSource as defaultCreateSource,
  validateSourceEnv as defaultValidateSourceEnv,
} from './sources/registry.mjs';
import { passesDmarc } from './dmarc.mjs';
import { extractLeads } from './extract.mjs';
import { normalizeLead } from './normalize.mjs';
import { resolveCanonical } from './resolve-canonical.mjs';
import { dedup } from './dedup.mjs';
import { buildJobs } from './append.mjs';

const DEFAULT_WINDOW_DAYS = 14;

// runIngest wires the configured source through the core. Dependencies are
// injectable so the wiring can be tested against a fake in-memory MailSource.
export async function runIngest(ctx, deps = {}) {
  const createSource = deps.createSource ?? defaultCreateSource;
  const validateSourceEnv = deps.validateSourceEnv ?? defaultValidateSourceEnv;

  const source = ctx?.settings?.source;
  const env = ctx?.env ?? {};

  // Fail fast: validate the selected source and its env before any mailbox work.
  validateSourceEnv(source, env);

  const mail = createSource(source, ctx);
  const sinceDays = windowDays(ctx?.settings?.sinceDays);
  const messages = (await mail.listMessages(sinceDays)) ?? [];

  const authenticated = messages.filter(passesDmarc);
  const leads = authenticated.flatMap(extractLeads).map(normalizeLead).map(resolveCanonical);
  // TODO(#7): buildJobs must not emit a Job whose url has status !== 'canonical' (a
  // dead tracking link). Enforce when canonical resolution lands.
  return buildJobs(dedup(leads));
}

function windowDays(setting) {
  const n = Number(setting);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_DAYS;
}
