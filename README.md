# career-ops-plugin-job-alerts

Multi-board job-alert email ingest for [career-ops](https://github.com/santifer/career-ops).
Reads job-alert emails from Gmail or Microsoft 365, verifies the sender is
authentic, extracts roles, and resolves board tracking links to the employer's
canonical posting before writing them to your pipeline.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why it exists

Job boards like Indeed and ZipRecruiter wrap each posting in an alert email behind
a tracking redirect that carries no static destination and bot-blocks the live hop.
The wrapped link stores an expiring token, so within days the lead becomes
un-openable. This plugin resolves the posting to the employer's own canonical page
(its ATS or careers site, which stays fetchable) using the company and title it
extracts, instead of relying on the dead board URL. A lead it cannot resolve is
flagged `needs-canonical` rather than kept as a broken link. It never fabricates a
destination.

## What it does

- Reads from **Gmail or Microsoft 365** through a source-adapter seam (IMAP is
  deferred, since a raw socket does not fit the HTTPS-only plugin sandbox).
- **Verifies sender authenticity** with a DMARC fail-closed gate, so spoofed or
  unauthenticated mail is skipped.
- **Extracts** marketing-leadership roles. Primary path is LLM extraction via the
  Anthropic API; without a key it falls back to regex and subject-line parsing.
- **Resolves canonical URLs** in two tiers: known ATS boards (Greenhouse, Lever,
  Ashby) by public API, then a search fallback via Tavily, else `needs-canonical`.
- Returns `Job[]` (`title`, `url`, `company`, `location`). It is human-in-the-loop
  and never submits anything anywhere.

## Install

This is a career-ops plugin. From your career-ops checkout:

```bash
node plugins.mjs add job-alerts
```

Then enable it in `config/plugins.yml`:

```yaml
plugins:
  job-alerts:
    enabled: true
    source: gmail # or ms365
```

## Configuration and setup

Pick a mailbox with the `source` setting (`gmail` or `ms365`) in the job-alerts
block shown above. The environment variables required depend on that choice. The
ingest hook validates them first, before any mailbox work, and fails with an error
that names the source, every missing key, and where to set it.

| Source  | Required environment variables                                  |
| ------- | --------------------------------------------------------------- |
| `gmail` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `ms365` | `MSGRAPH_CLIENT_ID`, `MSGRAPH_REFRESH_TOKEN`                    |

Optional for either source, never required (the feature degrades when absent):

| Variable            | Enables                                           |
| ------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | LLM extraction (falls back to regex when absent). |
| `TAVILY_API_KEY`    | Tier 2 canonical-search resolution.               |

How to obtain the credentials is documented in [skill.md](skill.md) and expanded as
each adapter lands. In outline:

- **Gmail**: a Google Cloud OAuth desktop client and a `gmail.readonly` refresh
  token.
- **Microsoft 365**: an Azure AD public client and a delegated `Mail.Read` refresh
  token (no client secret).

The plugin reads standard environment variables only. It never references a secret
manager.

## Development

```bash
npm install        # dev tooling only (Prettier, commitlint)
npm test           # zero-network test suite (smoke + unit)
npm run format:check
```

## Credits

This plugin reuses ideas and code, under MIT, from:

- [`Schlaflied/career-ops-plugin-linkedin-alerts`](https://github.com/Schlaflied/career-ops-plugin-linkedin-alerts)
  for OAuth-REST Gmail access and LinkedIn ID normalization.
- [`Schlaflied/career-ops-plugin-outlook-interviews`](https://github.com/Schlaflied/career-ops-plugin-outlook-interviews)
  for the Microsoft Graph token-refresh and message-listing skeleton.
- The bundled career-ops `gmail` plugin for the DMARC authenticity check.

## License

MIT. See [LICENSE](LICENSE).
