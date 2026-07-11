// @ts-check
// career-ops-plugin-job-alerts — a career-ops ingest plugin.
// Guide: https://github.com/santifer/career-ops/blob/main/docs/PLUGINS.md
//
// Rules the engine enforces:
//  - Egress ONLY through ctx.fetch / ctx.fetchJson / ctx.fetchText (manifest
//    allowedHosts is applied + SSRF-guarded). Do NOT import node:http/net or call
//    global fetch — community plugins are rejected for that.
//  - The ingest hook RETURNS Job[] = { title, url, company, location }; the engine
//    writes them to the pipeline. There is no auto-submit hook.
//  - Secrets come from ctx.env (declared in manifest.requiredEnv); non-secret
//    settings come from ctx.settings (the user's config/plugins.yml block).
//
// This is the scaffold entry. Real behavior (source-adapter seam, DMARC gate,
// extraction, canonical resolution) is built per the issues in this repo.

export default {
  async ingest(ctx) {
    return [];
  },
};
