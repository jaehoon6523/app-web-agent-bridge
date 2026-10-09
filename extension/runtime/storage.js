import { resolveWebTargetProvider } from "./provider-target.js";

export const DEFAULT_EXTENSION_CONFIG = Object.freeze({
  controllerUrl: "ws://127.0.0.1:8787/ws/extension",
  sharedSecret: "",
  extensionIdentity: "",
  lastBoundSessionId: null,
  lastBoundRunId: null,
  webProvider: null,
  conversationUrl: null,
  conversationId: null,
  tabId: null,
  windowId: null,
  documentId: null,
  frameId: null,
  currentDeliveryId: null,
  completedDelivery: null,
  lastAcknowledgedDelivery: null,
  lastDeliveryDiscard: null,
  deliveryScopes: {},
  lastActiveWebTarget: null,
  lastObservedUserMessageId: null,
  lastObservedAssistantMessageId: null,
  bindingError: null,
  bindingStatus: "NEEDS_REBIND",
});

const STORED_KEYS = Object.freeze(Object.keys(DEFAULT_EXTENSION_CONFIG));
const LEGACY_STORED_KEYS = Object.freeze(["lastActiveChatGptTarget"]);
const BINDING_STATUSES = new Set(["ROOT_READY", "BOUND", "NEEDS_REBIND", "AUTH_REQUIRED", "AMBIGUOUS"]);

export class ExtensionStateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionStateError";
    this.code = code;
    this.details = details;
  }
}

export function isLegacyBridgeTestDelivery(state) {
  return /^manual_session_\d+$/u.test(state?.lastBoundSessionId ?? "")
    && /^manual_run_\d+$/u.test(state?.lastBoundRunId ?? "")
    && /^turn_\d+$/u.test(state?.currentDeliveryId ?? "");
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
const SCOPE_BINDING_KEYS = ["lastBoundRunId", "webProvider", "conversationUrl", "conversationId", "tabId", "windowId", "documentId", "frameId"];
function deliveryScope(state) {
  return Object.fromEntries([...SCOPE_BINDING_KEYS, "currentDeliveryId", "completedDelivery",
    "lastObservedUserMessageId", "lastObservedAssistantMessageId"].map(key => [key, structuredClone(state[key])]));
}

function normalizeDeliveryScopes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scopes = {};
  for (const [sessionId, slot] of Object.entries(value)) {
    if (!nullableString(sessionId) || !slot || typeof slot !== "object" || Array.isArray(slot)) continue;
    const currentDeliveryId = nullableString(slot.currentDeliveryId);
    if (currentDeliveryId === null) continue;
    scopes[sessionId] = {
      ...Object.fromEntries(SCOPE_BINDING_KEYS.map(key => [key, ["tabId", "windowId", "frameId"].includes(key)
        ? nullableInteger(slot[key]) : nullableString(slot[key])])),
      currentDeliveryId,
      completedDelivery: slot.completedDelivery && typeof slot.completedDelivery === "object"
        ? structuredClone(slot.completedDelivery) : null,
      lastObservedUserMessageId: nullableString(slot.lastObservedUserMessageId),
      lastObservedAssistantMessageId: nullableString(slot.lastObservedAssistantMessageId),
    };
  }
  return scopes;
}

function normalizeActiveTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tabId = nullableInteger(value.tabId), windowId = nullableInteger(value.windowId);
  const documentId = nullableString(value.documentId), frameId = nullableInteger(value.frameId);
  const conversationUrl = nullableString(value.conversationUrl);
  const provider = conversationUrl === null ? null : resolveWebTargetProvider({
    provider:nullableString(value.provider),
    conversationUrl,
  });
  const conversationId = nullableString(value.conversationId);
  if (tabId === null || windowId === null || documentId === null || frameId !== 0
    || !provider || provider.canonicalize(conversationUrl) !== conversationUrl
    || (conversationId === null ? conversationUrl !== provider.rootUrl
      : provider.conversationIdFromUrl(conversationUrl) !== conversationId)) return null;
  return { provider:provider.provider, tabId, windowId, documentId, frameId, conversationUrl, conversationId,
    observedAt:Number.isFinite(value.observedAt) ? value.observedAt : 0 };
}

