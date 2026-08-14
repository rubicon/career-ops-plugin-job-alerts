# Architecture

career-ops-plugin-job-alerts is a career-ops plugin with the `ingest` hook. It
reads job-alert emails from a mailbox provider, verifies sender authenticity,
extracts candidate roles, resolves board tracking links toward the employer's
canonical posting, and returns `Job[]` to the pipeline. As a career-ops plugin it
must stay dependency-free (relative modules plus allowlisted Node built-ins only),
and all egress goes through `ctx.fetch` / `ctx.fetchJson` / `ctx.fetchText` so the
engine can apply `allowedHosts` and its SSRF guard.

## Layout

```
career-ops-plugin-job-alerts/
  manifest.json            # plugin manifest (ingest hook; no env, no hosts yet)
  index.mjs                # the ingest hook: a thin entry, delegates to lib/ingest.mjs
  lib/
    ingest.mjs             # I/O wiring: select source, validate env, run the core
    dmarc.mjs              # DMARC authenticity gate (pure, fail-closed)
    extract.mjs            # candidate role/link extraction from a message (pure)
    normalize.mjs          # lead field normalization (pure)
    resolve-canonical.mjs  # canonical-URL classification (pure)
    dedup.mjs              # in-batch deduplication (pure)
    append.mjs             # Job[] assembly (pure)
    sources/
      registry.mjs         # MailSource registry + per-source env validation
      gmail.mjs            # Gmail adapter (OAuth REST over the Gmail API)
      ms365.mjs            # Microsoft 365 adapter (OAuth REST over Microsoft Graph)
  test/
    smoke.mjs              # zero-network smoke test (manifest/exports parity)
    index.test.mjs         # ingest wiring tests against a fake in-memory source
    fake-source.mjs        # in-memory MailSource used by the wiring tests
```

## Two parts: a source-adapter seam and a source-agnostic core

The design splits along one seam so that mailbox providers and the processing
logic evolve independently.

1. **The source-adapter seam** (`lib/sources/`) is the boundary between a mailbox
   provider and the core. A `MailSource` exposes
   `listMessages(sinceDays) -> Promise<Array<{ id, subject, from, headers, body }>>`
   and an optional `archive(id)`. `registry.mjs` maps a `source` setting to an
   adapter, and validates that adapter's declared `requiredEnv` before any adapter
   is constructed, so the hook fails fast with one actionable error. v1 ships a
   Gmail adapter (OAuth REST over the Gmail API) and a Microsoft 365 adapter
   (OAuth REST over Microsoft Graph). Both list message ids for the window, then
   fetch each message individually, so one unreadable message is skipped and
   logged instead of losing the whole window, and both hand the core the same
   `{ id, subject, from, headers, body }` record with headers flattened to a
   plain-object map for the DMARC gate.
2. **The source-agnostic core** (the per-stage modules directly under `lib/`) only
   ever sees `{ subject, headers, body }`. It knows nothing about which provider a
   message came from.

Keeping these apart means a new provider is a new adapter with no change to the
core, and the core stages can be reasoned about as pure functions.

## The hook owns I/O ordering; the core stages are pure

`index.mjs` stays thin: its `ingest(ctx)` calls `runIngest(ctx)` and returns the
result. `lib/ingest.mjs` owns all I/O ordering and wiring, and its dependencies are
injectable so the wiring can be tested against a fake in-memory `MailSource`. Each
stage it calls is a pure, deterministic function with no network:

- `dmarc.passesDmarc` reads only the `Authentication-Results` header and is
  fail-closed: a message without a parseable `dmarc=pass` is rejected. It performs
  no DNS or network lookups.
- `extract.extractLeads` pulls candidate posting links from the body and pairs each
  with the subject as a provisional title. This is the deterministic fallback path;
  the richer LLM extraction path is I/O and is orchestrated by the hook, not here.
- `normalize.normalizeLead` trims and coerces each field to a stable string shape.
- `resolve-canonical.resolveCanonical` classifies whether a lead's URL is already an
  employer-canonical ATS posting (see below).
- `dedup.dedup` collapses leads whose URLs normalize to the same key, keeping the
  first occurrence, with no cross-run history (the engine owns persisted dedup).
- `append.buildJobs` shapes the surviving leads into the
  `{ title, url, company, location }` records the hook returns; the engine performs
  the actual append to the pipeline.

## resolve-canonical classifies, it never fetches or fabricates

Canonical resolution lives in this plugin (it is not shared). `resolve-canonical.mjs`
only classifies: it marks a lead `canonical` when its host is a known applicant
tracking system (Greenhouse, Lever, Ashby) and otherwise `needs-canonical`. Workday
is intentionally excluded because its hosts are dynamic per tenant. The network
resolution tiers (Tier 1 ATS API lookup by `{company, title}`, Tier 2 Tavily search)
are I/O owned by the hook and land in their own issue. This module never fetches,
never fabricates a URL, and never keeps a dead tracking link.

## Data flow

```
ctx ──> runIngest
          │  validateSourceEnv(source, env)      # fail fast, before any mailbox work
          │  createSource(source, ctx) ──> MailSource
          ▼
    mail.listMessages(sinceDays) ──> messages[]
          │
          ▼  filter: passesDmarc
    authenticated[]
          │  extractLeads ──> normalizeLead ──> resolveCanonical   # pure, per lead
          ▼
    leads[] ──> dedup ──> buildJobs ──> Job[] { title, url, company, location }
```
