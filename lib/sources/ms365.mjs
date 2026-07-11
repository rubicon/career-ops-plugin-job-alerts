// Microsoft 365 MailSource adapter. Stub: the Microsoft Graph implementation
// (token refresh + message listing via ctx.fetchJson, optional archive) lands in
// its own issue. This stub declares the env keys the real adapter needs and
// constructs a MailSource whose network methods throw until that issue is
// implemented.
//
// When implemented, egress must go only through ctx.fetch / ctx.fetchJson /
// ctx.fetchText. Do not import node:http/net or call global fetch. Microsoft 365
// uses an Azure AD public client with a delegated refresh token, so there is no
// client secret.
//
// The Graph token-refresh and message-listing shape is informed by
// Schlaflied/career-ops-plugin-outlook-interviews (MIT).

export const requiredEnv = ['MSGRAPH_CLIENT_ID', 'MSGRAPH_REFRESH_TOKEN'];

const notImplemented = () => {
  throw new Error('ms365 adapter is not implemented yet; it lands in its own issue.');
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