export function normalizeExtensionState(value = {}) {
  const conversationUrl = nullableString(value.conversationUrl);
  const bindingProvider = conversationUrl === null ? null : resolveWebTargetProvider({
    provider:nullableString(value.webProvider),
    conversationUrl,
  });
  const state = {
    controllerUrl: typeof value.controllerUrl === "string" && value.controllerUrl.length > 0
      ? value.controllerUrl
      : DEFAULT_EXTENSION_CONFIG.controllerUrl,
    sharedSecret: typeof value.sharedSecret === "string" ? value.sharedSecret : "",
    extensionIdentity: typeof value.extensionIdentity === "string" ? value.extensionIdentity : "",
    lastBoundSessionId: nullableString(value.lastBoundSessionId),
    lastBoundRunId: nullableString(value.lastBoundRunId),
    webProvider: bindingProvider?.provider ?? null,
    conversationUrl,
    conversationId: nullableString(value.conversationId),
    tabId: nullableInteger(value.tabId),
    windowId: nullableInteger(value.windowId),
    documentId: nullableString(value.documentId),
    frameId: nullableInteger(value.frameId),
    currentDeliveryId: nullableString(value.currentDeliveryId),
    completedDelivery: value.completedDelivery && typeof value.completedDelivery === "object"
      ? structuredClone(value.completedDelivery) : null,
    lastAcknowledgedDelivery: value.lastAcknowledgedDelivery && typeof value.lastAcknowledgedDelivery === "object"
      ? structuredClone(value.lastAcknowledgedDelivery) : null,
    lastDeliveryDiscard: value.lastDeliveryDiscard && typeof value.lastDeliveryDiscard === "object"
      ? structuredClone(value.lastDeliveryDiscard) : null,
    deliveryScopes: normalizeDeliveryScopes(value.deliveryScopes),
    lastActiveWebTarget: normalizeActiveTarget(
      value.lastActiveWebTarget !== undefined ? value.lastActiveWebTarget : value.lastActiveChatGptTarget,
    ),
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
      state.webProvider === null
      || state.tabId === null
      || state.windowId === null
      || state.conversationUrl === null
      || state.documentId === null
      || state.frameId !== 0
      || (state.bindingStatus === "BOUND" && state.conversationId === null)
      || (state.bindingStatus === "ROOT_READY" && (state.conversationUrl !== bindingProvider?.rootUrl || state.conversationId !== null))
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
    const stored = await storageArea.get([...STORED_KEYS, ...LEGACY_STORED_KEYS]);
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
        if (Object.values(current.deliveryScopes).some(slot => slot.currentDeliveryId
          && ((slot.tabId !== null && slot.tabId === current.tabId)
            || (slot.conversationUrl !== null && slot.conversationUrl === current.conversationUrl)))) {
          throw new ExtensionStateError("RECOVERY_REQUIRED", "Another session owns an unresolved delivery on this target.");
        }
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
    async updateIf(expected, patch) {
      for (const key of [...Object.keys(expected), ...Object.keys(patch)]) {
        if (!STORED_KEYS.includes(key)) throw new TypeError(`Unsupported extension state key: ${key}`);
      }
      return mutate(async () => {
        const current = await readStoredState();
        if (Object.entries(expected).some(([key, value]) => current[key] !== value)) {
          throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "The persisted owner changed; inspect it again.");
        }
        const next = normalizeExtensionState({ ...current, ...structuredClone(patch) });
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
        if (!changingSession && current.currentDeliveryId && current.lastBoundRunId !== patch.lastBoundRunId) {
          throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "An unresolved delivery cannot be reassigned to another run.");
        }
        if (changingSession && current.lastBoundSessionId && current.currentDeliveryId) {
          deliveryScopes[current.lastBoundSessionId] = deliveryScope(current);
        }
        const nextSlot = changingSession ? deliveryScopes[patch.lastBoundSessionId] ?? null : null;
        if (nextSlot?.lastBoundRunId && (nextSlot.lastBoundRunId !== patch.lastBoundRunId
          || nextSlot.conversationUrl !== patch.conversationUrl)) {
          throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "The parked delivery belongs to a different run or conversation.");
        }
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
    async selectDeliveryScope({ sessionId, deliveryId }) {
      return mutate(async () => {
        const current = await readStoredState(), slot = current.deliveryScopes[sessionId];
        if (!slot || slot.currentDeliveryId !== deliveryId) throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "The parked delivery changed.");
        if (!slot.lastBoundRunId || !slot.conversationUrl) throw new ExtensionStateError("DELIVERY_SCOPE_OWNER_UNCONFIRMED", "This older scope lacks binding metadata. Recover its exact session from the controller first.");
        const deliveryScopes = structuredClone(current.deliveryScopes);
        if (current.currentDeliveryId && current.lastBoundSessionId) deliveryScopes[current.lastBoundSessionId] = deliveryScope(current);
        delete deliveryScopes[sessionId];
        const next = normalizeExtensionState({ ...current, ...slot, deliveryScopes, lastBoundSessionId: sessionId,
          bindingStatus: "AMBIGUOUS", bindingError: "PENDING_DELIVERY_SELECTED: Inspect the selected delivery before recovery." });
        await storageArea.set(next); return next;
      });
    },
    async clearDelivery(deliveryId, sessionId = null) {
      if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
        throw new ExtensionStateError("INVALID_DELIVERY_ID", "Delivery ID must be a non-empty string.");
      }
      return mutate(async () => {
        const current = await readStoredState();
        const previous = current.lastAcknowledgedDelivery;
        if (current.currentDeliveryId === null && previous?.deliveryId === deliveryId
          && previous.sessionId === current.lastBoundSessionId && previous.runId === current.lastBoundRunId
          && previous.conversationUrl === current.conversationUrl
          && (sessionId === null || previous.sessionId === sessionId)) return current;
        if (current.currentDeliveryId !== deliveryId
          || (sessionId !== null && current.lastBoundSessionId !== sessionId)) {
          throw new ExtensionStateError(
            "DELIVERY_ACK_MISMATCH",
            "Delivery acknowledgement does not match the persisted delivery.",
            { expectedDeliveryId: current.currentDeliveryId, expectedSessionId: current.lastBoundSessionId },
          );
        }
        const next = normalizeExtensionState({ ...current, currentDeliveryId: null,
          lastAcknowledgedDelivery: { deliveryId, sessionId: current.lastBoundSessionId,
            runId: current.lastBoundRunId, conversationUrl: current.conversationUrl, at: new Date().toISOString() } });
        await storageArea.set(next);
        return next;
      });
    },
    async clearLegacyTestDelivery() {
      return mutate(async () => {
        const current = await readStoredState();
        if (!isLegacyBridgeTestDelivery(current)) throw new ExtensionStateError("NO_LEGACY_TEST_DELIVERY", "삭제할 오래된 브릿지 테스트 전송이 없습니다.");
        const next = normalizeExtensionState({ ...current, currentDeliveryId: null, completedDelivery: null,
          bindingStatus: "NEEDS_REBIND", bindingError: "Legacy bridge-test delivery was cleared by the user." });
        await storageArea.set(next); return next;
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
