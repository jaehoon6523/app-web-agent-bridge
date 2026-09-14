import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as documentBinding from "../extension/runtime/document-binding.js";
import * as conversation from "../extension/runtime/conversation.js";
import * as guards from "../extension/runtime/turn-guard.js";
import { createControlledPrompt } from "../extension/runtime/markers.js";
import { normalizeExtensionState } from "../extension/runtime/storage.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const documentGuard = content.slice(content.indexOf("function assertExpectedDocument("), content.indexOf("class ContentContractError"));
const execute = content.slice(content.indexOf("async function executePrompt("), content.indexOf("function cancelCurrentJob("));

function harness({ root = false, reloadBeforePing = false, reloadAfterPing = false, staleEvidence = false } = {}) {
  const state = { lastBoundSessionId: "s1", lastBoundRunId: "r1", currentDeliveryId: null,
    tabId: 7, windowId: 1, documentId: "d1", frameId: 0,
    conversationUrl: root ? "https://chatgpt.com/" : "https://chatgpt.com/c/a",
    conversationId: root ? null : "a", bindingStatus: root ? "ROOT_READY" : "BOUND" };
  const tab = { id: 7, windowId: 1, url: state.conversationUrl };
  const messages = [], dispatches = [], clicks = [];
  let documentId = reloadBeforePing ? "d2" : "d1";
  class ContractError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = vm.createContext({ ...documentBinding, ...conversation, ...guards, createControlledPrompt,
    console: { info() {}, warn() {} }, authenticated: false, lastError: null,
    turnGate: guards.createActiveTurnGate(), broadcastPopupState() {}, waitForContentScript: async () => {},
    ExtensionOperationError: ContractError, errorPayload: e => ({ code: e.code }), send: m => messages.push(m),
    store: { read: async () => ({ ...state }), update: async p => Object.assign(state, p),
      reserveDelivery: async id => { state.currentDeliveryId = id; return { ...state }; },
      clearDelivery: async () => { state.currentDeliveryId = null; } },
    chrome: { tabs: {
      // A focused tab B must have no effect on an already bound turn.
      query: async () => { throw new Error("Must not resolve the active tab"); },
      get: async id => { assert.equal(id, 7); return { ...tab }; },
      sendMessage: async (id, message) => {
        assert.equal(id, 7);
        if (message.type === "agent.ping") {
          const page = { ok: true, documentId, frameId: 0, url: tab.url,
            conversationId: conversation.conversationIdFromUrl(tab.url) };
          if (reloadAfterPing) documentId = "d2";
          return page;
        }
        dispatches.push(message);
        const location = { href: tab.url };
        const receiver = vm.createContext({ DOCUMENT_ID: documentId, FRAME_ID: 0, ContentContractError: ContractError,
          currentJob: null, requireSelectorRegistry() {}, AbortController, DOMException,
          location, selectorTelemetry: new Map(), messageSnapshot: () => [],
          canonicalConversationUrl: conversation.canonicalChatGptUrl, conversationIdFromUrl: conversation.conversationIdFromUrl,
          parseMarkers: () => ({ controllerMessageId: "t1", runId: "r1" }),
          assertExpectedConversation: url => assert.equal(url, location.href), inspectPageState: () => ({ status: "READY" }),
          submitPrompt: async () => { clicks.push(id); if (root) location.href = tab.url = "https://chatgpt.com/c/new"; },
          waitForControlledUserMessage: async () => ({ id: "u1" }),
          waitForAssistantResponse: async () => ({ text: "reply", confidence: "CONFIRMED_BY_UI_STATE",
            evidence: { conversationUrl: tab.url, conversationId: conversation.conversationIdFromUrl(tab.url),
              documentId: staleEvidence ? "stale" : documentId, frameId: 0 } }),
        });
        vm.runInContext(documentGuard + execute, receiver);
        try { return { ok: true, ...await receiver.executePrompt(message.requestId, message.payload) }; }
        catch (e) { return { ok: false, code: e.code, error: e.message }; }
      },
    } },
  });
  vm.runInContext(background.slice(background.indexOf("function bridgeLog("), background.indexOf("class ExtensionOperationError")), context);
  vm.runInContext(background.slice(background.indexOf("function requireBindingInput("), background.indexOf("async function focusTab(")), context);
  return { state, messages, dispatches, clicks,
    run: () => context.handlePrompt({ requestId: "t1", payload: { controllerMessageId: "t1", runId: "r1", text: "request" } }) };
}

for (const root of [false, true]) {
  test(`reload before dispatch blocks ${root ? "root" : "bound"} prompt and clears unsent reservation`, async () => {
    const h = harness({ root, reloadBeforePing: true }); await h.run();
    assert.equal(h.dispatches.length, 0); assert.equal(h.clicks.length, 0);
    assert.equal(h.state.currentDeliveryId, null);
    assert.equal(h.state.bindingStatus, "NEEDS_REBIND");
    assert.equal(h.messages[0].payload.code, "WEB_DOCUMENT_CHANGED");
  });
  test(`receiver rejects reload after ping for ${root ? "root" : "bound"} without submitting`, async () => {
    const h = harness({ root, reloadAfterPing: true }); await h.run();
    assert.equal(h.dispatches.length, 1); assert.equal(h.clicks.length, 0);
    assert.equal(h.state.currentDeliveryId, "t1"); // Dispatched requests remain recoverable, never auto-retried.
    assert.equal(h.messages[0].payload.code, "WEB_DOCUMENT_CHANGED");
  });
  test(`${root ? "root promotion" : "bound turn"} preserves document and persists success trace`, async () => {
    const h = harness({ root }); await h.run();
    assert.deepEqual(h.clicks, [7]);
    assert.equal(h.messages[0].type, "web.prompt.result");
    assert.equal(h.state.conversationId, root ? "new" : "a");
    assert.deepEqual({ ...h.state.completedDelivery.trace }, { requestId: "t1", actionId: "t1", result: "success",
      tabId: 7, bindingId: "s1:r1", documentId: "d1", frameId: 0 });
  });
  test(`${root ? "root" : "bound"} response from another document cannot complete`, async () => {
    const h = harness({ root, staleEvidence: true }); await h.run();
    assert.equal(h.messages[0].payload.code, "TURN_BINDING_CHANGED");
    assert.equal(h.state.completedDelivery, undefined);
    assert.equal(h.state.currentDeliveryId, "t1");
    if (root) assert.equal(h.state.conversationId, null);
  });
}

test("conversation change while waiting for send control prevents the actual click", async () => {
  const location = { href: "https://chatgpt.com/c/a" }; let clicks = 0;
  const context = vm.createContext({ DOCUMENT_ID: "d1", FRAME_ID: 0,
    ContentContractError: class extends Error {},
    waitForVisible: async () => ({ element: { focus() {} } }), setNativeValue() {}, sleep: async () => {},
    waitForEnabledSend: async () => { location.href = "https://chatgpt.com/c/b"; return { element: { click() { clicks++; } } }; },
    assertExpectedConversation: expected => assert.equal(location.href, expected),
  });
  vm.runInContext(documentGuard + content.slice(content.indexOf("async function submitPrompt("), content.indexOf("async function waitForControlledUserMessage(")), context);
  await assert.rejects(context.submitPrompt("request", null, {
    expectedDocumentId: "d1", expectedFrameId: 0, expectedConversationUrl: "https://chatgpt.com/c/a", expectedConversationId: "a",
  }));
  assert.equal(clicks, 0);
});

test("legacy ready state without a document requires preparation and retains unresolved delivery", () => {
  for (const bindingStatus of ["BOUND", "ROOT_READY"]) {
    const state = normalizeExtensionState({ bindingStatus, tabId: 1, windowId: 1,
      conversationUrl: "https://chatgpt.com/", conversationId: null,
      lastBoundSessionId: "s1", lastBoundRunId: "r1", currentDeliveryId: "old" });
    assert.equal(state.bindingStatus, "NEEDS_REBIND");
    assert.equal(state.currentDeliveryId, "old");
  }
});
