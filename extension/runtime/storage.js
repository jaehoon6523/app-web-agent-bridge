export const DEFAULT_EXTENSION_CONFIG = Object.freeze({
  controllerUrl: "ws://127.0.0.1:8787/ws/extension",
  sharedSecret: "",
  extensionIdentity: "",
  lastBoundSessionId: null,
  lastBoundRunId: null,
  conversationUrl: null,
  conversationId: null,
  tabId: null,
  windowId: null,
  documentId: null,
  frameId: null,
  currentDeliveryId: null,
  completedDelivery: null,
  deliveryScopes: {},
  lastObservedUserMessageId: null,
  lastObservedAssistantMessageId: null,
  bindingError: null,
  bindingStatus: "NEEDS_REBIND",
});

const STORED_KEYS = Object.freeze(Object.keys(DEFAULT_EXTENSION_CONFIG));
const BINDING_STATUSES = new Set(["ROOT_READY", "BOUND", "NEEDS_REBIND", "AUTH_REQUIRED", "AMBIGUOUS"]);

export class ExtensionStateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionStateError";
    this.code = code;
    this.details = details;
  }
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeDeliveryScopes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scopes = {};
  for (const [sessionId, slot] of Object.entries(value)) {
    if (!nullableString(sessionId) || !slot || typeof slot !== "object" || Array.isArray(slot)) continue;
    const currentDeliveryId = nullableString(slot.currentDeliveryId);
    if (currentDeliveryId === null) continue;
    scopes[sessionId] = {
      currentDeliveryId,
      completedDelivery: slot.completedDelivery && typeof slot.completedDelivery === "object"
        ? structuredClone(slot.completedDelivery) : null,
      lastObservedUserMessageId: nullableString(slot.lastObservedUserMessageId),
      lastObservedAssistantMessageId: nullableString(slot.lastObservedAssistantMessageId),
    };
  }
  return scopes;
}

export function normalizeExtensionState(value = {}) {
  const state = {
    controllerUrl: typeof value.controllerUrl === "string" && value.controllerUrl.length > 0
      ? value.controllerUrl
      : DEFAULT_EXTENSION_CONFIG.controllerUrl,
    sharedSecret: typeof value.sharedSecret === "string" ? value.sharedSecret : "",
    extensionIdentity: typeof value.extensionIdentity === "string" ? value.extensionIdentity : "",
    lastBoundSessionId: nullableString(value.lastBoundSessionId),
    lastBoundRunId: nullableString(value.lastBoundRunId),
    conversationUrl: nullableString(value.conversationUrl),
    conversationId: nullableString(value.conversationId),
    tabId: nullableInteger(value.tabId),
    windowId: nullableInteger(value.windowId),
    documentId: nullableString(value.documentId),
    frameId: nullableInteger(value.frameId),
    currentDeliveryId: nullableString(value.currentDeliveryId),
    completedDelivery: value.completedDelivery && typeof value.completedDelivery === "object"
      ? structuredClone(value.completedDelivery) : null,
    deliveryScopes: normalizeDeliveryScopes(value.deliveryScopes),
    lastObservedUserMessageId: nullableString(value.lastObservedUserMessageId),
    lastObservedAssistantMessageId: nullableString(value.lastObservedAssistantMessageId),
    bindingError: nullableString(value.bindingError),
    bindingStatus: BINDING_STATUSES.has(value.bindingStatus)
      ? value.bindingStatus
      : "NEEDS_REBIND",
  };
  if (
    ["BOUND", "ROOT_READY"].includes(state.bindingStatus)
    && (
      state.tabId === null
      || state.windowId === null
      || state.conversationUrl === null
      || state.documentId === null
      || state.frameId !== 0
      || (state.bindingStatus === "BOUND" && state.conversationId === null)
      || (state.bindingStatus === "ROOT_READY" && (state.conversationUrl !== "https://chatgpt.com/" || state.conversationId !== null))
      || state.lastBoundSessionId === null
      || state.lastBoundRunId === null
    )
  ) {
    state.bindingStatus = "NEEDS_REBIND";
  }
  return Object.freeze(state);
}

