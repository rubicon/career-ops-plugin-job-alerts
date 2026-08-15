// Source registry and per-source environment validation for the source-adapter
// seam. A MailSource is the seam between the mailbox provider and the
// source-agnostic core: the core only ever sees {subject, headers, body}.
//
// MailSource contract (documented; JS has no interfaces):
//   listMessages(sinceDays) -> Promise<Array<{ id, subject, from, headers, body }>>
//   archive(id)             -> Promise<void>   (optional)
//
// Adapter modules each export a `requiredEnv` array (the env var names their
// network implementation needs), a `trustedAuthservId` (the authserv-id that
// provider's receiving boundary stamps into Authentication-Results, or null for
// one that stamps none), and a `create(ctx)` factory. Env is validated from
// `requiredEnv` without constructing the adapter, so the ingest hook can fail
// fast before any mailbox or network work.
//
// `trustedAuthservId` lives with the adapter because it is provider knowledge:
// the DMARC gate reads a verdict only from the field bearing that id, and the
// core has no way to know which boundary delivered a message.

import * as gmail from './gmail.mjs';
import * as ms365 from './ms365.mjs';

const ADAPTERS = { gmail, ms365 };

export const KNOWN_SOURCES = Object.keys(ADAPTERS);

function assertKnownSource(name) {
  if (!name) {
    throw new Error(
      `No mail source configured. Set "source" to one of: ${KNOWN_SOURCES.join(', ')} ` +
        `in the job-alerts block of config/plugins.yml.`,
    );
  }
  if (!ADAPTERS[name]) {
    throw new Error(
      `Unknown mail source "${name}". Known sources: ${KNOWN_SOURCES.join(', ')}. ` +
        `Set "source" in the job-alerts block of config/plugins.yml.`,
    );
  }
}

// requiredEnvFor returns the env var names the named source needs.
export function requiredEnvFor(name) {
  assertKnownSource(name);
  return ADAPTERS[name].requiredEnv;
}

// trustedAuthservIdFor returns the authserv-id the DMARC gate must attribute a
// verdict to for the named source: the `authservId` setting when the user has
// declared one (their boundary is theirs to know), otherwise the adapter's
// default. Null means the boundary stamps no authserv-id.
export function trustedAuthservIdFor(name, ctx) {
  assertKnownSource(name);
  const configured = String(ctx?.settings?.authservId ?? '').trim();
  if (configured !== '') return configured;
  return ADAPTERS[name].trustedAuthservId ?? null;
}

// validateSourceEnv throws a single actionable error naming the source, every
// missing key, and where to set it. Empty or whitespace-only values count as
// missing. Optional keys (ANTHROPIC_API_KEY, TAVILY_API_KEY) are never required.
export function validateSourceEnv(name, env = {}) {
  assertKnownSource(name);
  const missing = ADAPTERS[name].requiredEnv.filter(
    (key) => String(env?.[key] ?? '').trim() === '',
  );
  if (missing.length > 0) {
    const plural = missing.length > 1;
    throw new Error(
      `Mail source "${name}" is missing required environment variable${plural ? 's' : ''}: ` +
        `${missing.join(', ')}. Set ${plural ? 'them' : 'it'} in your .env file.`,
    );
  }
}

// createSource constructs the adapter for the named source, passing ctx so the
// adapter can reach ctx.fetch. Throws for an unknown source.
export function createSource(name, ctx) {
  assertKnownSource(name);
  return ADAPTERS[name].create(ctx);
}
