#!/usr/bin/env node
// Guards the changelog heading shape. release-please inserts each new entry
// above the first heading matching /\n###? v?[0-9[]/. A "## " heading that does
// not start with a version number, such as "## [Unreleased]", sits out of order
// or hides the real insertion point (see rubicon/career-ops-capture#98). The
// adopted Keep a Changelog form "## [x.y.z] - YYYY-MM-DD" and release-please's
// raw form "## [x.y.z](url) (date)" both pass. A version listed twice fails.
// Runs in CI.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? join(ROOT, 'CHANGELOG.md');
const headings = readFileSync(file, 'utf-8')
  .split('\n')
  .filter((line) => line.startsWith('## '));

const problems = [];
if (headings.length === 0) problems.push('no "## " release heading found');
const seen = new Set();
for (const h of headings) {
  const m = /^## \[([0-9][^\]]*)\]/.exec(h);
  if (m === null) {
    problems.push(`heading is not "## [x.y.z]": ${h}`);
  } else if (seen.has(m[1])) {
    problems.push(`version listed twice: ${h}`);
  } else {
    seen.add(m[1]);
  }
}
if (problems.length > 0) {
  console.error(
    `${file}:\n  ${problems.join('\n  ')}\n` +
      'release-please inserts new entries above the first heading that starts with a\n' +
      'version. Use "## [x.y.z] - YYYY-MM-DD" and no "## [Unreleased]" heading.',
  );
  process.exit(1);
}
console.log(`validate-changelog: ok (${headings[0]})`);
