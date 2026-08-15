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
  unauthenticated mail is skipped. The verdict is taken only from the
  `Authentication-Results` field your receiving mail boundary stamped (RFC 7601),
  never from a copy the message arrived carrying.
- **Extracts** every posting it finds, with no role filter of its own: the alert
  subscription and career-ops's own downstream pipeline evaluate already narrow
  what you see. Primary path is a small LLM call (`claude-haiku-4-5-20251001`)
  per authenticated email via the Anthropic API; without a key, or if a call
  fails, it falls back to deterministic subject-line and regex parsing.
- **Resolves canonical URLs** in two tiers: known ATS boards (Greenhouse, Lever,
  Ashby) probed by public API, then, when `TAVILY_API_KEY` is set, a Tavily search
  for the posting those probes missed. A lead neither tier can pin down gets a live
  `{company, title}` search URL, never the dead tracking link. Tier 2 prefers that
  fallback over a confident-but-wrong hit, since a wrong link looks correct while a
  search URL is visibly a search. It accepts a result on a shared ATS board, on an
  employer's Workday or iCIMS tenant, or on the employer's own careers domain -- but
  only when the URL is tied to that employer by something other than the search
  ranking itself, the URL denotes one posting rather than a listings page, the
  company is named in the result, the role clears a title threshold, and no runner-up
  ties it. The weaker the host evidence, the more of the rest is demanded: a bespoke
  employer domain must match the company name exactly, account for every word of it,
  and clear a higher title bar than an ATS host does.
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

`ms365` also needs the `authservId` setting: the name your receiving mail
boundary puts at the front of the `Authentication-Results` header, which is the
only field the DMARC gate can attribute a verdict to. Microsoft publishes none
for Exchange Online, so there is no default and the source refuses to run until
you set it. See [skill.md](skill.md) for how to read it out of a message you
already have. `gmail` knows its own and needs no setting.

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
  @ `ac70c74` for the Microsoft Graph token-refresh and message-listing skeleton,
  widened here to select the full body and `internetMessageHeaders` and to
  paginate `@odata.nextLink`.
- The bundled career-ops `gmail` plugin for the DMARC authenticity check.

## License

MIT. See [LICENSE](LICENSE).
