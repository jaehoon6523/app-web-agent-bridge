import * as documentBinding from "../extension/runtime/document-binding.js";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as conversation from "../extension/runtime/conversation.js";
import * as guards from "../extension/runtime/turn-guard.js";
import { createControlledPrompt } from "../extension/runtime/markers.js";
import { recoverBootstrapAfterNavigation } from "../extension/runtime/bootstrap-recovery.js";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
test("content sends on root before resolving the created conversation", async () => {
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const location = { href: "https://chatgpt.com/" }, order = [];
  const context = vm.createContext({ ...documentBinding, location, currentJob: null, AbortController, DOMException,
    canonicalConversationUrl: conversation.canonicalChatGptUrl, conversationIdFromUrl: conversation.conversationIdFromUrl,
    assertExpectedDocument: payload => { assert.equal(payload.expectedDocumentId, "document-1"); assert.equal(payload.expectedFrameId, 0); },
    requireSelectorRegistry() {}, selectorTelemetry: new Map(), messageSnapshot: () => [],
    parseMarkers: () => ({ controllerMessageId: "d1", runId: "r1" }),
    assertExpectedConversation: url => assert.equal(url, location.href),
    inspectPageState: () => ({ status: "READY" }),
    ContentContractError: class extends Error {},
    submitPrompt: async () => { assert.equal(location.href, "https://chatgpt.com/"); order.push("sent"); location.href = "https://chatgpt.com/c/new"; },
    waitForControlledUserMessage: async expected => { assert.equal(expected.expectedConversationId, "new"); order.push("associated"); return { id: "u1" }; },
    waitForAssistantResponse: async ({ expected }) => { order.push("response"); return expected.expectedConversationUrl; },
  });
  vm.runInContext(content.slice(content.indexOf("async function executePrompt("), content.indexOf("function cancelCurrentJob(")), context);
  const result = await context.executePrompt("d1", { text: "request", controllerMessageId: "d1", runId: "r1", expectedConversationUrl: location.href, expectedConversationId: null, expectedDocumentId: "document-1", expectedFrameId: 0 });
  assert.equal(result, "https://chatgpt.com/c/new");
  assert.deepEqual(order, ["sent", "associated", "response"]);
});
test("content recognizes an unauthenticated conversation URL", () => {
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const context = vm.createContext({ URL, decodeURIComponent, CHATGPT_HOSTS: new Set(["chatgpt.com"]) });
  vm.runInContext(
    content.slice(content.indexOf("function canonicalConversationUrl("), content.indexOf("function inspectPageState(")),
    context,
  );
  assert.equal(
    context.conversationIdFromUrl("https://chatgpt.com/uc/6aa79817-cb80-83ea-98df-aab9c01d9751"),
    "6aa79817-cb80-83ea-98df-aab9c01d9751",
  );
});
test("content infers message roles from unauthenticated turn containers", () => {
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const context = vm.createContext({ String, messageContainer: node => node });
  vm.runInContext(
    content.slice(content.indexOf("function messageRole("), content.indexOf("function messageSnapshot(")),
    context,
  );
  const turn = (className, heading = "") => ({
    className,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => heading ? [{ getAttribute: () => null, textContent: heading }] : [],
    textContent: "",
  });
  assert.equal(context.messageRole(turn("group/user-turn")), "user");
  assert.equal(context.messageRole(turn("group/agent-turn")), "assistant");
  assert.equal(context.messageRole(turn("", "You said:")), "user");
  assert.equal(context.messageRole(turn("", "ChatGPT said:")), "assistant");
  assert.equal(context.messageRole(turn("", "Unrelated heading")), null);
});
test("new conversation document observes the submitted prompt without clicking send", async () => {
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  let submissions = 0;
  const expectedUrl = "https://chatgpt.com/uc/guest-created";
  const context = vm.createContext({ currentJob: null, AbortController,
    assertExpectedDocument: payload => assert.equal(payload.expectedDocumentId, "document-2"),
    requireSelectorRegistry() {}, canonicalConversationUrl: value => value,
    assertExpectedConversation: (url, id) => { assert.equal(url, expectedUrl); assert.equal(id, "guest-created"); },
    inspectPageState: () => ({ status: "READY" }), selectorTelemetry: new Map(),
    messageSnapshot: () => [{ id: "u1", role: "user" }],
    waitForControlledUserMessage: async () => ({ id: "u1", role: "user" }),
    waitForAssistantResponse: async () => ({ text: "reply" }),
    submitPrompt: async () => { submissions += 1; },
    ContentContractError: class extends Error {}, Number,
  });
  vm.runInContext(
    content.slice(content.indexOf("async function observeSubmittedPrompt("), content.indexOf("function cancelCurrentJob(")),
    context,
  );
  const result = await context.observeSubmittedPrompt("d1", {
    controllerMessageId: "d1", runId: "r1", expectedConversationUrl: expectedUrl,
    expectedConversationId: "guest-created", expectedDocumentId: "document-2", expectedFrameId: 0,
  });
  assert.equal(result.text, "reply");
  assert.equal(submissions, 0);
});
test("root prepare returns without navigation; first delivery sends once and persists created conversation", async () => {
  const state = { tabId: 99, bindingStatus: "AMBIGUOUS", currentDeliveryId: null };
  const tab = { id: 1, windowId: 2, url: "https://chatgpt.com/" };
  const sent = [], prompts = [];
  const context = vm.createContext({ ...documentBinding, ...conversation, ...guards, createControlledPrompt,
    recoverBootstrapAfterNavigation,
    console, Number, Date, setTimeout, clearTimeout, lastError: null,
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    turnGate: guards.createActiveTurnGate(), authenticated: false,
    broadcastPopupState() {}, waitForContentScript: async () => {}, focusTab: async () => {},
    send: m => sent.push(m), errorPayload: e => ({ code: e.code, message: e.message }),
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    store: { read: async () => ({ ...state }), update: async p => Object.assign(state, p),
      reserveDelivery: async id => { state.currentDeliveryId = id; return { ...state }; },
      clearDelivery: async () => { state.currentDeliveryId = null; } },
    chrome: { tabs: { query: async () => [tab], get: async () => ({ ...tab }), sendMessage: async (_id, m) => {
      if (m.type === "agent.ping") return { ok: true, ready: true, url: tab.url, conversationId: conversation.conversationIdFromUrl(tab.url), documentId: "document-1", frameId: 0 };
      prompts.push(m);
      assert.equal(tab.url, "https://chatgpt.com/");
      tab.url = "https://chatgpt.com/c/created";
      return { ok: true, text: "reply", confidence: "CONFIRMED_BY_UI_STATE",
        evidence: { documentId: "document-1", frameId: 0, conversationUrl: tab.url, conversationId: "created", userMessageId: "u1", assistantMessageId: "a1" } };
    } } },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function focusTab(")), context);
  const ready = await context.prepareBoundSession({ sessionId: "s1", runId: "r1", conversationUrl: null, conversationId: null });
  assert.equal(ready.bindingStatus, "ROOT_READY");
  assert.equal(prompts.length, 0);
  await context.handlePrompt({ requestId: "d1", payload: { runId: "r1", controllerMessageId: "d1", text: "request" } });
  assert.equal(prompts.length, 1);
  assert.equal(sent[0]?.type, "web.prompt.result", JSON.stringify(sent));
  assert.equal(state.conversationId, "created");
  assert.equal(state.completedDelivery.turnId, "d1");
  assert.equal(state.currentDeliveryId, "d1");
});

test("root delivery reattaches after navigation closes the original message channel without resending", async () => {
  const state = {
    lastBoundSessionId: "s1", lastBoundRunId: "r1", currentDeliveryId: null,
    tabId: 1, windowId: 2, documentId: "document-1", frameId: 0,
    conversationUrl: "https://chatgpt.com/", conversationId: null, bindingStatus: "ROOT_READY",
  };
  const tab = { id: 1, windowId: 2, url: "https://chatgpt.com/", title: "ChatGPT" };
  const sent = [], prompts = [], observations = [];
  const page = () => ({
    ok: true, ready: true, url: tab.url,
    conversationId: conversation.conversationIdFromUrl(tab.url),
    documentId: tab.url === "https://chatgpt.com/" ? "document-1" : "document-2",
    frameId: 0,
  });
  const context = vm.createContext({ ...documentBinding, ...conversation, ...guards, createControlledPrompt,
    recoverBootstrapAfterNavigation,
    console, Number, Date, setTimeout, clearTimeout, lastError: null, sleep: async () => {},
    turnGate: guards.createActiveTurnGate(), authenticated: false,
    broadcastPopupState() {}, focusTab: async () => {}, waitForContentScript: async () => page(),
    send: message => sent.push(message), errorPayload: error => ({ code: error.code, message: error.message }),
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
    store: {
      read: async () => ({ ...state }),
      update: async patch => Object.assign(state, patch),
      reserveDelivery: async id => { state.currentDeliveryId = id; return { ...state }; },
      clearDelivery: async () => { state.currentDeliveryId = null; },
    },
    chrome: { tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (_tabId, message) => {
        if (message.type === "agent.ping") return page();
        if (message.type === "agent.prompt") {
          prompts.push(message);
          tab.url = "https://chatgpt.com/uc/guest-created";
          throw new Error("A listener indicated an asynchronous response, but the message channel closed.");
        }
        if (message.type === "agent.observeSubmittedPrompt") {
          observations.push(message);
          return { ok: true, text: "reply", confidence: "CONFIRMED_BY_UI_STATE",
            evidence: { documentId: "document-2", frameId: 0, conversationUrl: tab.url,
              conversationId: "guest-created", userMessageId: "u1", assistantMessageId: "a1" } };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
    } },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function focusTab(")), context);
  await context.handlePrompt({ requestId: "d1", payload: {
    runId: "r1", controllerMessageId: "d1", text: "request",
  } });
  assert.equal(prompts.length, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].payload.expectedDocumentId, "document-2");
  assert.equal(state.conversationUrl, "https://chatgpt.com/uc/guest-created");
  assert.equal(state.conversationId, "guest-created");
  assert.equal(state.documentId, "document-2");
  assert.equal(state.completedDelivery.turnId, "d1");
  assert.equal(sent[0]?.type, "web.prompt.result", JSON.stringify(sent));
});
