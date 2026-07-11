# Agent Instructions

This is the canonical instruction file for AI coding agents working in this
repository. `AGENTS.md` is a pointer to this file.

## What this project is

career-ops-plugin-job-alerts is a [career-ops](https://github.com/santifer/career-ops)
plugin with the `ingest` hook. It reads job-alert emails from Gmail or Microsoft
365, verifies sender authenticity (DMARC), extracts marketing-leadership roles, and
resolves board tracking links to the employer's canonical posting before returning
`Job[]` to the pipeline. See `ARCHITECTURE.md` (once written) for layout and data
flow.

## Governing policies (read before acting)

These are the maintainer's machine-local policies. Read the ones relevant to your
task in the session that acts on them; do not work from a remembered summary.

- `~/.claude/CLAUDE.md` — global preferences.
- `~/.claude/policies/general-repository-process-policy.md` — repo mechanics.
- `~/.claude/policies/software-engineering-practices-policy.md` — engineering craft.
- `~/.claude/policies/agent-orchestration-and-verification-policy.md` — coordination
  and verification.

## Non-negotiable governance gates (bind every agent and subagent)

- **Issue-first** in THIS repo for every unit of work; one issue per unit.
- Branch `dev/<issue>-<slug>`; a **git worktree per issue branch**; never touch
  `main` directly.
- **Signed commits** (SSH signing via the 1Password agent). Never `--no-verify`,
  never skip a hook.
- One PR per branch; body links the issue with `Closes #N`. **Do not merge without
  Dax's explicit review.**
- **No AI-authorship attribution anywhere.** No `Co-Authored-By: Claude`, no
  "Generated with" lines in commits, PRs, or files. The harness appends these by
  default, so a dispatched subagent must be told explicitly to omit them.
- **TDD**: tests first, real APIs, no mocked-behavior tests, pristine output.
- Conventional Commits; commit messages and PR titles are linted in CI.
- No em-dashes and no emojis in code, comments, docs, commits, issues, or PRs.
- License is MIT (SPDX headers where source headers are used). Credit
  `linkedin-alerts`, `outlook-interviews`, and the bundled `gmail` plugin where
  their code informed a file.

## Plugin contract the career-ops engine enforces

- **Egress only through `ctx.fetch` / `ctx.fetchJson` / `ctx.fetchText`.** The
  engine applies `manifest.allowedHosts` and SSRF-guards the call. Do not import
  `node:http`/`node:net` or call global `fetch`; community plugins are rejected for
  that. This is why IMAP (a raw TLS socket) is deferred.
- `allowedHosts` is HTTPS-only, no wildcards, no IP literals.
- The `ingest` hook returns `Job[] = { title, url, company, location }`. There is no
  auto-submit hook; `humanInTheLoop` stays `true`.
- Secrets come from `ctx.env` (declared in `manifest.requiredEnv`); non-secret
  settings come from `ctx.settings` (the user's `config/plugins.yml` block).
- `test/smoke.mjs` asserts manifest hooks match `index.mjs` exports; keep it green.
- The plugin reads standard environment variables only. It must never reference
  `op://` or any secret manager.

## Architecture (build target)

- A **source-adapter seam**: a `MailSource` interface
  (`listMessages(sinceDays)` returning `{id, subject, from, headers, body}`,
  optional `archive(id)`) with a registry keyed by a `source` setting. v1 adapters
  are Gmail and Microsoft 365.
- A **source-agnostic core**: DMARC gate, extraction, normalization, canonical
  resolution, dedup, and resilient append, operating only on
  `{subject, headers, body}`.
- **`resolve-canonical` lives here** (not shared): Tier 1 maps `{company, title}`
  to a known ATS board (Greenhouse, Lever, Ashby) by public API; Tier 2 searches via
  Tavily; otherwise returns a structured `needs-canonical` result. Never fabricate a
  URL and never keep a dead tracking link. Workday is deferred (dynamic hosts).

## Port and reuse sources (read-only)

- `career-ops-exec` (`/Users/daxdavis/Developer/github.com/rubicon/career-ops-exec`):
  `email-ingest-core.mjs`, `email-ingest-fetch.mjs`, `email-ingest-tests.mjs`, and
  the bundled `plugins/gmail` DMARC check. Read-only. Never touch its issues,
  branches, or remote.
- `Schlaflied/career-ops-plugin-linkedin-alerts` @ `de54949` and
  `Schlaflied/career-ops-plugin-outlook-interviews` @ `ac70c74` (both MIT).

## Commands

- `npm test` runs the zero-network smoke test.
- `npm run format:check` / `npm run format` (Prettier).
- In career-ops: `node plugins.mjs run job-alerts ingest [--dry-run]`.
