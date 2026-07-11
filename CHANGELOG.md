# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
