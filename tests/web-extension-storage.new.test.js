import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  assertStrongExtensionSharedSecret,
  computeChallengeHmac,
} from "../extension/runtime/hmac.js";
import { computeWebChallengeHmac } from "../src/runtime/web/auth.js";
import {
  createExtensionStateStore,
  ensureExtensionIdentity,
} from "../extension/runtime/storage.js";
import {
  conversationIdFromUrl,
  matchExactConversationTabs,
  validateLocalControllerUrl,
} from "../extension/runtime/conversation.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MemoryStorageArea {
  values = {};

  async get(keys) {
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }

  async set(value) {
    Object.assign(this.values, structuredClone(value));
  }
}

class DelayedStorageArea extends MemoryStorageArea {
  async get(keys) {
    const snapshot = await super.get(keys);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return snapshot;
  }

  async set(value) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return super.set(value);
  }
}

test("extension state survives service-worker store reconstruction", async () => {
  const area = new MemoryStorageArea();
  const firstWorker = createExtensionStateStore(area);
  assert.equal(await ensureExtensionIdentity(firstWorker, () => "extension-fixed"), "extension-fixed");
  await firstWorker.update({
    sharedSecret: "not-logged",
    lastBoundSessionId: "session-1",
    lastBoundRunId: "run-1",
    conversationUrl: "https://chatgpt.com/c/abc",
    conversationId: "abc",
    tabId: 4,
    windowId: 2,
    documentId: "document-1",
    frameId: 0,
    currentDeliveryId: "delivery-1",
    lastObservedUserMessageId: "u1",
    lastObservedAssistantMessageId: "a1",
    bindingStatus: "BOUND",
  });

  const restartedWorker = createExtensionStateStore(area);
  const restored = await restartedWorker.read();
  assert.equal(restored.extensionIdentity, "extension-fixed");
  assert.equal(restored.currentDeliveryId, "delivery-1");
  assert.equal(restored.conversationUrl, "https://chatgpt.com/c/abc");
  assert.equal(restored.bindingStatus, "BOUND");
});

test("concurrent extension state patches are serialized without lost updates", async () => {
  const area = new DelayedStorageArea();
  const store = createExtensionStateStore(area);
  await Promise.all([
    store.update({ currentDeliveryId: "delivery-race" }),
    store.update({ bindingStatus: "AUTH_REQUIRED" }),
  ]);
  const state = await store.read();
  assert.equal(state.currentDeliveryId, "delivery-race");
  assert.equal(state.bindingStatus, "AUTH_REQUIRED");
});

test("concurrent delivery reservations persist exactly one winner", async () => {
  const area = new DelayedStorageArea();
  const store = createExtensionStateStore(area);
  const results = await Promise.allSettled([
    store.reserveDelivery("delivery-a"),
    store.reserveDelivery("delivery-b"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "DELIVERY_ALREADY_RESERVED");
  assert.equal((await store.read()).currentDeliveryId, fulfilled[0].value.currentDeliveryId);
});

test("delivery acknowledgement clears only an exact non-empty persisted ID", async () => {
  const area = new MemoryStorageArea();
  const store = createExtensionStateStore(area);
  await store.reserveDelivery("delivery-exact");

  await assert.rejects(store.clearDelivery(""), { code: "INVALID_DELIVERY_ID" });
  await assert.rejects(store.clearDelivery(undefined), { code: "INVALID_DELIVERY_ID" });
  await assert.rejects(store.clearDelivery("delivery-stale"), { code: "DELIVERY_ACK_MISMATCH" });
  assert.equal((await store.read()).currentDeliveryId, "delivery-exact");

  const cleared = await store.clearDelivery("delivery-exact");
  assert.equal(cleared.currentDeliveryId, null);
});

test("extension HMAC matches the controller HMAC contract", async () => {
  assert.equal(
    await computeChallengeHmac("nonce", "secret"),
    computeWebChallengeHmac("nonce", "secret"),
  );
});

test("extension configuration rejects weak shared secrets", () => {
  assert.throws(() => assertStrongExtensionSharedSecret("too-short"), /at least 32/u);
  assert.equal(
    assertStrongExtensionSharedSecret("extension-secret-0123456789abcdef"),
    "extension-secret-0123456789abcdef",
  );
});

test("extension conversation matching is exact and local controller URLs cannot carry tokens", () => {
  assert.equal(conversationIdFromUrl("https://chatgpt.com/c/WEB:temporary"), null);
  assert.equal(conversationIdFromUrl("https://chatgpt.com/c/WEB%3Atemporary"), null);
  assert.equal(conversationIdFromUrl("https://chatgpt.com/uc/guest-abc"), "guest-abc");
  const exact = matchExactConversationTabs([
    { id: 1, active: true, url: "https://chatgpt.com/c/wrong" },
    { id: 2, active: false, url: "https://chatgpt.com/c/right" },
  ], {
    conversationUrl: "https://chatgpt.com/c/right",
    conversationId: "right",
  });
  assert.equal(exact.tab.id, 2);
  assert.equal(matchExactConversationTabs([], {
    conversationUrl: "https://chatgpt.com/c/right",
    conversationId: "right",
  }).status, "NEEDS_REBIND");
  assert.equal(matchExactConversationTabs([
    { id: 2, url: "https://chatgpt.com/c/right" },
    { id: 3, url: "https://chatgpt.com/c/right" },
  ], {
    conversationUrl: "https://chatgpt.com/c/right",
    conversationId: "right",
  }).status, "AMBIGUOUS");
  assert.throws(() => validateLocalControllerUrl("ws://127.0.0.1:8787/ws?token=secret"));
  assert.throws(() => validateLocalControllerUrl("wss://remote.example/ws"));
  assert.equal(validateLocalControllerUrl("ws://127.0.0.1:8787/ws/extension"), "ws://127.0.0.1:8787/ws/extension");
});
