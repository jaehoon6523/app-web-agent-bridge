const RELAY_SAFE_CONFIDENCES = new Set([
  "CONFIRMED_BY_UI_STATE",
  "HEURISTIC",
]);

export class ExtensionTurnGuardError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionTurnGuardError";
    this.code = code;
    this.details = details;
  }
}

function requireNonEmptyString(value, label, code = "INVALID_DELIVERY_BINDING") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExtensionTurnGuardError(code, `${label} must be a non-empty string.`);
  }
  return value;
}

function requireTabId(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExtensionTurnGuardError(
      "INVALID_DELIVERY_BINDING",
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function createActiveTurnGate() {
  let activeReservation = null;

  return Object.freeze({
    get active() {
      return activeReservation !== null;
    },
    get activeRequestId() {
      return activeReservation?.requestId ?? null;
    },
    reserve(requestId) {
      const exactRequestId = requireNonEmptyString(requestId, "requestId", "INVALID_DELIVERY");
      if (activeReservation !== null) {
        throw new ExtensionTurnGuardError(
          "WEB_SESSION_BUSY",
          "The bound ChatGPT conversation is already processing another delivery.",
          { activeRequestId: activeReservation.requestId },
        );
      }
      activeReservation = Object.freeze({ requestId: exactRequestId });
      return activeReservation;
    },
    assertIdle(operation) {
      if (activeReservation === null) return;
      throw new ExtensionTurnGuardError(
        "WEB_SESSION_BUSY",
        `${operation || "This operation"} is blocked while a Web turn is active.`,
        { activeRequestId: activeReservation.requestId },
      );
    },
    release(reservation) {
      if (reservation !== activeReservation) return false;
      activeReservation = null;
      return true;
    },
  });
}

export function captureTurnBinding(state, {
  requestId,
  controllerMessageId,
  runId,
} = {}) {
  if (!state || typeof state !== "object" || state.bindingStatus !== "BOUND") {
    throw new ExtensionTurnGuardError(
      "NEEDS_REBIND",
      "A turn requires a persisted exact ChatGPT Web session binding.",
    );
  }
  const snapshot = {
    requestId: requireNonEmptyString(requestId, "requestId", "INVALID_DELIVERY"),
    controllerMessageId: requireNonEmptyString(
      controllerMessageId,
      "controllerMessageId",
      "INVALID_DELIVERY",
    ),
    sessionId: requireNonEmptyString(state.lastBoundSessionId, "sessionId"),
    runId: requireNonEmptyString(runId, "runId", "INVALID_DELIVERY"),
    conversationUrl: requireNonEmptyString(state.conversationUrl, "conversationUrl"),
    conversationId: requireNonEmptyString(state.conversationId, "conversationId"),
    tabId: requireTabId(state.tabId, "tabId"),
    windowId: requireTabId(state.windowId, "windowId"),
  };
  if (snapshot.runId !== state.lastBoundRunId) {
    throw new ExtensionTurnGuardError(
      "DELIVERY_BINDING_MISMATCH",
      "Delivery run ID does not match the persisted Web session binding.",
    );
  }
  if (state.currentDeliveryId !== snapshot.requestId) {
    throw new ExtensionTurnGuardError(
      "DELIVERY_BINDING_MISMATCH",
      "The reserved delivery does not match the active Web turn.",
      { currentDeliveryId: state.currentDeliveryId },
    );
  }
  return Object.freeze(snapshot);
}

function observedStateBinding(state) {
  return {
    requestId: state?.currentDeliveryId,
    sessionId: state?.lastBoundSessionId,
    runId: state?.lastBoundRunId,
    conversationUrl: state?.conversationUrl,
    conversationId: state?.conversationId,
    tabId: state?.tabId,
    windowId: state?.windowId,
    bindingStatus: state?.bindingStatus,
  };
}

function observedSessionBinding(session, requestId) {
  return {
    requestId,
    sessionId: session?.sessionId,
    runId: session?.runId,
    conversationUrl: session?.conversationUrl,
    conversationId: session?.conversationId,
    tabId: session?.tabId,
    windowId: session?.windowId,
    bindingStatus: session?.bindingStatus,
  };
}

function assertBindingFields(expected, observed) {
  for (const key of [
    "requestId",
    "sessionId",
    "runId",
    "conversationUrl",
    "conversationId",
    "tabId",
    "windowId",
  ]) {
    if (observed[key] !== expected[key]) {
      throw new ExtensionTurnGuardError(
        "TURN_BINDING_CHANGED",
        `The Web turn binding changed at ${key}.`,
        { field: key, expected: expected[key], observed: observed[key] ?? null },
      );
    }
  }
  if (observed.bindingStatus !== "BOUND") {
    throw new ExtensionTurnGuardError(
      "TURN_BINDING_CHANGED",
      "The Web session is no longer exactly bound.",
      { observedBindingStatus: observed.bindingStatus ?? null },
    );
  }
}

export function assertTurnStateBinding(expected, state) {
  assertBindingFields(expected, observedStateBinding(state));
  return state;
}

export function assertTurnSessionBinding(expected, session) {
  assertBindingFields(expected, observedSessionBinding(session, expected.requestId));
  return session;
}

export function assertTurnTabBinding(expected, tab, canonicalUrl, conversationId) {
  const observed = {
    requestId: expected.requestId,
    sessionId: expected.sessionId,
    runId: expected.runId,
    conversationUrl: canonicalUrl,
    conversationId,
    tabId: tab?.id,
    windowId: tab?.windowId,
    bindingStatus: "BOUND",
  };
  assertBindingFields(expected, observed);
  return tab;
}

export function assertRelaySafeCompletion(result, expected) {
  if (!result || typeof result !== "object" || !RELAY_SAFE_CONFIDENCES.has(result.confidence)) {
    throw new ExtensionTurnGuardError(
      "AMBIGUOUS_COMPLETION",
      "ChatGPT response completion was not returned with a relay-safe confidence.",
      { confidence: result?.confidence ?? null },
    );
  }
  if (typeof result.text !== "string" || result.text.trim().length === 0) {
    throw new ExtensionTurnGuardError(
      "AMBIGUOUS_COMPLETION",
      "ChatGPT returned no non-empty response text.",
    );
  }
  if (
    result.evidence?.conversationUrl !== expected.conversationUrl
    || result.evidence?.conversationId !== expected.conversationId
  ) {
    throw new ExtensionTurnGuardError(
      "TURN_BINDING_CHANGED",
      "ChatGPT completion evidence does not match the frozen conversation binding.",
      {
        observedConversationUrl: result.evidence?.conversationUrl ?? null,
        observedConversationId: result.evidence?.conversationId ?? null,
      },
    );
  }
  return result;
}
