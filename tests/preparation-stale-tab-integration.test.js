import * as documentBinding from "../extension/runtime/document-binding.js";
import * as conversation from "../extension/runtime/conversation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createExtensionStateStore } from "../extension/runtime/storage.js";
import { createStoredTarget } from "../extension/runtime/current-target.js";

test("a saved exact conversation is reopened when its tab is missing", async () => {
  let stored = {};
  const store = createExtensionStateStore({
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  });
  const requested = { sessionId: "web_run_judge", runId: "run_1",
    conversationUrl: "https://chatgpt.com/c/judge", conversationId: "judge" };
  const tab = { id: 31, windowId: 1, url: requested.conversationUrl };
  let reopenCount = 0;
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...documentBinding, ...conversation, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => [], sendMessage: async () => ({ ready: true }) } },
    reopenExactConversationTab: async (_chrome, _wait, binding) => {
      reopenCount++;
      assert.equal(binding.conversationId, "judge");
      return tab;
    },
    waitForContentScript: async () => {},
    inspectBoundDocument: async () => ({ documentId: "document-31", frameId: 0 }),
    focusTab: async () => {},
    getSessionInfo: async () => ({ ...requested, tabId: 31, bindingStatus: "BOUND" }),
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function requireExactBoundTab(")), context);
  const session = await context.prepareBoundSession(requested);
  assert.equal(reopenCount, 1);
  assert.equal(session.tabId, 31);
  assert.equal((await store.read()).conversationId, "judge");
});

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
    ...documentBinding, ...conversation, createStoredTarget, console, store,
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
    ...documentBinding, ...conversation, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => [], sendMessage: async () => null } },
    createConversationBootstrapTab: async () => null,
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
  }), (error) => error.code === "ROOT_TAB_CREATE_FAILED"
    && error.details?.flow === "ROOT_BOOTSTRAP_V2"
    && error.details?.stage === "CREATE"
    && error.details?.rootCount === 0);

  assert.deepEqual(await store.read(), before);
});

test("preparation opens a ChatGPT root tab when none exists", async () => {
  let stored = {};
  const store = createExtensionStateStore({
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  });
  const root = { id: 19, windowId: 1, url: "https://chatgpt.com/" };
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  let created = 0;
  const context = vm.createContext({
    ...documentBinding, ...conversation, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => [], sendMessage: async () => ({ ok: true, ready: true,
      busy: false, generating: false, url: root.url, conversationId: null, documentId: "doc-19", frameId: 0 }) } },
    createConversationBootstrapTab: async () => { created++; return root; },
    waitForContentScript: async () => {}, focusTab: async () => {},
    getSessionInfo: async () => { throw new Error("not used"); },
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function rebindSession(")), context);
  const session = await context.prepareBoundSession({ sessionId: "web_prep_1", runId: "prep_1",
    conversationUrl: null, conversationId: null });
  assert.equal(created, 1);
  assert.equal(session.bindingStatus, "ROOT_READY");
  assert.equal((await store.read()).tabId, 19);
});
