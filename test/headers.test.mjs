// Unit tests for the shared header-map encoding (lib/headers.mjs).
//
// RFC 5322 header names repeat (Received, and often more than one
// Authentication-Results), and RFC 5322 fields fold across lines. The encoding
// has to keep those two facts apart: an instance boundary and a fold boundary
// are not the same thing, and a reader that cannot tell them apart can join text
// from one instance onto another. These tests pin the boundary: every instance
// survives, every instance stays its own field, and folding is resolved inside
// an instance and never across two.
//
// Hermetic: no network, no files.
import assert from 'node:assert/strict';

import { headersToObject, headerValue, headerFields } from '../lib/headers.mjs';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

const AR = 'Authentication-Results';

// -- headersToObject: one array of instances per name ----------------------
t('a single instance is still stored as a one-element array', () => {
  const map = headersToObject([{ name: 'Subject', value: 'VP Marketing at Acme' }]);
  assert.deepEqual(map, { Subject: ['VP Marketing at Acme'] });
});
t('repeated names keep every instance, in order, under one key', () => {
  const map = headersToObject([
    { name: 'Received', value: 'from a' },
    { name: AR, value: 'mx.google.com; dmarc=pass' },
    { name: 'Received', value: 'from b' },
    { name: AR, value: 'evil.tld; dmarc=fail' },
  ]);
  assert.deepEqual(map[AR], ['mx.google.com; dmarc=pass', 'evil.tld; dmarc=fail']);
  assert.deepEqual(map.Received, ['from a', 'from b']);
});
t('names collapse case-insensitively, first-seen casing wins', () => {
  const map = headersToObject([
    { name: AR, value: 'mx.google.com; dmarc=pass' },
    { name: 'AUTHENTICATION-RESULTS', value: 'evil.tld; dmarc=fail' },
  ]);
  assert.deepEqual(Object.keys(map), [AR]);
  assert.equal(map[AR].length, 2);
});
t('a non-array, or an entry with no name, contributes nothing', () => {
  assert.deepEqual(headersToObject(undefined), {});
  assert.deepEqual(headersToObject(null), {});
  assert.deepEqual(headersToObject([{ value: 'orphan' }, null]), {});
});
t('a missing value is stored as an empty string, never undefined', () => {
  assert.deepEqual(headersToObject([{ name: 'X', value: undefined }]), { X: [''] });
});

// -- headerFields: one field per instance ----------------------------------
t('each instance is exactly one field', () => {
  const map = headersToObject([
    { name: AR, value: 'mx.google.com; dmarc=pass' },
    { name: AR, value: 'evil.tld; dmarc=fail' },
  ]);
  assert.deepEqual(headerFields(map, AR), ['mx.google.com; dmarc=pass', 'evil.tld; dmarc=fail']);
});
t('the lookup is case-insensitive and gathers every case variant of the name', () => {
  const fields = headerFields(
    { 'authentication-results': ['a; dmarc=pass'], 'Authentication-Results': ['b; dmarc=fail'] },
    AR,
  );
  assert.equal(fields.length, 2);
});
t('a folded instance is unfolded into the one field it is', () => {
  // RFC 5322 folding: a continuation line starts with whitespace and belongs to
  // the field above it.
  assert.deepEqual(headerFields({ [AR]: ['mx.google.com; spf=pass;\r\n\tdmarc=pass'] }, AR), [
    'mx.google.com; spf=pass; dmarc=pass',
  ]);
});
t('a continuation line cannot join two instances into one field', () => {
  // The load-bearing case. An instance whose value opens with whitespace is a
  // continuation only of itself: it is a separate field, and the field above it
  // does not absorb it. Anything else would let one instance lend its
  // authserv-id to text written by another.
  const map = headersToObject([
    { name: AR, value: 'mx.google.com; spf=pass; dkim=pass' },
    { name: AR, value: ' ; dmarc=pass' },
  ]);
  assert.deepEqual(headerFields(map, AR), ['mx.google.com; spf=pass; dkim=pass', '; dmarc=pass']);
});
t('empty and whitespace-only instances are dropped', () => {
  assert.deepEqual(headerFields({ [AR]: ['', '   ', 'mx.google.com; dmarc=pass'] }, AR), [
    'mx.google.com; dmarc=pass',
  ]);
});
t('a bare string value is one instance, so its newlines are only folding', () => {
  // The plain-string shape stays readable for hand-built messages. It carries no
  // instance boundary of its own, so it can only ever be a single field.
  assert.deepEqual(headerFields({ [AR]: 'mx.google.com; spf=pass;\n dmarc=pass' }, AR), [
    'mx.google.com; spf=pass; dmarc=pass',
  ]);
  assert.equal(
    headerFields({ [AR]: 'mx.google.com; dmarc=pass\nevil.tld; dmarc=fail' }, AR).length,
    1,
  );
});
t('a missing header, or no headers at all, yields no fields', () => {
  assert.deepEqual(headerFields({}, AR), []);
  assert.deepEqual(headerFields(undefined, AR), []);
  assert.deepEqual(headerFields('not an object', AR), []);
});

// -- headerValue: the single-instance reader --------------------------------
t('headerValue reads a single-instance header case-insensitively', () => {
  const map = headersToObject([{ name: 'Subject', value: 'VP Marketing at Acme' }]);
  assert.equal(headerValue(map, 'subject'), 'VP Marketing at Acme');
  assert.equal(headerValue(map, 'SUBJECT'), 'VP Marketing at Acme');
});
t('headerValue returns an empty string for an absent header', () => {
  assert.equal(headerValue({}, 'subject'), '');
  assert.equal(headerValue(undefined, 'subject'), '');
});
t('headerValue joins repeats rather than hiding them', () => {
  const map = headersToObject([
    { name: 'Received', value: 'from a' },
    { name: 'Received', value: 'from b' },
  ]);
  assert.equal(headerValue(map, 'received'), 'from a\nfrom b');
});

console.log(`headers.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
