// Lead field normalization. Pure and deterministic: trims whitespace and coerces
// each field to a string so downstream stages operate on a stable shape. No
// network. Wrapped-tracking-link decoding is a separate concern and lands in its
// own issue.

const str = (value) => String(value ?? '').trim();

// normalizeLead returns a lead with title, url, company, and location as trimmed
// strings.
export function normalizeLead(lead) {
  return {
    title: str(lead?.title),
    url: str(lead?.url),
    company: str(lead?.company),
    location: str(lead?.location),
  };
}