export function createExtensionStateStore(storageArea) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("A chrome.storage-compatible area is required");
  }
  let mutationQueue = Promise.resolve();

  async function readStoredState() {
    const stored = await storageArea.get(STORED_KEYS);
    return normalizeExtensionState(stored);
  }

  function mutate(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    async read() {
      await mutationQueue;
      return readStoredState();
    },
    async update(patch) {
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("Extension state patch must be an object");
      }
      for (const key of Object.keys(patch)) {
        if (!STORED_KEYS.includes(key)) throw new TypeError(`Unsupported extension state key: ${key}`);
      }
      return mutate(async () => {
        const next = normalizeExtensionState({
          ...(await readStoredState()),
          ...structuredClone(patch),
        });
        await storageArea.set(next);
        return next;
      });
    },
    async reserveDelivery(deliveryId) {
      if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
        throw new ExtensionStateError("INVALID_DELIVERY_ID", "Delivery ID must be a non-empty string.");
      }
      return mutate(async () => {
        const current = await readStoredState();
        if (current.currentDeliveryId !== null) {
          throw new ExtensionStateError(
            "DELIVERY_ALREADY_RESERVED",
            "A Web delivery is already reserved and requires acknowledgement or recovery.",
            { currentDeliveryId: current.currentDeliveryId },
          );
        }
        const next = normalizeExtensionState({ ...current, currentDeliveryId: deliveryId, completedDelivery: null });
        await storageArea.set(next);
        return next;
      });
    },
    async bindSession(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)
        || typeof patch.lastBoundSessionId !== "string" || !patch.lastBoundSessionId.trim()
        || typeof patch.lastBoundRunId !== "string" || !patch.lastBoundRunId.trim()) {
        throw new ExtensionStateError("INVALID_SESSION_BINDING", "A session and run are required to commit a binding.");
      }
      for (const key of Object.keys(patch)) {
        if (!STORED_KEYS.includes(key)) throw new TypeError(`Unsupported extension state key: ${key}`);
      }
      return mutate(async () => {
        const current = await readStoredState();
        const deliveryScopes = structuredClone(current.deliveryScopes);
        const changingSession = current.lastBoundSessionId !== patch.lastBoundSessionId;
        if (changingSession && current.lastBoundSessionId && current.currentDeliveryId) {
          deliveryScopes[current.lastBoundSessionId] = {
            currentDeliveryId: current.currentDeliveryId,
            completedDelivery: current.completedDelivery,
            lastObservedUserMessageId: current.lastObservedUserMessageId,
            lastObservedAssistantMessageId: current.lastObservedAssistantMessageId,
          };
        }
        const nextSlot = changingSession ? deliveryScopes[patch.lastBoundSessionId] ?? null : null;
        if (changingSession) delete deliveryScopes[patch.lastBoundSessionId];
        const next = normalizeExtensionState({
          ...current,
          ...structuredClone(patch),
          deliveryScopes,
          ...(changingSession ? {
            currentDeliveryId: nextSlot?.currentDeliveryId ?? null,
            completedDelivery: nextSlot?.completedDelivery ?? null,
            lastObservedUserMessageId: nextSlot?.lastObservedUserMessageId ?? null,
            lastObservedAssistantMessageId: nextSlot?.lastObservedAssistantMessageId ?? null,
          } : {}),
        });
        await storageArea.set(next);
        return next;
      });
    },
    async clearDelivery(deliveryId, sessionId = null) {
      if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
        throw new ExtensionStateError("INVALID_DELIVERY_ID", "Delivery ID must be a non-empty string.");
      }
      return mutate(async () => {
        const current = await readStoredState();
        if (current.currentDeliveryId !== deliveryId
          || (sessionId !== null && current.lastBoundSessionId !== sessionId)) {
          throw new ExtensionStateError(
            "DELIVERY_ACK_MISMATCH",
            "Delivery acknowledgement does not match the persisted delivery.",
            { expectedDeliveryId: current.currentDeliveryId, expectedSessionId: current.lastBoundSessionId },
          );
        }
        const next = normalizeExtensionState({ ...current, currentDeliveryId: null });
        await storageArea.set(next);
        return next;
      });
    },
  });
}

export async function ensureExtensionIdentity(store, randomUuid = () => crypto.randomUUID()) {
  const current = await store.read();
  if (current.extensionIdentity) return current.extensionIdentity;
  const extensionIdentity = randomUuid();
  if (typeof extensionIdentity !== "string" || extensionIdentity.length === 0) {
    throw new TypeError("Generated extension identity must be a non-empty string");
  }
  await store.update({ extensionIdentity });
  return extensionIdentity;
}
