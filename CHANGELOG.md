# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0](https://github.com/rubicon/career-ops-plugin-job-alerts/compare/v0.1.0...v0.1.0) (2026-08-15)


### Features

* **ms365:** implement the Microsoft Graph MailSource adapter ([#19](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/19)) ([0a72d06](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/0a72d06c7b15e38b1a766db801da242b64e8b963))
* **resolve-network:** add tier-2 Tavily canonical resolution ([#20](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/20)) ([5caeaef](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/5caeaef01e23a26d35c2a2102b735beda2495903))


### Bug Fixes

* **ci:** address the release-please 1Password item by UUID ([#15](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/15)) ([c188ab9](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/c188ab94e5f37a0bd5da50d4260d8d8532de65e0)), closes [#14](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/14)

## [0.1.0](https://github.com/rubicon/career-ops-plugin-job-alerts/compare/v0.1.0...v0.1.0) (2026-08-03)


### Bug Fixes

* **ci:** address the release-please 1Password item by UUID ([#15](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/15)) ([c188ab9](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/c188ab94e5f37a0bd5da50d4260d8d8532de65e0)), closes [#14](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/14)

## 0.1.0 (2026-07-21)


### Features

* **extract:** LLM-enriched, role-agnostic extraction ([#11](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/11)) ([54f670a](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/54f670a906217c880ee2083b40a8112b07875b9f))
* **gmail:** implement OAuth-REST MailSource adapter ([#7](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/7)) ([f9387f5](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/f9387f51e9976671a2c50d51a6e1b75c2024443a))
* **resolve-canonical:** tier-1 ATS resolution and never-dead-link contract ([#9](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/9)) ([9b45f99](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/9b45f995b52dab2d855dbb0b3bac1d7fc62844f1)), closes [#8](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/8)
* source-adapter seam and source-agnostic core skeleton ([#3](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/3)) ([f23c317](https://github.com/rubicon/career-ops-plugin-job-alerts/commit/f23c3176bb45c3012c0078233d99711954bb6643)), closes [#2](https://github.com/rubicon/career-ops-plugin-job-alerts/issues/2)

## [Unreleased]

### Added

- Plugin scaffold for the career-ops `ingest` hook: a thin `index.mjs` entry that
  delegates to `lib/ingest.mjs`.
- Source-adapter seam: a `MailSource` registry keyed by a `source` setting, with
  Gmail and Microsoft 365 adapter stubs and fail-fast per-source environment
  validation.
- Source-agnostic core stages, each pure and deterministic: DMARC authenticity
  gate, role extraction, lead normalization, canonical-URL classification,
  in-batch dedup, and `Job[]` assembly.
- Release automation (release-please), CI (smoke, format, and commitlint checks),
  and the standard repository documentation set.

[Unreleased]: https://github.com/rubicon/career-ops-plugin-job-alerts/commits/main
