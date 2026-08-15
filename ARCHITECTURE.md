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
    headers.mjs            # shared header-map encoding (repeats preserved)
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
    dmarc.test.mjs         # DMARC gate: trust boundary and Authentication-Results parse
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
  fail-closed: a message without a boundary-issued `dmarc=pass` is rejected. It
  performs no DNS or network lookups. See "The DMARC gate reads one field" below.
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

## The DMARC gate reads one field: the receiving boundary's

`Authentication-Results` is trust-domain metadata (RFC 7601), not a property of
the message. Any sender can put the field in the mail it sends, and the receiving
MTA delivers those copies alongside the one it stamps itself, in no guaranteed
order. What makes exactly one of them meaningful is RFC 7601 section 5: an MTA
must strip any pre-existing field bearing the authserv-id it uses, so a surviving
field with that id can only have come from the boundary.

The gate therefore takes the boundary's authserv-id as an argument and reads a
verdict only from fields carrying it, compared **whole** (`mx.google.com.evil.tld`
and `notmx.google.com` both contain the trusted name and are not it). Since the
id is provider-specific, each adapter declares its own and
`registry.trustedAuthservIdFor` resolves it, with the `authservId` setting
overriding the default. `gmail` declares `mx.google.com`.

`ms365` declares `null`, which is the absence of an answer rather than a looser
rule: Microsoft's published header opens straight into `spf=` with no
authserv-id, and a field naming no boundary is one any sender can write, since
section 5 leaves the receiver nothing to strip. Reading it would mean accepting a
verdict the sender asserted about itself, so the source instead refuses to run
until the `authservId` setting names the boundary, and the refusal happens
alongside the env validation, before the mailbox is opened. The alternative,
reading the mailbox and then failing every message in it, is indistinguishable
from an empty inbox. `registry.declaredAuthservId` requires the declaration to
exist, so an adapter that omits or misspells the export fails as the plugin bug
it is instead of resolving to anything the gate would act on.

Verdicts are parsed, never searched for. Comments in parentheses (which nest) and
quoted strings are legal syntax carrying free diagnostic text (`reason="..."` is
routine), so both are stripped before the field is split on `;` and the `dmarc`
methodspec is read anchored at the start of its own part — which is what keeps a
`reason=dmarc=pass` property hanging off a _failing_ `spf` methodspec from being
read as DMARC's own result. Conflicting verdicts do not vote: any non-pass from
the boundary rejects the message.

Because a header name legitimately repeats, `lib/headers.mjs` fixes one encoding
for every adapter: each key holds an array of instance values, one entry per
occurrence, in provider order. An adapter that overwrote on a repeat would destroy
the only field that carries any weight.

The array is what keeps the two RFC 5322 boundaries apart. A field also folds
across lines, and a continuation line is recognised by the whitespace it starts
with, so text beginning with whitespace reads as a continuation of whatever
preceded it. Joining the instances into one string leaves the reader unable to
tell "this continues the field above" from "this is the next instance", and an
instance opening with whitespace is then appended to the one above it, carrying
that instance's authserv-id with it. With the instances kept apart, one instance
is one field: folding is resolved inside an instance and never between two, so a
field's verdict is only ever attributed to the authserv-id that same field
carries.

## resolve-canonical classifies, it never fetches or fabricates

Canonical resolution lives in this plugin (it is not shared). `resolve-canonical.mjs`
only classifies: it marks a lead `canonical` when its host belongs to a known
posting-host family and otherwise `needs-canonical`. Two kinds of family, because
the resolver has to treat them differently:

- **shared boards** (Greenhouse, Lever, Ashby) — the employer registers a slug and
  the vendor serves every posting under it, so the first path segment identifies the
  employer and every URL on the board is a posting;
- **per-employer tenants** (Workday, iCIMS) — the employer's name is a host label,
  and the platform also serves index and faceted-search URLs, so a posting has to be
  told apart from a listing by its path.

Workday and iCIMS have no Tier-1 probe, because their per-tenant hosts cannot be
enumerated in `manifest.allowedHosts`. That bars probing them, not recognizing them:
a Workday posting URL is as canonical as a Greenhouse one, and classifying it
otherwise sent a perfectly good posting round the network to come back as a search
fallback. The module exports `CANONICAL_HOST_FAMILIES` / `canonicalHostFamily` so
the network resolver decides against this one definition of "canonical" rather than
a second copy that could drift. It never fetches, never fabricates a URL, and never
keeps a dead tracking link.

The network resolution tiers are I/O and live in `resolve-network.mjs`:

- **Tier 1** probes the public Greenhouse, Lever, and Ashby board APIs with slugs
  guessed from the company name, and takes the posting whose title uniquely clears
  a symmetric Jaccard threshold.
- **Tier 2** runs only for a lead Tier 1 missed, and only when `TAVILY_API_KEY` is
  set. It POSTs to the Tavily Search API and accepts a result only when every gate
  below holds. Tavily's own `score` is not a gate, because the API docs define
  neither a range nor a threshold for it.
- **Fallback** is a live `{company, title}` search URL.

A wrong canonical URL is worse than none, since it looks correct to the reader,
whereas a search URL is visibly a search. Every ambiguous case therefore falls
through to the fallback. Tier 2 accepts three classes, each tied to the employer by
something other than the search ranking that produced it — since the ranking is the
very thing under test — and the weaker the host evidence, the more corroboration is
demanded:

|                    | shared board                     | tenant platform                    | employer domain                                      |
| ------------------ | -------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| identity           | vendor host + board slug in path | vendor host + tenant in host label | domain label **equals** a company slug               |
| employer test      | slug relatable to company        | tenant relatable to company        | equality, on a host shape recognized as registrable  |
| posting vs listing | every board URL is a posting     | posting id required in path        | job-word host or path, and a role slug or posting id |
| corroboration      | two company tokens               | two company tokens                 | **every** company token                              |
| title threshold    | 0.6                              | 0.6                                | **0.75**                                             |
| emitted as         | `canonical`                      | `canonical`                        | `employerCanonical`                                  |

A host-classified result wins over an employer-domain one whenever both clear their
gates, so the stronger evidence decides and the lead carries `canonical` wherever it
honestly can.

What Tier 2 still declines, deliberately, keeping the search fallback: an employer
domain whose label is only _similar_ to a company slug (`acmetech.com` for "Acme
Technologies"), because containment on a global namespace is how a confident wrong
employer gets emitted; a host shape not recognized as a registrable domain, since
this is an allowlist of shapes and deliberately not a public-suffix list; and any
vendor whose tenant location and posting-URL shape have not been verified from that
vendor's own material.

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
