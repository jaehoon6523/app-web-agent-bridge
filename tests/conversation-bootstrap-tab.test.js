import test from "node:test";
import assert from "node:assert/strict";
import { createConversationBootstrapTab } from "../extension/runtime/conversation-bootstrap.js";

test("opens and uses the newly activated ChatGPT start tab", async () => {
  const calls = [];
  let opened = false;
  const root = { id:41, windowId:2, url:"https://chatgpt.com/" };
  const tabs = {
    query: async () => opened ? [root] : [],
    create: async (options) => { calls.push(options); opened = true; return { id: 41 }; },
    get: async (id) => ({ id, windowId: 2, url: "https://chatgpt.com/" }),
  };
  const tab = await createConversationBootstrapTab({ tabs, windows:{ getAll:async () => [{id:2, type:"normal", incognito:false, tabs:opened ? [root] : []}] } }, async (id) => {
    assert.equal(id, 41);
  });
  assert.deepEqual(calls, [{ url: "https://chatgpt.com/", active: true, windowId: 2 }]);
  assert.equal(tab.id, 41);
});
