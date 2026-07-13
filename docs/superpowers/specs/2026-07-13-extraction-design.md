# Extraction design (issue #10)

Status: approved by Dax 2026-07-13. Implements the `extract` half of the ingest
pipeline: turning an authenticated message's raw text into `{title, company,
location}` per posting, with an optional LLM enrichment pass over a regex
baseline that already exists.

## Problem

Today's `lib/extract.mjs` finds every URL in a message body via regex, correct
and deterministic, but gives every URL in the message the *same* title (the raw
email subject) and blank `company`/`location`. For a multi-posting digest email
("3 new jobs for you"), this is right for at most one lead and wrong for the
rest. This issue makes those fields real: a per-URL regex baseline plus an
optional LLM enrichment pass, both grounded to never invent a URL.

## Non-goal: role filtering

The plugin does not filter by role, seniority, or any other criterion, and
issue #10 does not add any such filter. Two mechanisms already do this job:

1. **The job board alert subscription itself.** A "job alert" email exists
   because the user configured keywords with the board (Indeed, LinkedIn,
   ZipRecruiter, etc.); the email is already the output of that filter.
2. **career-ops's own downstream pipeline.** `plugins.mjs`'s `ingest` runner
   dedupes and appends `Job[]` to `data/pipeline.md`, then the user runs
   `/career-ops pipeline evaluate`, which applies `classify-tier.mjs` (seniority
   tiers) and the user's own `portals.yml` `title_filter.positive`/`.negative`,
   uniformly across every source plugin. Verified in
   `career-ops-exec/plugins.mjs:154-165` and `docs/CUSTOMIZATION.md`.

Building a third filter layer inside this plugin would duplicate both. No
bundled or community ingest plugin (`gmail`, `apify`, `notion`) implements its
own role filter; `linkedin-alerts`' `titleKeywords` exists specifically to
compensate for LinkedIn's own alert algorithm widening matches beyond the
user's search, which does not generalize to a source-agnostic plugin.

This also corrects a defect already present in the codebase: the ported
fork prompt (`career-ops-exec/email-ingest-fetch.mjs:138`) hard-codes
`"Include ONLY marketing-leadership roles (CMO, SVP, VP, ...)"`. That
personal filter is a maintainer's own use case and must not ship in a
public community plugin. This issue also corrects the "marketing-leadership"
language in `CLAUDE.md`, `README.md`, and `skill.md` to role-agnostic wording.

## Architecture

Mirrors the pure-classifier / I/O-resolver split already established in issue
#8 (`lib/resolve-canonical.mjs` pure / `lib/resolve-network.mjs` I/O):

- **`lib/extract.mjs` (existing, stays pure, gets smarter).** Still finds every
  URL in the message body deterministically via regex: the unconditional
  source of truth for "what URLs exist" in a message. This issue extends it to
  also parse the subject line into `{title, company}` using patterns ported
  from `Schlaflied/career-ops-plugin-linkedin-alerts`'s `parseSubject` (credit
  in the file header): `"{Role} at {Company}"`, `"{Company} is hiring a
  {Role}"`, `"N new {Role} jobs"`. This baseline is unconditional: it always
  runs, costs no network call, and is what a user without `ANTHROPIC_API_KEY`
  gets.
- **`lib/extract-llm.mjs` (new, I/O, conditional on `ANTHROPIC_API_KEY` being
  present).** Given one authenticated message and the leads `extract.mjs`
  already produced for it, makes exactly one Anthropic Messages API call,
  passing the message body plus the already-found URL list, and asks for
  `{url, title, company, location}` per URL. Any returned `url` that is not a
  member of the known list is discarded outright: the LLM enriches fields on a
  fixed list, it never gets to introduce a URL. Where it returns a usable
  answer for a known URL, that lead's fields are overwritten; anything it does
  not return, or any failure, leaves the `extract.mjs` regex fields untouched.

Pipeline order becomes: `extract` (pure, per message) -> `extract-llm` (I/O,
conditional, per message) -> `normalize` -> `classify` -> `resolveNetwork` ->
`dedup` -> `buildJobs`. Nothing downstream of extraction changes.

