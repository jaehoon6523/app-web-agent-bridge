import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  BindingRecoveryCode,
  bindingRecoveryMessage,
  classifyStoredAmbiguousRoot,
} from "../extension/runtime/binding-recovery.js";
import { canonicalChatGptUrl, conversationIdFromUrl } from "../extension/runtime/conversation.js";
import { diagnosticError } from "../extension/runtime/document-binding.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const popup = readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8");
const connectionStateSource = background.slice(
  background.indexOf("async function connectionState("),
  background.indexOf("function broadcastPopupState("),
);

function state(overrides = {}) {
  return {
    bindingStatus: "AMBIGUOUS",
    currentDeliveryId: null,
    tabId: 1490715643,
    windowId: 1490715642,
    conversationUrl: "https://chatgpt.com/",
    conversationId: null,
    ...overrides,
  };
}

function rootPage(overrides = {}) {
  return {
    ok: true,
    ready: true,
    busy: false,
    generating: false,
    url: "https://chatgpt.com/",
    conversationId: null,
    documentId: "document-current",
    frameId: 0,
    ...overrides,
  };
}

const root = { id: 1490715643, windowId: 1490715642, url: "https://chatgpt.com/" };

test("stored AMBIGUOUS with one exact idle root maps to ROOT_READY recovery", () => {
  const result = classifyStoredAmbiguousRoot({ state: state(), roots: [root], rootPage: rootPage(), busy: false });

  assert.deepEqual(result, {
    recovered: true,
    code: "STORED_AMBIGUOUS_ROOT_RECOVERED",
    message: "동일한 ChatGPT 시작 탭 하나를 확인해 새 대화 준비 상태로 복구했습니다.",
    patch: {
      documentId: "document-current",
      frameId: 0,
      bindingStatus: "ROOT_READY",
      bindingError: null,
    },
  });
});

test("stored AMBIGUOUS with an unresolved delivery remains blocked with exact guidance", () => {
  const result = classifyStoredAmbiguousRoot({
    state: state({ currentDeliveryId: "delivery-unresolved" }),
    roots: [root],
    rootPage: rootPage(),
    busy: false,
  });

  assert.deepEqual(result, {
    recovered: false,
    code: "STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED",
    message: "미확정 전송이 남아 있어 자동 복구하지 않았습니다. 전송 상태를 확인하거나 폐기하세요.",
  });
});

test("stored AMBIGUOUS mapping contract is closed and returns user-facing text", () => {
  assert.deepEqual(Object.values(BindingRecoveryCode), [
    "STORED_AMBIGUOUS_ROOT_RECOVERED",
    "STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED",
    "STORED_AMBIGUOUS_REBIND_REQUIRED",
  ]);
  for (const code of Object.values(BindingRecoveryCode)) {
    assert.equal(typeof bindingRecoveryMessage(code), "string");
    assert.ok(bindingRecoveryMessage(code).length > 0);
  }
  assert.equal(bindingRecoveryMessage("UNKNOWN"), null);
});

async function backgroundConnectionState({ currentDeliveryId = null, bindingError = "AMBIGUOUS: previous failure" } = {}) {
  const stored = state({
    currentDeliveryId,
    bindingError,
    lastBoundSessionId: "session-1",
    lastBoundRunId: "run-1",
    documentId: "document-old",
    frameId: 0,
    extensionIdentity: "extension-1",
  });
  const context = vm.createContext({
    canonicalChatGptUrl,
    conversationIdFromUrl,
    classifyStoredAmbiguousRoot,
    diagnosticError,
    ExtensionOperationError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    },
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    authenticated: true,
    socket: { readyState: 1 },
    WebSocket: { OPEN: 1, CONNECTING: 0 },
    turnGate: { active: false },
    lastError: null,
    store: {
      read: async () => ({ ...stored }),
      update: async patch => { Object.assign(stored, patch); return { ...stored }; },
    },
    chrome: { tabs: {
      query: async () => [root],
      sendMessage: async () => rootPage(),
    } },
  });
  vm.runInContext(connectionStateSource, context);
  return { output: await context.connectionState(), stored };
}

test("background maps recoverable stored AMBIGUOUS to ROOT_READY with its recovery text", async () => {
  const { output, stored } = await backgroundConnectionState();

  assert.equal(stored.bindingStatus, "ROOT_READY");
  assert.equal(stored.bindingError, null);
  assert.equal(stored.documentId, "document-current");
  assert.deepEqual({ ...output.bindingRecovery }, {
    recovered: true,
    code: "STORED_AMBIGUOUS_ROOT_RECOVERED",
    message: "동일한 ChatGPT 시작 탭 하나를 확인해 새 대화 준비 상태로 복구했습니다.",
  });
});

test("background maps unresolved delivery to a stable blocked code and text", async () => {
  const { output, stored } = await backgroundConnectionState({ currentDeliveryId: "delivery-unresolved", bindingError: null });

  assert.equal(stored.bindingStatus, "AMBIGUOUS");
  assert.match(stored.bindingError, /^STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED:/u);
  assert.deepEqual({ ...output.bindingRecovery }, {
    recovered: false,
    code: "STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED",
    message: "미확정 전송이 남아 있어 자동 복구하지 않았습니다. 전송 상태를 확인하거나 폐기하세요.",
  });
});

function renderPopupState(state) {
  const elements = Object.fromEntries([
    "status", "detail", "controllerUrl", "sharedSecret", "save", "reconnect", "legacyRecovery", "clearLegacy",
  ].map(id => [id, { textContent: "", className: "", hidden: false, value: "", placeholder: "" }]));
  const context = vm.createContext({
    document: { querySelector: selector => elements[selector.slice(1)] },
    chrome: { runtime: { sendMessage() {} } },
  });
  vm.runInContext(popup.slice(0, popup.indexOf("async function refresh(")), context);
  context.response = { ok: true, state };
  vm.runInContext("render(response)", context);
  return elements;
}

test("popup renders the mapped recovery text instead of a stale generic error", () => {
  const message = bindingRecoveryMessage(BindingRecoveryCode.DELIVERY_REVIEW_REQUIRED);
  const elements = renderPopupState({
    connected: true,
    transportConnected: true,
    busy: false,
    tabId: 1490715643,
    bindingStatus: "AMBIGUOUS",
    bindingError: "AMBIGUOUS: previous generic error",
    currentDeliveryId: "delivery-unresolved",
    extensionIdentity: "extension-1",
    bindingRecovery: { code: BindingRecoveryCode.DELIVERY_REVIEW_REQUIRED, message, recovered: false },
  });

  assert.match(elements.detail.textContent, new RegExp(message, "u"));
  assert.doesNotMatch(elements.detail.textContent, /previous generic error/u);
});

test("popup renders the successful root recovery text", () => {
  const message = bindingRecoveryMessage(BindingRecoveryCode.ROOT_RECOVERED);
  const elements = renderPopupState({
    connected: true,
    transportConnected: true,
    busy: false,
    tabId: 1490715643,
    bindingStatus: "ROOT_READY",
    currentDeliveryId: null,
    extensionIdentity: "extension-1",
    startTab: { tabId: 1490715643, ready: true },
    bindingRecovery: { code: BindingRecoveryCode.ROOT_RECOVERED, message, recovered: true },
  });

  assert.match(elements.detail.textContent, new RegExp(message, "u"));
});
