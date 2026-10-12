import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'validate-changelog.mjs');
const PREAMBLE = '# Changelog\n\nAll notable changes are documented here.\n\n';

function run(changelog) {
  const args = [SCRIPT];
  if (changelog !== null) {
    const file = join(mkdtempSync(join(tmpdir(), 'changelog-')), 'CHANGELOG.md');
    writeFileSync(file, changelog);
    args.push(file);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf-8' });
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n${err.message}`);
  }
}

check('fails on an [Unreleased] heading below a release', () => {
  const r = run(`${PREAMBLE}## [0.1.1] - 2026-08-03\n\n## [Unreleased]\n`);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /\[Unreleased\]/);
});

check('fails on a heading that does not start with a version', () => {
  const r = run(`${PREAMBLE}## [0.1.1] - 2026-08-03\n\n## 0.1.0 (2026-07-21)\n`);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /0\.1\.0 \(2026-07-21\)/);
});

check('fails when a version is listed twice', () => {
  const r = run(
    `${PREAMBLE}## [0.1.1] - 2026-08-15\n\n## [0.1.0] - 2026-08-03\n\n## [0.1.0] - 2026-07-21\n`,
  );
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /version listed twice/);
});

check('fails when there is no release heading at all', () => {
  assert.strictEqual(run(`${PREAMBLE}Nothing yet.\n`).status, 1);
});

check('passes Keep a Changelog headings', () => {
  const r = run(`${PREAMBLE}## [0.1.2] - 2026-10-12\n\n## [0.1.1] - 2026-08-03\n`);
  assert.strictEqual(r.status, 0);
});

check('passes a raw release-please heading', () => {
  const r = run(
    `${PREAMBLE}## [0.1.3](https://example.test/compare/v0.1.2...v0.1.3) (2026-10-20)\n`,
  );
  assert.strictEqual(r.status, 0);
});

check('passes the repository CHANGELOG.md', () => {
  const r = run(null);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.status, 0);
});

process.exit(failed === 0 ? 0 : 1);
