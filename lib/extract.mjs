// Role extraction from an authenticated message. Pure and deterministic: this is
// the regex baseline that pulls candidate posting links from the body and pairs
// each with a title and company derived from the subject line. The optional LLM
// enrichment path is I/O (lib/extract-llm.mjs) and is orchestrated by the ingest
// hook, not here.
//
// The "{Role} at {Company}" pattern (with alert-prefix stripping and " - "/" | "
// truncation) is ported from the bundled career-ops gmail plugin's
// _helpers.mjs parseRoleAtCompany (MIT). The remaining three subject forms are
// ported from Schlaflied/career-ops-plugin-linkedin-alerts's parseSubject
// @ de54949 (MIT).

const URL_RE = /https?:\/\/[^\s"'<>()\]]+/gi;

const ALERT_PREFIX_RE =
  /^(re|fwd|new match|job alert|alert|match|notification|alert for|daily alert for):\s*/i;

// parseRoleAtCompany matches "{Role} at {Company}", after stripping a known
// alert-email prefix and truncating at a trailing " - "/" | " segment.
function parseRoleAtCompany(subject) {
  let clean = subject.replace(ALERT_PREFIX_RE, '').trim();
  clean = clean.split(/\s+[-|]\s+/)[0].trim();
  const match = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (!match) return null;
  const title = match[1].trim();
  const company = match[2].trim();
  if (!title || !company || title.length >= 100 || company.length >= 100) return null;
  return { title, company };
}

// parseLinkedinStyle matches the three subject forms linkedin-alerts recognizes:
// "{Company} is hiring a {Role}", "new jobs for you: {Role}, ...", and
// "N new {Role} jobs".
function parseLinkedinStyle(subject) {
  let m = subject.match(/^(.+?) is hiring (?:a |an )?(.+)$/i);
  if (m) return { company: m[1].trim(), title: m[2].trim() };

  m = subject.match(/new (?:\w+ )?jobs? for you:?\s*(.+)$/i);
  if (m) return { company: '', title: m[1].trim().split(',')[0].trim() };

  m = subject.match(/^\d+ new (.+?) jobs?/i);
  if (m) return { company: '', title: m[1].trim() };

  return null;
}

// parseSubjectFields tries each pattern in order, falling back to the raw
// subject as the title with no company when nothing matches.
function parseSubjectFields(subject) {
  const s = String(subject ?? '').trim();
  if (s === '') return { title: '', company: '' };
  return parseRoleAtCompany(s) ?? parseLinkedinStyle(s) ?? { title: s, company: '' };
}

// extractLeads returns one raw lead per link found in the message body, all
// sharing the same subject-derived title and company.
export function extractLeads(message) {
  const body = String(message?.body ?? '');
  const subject = String(message?.subject ?? '').trim();
  const { title, company } = parseSubjectFields(subject);
  const urls = body.match(URL_RE) ?? [];
  return urls.map((url) => ({ title, url, company, location: '' }));
}
