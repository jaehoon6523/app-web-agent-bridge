import test from "node:test";
import assert from "node:assert/strict";
import { createConversationBootstrapTab } from "../extension/runtime/conversation-bootstrap.js";

const root = { id:41, windowId:2, url:"https://chatgpt.com/" };
const other = { id:9, windowId:2, url:"https://chatgpt.com/c/other" };

function browser({ initial = [other], afterCreate = [], queryTabs, windowCount = 1 } = {}) {
  const calls = [];
  let visible = initial;
  const tabs = {
    query:async () => queryTabs ?? visible,
    create:async options => { calls.push(options); const tab = { ...root, windowId:options.windowId }; visible = [...visible, tab, ...afterCreate]; return tab; },
  };
  const windows = { getAll:async () => Array.from({ length:windowCount }, (_, i) =>
    ({ id:2 + i, type:"normal", incognito:false, tabs:visible.filter(tab => tab.windowId === 2 + i) })) };
  return { chrome:{ tabs, windows }, calls };
}

test("opens the approved start tab in the verified existing window", async () => {
  const { chrome, calls } = browser();
  const tab = await createConversationBootstrapTab(chrome, async (id) => {
    assert.equal(id, 41);
  });
  assert.deepEqual(calls, [{ url: "https://chatgpt.com/", active: true, windowId:2 }]);
  assert.equal(tab.id, 41);
});

test("reuses a single root and refuses to create when the tab inventory changes or scope is unclear", async () => {
  const existing = browser({ initial:[other, root] });
  assert.equal(await createConversationBootstrapTab(existing.chrome, async () => {}), root);
  assert.deepEqual(existing.calls, []);
  for (const options of [{ windowCount:0 }, { queryTabs:[other, root] }, { queryTabs:[] }]) {
    const { chrome, calls } = browser(options);
    await assert.rejects(createConversationBootstrapTab(chrome, async () => {}), { code:options.windowCount === 0 ? "BROWSER_SCOPE_UNCONFIRMED" : "WEB_TAB_INVENTORY_CHANGED" });
    assert.deepEqual(calls, []);
  }
});

test("two regular windows reuse a unique root or require explicit selection before creating", async () => {
  const second = { ...other, id:10, windowId:3 };
  const existing = browser({ initial:[other, second, root], windowCount:2 });
  assert.deepEqual(await createConversationBootstrapTab(existing.chrome, async () => {}), root);
  assert.deepEqual(existing.calls, []);
  const missing = browser({ initial:[other, second], windowCount:2 });
  await assert.rejects(createConversationBootstrapTab(missing.chrome, async () => {}), { code:"ROOT_WINDOW_SELECTION_REQUIRED" });
  assert.deepEqual(missing.calls, []);
  assert.equal((await createConversationBootstrapTab(missing.chrome, async () => {}, undefined, 3)).windowId, 3);
  const ambiguous = browser({ initial:[other, root, { ...root, id:42, windowId:3 }], windowCount:2 });
  await assert.rejects(createConversationBootstrapTab(ambiguous.chrome, async () => {}), { code:"AMBIGUOUS" });
  assert.deepEqual(ambiguous.calls, []);
  missing.chrome.tabs.query = async () => { throw new Error("unavailable"); };
  await assert.rejects(createConversationBootstrapTab(missing.chrome, async () => {}), { code:"ROOT_TAB_QUERY_FAILED" });
});

test("duplicate start tabs block creation or prevent returning the created tab for binding", async () => {
  const duplicate = { ...root, id:42 };
  const before = browser({ initial:[other, root, duplicate] });
  await assert.rejects(createConversationBootstrapTab(before.chrome, async () => {}), { code:"AMBIGUOUS" });
  assert.deepEqual(before.calls, []);
  const after = browser({ afterCreate:[duplicate] });
  await assert.rejects(createConversationBootstrapTab(after.chrome, async () => {}), { code:"AMBIGUOUS" });
  assert.equal(after.calls.length, 1);
});
