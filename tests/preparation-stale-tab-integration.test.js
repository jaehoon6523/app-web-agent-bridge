import * as documentBinding from "../extension/runtime/document-binding.js";
import * as conversation from "../extension/runtime/conversation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createExtensionStateStore } from "../extension/runtime/storage.js";
import { createStoredTarget } from "../extension/runtime/current-target.js";
import { conversationTabCandidates } from "../extension/runtime/conversation-bootstrap.js";

test("exact binding reuses one candidate and blocks missing, duplicate, and late duplicate tabs", async () => {
  let stored = {};
  const store = createExtensionStateStore({
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  });
  const requested = { sessionId: "web_run_judge", runId: "run_1",
    conversationUrl: "https://chatgpt.com/c/judge", conversationId: "judge" };
  const tab = { id: 31, windowId: 1, url: requested.conversationUrl };
  let reopenCount = 0, candidates = [];
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...documentBinding, ...conversation, conversationTabCandidates, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => candidates, sendMessage: async () => ({ ready: true }) } },
    reopenExactConversationTab: async (_chrome, _wait, binding) => {
      reopenCount++;
      assert.equal(binding.conversationId, "judge");
      return tab;
    },
    waitForContentScript: async () => ({ documentId: "document-31", frameId: 0 }),
    persistBoundTab: async () => {},
    inspectBoundDocument: async () => ({ documentId: "document-31", frameId: 0 }),
    focusTab: async () => {},
    getSessionInfo: async () => ({ ...requested, tabId: 31, bindingStatus: "BOUND" }),
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function requireExactBoundTab(")), context);
  await assert.rejects(context.prepareBoundSession(requested), { code:"BROWSER_SCOPE_UNCONFIRMED" });
  candidates = [tab];
  const session = await context.prepareBoundSession(requested);
  assert.equal(session.tabId, 31);
  const duplicate = { id:32, windowId:2, pendingUrl:requested.conversationUrl + "?source=manual" };
  candidates.push(duplicate);
  await assert.rejects(context.prepareBoundSession(requested), { code:"AMBIGUOUS" });
  candidates = [tab];
  context.waitForContentScript = async () => { candidates.push(duplicate); return { documentId:"document-31" }; };
  await assert.rejects(context.prepareBoundSession(requested), { code:"AMBIGUOUS" });
  assert.equal(reopenCount, 0);
});

test("a new root preparation cannot displace another session's unresolved delivery", async () => {
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

  await assert.rejects(context.prepareBoundSession({
    sessionId: "web_prep_new", runId: "prep_new",
    conversationUrl: null, conversationId: null, focus: true,
  }), { code:"WEB_SESSION_BUSY" });
  const active = await store.read();
  assert.equal(active.lastBoundSessionId, "manual_session_1788583228656");
  assert.equal(active.currentDeliveryId, "turn_1788583228992");
  assert.equal(active.tabId, 7);
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
  }), { code:"WEB_SESSION_BUSY" });

  assert.deepEqual(await store.read(), before);
});

test("preparation requires an explicit creation request when no root is visible", async () => {
  let stored = {};
  const store = createExtensionStateStore({
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  });
  const root = { id: 19, windowId: 1, url: "https://chatgpt.com/" };
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  let created = 0, tabs = [];
  const context = vm.createContext({
    ...documentBinding, ...conversation, conversationTabCandidates, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => tabs, sendMessage: async () => ({ ok: true, ready: true,
      busy: false, generating: false, url: root.url, conversationId: null, documentId: "doc-19", frameId: 0 }) } },
    createConversationBootstrapTab: async () => { created++; tabs = [root]; return root; },
    inspectBoundDocument: async () => ({ documentId:"doc-19", frameId:0 }),
    waitForContentScript: async () => ({ ok: true, ready: true, busy: false, generating: false,
      url: root.url, conversationId: null, documentId: "doc-19", frameId: 0 }), focusTab: async () => {},
    getSessionInfo: async () => { throw new Error("not used"); },
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function rebindSession(")), context);
  const request = { sessionId:"web_prep_1", runId:"prep_1", conversationUrl:null, conversationId:null };
  await assert.rejects(context.prepareBoundSession(request), { code:"ROOT_TAB_NOT_FOUND" });
  assert.equal(created, 0);
  const session = await context.prepareBoundSession({ ...request, createNewConversation:true });
  assert.equal(created, 1);
  assert.equal(session.bindingStatus, "ROOT_READY");
  assert.equal((await store.read()).tabId, 19);
});

test("explicit rebind can select one ChatGPT start tab when several roots are open", async () => {
  let stored = {};
  const store = createExtensionStateStore({
    get: async () => structuredClone(stored),
    set: async (value) => { stored = structuredClone(value); },
  });
  const selected = { id:22, windowId:4, url:"https://chatgpt.com/", title:"Selected new chat" };
  const page = { ok:true, ready:true, busy:false, generating:false, url:selected.url,
    conversationId:null, documentId:"document-22", frameId:0 };
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...documentBinding, ...conversation, createStoredTarget, console, store,
    CHATGPT_URL_PATTERNS:["https://chatgpt.com/*"],
    chrome:{ tabs:{
      get:async (id) => { assert.equal(id, 22); return selected; },
      sendMessage:async () => page,
    } },
    waitForContentScript:async () => page,
    inspectBoundDocument:async () => ({ documentId:"document-22", frameId:0 }),
    focusTab:async () => {},
    getSessionInfo:async () => { throw new Error("root rebind returns directly"); },
    ExtensionOperationError:class extends Error {
      constructor(code, message, details) { super(message); this.code=code; this.details=details; }
    },
  });
  vm.runInContext(
    source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function requireExactBoundTab(")),
    context,
  );
  const rebound = await context.rebindSession({
    sessionId:"web_prep_root", runId:"prep_root",
    conversationUrl:null, conversationId:null, tabId:22, focus:true,
  });
  assert.equal(rebound.bindingStatus, "ROOT_READY");
  assert.equal(rebound.tabId, 22);
  const state = await store.read();
  assert.equal(state.bindingStatus, "ROOT_READY");
  assert.equal(state.tabId, 22);
  assert.equal(state.conversationUrl, "https://chatgpt.com/");
  assert.equal(state.conversationId, null);
});
