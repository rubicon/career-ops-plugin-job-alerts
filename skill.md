---
name: career-ops-plugin-job-alerts
description: How to run the job-alerts ingest plugin and the data it produces.
license: MIT
---

# job-alerts

> This file teaches an AI agent how to drive THIS plugin. Keep it scoped to the
> plugin's own domain. It must not instruct the agent to edit core files, change
> scoring, or act outside the plugin's declared `ingest` hook.

## What it does

Reads job-alert emails from a Gmail or Microsoft 365 mailbox, verifies the sender
is authentic (DMARC fail-closed), extracts marketing-leadership roles, and resolves
board tracking links to the employer's canonical posting before returning them to
the pipeline. It never submits anything; it only produces leads you review.

## How to run it

- `node plugins.mjs run job-alerts ingest` — runs the ingest hook.
- `node plugins.mjs run job-alerts ingest --dry-run` — report what it would write.

## What it produces

`Job[]` where each job is `{ title, url, company, location }`. `url` is the
resolved canonical posting when resolution succeeds; a lead that cannot be resolved
is flagged `needs-canonical` rather than kept as a dead tracking link. Roles are
filtered to marketing leadership.

## Settings

Set these under `plugins.job-alerts` in `config/plugins.yml`; they arrive as
`ctx.settings`:

| Setting     | Values             | Default | Meaning                        |
| ----------- | ------------------ | ------- | ------------------------------ |
| `source`    | `gmail` or `ms365` | (none)  | Which mailbox adapter to use.  |
| `sinceDays` | positive integer   | `14`    | How far back to read messages. |

`source` is required; a missing or unknown value fails with a clear error that
lists the known sources.

## Required environment variables

Secrets come from the environment (`ctx.env`), and the required set depends on the
selected `source`. The ingest hook validates the selected source's keys first,
before any mailbox work, and fails with an error naming the source, every missing
key, and telling you to set it in `.env`. `manifest.requiredEnv` stays empty
because the requirement is source-dependent, not fixed.

| Source  | Required environment variables                                  |
| ------- | --------------------------------------------------------------- |
| `gmail` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `ms365` | `MSGRAPH_CLIENT_ID`, `MSGRAPH_REFRESH_TOKEN`                    |

Optional for either source (never required; the feature degrades when absent):

| Variable            | Enables                                           |
| ------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | LLM extraction (falls back to regex when absent). |
| `TAVILY_API_KEY`    | Tier 2 canonical-search resolution.               |

## Setup

Obtaining the credentials above (documented fully as each adapter lands):

- Gmail: a Google Cloud OAuth desktop client with `gmail.readonly`, exchanged for a
  refresh token.
- Microsoft 365: an Azure AD public client with delegated `Mail.Read`, exchanged for
  a refresh token (no client secret).

The plugin reads standard environment variables only. It never references `op://` or
any secret manager.
