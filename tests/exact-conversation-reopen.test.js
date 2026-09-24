import test from "node:test";
import assert from "node:assert/strict";
import { reopenExactConversationTab } from "../extension/runtime/conversation-bootstrap.js";

test("reopens a saved conversation only after its exact URL is observed", async () => {
  const requested = { conversationUrl: "https://chatgpt.com/c/known", conversationId: "known" };
  const created = [];
  const chrome = { tabs: {
    create: async (options) => { created.push(options); return { id: 12 }; },
    get: async () => ({ id: 12, url: "https://chatgpt.com/c/known" }),
  } };
  const tab = await reopenExactConversationTab(chrome, async () => {}, requested);
  assert.equal(tab.id, 12);
  assert.deepEqual(created, [{ url: requested.conversationUrl, active: true }]);
  chrome.tabs.get = async () => ({ id: 12, url: "https://chatgpt.com/c/other" });
  assert.equal(await reopenExactConversationTab(chrome, async () => {}, requested), null);
});
