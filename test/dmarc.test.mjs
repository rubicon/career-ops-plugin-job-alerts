// Unit tests for the DMARC authenticity gate (lib/dmarc.mjs).
//
// Authentication-Results is trust-domain metadata (RFC 7601): a sender may write
// as many copies as it likes into the mail it sends, and the receiving MTA
// delivers those alongside the one field it stamps itself. Only the field
// bearing the receiving boundary's own authserv-id carries any weight, because
// RFC 7601 section 5 requires that MTA to strip pre-existing fields bearing that
// same id. These tests pin both halves of that: the boundary's own verdict is
// honoured in either direction, and no other copy can speak for it.
//
// They also pin the parse. Comments in parentheses and quoted strings are legal
// syntax carrying free diagnostic text (Google writes reason="..." routinely),
// so anything that scans the raw field for a verdict reads prose as a result.
//
// Hermetic: no network, no files.
import assert from 'node:assert/strict';

import { passesDmarc } from '../lib/dmarc.mjs';

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

const GOOGLE = { authservId: 'mx.google.com' };
const UNNAMED = { authservId: null };

// msg builds a message whose Authentication-Results header carries `fields`.
// Repeated header instances are joined with "\n", the encoding the adapters use
// when a header name occurs more than once.
function msg(...fields) {
  return { headers: { 'Authentication-Results': fields.join('\n') } };
}

// -- contract: the trusted authserv-id is mandatory ------------------------
t('passesDmarc refuses to run without an explicit trusted authserv-id', () => {
  assert.throws(() => passesDmarc(msg('mx.google.com; dmarc=pass')), /authserv-id/i);
});
t('passesDmarc rejects a non-string, non-null authserv-id', () => {
  // Array.prototype.filter passes (element, index, array): a bare
  // `messages.filter(passesDmarc)` would hand the index in as the options
  // argument. That must fail loudly rather than degrade into some default.
  assert.throws(() => passesDmarc(msg('mx.google.com; dmarc=pass'), 0), /authserv-id/i);
  assert.throws(
    () => passesDmarc(msg('mx.google.com; dmarc=pass'), { authservId: '' }),
    /authserv-id/i,
  );
});

// -- a genuine receiver-issued pass is still accepted ----------------------
t('a receiver-issued dmarc=pass passes', () => {
  assert.equal(passesDmarc(msg('mx.google.com; spf=pass; dkim=pass; dmarc=pass'), GOOGLE), true);
});
t('a receiver-issued dmarc=pass with trailing properties passes', () => {
  assert.equal(
    passesDmarc(msg('mx.google.com; dmarc=pass action=none header.from=acme.com'), GOOGLE),
    true,
  );
});
t('a receiver-issued dmarc=pass alongside an unrelated comment passes', () => {
  assert.equal(
    passesDmarc(
      msg(
        'mx.google.com; spf=pass (google.com: domain of alerts@acme.com designates ' +
          '1.2.3.4 as permitted sender) smtp.mailfrom=alerts@acme.com; ' +
          'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=acme.com',
      ),
      GOOGLE,
    ),
    true,
  );
});
t('whitespace around the "=" is legal and still passes', () => {
  assert.equal(passesDmarc(msg('mx.google.com; dmarc = pass'), GOOGLE), true);
});
t('method, result and authserv-id all compare case-insensitively', () => {
  assert.equal(passesDmarc(msg('MX.Google.COM; DMARC=PASS'), GOOGLE), true);
});
t('a folded field is unfolded, not read as two fields', () => {
  // RFC 5322 folding: a continuation line starts with whitespace and belongs to
  // the field above it.
  assert.equal(passesDmarc(msg('mx.google.com; spf=pass;\n\tdmarc=pass'), GOOGLE), true);
});

// -- the verdict is parsed, not scanned for --------------------------------
t('dmarc=fail does not pass', () => {
  assert.equal(passesDmarc(msg('mx.google.com; dmarc=fail'), GOOGLE), false);
});
t('dmarc=passfoo is not a pass', () => {
  assert.equal(passesDmarc(msg('mx.google.com; dmarc=passfoo'), GOOGLE), false);
});
t('a field with no dmarc methodspec fails closed', () => {
  assert.equal(passesDmarc(msg('mx.google.com; spf=pass; dkim=pass'), GOOGLE), false);
});
t('a missing or empty Authentication-Results fails closed', () => {
  assert.equal(passesDmarc({ headers: {} }, GOOGLE), false);
  assert.equal(passesDmarc({}, GOOGLE), false);
  assert.equal(passesDmarc(undefined, GOOGLE), false);
  assert.equal(passesDmarc(msg(''), GOOGLE), false);
});
t('a verdict inside a comment is diagnostic text, not a result', () => {
  assert.equal(
    passesDmarc(
      msg('mx.google.com; spf=fail (dmarc=pass) smtp.mailfrom=evil.tld; dmarc=fail'),
      GOOGLE,
    ),
    false,
  );
});
t('comments nest, and a verdict nested inside one is still not a result', () => {
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=fail (outer (dmarc=pass) tail); dmarc=fail'), GOOGLE),
    false,
  );
});
t('a verdict inside a quoted string is diagnostic text, not a result', () => {
  assert.equal(
    passesDmarc(
      msg('mx.google.com; spf=fail reason="dmarc=pass" smtp.mailfrom=evil.tld; dmarc=fail'),
      GOOGLE,
    ),
    false,
  );
});
t('a reason hanging off the dmarc methodspec is not a second verdict', () => {
  assert.equal(
    passesDmarc(
      msg('mx.google.com; dmarc=fail reason="wanted dmarc=pass" header.from=evil.tld'),
      GOOGLE,
    ),
    false,
  );
});
t('a property of another method is not a dmarc result', () => {
  // Anchoring each methodspec at the start of its own ";"-delimited part keeps
  // `reason=dmarc=pass` on a failing spf methodspec from being read as DMARC's.
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=fail reason=dmarc=pass; dmarc=fail'), GOOGLE),
    false,
  );
});

