// Gmail MailSource adapter. Stub: the OAuth-REST implementation (list job-alert
// messages via ctx.fetchJson, optional archive) lands in its own issue. This
// stub declares the env keys the real adapter needs and constructs a MailSource
// whose network methods throw until that issue is implemented.
//
// When implemented, egress must go only through ctx.fetch / ctx.fetchJson /
// ctx.fetchText. Do not import node:http/net or call global fetch.
//
// The Gmail OAuth-REST approach is informed by
// Schlaflied/career-ops-plugin-linkedin-alerts (MIT).

export const requiredEnv = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

const notImplemented = () => {
  throw new Error('gmail adapter is not implemented yet; it lands in its own issue.');
};

export function create(_ctx) {
  return {
    async listMessages(_sinceDays) {
      return notImplemented();
    },
    async archive(_id) {
      return notImplemented();
    },
  };
}