## Components

- **Model:** `claude-haiku-4-5-20251001`, hardcoded (not a `ctx.settings`
  option in this issue -- YAGNI; add a setting later only if a real need
  appears). Matches the ported prompt's original choice of a Haiku-class model:
  cheap and well suited to structured field extraction.
- **Request contract** (verified against the official API reference, not
  invented): `POST https://api.anthropic.com/v1/messages` via
  `ctx.fetchJson`, headers `anthropic-version: 2023-06-01` and
  `x-api-key: <ANTHROPIC_API_KEY>`, body `{ model, max_tokens, system,
  messages: [{ role: 'user', content }] }`. Add `api.anthropic.com` to
  `manifest.allowedHosts`.
- **System prompt** requires the model to return ONLY a JSON array, scoped
  strictly to the provided URL list, with an explicit instruction never to
  invent a URL and to leave a field empty rather than guess.
- **Response parsing:** defensively extract the first JSON array in the
  response text (ports the `firstJson` helper pattern from
  `career-ops-exec/email-ingest-fetch.mjs`), then filter to only entries whose
  `url` is a member of the known set before merging. If the model returns more
  than one entry for the same `url`, the first one wins; later duplicates for
  that `url` are ignored.

## Error handling

- Any failure for a given message (a non-2xx throw per the engine's real
  `ctx.fetch`/`ctx.fetchJson` contract, a timeout, or malformed/unparseable
  JSON in the response) is caught, logged via `ctx.log`, and that message's
  leads simply keep their `extract.mjs` regex-derived fields. A single bad
  response never crashes the run.
- **Circuit breaker:** on the first `401`/`403` (missing or invalid key) within
  one invocation of the `ingest` hook, stop calling the LLM for the rest of
  that invocation and log once, rather than repeating the same failure once
  per message. This state is local to a single `runIngest` call; it is not
  persisted across separate ingest runs. Transient errors (5xx, timeout) do
  not trip the breaker; each message still gets its own independent attempt.

## Testing

Same pattern already used in `test/gmail.test.mjs` and
`test/resolve-network.test.mjs`: inject a fake `ctx.fetchJson` returning
captured, realistic response shapes (a valid JSON array, a truncated/malformed
one, a non-2xx that throws per the real engine contract). Assert, with real
parsing against real shapes (not mocked-behavior tautologies):

- Correct request shape (model, headers, the URL list embedded in the prompt).
- Correct field-merge behavior: an LLM answer overwrites the matching lead;
  fields the LLM omits keep the regex baseline.
- An LLM-invented URL (not in the known list) never survives into the leads.
- Graceful fallback to the regex baseline on every failure mode.
- The circuit breaker fires after a 401 and suppresses further calls that run.
- The unconditional regex baseline itself: subject-pattern parsing for the
  three ported forms, and the plain-subject fallback when none match.

An optional live test gated on a real `ANTHROPIC_API_KEY` in the environment,
skipped (with a clear SKIP line) otherwise, keeps CI zero-network. Keep the
whole existing suite (`smoke`, `index.test`, `gmail.test`,
`resolve-network.test`) green throughout.

## Docs

Update `CLAUDE.md`, `README.md`, and `skill.md`: remove "marketing-leadership"
language; state plainly that the plugin extracts every posting found in an
authenticated alert email, and that narrowing what you see is the alert
subscription's job and career-ops's own downstream scoring, not this plugin's.
Document `ANTHROPIC_API_KEY` as optional with the graceful regex-baseline
fallback, and name the hardcoded extraction model.

## Out of scope

Tier-2 Tavily search, the MS365 adapter, incremental cursor + resilient
append (issue #9's follow-ups). This issue only touches extraction; it does
not touch `lib/normalize.mjs`, `lib/resolve-canonical.mjs`,
`lib/resolve-network.mjs`, `lib/dedup.mjs`, `lib/append.mjs`, or either
`MailSource` adapter.
