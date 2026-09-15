import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { canonicalChatGptUrl, conversationIdFromUrl } from "../extension/runtime/conversation.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const topologySource = background.slice(
  background.indexOf("async function inspectBoundTabTopology("),
  background.indexOf("chrome.tabs.onCreated.addListener("),
);

test("bound tab topology change emits an AMBIGUOUS manual-intervention event", async () => {
  const state = {
    bindingStatus: "BOUND",
    conversationUrl: "https://chatgpt.com/c/original",
    conversationId: "original",
    tabId: 7,
    windowId: 1,
    currentDeliveryId: "delivery-1",
  };
  const updates = [];
  const messages = [];
  const cancelled = [];
  const context = vm.createContext({
    canonicalChatGptUrl,
    conversationIdFromUrl,
    authenticated: true,
    lastError: null,
    store: {
      read: async () => ({ ...state }),
      update: async patch => { updates.push(patch); Object.assign(state, patch); return { ...state }; },
    },
    chrome: { tabs: {
      get: async () => ({ id: 7, windowId: 1, url: "https://chatgpt.com/c/other" }),
      sendMessage: async (_tabId, message) => { cancelled.push(message); return { ok: true }; },
    } },
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
    diagnosticError: error => `${error.code}: ${error.message}`,
    broadcastPopupState() {},
    send: message => { messages.push(message); return true; },
  });
  vm.runInContext(topologySource, context);

  await context.inspectBoundTabTopology(7);

  assert.equal(state.bindingStatus, "AMBIGUOUS");
  assert.equal(updates.length, 2);
  assert.equal(cancelled[0].requestId, "delivery-1");
  assert.equal(messages[0].type, "web.manual-intervention");
  assert.equal(messages[0].payload.observedBindingStatus, "AMBIGUOUS");
});
