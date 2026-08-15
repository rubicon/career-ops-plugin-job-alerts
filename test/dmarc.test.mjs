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
// And they pin the instance boundary. RFC 5322 folds a field across lines and
// marks the continuation by leading whitespace, so an instance that opens with
// whitespace has the shape of a continuation of the instance above it. One
// header instance is one field: what a field asserts is only ever attributed to
// the authserv-id that same field carries.
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

// msg builds a message whose Authentication-Results header carries `fields`,
// one entry per header instance -- the encoding the adapters produce (see
// lib/headers.mjs) when a header name occurs more than once.
function msg(...fields) {
  return { headers: { 'Authentication-Results': fields } };
}

// -- contract: the trusted authserv-id is mandatory ------------------------
t('passesDmarc refuses to run without an explicit trusted authserv-id', () => {
  assert.throws(() => passesDmarc(msg('mx.google.com; dmarc=pass')), /authserv-id/i);
});
t('passesDmarc rejects anything that is not a non-empty authserv-id', () => {
  // Array.prototype.filter passes (element, index, array): a bare
  // `messages.filter(passesDmarc)` would hand the index in as the options
  // argument. That must fail loudly rather than degrade into some default.
  assert.throws(() => passesDmarc(msg('mx.google.com; dmarc=pass'), 0), /authserv-id/i);
  assert.throws(
    () => passesDmarc(msg('mx.google.com; dmarc=pass'), { authservId: '' }),
    /authserv-id/i,
  );
  assert.throws(
    () => passesDmarc(msg('mx.google.com; dmarc=pass'), { authservId: '   ' }),
    /authserv-id/i,
  );
});
t('null is not a trusted mode: an unnamed field is not attributable to anyone', () => {
  // A field carrying no authserv-id is one any sender can write, and RFC 7601
  // section 5 gives the receiver nothing to strip, so no copy of it can be
  // attributed to the boundary. There is no message the gate could read under
  // it, so it refuses the option rather than reading one anyway.
  assert.throws(
    () => passesDmarc(msg('spf=pass; dmarc=pass'), { authservId: null }),
    /authserv-id/i,
  );
  assert.throws(() => passesDmarc(msg('dmarc=pass'), { authservId: null }), /authserv-id/i);
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

// -- the parse is discriminated, not merely reachable ----------------------
// The cases above all place a genuine dmarc=fail ahead of the decoy, so the
// boundary's real verdict decides them whether or not the free-text and
// anchoring rules do any work. These four put the decoy's own ';' or '.' where
// it changes which token the parser reads as the DMARC methodspec, ahead of a
// genuine dmarc=pass. Remove the comment and quoted-string stripping, or the
// methodspec anchor, and each of them starts reading a second, conflicting
// dmarc result out of text that asserts nothing, so the boundary's own pass
// becomes unresolvable and these assertions fail.
t('a semicolon inside a quoted string does not open a new methodspec', () => {
  assert.equal(
    passesDmarc(
      msg('mx.google.com; spf=fail reason="checked; dmarc=fail applies"; dmarc=pass'),
      GOOGLE,
    ),
    true,
  );
});
t('a semicolon inside a comment does not open a new methodspec', () => {
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=fail (checked; dmarc=fail applies); dmarc=pass'), GOOGLE),
    true,
  );
});
t('a semicolon inside a nested comment does not open a new methodspec either', () => {
  assert.equal(
    passesDmarc(
      msg('mx.google.com; spf=fail (outer (checked; dmarc=fail) tail); dmarc=pass'),
      GOOGLE,
    ),
    true,
  );
});
t('a propspec whose property is named dmarc is not a dmarc methodspec', () => {
  // RFC 7601 propspecs are `ptype "." property "=" pvalue`, so `policy.dmarc=`
  // states a property of the policy ptype, not DMARC's own result. Anchoring
  // the methodspec at the start of its own part is what tells them apart: the
  // part does not begin with `method=`, so it asserts no result at all.
  assert.equal(passesDmarc(msg('mx.google.com; policy.dmarc=fail; dmarc=pass'), GOOGLE), true);
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
t('a continuation-shaped instance cannot borrow the boundary field authserv-id', () => {
  // RFC 5322 marks a continuation line by the whitespace it starts with, so an
  // instance whose value opens with whitespace looks like one. It is not: it is
  // its own field, carrying its own (here absent) authserv-id. Folding it into
  // the field above would read its methodspecs as the boundary's own, which is
  // the whole verdict when the boundary field asserts no dmarc result itself.
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=pass; dkim=pass', ' ; dmarc=pass'), GOOGLE),
    false,
  );
  assert.equal(
    passesDmarc(msg('mx.google.com; spf=pass; dkim=pass', '\t; dmarc=pass'), GOOGLE),
    false,
  );
  // Same shape against a boundary field that did assert one: the injected
  // methodspec must not join it, in either direction.
  assert.equal(passesDmarc(msg('mx.google.com; dmarc=fail', ' ; dmarc=pass'), GOOGLE), false);
});

// -- a field carrying no authserv-id speaks for no boundary ----------------
const CONTOSO = { authservId: 'mail.contoso.com' };

t('a field with no authserv-id is never read as the configured boundary', () => {
  // RFC 7601 section 5 gives a receiver nothing to strip when a field carries no
  // id, so no copy of one can be attributed to it. Position does not change
  // that, in either direction.
  assert.equal(passesDmarc(msg('spf=pass; dkim=pass; dmarc=pass'), CONTOSO), false);
  assert.equal(
    passesDmarc(msg('spf=pass; dmarc=pass', 'mail.contoso.com; dmarc=fail'), CONTOSO),
    false,
  );
  assert.equal(
    passesDmarc(msg('mail.contoso.com; dmarc=pass', 'spf=fail; dmarc=fail'), CONTOSO),
    true,
  );
});
t('the boundary field is parsed the same way whatever id it carries', () => {
  assert.equal(
    passesDmarc(msg('mail.contoso.com; spf=fail (dmarc=pass); dmarc=fail'), CONTOSO),
    false,
  );
  assert.equal(passesDmarc(msg('mail.contoso.com; dmarc=passfoo'), CONTOSO), false);
  assert.equal(passesDmarc(msg('mail.contoso.com; dmarc = pass'), CONTOSO), true);
  assert.equal(
    passesDmarc(
      msg(
        'mail.contoso.com; spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=acme.com; ' +
          'dkim=pass (signature was verified) header.d=acme.com;dmarc=pass action=none ' +
          'header.from=acme.com;compauth=pass reason=100',
      ),
      CONTOSO,
    ),
    true,
  );
});

console.log(`dmarc.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
