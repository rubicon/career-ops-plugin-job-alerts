// In-memory MailSource fake for hermetic tests. Implements the MailSource
// contract (listMessages, archive) with no network and no files. It records the
// last sinceDays it was asked for and the ids it archived so tests can assert the
// wiring.
export function createFakeSource(messages = []) {
  return {
    lastSinceDays: undefined,
    archived: [],
    async listMessages(sinceDays) {
      this.lastSinceDays = sinceDays;
      return messages;
    },
    async archive(id) {
      this.archived.push(id);
    },
  };
}
