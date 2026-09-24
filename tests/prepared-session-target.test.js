import test from "node:test";
import assert from "node:assert/strict";
import { resolvePreparedSessionTarget } from "../extension/runtime/current-target.js";

test("controller delivery stays on the prepared reviewer tab when another ChatGPT tab is active", async () => {
  const state = { bindingStatus: "BOUND", tabId: 12, conversationUrl: "https://chatgpt.com/c/judge", conversationId: "judge" };
  const tabs = {
    get: async (id) => ({ id, windowId: 1, url: state.conversationUrl }),
    sendMessage: async () => ({ ok: true, ready: true, busy: false, generating: false,
      url: state.conversationUrl, conversationId: "judge", documentId: "document-12", frameId: 0 }),
    query: async () => { throw new Error("active tab must not be consulted"); },
  };
  const target = await resolvePreparedSessionTarget({ tabs, state, waitForContentScript: async () => {} });
  assert.equal(target.tabId, 12);
  tabs.sendMessage = async () => ({ ok: true, ready: true, busy: false, generating: false,
    url: "https://chatgpt.com/c/critic", conversationId: "critic", documentId: "document-12", frameId: 0 });
  await assert.rejects(resolvePreparedSessionTarget({ tabs, state, waitForContentScript: async () => {} }), { code: "NEEDS_REBIND" });
});
