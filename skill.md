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

TODO: non-secret options under `plugins.job-alerts` in `config/plugins.yml`
(these arrive as `ctx.settings`), including the mail `source` selector
(`gmail` or `ms365`). Documented as the adapters land.

## Setup

TODO: Gmail (Google Cloud OAuth desktop client, `gmail.readonly`) and Microsoft 365
(Azure AD public client, delegated `Mail.Read`) one-time setup, plus optional
`ANTHROPIC_API_KEY` (LLM extraction) and `TAVILY_API_KEY` (canonical search).
Documented as the adapters and resolver land.
