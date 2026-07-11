// Role extraction from an authenticated message. Pure and deterministic: this is
// the regex fallback path that pulls candidate posting links from the body and
// pairs each with the subject as a provisional title. The primary LLM extraction
// path is I/O (via ctx.fetch) and is orchestrated by the ingest hook, not here.
// Richer parsing (company, location, marketing-leadership filtering) lands in its
// own issue.

const URL_RE = /https?:\/\/[^\s"'<>()\]]+/gi;

// extractLeads returns one raw lead per link found in the message body.
export function extractLeads(message) {
  const body = String(message?.body ?? '');
  const title = String(message?.subject ?? '').trim();
  const urls = body.match(URL_RE) ?? [];
  return urls.map((url) => ({ title, url, company: '', location: '' }));
}
