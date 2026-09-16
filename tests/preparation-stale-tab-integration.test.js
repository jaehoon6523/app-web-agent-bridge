import * as documentBinding from "../extension/runtime/document-binding.js";
import * as conversation from "../extension/runtime/conversation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createExtensionStateStore } from "../extension/runtime/storage.js";

test("a new root preparation parks another session's unresolved delivery instead of recovering or blocking on it", async () => {
  let stored = {
    currentDeliveryId: "turn_1788583228992",
    lastBoundRunId: "manual_run_1788583228656",
    lastBoundSessionId: "manual_session_1788583228656",
    tabId: 7, windowId: 1, documentId: "document-old", frameId: 0,
    conversationUrl: "https://chatgpt.com/c/old", conversationId: "old",
    bindingStatus: "BOUND",
  };
  const storage = {
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  };
  const store = createExtensionStateStore(storage);
  const rootTab = { id: 8, windowId: 1, url: "https://chatgpt.com/", title: "New chat" };
  const rootPage = {
    ok: true, ready: true, busy: false, generating: false,
    url: "https://chatgpt.com/", conversationId: null,
    documentId: "document-root", frameId: 0,
  };
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...documentBinding, ...conversation, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: {
      query: async () => [rootTab],
      sendMessage: async (tabId) => tabId === rootTab.id ? rootPage : null,
    } },
    waitForContentScript: async () => rootPage,
    focusTab: async () => {},
    getSessionInfo: async () => { throw new Error("not used for root bootstrap"); },
    deliveryDetails: async () => { throw new Error("another session must not be inspected or recovered"); },
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(
    source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function rebindSession(")),
    context,
  );

  const session = await context.prepareBoundSession({
    sessionId: "web_prep_new", runId: "prep_new",
    conversationUrl: null, conversationId: null, focus: true,
  });

  assert.equal(session.sessionId, "web_prep_new");
  assert.equal(session.bindingStatus, "ROOT_READY");
  const active = await store.read();
  assert.equal(active.lastBoundSessionId, "web_prep_new");
  assert.equal(active.currentDeliveryId, null);
  assert.equal(active.tabId, 8);
  assert.equal(active.documentId, "document-root");
  assert.equal(
    active.deliveryScopes.manual_session_1788583228656.currentDeliveryId,
    "turn_1788583228992",
  );
});

test("a failed new root binding leaves the existing session and delivery untouched", async () => {
  let stored = {
    currentDeliveryId: "delivery-old",
    lastBoundRunId: "run-old",
    lastBoundSessionId: "session-old",
    tabId: 7, windowId: 1, documentId: "document-old", frameId: 0,
    conversationUrl: "https://chatgpt.com/c/old", conversationId: "old",
    bindingStatus: "BOUND",
  };
  const storage = {
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  };
  const store = createExtensionStateStore(storage);
  const before = await store.read();
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...documentBinding, ...conversation, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => [], sendMessage: async () => null } },
    waitForContentScript: async () => { throw new Error("must not wait without a root tab"); },
    focusTab: async () => {},
    getSessionInfo: async () => { throw new Error("not used"); },
    deliveryDetails: async () => { throw new Error("another session must not be inspected"); },
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(
    source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function rebindSession(")),
    context,
  );

  await assert.rejects(context.prepareBoundSession({
    sessionId: "session-new", runId: "run-new", conversationUrl: null, conversationId: null, focus: true,
  }), { code: "NEEDS_REBIND" });

  assert.deepEqual(await store.read(), before);
});
