import test from "node:test";
import assert from "node:assert/strict";
import { createConversationBootstrapTab } from "../extension/runtime/conversation-bootstrap.js";

test("opens and uses the newly activated ChatGPT start tab", async () => {
  const calls = [];
  const tabs = {
    create: async (options) => { calls.push(options); return { id: 41 }; },
    get: async (id) => ({ id, windowId: 2, url: "https://chatgpt.com/" }),
  };
  const tab = await createConversationBootstrapTab({ tabs }, async (id) => {
    assert.equal(id, 41);
  });
  assert.deepEqual(calls, [{ url: "https://chatgpt.com/", active: true }]);
  assert.equal(tab.id, 41);
});
