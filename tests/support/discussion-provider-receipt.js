import { bindDiscussionProviderReceipt } from "../../src/orchestration/discussion-session-binding.js";

export function providerReceiptForSession(
  store,
  sessionId,
  externalTurnId,
  providerFields = {},
) {
  const session = store.getAgentSession(sessionId);
  if (session === null) throw new Error(`Test Agent session ${sessionId} does not exist.`);
  return bindDiscussionProviderReceipt({ ...providerFields, externalTurnId }, session);
}