// -- only the receiving boundary's own field counts ------------------------
t('an authserv-id is compared whole, never by substring', () => {
  assert.equal(passesDmarc(msg('mx.google.com.evil.tld; dmarc=pass'), GOOGLE), false);
  assert.equal(passesDmarc(msg('notmx.google.com; dmarc=pass'), GOOGLE), false);
  assert.equal(passesDmarc(msg('evil.tld; dmarc=pass'), GOOGLE), false);
});
t('a repeated field from another authserv-id cannot overturn the boundary verdict', () => {
  // Conflicting verdicts across repeats: the boundary says fail, another copy
  // says pass. Position must not decide it.
  assert.equal(
    passesDmarc(msg('mx.google.com; dmarc=fail', 'evil.tld; dmarc=pass'), GOOGLE),
    false,
  );
  assert.equal(
    passesDmarc(msg('evil.tld; dmarc=pass', 'mx.google.com; dmarc=fail'), GOOGLE),
    false,
  );
});
t('the boundary verdict is found among repeats, in either position', () => {
  assert.equal(passesDmarc(msg('mx.google.com; dmarc=pass', 'evil.tld; dmarc=fail'), GOOGLE), true);
  assert.equal(passesDmarc(msg('evil.tld; dmarc=fail', 'mx.google.com; dmarc=pass'), GOOGLE), true);
});
t('two fields from the boundary itself with conflicting verdicts fail closed', () => {
  assert.equal(
    passesDmarc(msg('mx.google.com; dmarc=pass', 'mx.google.com; dmarc=fail'), GOOGLE),
    false,
  );
});
t('a boundary field carrying no dmarc result is not rescued by another copy', () => {
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=pass; dkim=pass', 'evil.tld; dmarc=pass'), GOOGLE),
    false,
  );
});

// -- a boundary that stamps no authserv-id (authservId: null) --------------
t('the single unnamed field is the boundary when none is configured', () => {
  assert.equal(passesDmarc(msg('spf=pass; dkim=pass; dmarc=pass'), UNNAMED), true);
  assert.equal(passesDmarc(msg('spf=pass; dkim=pass; dmarc=fail'), UNNAMED), false);
});
t('an unnamed boundary field is read past a named copy, not shadowed by it', () => {
  assert.equal(passesDmarc(msg('spf=pass; dmarc=pass', 'evil.tld; dmarc=fail'), UNNAMED), true);
  assert.equal(passesDmarc(msg('evil.tld; dmarc=pass', 'spf=pass; dmarc=fail'), UNNAMED), false);
});
t('two unnamed fields are ambiguous and fail closed', () => {
  // Nothing distinguishes the boundary's own field from an injected copy that
  // also omits an authserv-id, so neither is trusted.
  assert.equal(passesDmarc(msg('spf=fail; dmarc=fail', 'spf=pass; dmarc=pass'), UNNAMED), false);
  assert.equal(passesDmarc(msg('spf=pass; dmarc=pass', 'spf=pass; dmarc=pass'), UNNAMED), false);
});
t('with no unnamed field present, a named one is not promoted', () => {
  assert.equal(passesDmarc(msg('evil.tld; dmarc=pass'), UNNAMED), false);
});
t('an unnamed boundary field is parsed the same way', () => {
  assert.equal(passesDmarc(msg('spf=fail (dmarc=pass); dmarc=fail'), UNNAMED), false);
  assert.equal(passesDmarc(msg('dmarc=passfoo'), UNNAMED), false);
  assert.equal(passesDmarc(msg('dmarc = pass'), UNNAMED), true);
  assert.equal(
    passesDmarc(
      msg(
        'spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=acme.com; dkim=pass ' +
          '(signature was verified) header.d=acme.com;dmarc=pass action=none ' +
          'header.from=acme.com;compauth=pass reason=100',
      ),
      UNNAMED,
    ),
    true,
  );
});

console.log(`dmarc.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
