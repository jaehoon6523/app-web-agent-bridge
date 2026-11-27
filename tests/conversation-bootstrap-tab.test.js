import test from "node:test";
import assert from "node:assert/strict";
import { createConversationBootstrapTab } from "../extension/runtime/conversation-bootstrap.js";
import { createBrowserRuntime } from "../extension/runtime/browser-runtime.js";

const root = { id:41, windowId:2, url:"https://chatgpt.com/" };
const other = { id:9, windowId:2, url:"https://chatgpt.com/c/other" };

function browser({ initial = [other], afterCreate = [], queryTabs, windowCount = 1 } = {}) {
  const calls = [];
  let visible = initial;
  const tabs = {
    query:async () => queryTabs ?? visible,
    create:async options => { calls.push(options); visible = [...visible, root, ...afterCreate]; return root; },
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

test("startup navigation during readiness rechecks the new document on the same tab", async () => {
  const { chrome, calls } = browser();
  let onUpdated, pings = 0;
  chrome.tabs.onUpdated = { addListener(listener) { onUpdated = listener; } };
  chrome.tabs.get = async () => ({ ...root, status:"complete" });
  chrome.tabs.sendMessage = async (id, message) => {
    assert.equal(id, root.id);
    assert.equal(message.type, "agent.ping");
    if (++pings <= 2) {
      onUpdated(id, { status:"loading" });
      onUpdated(id, { url:root.url });
    }
    return { ok:true, ready:true, documentId:`document-${pings}`, frameId:0 };
  };
  const runtime = createBrowserRuntime(chrome);
  assert.equal((await createConversationBootstrapTab(chrome, runtime.waitForContentScript)).id, root.id);
  assert.equal(pings, 3);
  assert.equal(calls.length, 1);
});

test("a new start tab waits through loading and URL events before its first content ping", async () => {
  const { chrome, calls } = browser();
  let update, reads = 0, pings = 0;
  chrome.tabs.onUpdated = { addListener(listener) { update = listener; } };
  chrome.tabs.get = async () => {
    if (++reads === 1) {
      update(root.id, {status:"loading"});
      update(root.id, {url:root.url});
      return { ...root, url:"about:blank", pendingUrl:root.url, status:"loading" };
    }
    if (reads === 2) {
      update(root.id, {status:"loading"});
      return { ...root, status:"loading" };
    }
    return { ...root, status:"complete" };
  };
  chrome.tabs.sendMessage = async (id) => {
    assert.equal(id, root.id);
    assert.ok(reads >= 3);
    pings++;
    return {ok:true, ready:true, documentId:"first-committed", frameId:0};
  };
  const runtime = createBrowserRuntime(chrome);
  assert.equal((await createConversationBootstrapTab(chrome, runtime.waitForContentScript)).id, root.id);
  assert.equal(pings, 1);
  assert.equal(calls.length, 1);
});

test("startup recheck refuses a navigated or replaced tab and retries only once", async () => {
  const changed = () => Object.assign(new Error("document changed"), { code:"WEB_DOCUMENT_CHANGED" });
  for (const replacement of [{ ...root, id:42 }, { ...root, url:other.url }, root]) {
    const { chrome, calls } = browser();
    let waits = 0;
    chrome.tabs.query = async () => waits ? [other, replacement] : [other];
    chrome.windows.getAll = async () => [{ id:2, type:"normal", incognito:false, tabs:await chrome.tabs.query() }];
    await assert.rejects(createConversationBootstrapTab(chrome, async () => { waits++; throw changed(); }), {
      code:replacement === root ? "WEB_DOCUMENT_CHANGED" : "WEB_TAB_INVENTORY_CHANGED",
    });
    assert.equal(waits, replacement === root ? 2 : 1);
    assert.equal(calls.length, 1);
  }
});

test("reuses a single root and refuses to create when the tab inventory changes or scope is unclear", async () => {
  const existing = browser({ initial:[other, root] });
  assert.equal(await createConversationBootstrapTab(existing.chrome, async () => {}), root);
  assert.deepEqual(existing.calls, []);
  for (const [options, code] of [[{ windowCount:0 }, "BROWSER_SCOPE_UNCONFIRMED"],
    [{ windowCount:2 }, "ROOT_WINDOW_SELECTION_REQUIRED"], [{ queryTabs:[other, root] }, "WEB_TAB_INVENTORY_CHANGED"],
    [{ queryTabs:[] }, "WEB_TAB_INVENTORY_CHANGED"]]) {
    const { chrome, calls } = browser(options);
    await assert.rejects(createConversationBootstrapTab(chrome, async () => {}), { code });
    assert.deepEqual(calls, []);
  }
  const multiWindow = browser({ initial:[other, { ...root, windowId:3 }], windowCount:2 });
  assert.equal((await createConversationBootstrapTab(multiWindow.chrome, async () => {})).windowId, 3);
  assert.deepEqual(multiWindow.calls, []);
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
