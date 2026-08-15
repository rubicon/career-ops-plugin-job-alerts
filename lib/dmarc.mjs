// DMARC authenticity gate. Pure and fail-closed: inspects only the message's
// Authentication-Results header fields and performs no network lookups (the
// adapters and the engine own all I/O). A message with no boundary-issued
// dmarc=pass is rejected.
//
// Two properties of Authentication-Results shape this module.
//
// 1. It is trust-domain metadata, not a property of the message (RFC 7601).
//    Anyone can put an Authentication-Results field in the mail they send, and
//    the receiving MTA delivers those copies alongside the one it stamps
//    itself, in no guaranteed order. What makes exactly one of them meaningful
//    is RFC 7601 section 5: an MTA must strip any pre-existing field bearing
//    the authserv-id it uses, so a surviving field with that id can only have
//    come from the boundary. Every other copy is unverifiable text. The gate
//    therefore reads the verdict only from fields whose authserv-id is the
//    receiving boundary's, compared whole -- `mx.google.com.evil.tld` and
//    `notmx.google.com` both contain the trusted name and are not it. The
//    authserv-id is provider-specific, so the caller supplies it (the adapters
//    declare it; see lib/sources/registry.mjs) rather than this module assuming
//    one.
//
// 2. Its verdicts have to be parsed, not searched for. Comments in parentheses
//    (which nest) and quoted strings are legal syntax carrying free diagnostic
//    text -- `reason="..."` is routine -- so a substring scan reads prose as a
//    verdict. Comments and quoted strings are stripped first, the field is then
//    split on ';', and the DMARC result is read from the methodspec whose
//    method is `dmarc`, anchored at the start of its own part. That anchoring is
//    what keeps a `reason=dmarc=pass` property hanging off a *failing* spf
//    methodspec from being read as DMARC's own result.
//
// There is no reading for a boundary whose authserv-id is unknown. A field that
// carries no id gives the receiver nothing to strip, so section 5 attributes no
// copy of it to anyone: "the single field carrying no authserv-id" identifies
// the boundary's own only while no sender has written one, and a sender writes
// the whole message. Reading it anyway would mean accepting a dmarc=pass the
// sender asserted about itself. So the id is required, and there is no mode in
// which its absence still yields a verdict.
//
// The fail-closed authenticity check is informed by the bundled career-ops gmail
// plugin (MIT).

import { headerFields } from './headers.mjs';

const HEADER = 'Authentication-Results';
// A methodspec opens with `method =` (RFC 7601 method / result tokens are
// alphanumerics and '-'). Used both to read a result and to tell an
// authserv-id apart from a field that opens straight into a methodspec.
const METHODSPEC = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*=[ \t]*([A-Za-z0-9][A-Za-z0-9-]*)/;
const METHOD_START = /^[A-Za-z][A-Za-z0-9-]*[ \t]*=/;

// passesDmarc returns true only when the receiving boundary's own
// Authentication-Results field asserts dmarc=pass. `options.authservId` is the
// authserv-id that boundary stamps; it is required, because there is no safe
// default. Absent, failing, unattributable and ambiguous results are all
// rejected.
export function passesDmarc(message, options) {
  const trusted = trustedAuthservId(options);
  const fields = headerFields(message?.headers, HEADER).map(parseField);
  const boundary = fields.filter((f) => f.authservId === trusted);
  if (boundary.length === 0) return false;

  const verdicts = boundary.map(dmarcResult).filter((v) => v !== undefined);
  if (verdicts.length === 0) return false;
  // Conflicting verdicts from the same boundary are not a majority vote.
  return verdicts.every((v) => v === 'pass');
}

// trustedAuthservId normalizes the caller's declared boundary id. Anything but a
// non-empty string is a programming error -- the index that
// `messages.filter(passesDmarc)` would pass, and equally a null standing in for
// a boundary whose id nobody knows -- and throws rather than silently selecting
// a weaker rule.
function trustedAuthservId(options) {
  const value = options?.authservId;
  if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase();
  throw new Error(
    'passesDmarc requires options.authservId: the authserv-id the receiving boundary stamps ' +
      'into Authentication-Results. A field carrying no authserv-id is one any sender can ' +
      'write, so there is no verdict to read without it.',
  );
}

// parseField splits one Authentication-Results field into its authserv-id (null
// when the field opens straight into a methodspec) and its method results.
function parseField(raw) {
  const parts = stripCommentsAndQuoted(raw).split(';');
  const head = parts[0]?.trim() ?? '';
  let authservId = null;
  let first = 0;
  if (head !== '' && !METHOD_START.test(head)) {
    // authserv-id, optionally followed by a version number.
    authservId = head.split(/[ \t]+/)[0].toLowerCase();
    first = 1;
  }
  const results = [];
  for (let i = first; i < parts.length; i++) {
    const m = METHODSPEC.exec(parts[i].trim());
    if (m) results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase() });
  }
  return { authservId, results };
}

// dmarcResult returns the field's DMARC result, or undefined when it asserts
// none. A field carrying more than one dmarc methodspec is treated as
// unresolvable unless they agree.
function dmarcResult(field) {
  const results = field.results.filter((r) => r.method === 'dmarc').map((r) => r.result);
  if (results.length === 0) return undefined;
  return results.every((r) => r === results[0]) ? results[0] : 'ambiguous';
}

// stripCommentsAndQuoted removes RFC 5322 comments (which nest) and quoted
// strings, replacing each with a space so the surrounding tokens stay separate.
// An unterminated comment or quoted string swallows the rest of the field,
// which loses the verdict and so fails closed.
function stripCommentsAndQuoted(value) {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      // quoted-pair: the backslash and whatever it escapes are both text.
      i++;
      continue;
    }
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      out += ' ';
      continue;
    }
    if (ch === '(') {
      depth++;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}
