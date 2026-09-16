import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBootstrapAfterNavigation } from '../extension/runtime/bootstrap-recovery.js';
import { createExtensionStateStore } from '../extension/runtime/storage.js';
import * as documentBinding from "../extension/runtime/document-binding.js";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as conversation from "../extension/runtime/conversation.js";
import * as guards from "../extension/runtime/turn-guard.js";
import { createControlledPrompt } from "../extension/runtime/markers.js";
import * as currentTarget from "../extension/runtime/current-target.js";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

// Whole content/background scripts and their Web adapter connection are tested
// by npm run test:browser. These are focused recovery policy boundary checks.
function fixture({ current = {}, page = {}, tabUrls = ['https://chatgpt.com/uc/created'] } = {}) {
  const reservedState = { lastBoundSessionId: 's1', lastBoundRunId: 'r1', currentDeliveryId: 'd1',
    tabId: 7, windowId: 3, documentId: 'old-document', frameId: 0,
    conversationUrl: 'https://chatgpt.com/', conversationId: null, bindingStatus: 'ROOT_READY' };
  let saved = { ...reservedState, ...current };
  const sent = [];
  const store = createExtensionStateStore({ get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); } });
  const observed = { ok: true, url: 'https://chatgpt.com/uc/created', conversationId: 'created',
    documentId: 'new-document', frameId: 0, ...page };
  let tabRead = 0;
  const args = { store, reservedState, tab: { id: 7 }, turnIdentity: { requestId: 'd1', controllerMessageId: 'd1', runId: 'r1' },
    payload: {}, waitForContentScript: async () => observed, sleep: async () => {},
    tabs: { get: async () => ({ id: 7, windowId: 3, url: tabUrls[Math.min(tabRead++, tabUrls.length - 1)] }),
      sendMessage: async (tabId, message) => { sent.push({ tabId, ...message }); return { ok: true }; } } };
  return { args, sent, store };
}

test('bootstrap recovery persists the observed document and requests observation only', async () => {
  const f = fixture();
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'agent.observeSubmittedPrompt');
  assert.equal(f.sent[0].payload.expectedDocumentId, 'new-document');
  assert.equal(f.sent[0].payload.controllerMessageId, 'd1');
  assert.equal(result.frozenTurn.documentId, 'new-document');
  assert.equal((await f.store.read()).currentDeliveryId, 'd1');
});
test('bootstrap recovery waits for a temporary WEB ID to settle', async () => {
  const f = fixture({ tabUrls: [
    'https://chatgpt.com/c/WEB:temporary',
    'https://chatgpt.com/c/created',
  ], page: { url: 'https://chatgpt.com/c/created', conversationId: 'created' } });
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(result.frozenTurn.conversationId, 'created');
  assert.equal((await f.store.read()).conversationUrl, 'https://chatgpt.com/c/created');
  assert.equal(f.sent.length, 1);
});

test("root prepare returns without navigation; first delivery sends once and persists created conversation", async () => {
  const state = { tabId: 99, bindingStatus: "AMBIGUOUS", currentDeliveryId: null };
  const tab = { id: 1, windowId: 2, url: "https://chatgpt.com/" };
  const sent = [], prompts = [];
  const context = vm.createContext({ ...documentBinding, ...conversation, ...guards, ...currentTarget, createControlledPrompt,
    console, Number, Date, setTimeout, clearTimeout, lastError: null,
    bridgeLog() {},
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    turnGate: guards.createActiveTurnGate(), authenticated: false,
    broadcastPopupState() {}, waitForContentScript: async () => {}, focusTab: async () => {},
    send: m => sent.push(m), errorPayload: e => ({ code: e.code, message: e.message }),
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    store: { read: async () => ({ ...state }), update: async p => Object.assign(state, p),
      bindSession: async patch => {
        if (state.lastBoundSessionId !== patch.lastBoundSessionId) {
          state.currentDeliveryId = null;
          state.completedDelivery = null;
          state.lastObservedUserMessageId = null;
          state.lastObservedAssistantMessageId = null;
        }
        Object.assign(state, patch);
        return { ...state };
      },
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
  assert.deepEqual({ ...state.completedDelivery.trace }, {
    requestId: "d1", actionId: "d1", result: "success", tabId: 1,
    bindingId: "s1:r1", documentId: "document-1", frameId: 0,
  });
});

for (const current of [{ currentDeliveryId: 'other' }, { lastBoundSessionId: 'other' }, { lastBoundRunId: 'other' }, { tabId: 8 }]) {
  test(`bootstrap rejects a changed ${Object.keys(current)[0]} before observing or promoting`, async () => {
    const f = fixture({ current });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'TURN_BINDING_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}

for (const page of [{ url: 'https://chatgpt.com/c/other' }, { conversationId: 'other' }, { documentId: null }, { frameId: 1 }]) {
  test(`bootstrap rejects invalid observed ${Object.keys(page)[0]} and keeps the unresolved delivery`, async () => {
    const f = fixture({ page });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'WEB_DOCUMENT_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}
