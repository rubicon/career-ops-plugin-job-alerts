// The shared identity corpus: does THIS url belong to THIS employer?
//
// One table, consumed by resolve-network.test.mjs. Every row is a real shape the
// resolver can meet, and every row records BOTH what the resolver should do and
// what it does today, because those disagree on seven of them.
//
// Why a table rather than cases written inline: the wrong-employer defect has
// been fixed twice, in two directions, with two different rules (#23 for
// employer-hosted domains, #30 for board tenants). Each fix was checked against
// the input that prompted it. A shared table is what makes the NEXT fix provable
// against the whole family instead of against its own example.
//
// `verdict` is what the resolver SHOULD do.
//   'accept' - emit the board/domain url as canonical.
//   'reject' - emit the search fallback; the url belongs to someone else, or
//              cannot be shown to belong to this employer.
//
// `knownWrong` names the issue where the disagreement is tracked, and is set on
// every row whose live behaviour contradicts `verdict`. It is not a waiver: the
// test asserts LIVE behaviour on those rows, so if the gate changes at all the
// row fails and has to be revisited deliberately. Removing a knownWrong marker
// is how a fix proves which cases it actually closed.
//
// A wrong canonical url is worse than none. A wrong one looks correct in the
// tracker; a search fallback is visibly a search.

export const IDENTITY_CORPUS = [
  // ---- accepts: these must keep working, or a tightening has gone too far ----
  {
    name: 'the company abbreviated, on its own board',
    company: 'Acme Technologies',
    slug: 'acmetech',
    boardUrl: 'https://jobs.lever.co/acmetech/a1b2c3d4',
    verdict: 'accept',
    why: 'A leading abbreviation of the whole name is how companies actually name boards.',
  },

  // ---- rejects: a different employer, reached through the company name --------
  {
    name: 'a trailing word of the company name is another employer',
    company: 'Northstar Health Systems',
    slug: 'systems',
    boardUrl: 'https://boards.greenhouse.io/systems/jobs/4001',
    verdict: 'reject',
    knownWrong: 29,
    why: '"northstarhealthsystems".includes("systems"). A common noun is not an identity.',
  },
  {
    name: 'a trailing word of a two-word name is another employer',
    company: 'Nimbus Data',
    slug: 'data',
    boardUrl: 'https://boards.greenhouse.io/data/jobs/9001',
    verdict: 'reject',
    knownWrong: 29,
    why: '"nimbusdata".includes("data").',
  },
  {
    name: 'a trailing word of a well-known name is another employer',
    company: 'Meta Platforms',
    slug: 'platforms',
    boardUrl: 'https://jobs.lever.co/platforms/abc-123',
    verdict: 'reject',
    knownWrong: 29,
    why: '"metaplatforms".includes("platforms").',
  },
  {
    name: 'a substring straddling two words is not even a word',
    company: 'Northstar Health Systems',
    slug: 'starhealth',
    boardUrl: 'https://boards.greenhouse.io/starhealth/jobs/7001',
    verdict: 'reject',
    knownWrong: 29,
    why: '"northstarhealthsystems".includes("starhealth") across the north|star|health seam.',
  },
  {
    name: 'the bare first word is a different, shorter company',
    company: 'Nimbus Data',
    slug: 'nimbus',
    boardUrl: 'https://boards.greenhouse.io/nimbus/jobs/1201',
    verdict: 'reject',
    knownWrong: 29,
    why: 'The prefix ends at a word boundary, so it names a different company.',
  },
  {
    name: 'the company name is a prefix of a longer, unrelated employer',
    company: 'Nova Credit',
    slug: 'novacreditunion',
    boardUrl: 'https://jobs.lever.co/novacreditunion/xyz789',
    verdict: 'reject',
    knownWrong: 29,
    why: 'Direction B. A credit union is not the fintech, and the string cannot tell them apart alone.',
  },
  {
    name: 'a mid-name word is a Workday tenant for someone else',
    company: 'Northstar Health Systems',
    slug: 'health',
    boardUrl:
      'https://health.wd5.myworkdayjobs.com/en-US/Careers/job/Dallas-TX/VP-Marketing_JR-10423',
    verdict: 'reject',
    knownWrong: 29,
    why: 'Workday and iCIMS get NO Tier-1 probe, so gate 2 is their only identity test and it is the loosest one.',
  },
  {
    name: 'vendor furniture strips down to a different company',
    company: 'Nimbus Data',
    slug: 'careers-nimbus',
    boardUrl: 'https://careers-nimbus.icims.com/jobs/44120/vp-marketing/job',
    verdict: 'reject',
    knownWrong: 29,
    why: 'The strip is correct; what it leaves behind is a prefix ending at a word boundary.',
  },
  {
    name: 'a lookalike that shares no relation at all',
    company: 'Acme Technologies',
    slug: 'globex',
    boardUrl: 'https://jobs.lever.co/globex/9f2a1b',
    verdict: 'reject',
    why: 'The control. Nothing ties this board to the company, and nothing should.',
  },
];

/** Rows whose live behaviour still contradicts `verdict`. */
export const KNOWN_WRONG = IDENTITY_CORPUS.filter((r) => r.knownWrong);

/** What the resolver does TODAY for a row: the verdict, unless it is known wrong. */
export function liveVerdict(row) {
  if (!row.knownWrong) return row.verdict;
  return row.verdict === 'reject' ? 'accept' : 'reject';
}
