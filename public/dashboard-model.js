export const ACTORS = Object.freeze(["CODEX_AGENT", "CHATGPT_WEB_AGENT"]);

const DELIVERY_STATES = new Set([
  "PENDING",
  "DISPATCHING",
  "SUBMITTED",
  "RESPONSE_STARTED",
  "RESPONSE_COMPLETED",
  "RELAYED",
  "FAILED",
  "AMBIGUOUS",
]);

function optionalArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}

function optionalObject(value, name) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function normalizeRun(value) {
  const run = optionalObject(value, "run");
  if (!run) return null;
  const runId = run.runId ?? run.id;
  if (typeof runId !== "string" || !runId) throw new TypeError("run.runId is required.");
  if (!Number.isSafeInteger(run.version) || run.version < 1) {
    throw new TypeError("run.version must be a positive safe integer.");
  }
  return Object.freeze({
    ...run,
    runId,
    phase: String(run.phase ?? run.status ?? "UNKNOWN"),
    currentTurn: Number.isSafeInteger(run.currentTurn) ? run.currentTurn : 0,
    maxTurns: Number.isSafeInteger(run.maxTurns) ? run.maxTurns : 0,
    activeActor: ACTORS.includes(run.activeActor) ? run.activeActor : null,
    paused: run.paused === true,
  });
}

function normalizeSessions(value) {
  const records = optionalArray(value, "sessions");
  const sessions = new Map();
  for (const session of records) {
    if (!session || !ACTORS.includes(session.actor)) continue;
    if (sessions.has(session.actor)) {
      throw new TypeError(`Duplicate session for ${session.actor}.`);
    }
    sessions.set(session.actor, Object.freeze({ ...session }));
  }
  return sessions;
}

export function normalizeDashboardState(value) {
  if (value == null) {
    return Object.freeze({
      run: null,
      sessions: new Map(),
      messages: [],
      deliveries: [],
      approvals: [],
      events: [],
      commandCapabilities: new Set(),
    });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Dashboard state must be an object.");
  }
  const capabilities = optionalArray(value.commandCapabilities, "commandCapabilities");
  return Object.freeze({
    run: normalizeRun(value.run),
    sessions: normalizeSessions(value.sessions),
    messages: optionalArray(value.messages, "messages"),
    deliveries: optionalArray(value.deliveries, "deliveries"),
    approvals: optionalArray(value.approvals, "approvals"),
    events: optionalArray(value.events, "events"),
    commandCapabilities: new Set(capabilities.filter((item) => typeof item === "string")),
  });
}

export function buildCommandEnvelope({
  type,
  requestId,
  run,
  payload = {},
  allowWithoutRun = false,
}) {
  if (typeof type !== "string" || !type) throw new TypeError("type is required.");
  if (typeof requestId !== "string" || !requestId) throw new TypeError("requestId is required.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object.");
  }

  if (!run) {
    if (!allowWithoutRun) throw new TypeError(`${type} requires a canonical run.`);
    return Object.freeze({
      type,
      requestId,
      payload: Object.freeze({ ...payload, expectedVersion: 0 }),
    });
  }

  if (typeof run.runId !== "string" || !run.runId) throw new TypeError("run.runId is required.");
  if (!Number.isSafeInteger(run.version) || run.version < 1) {
    throw new TypeError("run.version must be a positive safe integer.");
  }
  return Object.freeze({
    type,
    requestId,
    payload: Object.freeze({
      ...payload,
      runId: run.runId,
      expectedVersion: run.version,
    }),
  });
}

export function statusKind(status) {
  const normalized = String(status || "").toUpperCase();
  if (["READY", "WAITING", "COMPLETE", "RELAYED", "RESPONSE_COMPLETED", "BOUND"].includes(normalized)) {
    return "ok";
  }
  if ([
    "CREATING",
    "RUNNING",
    "STARTING_SESSIONS",
    "CODEX_TURN_PENDING",
    "CODEX_TURN_RUNNING",
    "CODEX_TO_WEB_PENDING",
    "WEB_TURN_RUNNING",
    "WEB_TO_CODEX_PENDING",
    "CONSENSUS_CHECK",
    "DISPATCHING",
    "SUBMITTED",
    "RESPONSE_STARTED",
  ].includes(normalized)) return "busy";
  if ([
    "FAILED",
    "DISCONNECTED",
    "AUTH_REQUIRED",
    "RECOVERY_REQUIRED",
    "AMBIGUOUS",
    "CANCELLED",
    "NOT_AVAILABLE",
  ].includes(normalized)) return "bad";
  return "neutral";
}

export function classifyMessageOrigin(message) {
  const source = String(message?.origin ?? message?.source ?? "").toUpperCase();
  if (["HUMAN", "USER", "MANUAL"].includes(source) || message?.humanAuthored === true) {
    return Object.freeze({ label: "HUMAN INPUT", cssClass: "human" });
  }
  if (["CONTROLLER", "CONTROLLER_RELAY", "RELAY"].includes(source)
      || message?.fromActor === "CONTROLLER") {
    return Object.freeze({ label: "CONTROLLER RELAY", cssClass: "relay" });
  }
  if (ACTORS.includes(message?.fromActor) || ACTORS.includes(message?.actor)) {
    return Object.freeze({ label: "AGENT OUTPUT", cssClass: "agent" });
  }
  return Object.freeze({ label: "UNCLASSIFIED", cssClass: "unknown" });
}

export function selectMessagesForActor(messages, actor, runId = null) {
  if (!ACTORS.includes(actor)) throw new TypeError(`Unknown actor: ${actor}`);
  return optionalArray(messages, "messages")
    .filter((message) => {
      if (!message || typeof message !== "object") return false;
      if (runId && message.runId !== runId) return false;
      if (message.actor === actor) return true;
      if (message.fromActor === actor) return true;
      return message.toActor === actor;
    })
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
}

export function deliveryState(delivery) {
  const state = String(delivery?.state ?? delivery?.status ?? "UNKNOWN").toUpperCase();
  return DELIVERY_STATES.has(state) ? state : "UNKNOWN";
}

export function sessionFieldRows(actor, session) {
  if (!ACTORS.includes(actor)) throw new TypeError(`Unknown actor: ${actor}`);
  if (!session) {
    return actor === "CODEX_AGENT"
      ? [["thread ID", "—"], ["active turn ID", "—"], ["sandbox", "—"], ["approval policy", "—"], ["last resumed", "—"]]
      : [["conversation ID", "—"], ["conversation URL", "—"], ["tab / window", "—"], ["login", "—"], ["binding confidence", "—"], ["last message ID", "—"]];
  }
  if (actor === "CODEX_AGENT") {
    return [
      ["thread ID", session.externalSessionId ?? session.threadId ?? "—"],
      ["active turn ID", session.activeTurnId ?? "—"],
      ["sandbox", session.sandbox ?? "—"],
      ["approval policy", session.approvalPolicy ?? "—"],
      ["last resumed", session.lastResumedAt ?? "—"],
    ];
  }
  return [
    ["conversation ID", session.conversationId ?? session.externalSessionId ?? "—"],
    ["conversation URL", session.conversationUrl ?? session.externalLocator ?? "—"],
    ["tab / window", `${session.tabId ?? "—"} / ${session.windowId ?? "—"}`],
    ["login", session.loginStatus ?? "—"],
    ["binding confidence", session.bindingConfidence ?? session.bindingStatus ?? "—"],
    ["last message ID", session.lastObservedAssistantMessageId ?? session.lastObservedMessageId ?? "—"],
  ];
}
