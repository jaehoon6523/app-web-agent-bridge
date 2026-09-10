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
  currentDeliveryId: null,
  completedDelivery: null,
  lastObservedUserMessageId: null,
  lastObservedAssistantMessageId: null,
  bindingStatus: "NEEDS_REBIND",
});

const STORED_KEYS = Object.freeze(Object.keys(DEFAULT_EXTENSION_CONFIG));
const BINDING_STATUSES = new Set(["BOUND", "NEEDS_REBIND", "AUTH_REQUIRED", "AMBIGUOUS"]);

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
    currentDeliveryId: nullableString(value.currentDeliveryId),
    completedDelivery: value.completedDelivery && typeof value.completedDelivery === "object"
      ? structuredClone(value.completedDelivery) : null,
    lastObservedUserMessageId: nullableString(value.lastObservedUserMessageId),
    lastObservedAssistantMessageId: nullableString(value.lastObservedAssistantMessageId),
    bindingStatus: BINDING_STATUSES.has(value.bindingStatus)
      ? value.bindingStatus
      : "NEEDS_REBIND",
  };
  if (
    state.bindingStatus === "BOUND"
    && (
      state.tabId === null
      || state.windowId === null
      || state.conversationUrl === null
      || state.conversationId === null
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
    async clearDelivery(deliveryId) {
      if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
        throw new ExtensionStateError("INVALID_DELIVERY_ID", "Delivery ID must be a non-empty string.");
      }
      return mutate(async () => {
        const current = await readStoredState();
        if (current.currentDeliveryId !== deliveryId) {
          throw new ExtensionStateError(
            "DELIVERY_ACK_MISMATCH",
            "Delivery acknowledgement does not match the persisted delivery.",
            { expectedDeliveryId: current.currentDeliveryId },
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
