import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { validateRuntimeEventType } from "../runtime-events.js";
import { WebExtensionAuthenticator } from "./auth.js";
import { createWebSessionBinding, validateWebSessionBinding } from "./binding.js";
import { parseFinalControllerPacket } from "./controller-packet.js";
import {
  WEB_BRIDGE_PROTOCOL_VERSION,
  WebAuthenticationState,
  WebBindingStatus,
  WebCompletionConfidence,
  WebProtocolError,
  assertProtocolEnvelope,
} from "./protocol.js";

/**
 * @typedef {object} WebSessionBindingValue
 * @property {string} sessionId
 * @property {string} runId
 * @property {number | null} tabId
 * @property {number | null} windowId
 * @property {string | null} conversationUrl
 * @property {string | null} conversationId
 * @property {string | null} title
 * @property {string | null} lastObservedUserMessageId
 * @property {string | null} lastObservedAssistantMessageId
 * @property {string} bindingStatus
 */

function socketIsOpen(socket) {
  return socket?.readyState === 1;
}

const AMBIGUOUS_WEB_TURN_CODES = new Set([
  "WEB_TURN_AMBIGUOUS",
  "MANUAL_INTERVENTION_DETECTED",
]);

const SESSION_INVALIDATING_CODES = new Set([
  "MANUAL_INTERVENTION_DETECTED",
  "SESSION_AUTH_REQUIRED",
  "AUTH_REQUIRED",
  "WEB_SESSION_BINDING_MISSING",
  "WEB_SESSION_BINDING_MISMATCH",
]);

function safeParse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new WebProtocolError("Extension sent invalid JSON", "INVALID_JSON");
  }
}

// Authenticated transport only. AgentSession lifecycle semantics are provided by
// ChatGptWebSessionAdapter below rather than being inferred from socket state.
export class WebExtensionTransport extends EventEmitter {
  #authentication = null;
  #authenticationState = WebAuthenticationState.DISCONNECTED;
  #authenticator;
  #binding = null;
  #socket = null;

  constructor(authenticationOptions = {}) {
    super();
    this.#authenticator = new WebExtensionAuthenticator(authenticationOptions);
  }

  get authenticated() {
    return this.#authenticationState === WebAuthenticationState.AUTHENTICATED;
  }

  get snapshot() {
    return Object.freeze({
      authenticationState: this.#authenticationState,
      authenticated: this.authenticated,
      extensionIdentity: this.#authentication?.extensionIdentity ?? null,
      binding: this.#binding,
      connected: socketIsOpen(this.#socket),
    });
  }

  attach(socket) {
    if (!socket || typeof socket.on !== "function" || typeof socket.send !== "function") {
      throw new WebProtocolError("A WebSocket-compatible peer is required", "INVALID_SOCKET");
    }
    if (
      this.#socket
      && this.#socket !== socket
      && this.authenticated
      && socketIsOpen(this.#socket)
    ) {
      this.emit("diagnostic", Object.freeze({
        type: "EXTENSION_CONNECTION_REJECTED",
        code: "AUTHENTICATED_EXTENSION_ALREADY_CONNECTED",
      }));
      this.#closeSocket(socket, 4409, "Authenticated extension already connected");
      return;
    }
    if (this.#socket && this.#socket !== socket) {
      this.#closeSocket(this.#socket, 4001, "Replaced by a newer extension connection");
    }
    this.#socket = socket;
    this.#authentication = null;
    this.#authenticationState = WebAuthenticationState.CHALLENGE_SENT;
    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("close", () => this.#onClose(socket));
    socket.on("error", () => this.emit("diagnostic", Object.freeze({
      type: "WEB_SOCKET_ERROR",
      code: "WEB_SOCKET_ERROR",
    })));
    this.#sendRaw(this.#authenticator.issueChallenge());
    this.emit("state", this.snapshot);
  }

  setBinding(binding) {
    validateWebSessionBinding(binding);
    this.#binding = createWebSessionBinding(binding);
    this.emit("binding", this.#binding);
    return this.#binding;
  }

  send(message) {
    if (!this.authenticated) {
      throw new WebProtocolError(
        "Cannot send an extension command before authentication",
        "EXTENSION_NOT_AUTHENTICATED",
      );
    }
    const envelope = {
      ...structuredClone(message),
      protocolVersion: WEB_BRIDGE_PROTOCOL_VERSION,
    };
    if (typeof envelope.type !== "string" || envelope.type.length === 0) {
      throw new WebProtocolError("Outgoing message type is required", "INVALID_MESSAGE");
    }
    this.#sendRaw(envelope);
  }

  close() {
    if (this.#socket) this.#closeSocket(this.#socket, 1000, "Controller closed extension session");
    this.#socket = null;
    this.#authentication = null;
    this.#authenticationState = WebAuthenticationState.DISCONNECTED;
    this.emit("state", this.snapshot);
  }

  onEvent(listener) {
    this.on("runtimeEvent", listener);
    return () => this.off("runtimeEvent", listener);
  }

  #onMessage(socket, raw) {
    if (socket !== this.#socket) return;
    let message;
    try {
      message = assertProtocolEnvelope(safeParse(raw));
    } catch (error) {
      this.emit("diagnostic", Object.freeze({
        type: "PROTOCOL_MESSAGE_IGNORED",
        code: error.code || "INVALID_MESSAGE",
      }));
      return;
    }

    if (!this.authenticated) {
      if (message.type !== "extension.auth.response") {
        this.emit("diagnostic", Object.freeze({
          type: "UNAUTHENTICATED_MESSAGE_IGNORED",
          messageType: message.type,
        }));
        return;
      }
      this.#authenticate(socket, message);
      return;
    }

    if (message.type === "extension.auth.response") {
      this.emit("diagnostic", Object.freeze({
        type: "AUTH_REPLAY_IGNORED",
        messageType: message.type,
      }));
      return;
    }

    this.emit("message", message);
    this.emit("diagnostic", Object.freeze({
      type: "WEB_EXTENSION_MESSAGE",
      messageType: message.type,
      requestId: typeof message.requestId === "string" ? message.requestId : null,
    }));
  }

  #authenticate(socket, message) {
    try {
      this.#authentication = this.#authenticator.verifyResponse(message);
      this.#authenticationState = WebAuthenticationState.AUTHENTICATED;
      this.#sendRaw({
        type: "controller.auth.accepted",
        protocolVersion: WEB_BRIDGE_PROTOCOL_VERSION,
        challengeId: this.#authentication.challengeId,
      });
      this.emit("authenticated", this.snapshot);
      this.emit("state", this.snapshot);
    } catch (error) {
      this.#authentication = null;
      this.#authenticationState = WebAuthenticationState.REJECTED;
      if (socketIsOpen(socket)) {
        socket.send(JSON.stringify({
          type: "controller.auth.rejected",
          protocolVersion: WEB_BRIDGE_PROTOCOL_VERSION,
          code: error.code || "AUTHENTICATION_FAILED",
        }));
      }
      this.emit("diagnostic", Object.freeze({
        type: "AUTHENTICATION_REJECTED",
        code: error.code || "AUTHENTICATION_FAILED",
      }));
      this.emit("state", this.snapshot);
      this.#closeSocket(socket, 4403, "Extension authentication rejected");
    }
  }

  #onClose(socket) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#authentication = null;
    this.#authenticationState = WebAuthenticationState.DISCONNECTED;
    this.emit("runtimeEvent", Object.freeze({
      type: "SESSION_DISCONNECTED",
      occurredAt: new Date().toISOString(),
      sessionId: this.#binding?.sessionId ?? null,
      turnId: null,
      payload: Object.freeze({ reason: "WEB_SOCKET_CLOSED" }),
    }));
    this.emit("state", this.snapshot);
  }

  #sendRaw(message) {
    if (!socketIsOpen(this.#socket)) {
      throw new WebProtocolError("Extension socket is not open", "EXTENSION_DISCONNECTED");
    }
    this.#socket.send(JSON.stringify(message));
  }

  #closeSocket(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // The state transition remains fail-closed even if the peer already disappeared.
    }
  }
}

export class ChatGptWebSessionAdapter {
  #activeTurnId = null;
  #ambiguousTurnId = null;
  #events = new EventEmitter();
  #interrupts = new Map();
  #pending = new Map();
  #responseTimeoutMs;
  #ready = false;
  #sessionOperation = null;
  #transport;

  /**
   * @param {{transport?: WebExtensionTransport, responseTimeoutMs?: number}} [options]
   */
  constructor({ transport, responseTimeoutMs = 300_000 } = {}) {
    if (!(transport instanceof WebExtensionTransport)) {
      throw new WebProtocolError(
        "ChatGptWebSessionAdapter requires a WebExtensionTransport",
        "INVALID_WEB_TRANSPORT",
      );
    }
    if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1) {
      throw new WebProtocolError("responseTimeoutMs must be positive", "INVALID_WEB_ADAPTER_CONFIG");
    }
    this.#transport = transport;
    this.#responseTimeoutMs = responseTimeoutMs;
    transport.on("message", (message) => this.#onMessage(message));
    transport.on("runtimeEvent", (event) => this.#handleTransportRuntimeEvent(event));
    transport.on("diagnostic", (event) => this.#events.emit("diagnostic", event));
  }

  get actor() {
    return "CHATGPT_WEB_AGENT";
  }

  // The durable external identity is the exact ChatGPT conversation, never a
  // transient browser tab id or an extension socket.
  get externalSessionId() {
    return this.#transport.snapshot.binding?.conversationId ?? null;
  }

  /** @param {{binding?: WebSessionBindingValue, focus?: boolean}} [input] */
  async start({ binding, focus = false } = {}) {
    validateWebSessionBinding(binding);
    if (!this.#transport.authenticated) {
      throw new WebProtocolError("Web extension is not authenticated", "EXTENSION_NOT_AUTHENTICATED");
    }
    if (binding.bindingStatus !== "BOUND" || binding.tabId === null) {
      throw new WebProtocolError(
        "Starting a Web session requires an explicit exact tab binding",
        "EXPLICIT_REBIND_REQUIRED",
      );
    }
    this.#beginSessionOperation("START");
    this.#ready = false;
    try {
      const message = await this.#request({
        type: "web.session.rebind",
        payload: this.#bindingPayload(binding, { tabId: binding.tabId, focus }),
      }, new Set(["web.session.ready", "web.session.error"]), 60_000);
      if (message.type === "web.session.error") throw this.#messageError(message);
      this.#acceptReturnedBinding(message.payload?.session, { expectedBinding: binding });
      this.#ready = true;
      this.#emitRuntimeEvent(this.#runtimeEvent("SESSION_READY", null, {
        binding: this.#transport.snapshot.binding,
        resumed: false,
      }));
      return this.#transport.snapshot.binding;
    } catch (error) {
      this.#ready = false;
      throw error;
    } finally {
      this.#sessionOperation = null;
    }
  }

  /** @param {{binding?: WebSessionBindingValue, focus?: boolean}} [input] */
  async resume({ binding, focus = false } = {}) {
    validateWebSessionBinding(binding);
    if (!this.#transport.authenticated) {
      throw new WebProtocolError("Web extension is not authenticated", "EXTENSION_NOT_AUTHENTICATED");
    }
    if (!binding.conversationUrl || !binding.conversationId) {
      throw new WebProtocolError(
        "Resuming a Web session requires an exact conversation binding",
        "EXPLICIT_REBIND_REQUIRED",
      );
    }
    this.#beginSessionOperation("RESUME");
    this.#ready = false;
    try {
      const message = await this.#request({
        type: "web.session.prepare",
        payload: this.#bindingPayload(binding, { focus }),
      }, new Set(["web.session.ready", "web.session.error"]), 60_000);
      if (message.type === "web.session.error") throw this.#messageError(message);
      this.#acceptReturnedBinding(message.payload?.session, {
        expectedBinding: binding,
        allowTabRelocation: true,
      });
      this.#ready = true;
      this.#emitRuntimeEvent(this.#runtimeEvent("SESSION_READY", null, {
        binding: this.#transport.snapshot.binding,
        resumed: true,
      }));
      return this.#transport.snapshot.binding;
    } catch (error) {
      this.#ready = false;
      throw error;
    } finally {
      this.#sessionOperation = null;
    }
  }

  async inspect() {
    return Object.freeze({
      ...this.#transport.snapshot,
      sessionReady: this.#ready,
      ambiguousTurnId: this.#ambiguousTurnId,
    });
  }

  /**
   * @param {{
   *   turnId?: string,
   *   controllerMessageId?: string,
   *   runId?: string,
   *   text?: string,
   *   timeoutMs?: number,
   *   stableMs?: number
   * }} [input]
   */
  async submitTurn({
    turnId,
    controllerMessageId,
    runId,
    text,
    timeoutMs = this.#responseTimeoutMs,
    stableMs,
  } = {}) {
    this.#assertNoAmbiguousTurn();
    if (!this.#ready) {
      throw new WebProtocolError("Web session has not been confirmed ready", "WEB_SESSION_NOT_READY");
    }
    const binding = this.#transport.snapshot.binding;
    if (!binding || binding.bindingStatus !== "BOUND") {
      throw new WebProtocolError("Web session requires exact binding", "NEEDS_REBIND");
    }
    if (runId !== binding.runId) {
      throw new WebProtocolError("Turn run ID does not match Web session", "DELIVERY_BINDING_MISMATCH");
    }
    if (typeof turnId !== "string" || !turnId || typeof controllerMessageId !== "string" || !controllerMessageId) {
      throw new WebProtocolError("turnId and controllerMessageId are required", "INVALID_WEB_TURN");
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new WebProtocolError("Web turn text must be non-empty", "INVALID_WEB_TURN");
    }
    if (this.#activeTurnId !== null) {
      throw new WebProtocolError("Another Web turn is already active", "WEB_SESSION_BUSY");
    }

    let response;
    try {
      response = this.#request({
        type: "web.prompt",
        requestId: turnId,
        payload: {
          controllerMessageId,
          runId,
          text,
          timeoutMs,
          ...(Number.isSafeInteger(stableMs) ? { stableMs } : {}),
        },
      }, new Set(["web.prompt.result", "web.prompt.error", "web.prompt.cancelled"]), timeoutMs + 15_000, turnId);
    } catch (error) {
      // A command that never reached the authenticated transport is not a started turn.
      throw error;
    }

    this.#activeTurnId = turnId;
    this.#emitRuntimeEvent(this.#runtimeEvent("TURN_STARTED", turnId, {
      controllerMessageId,
    }));
    const completion = this.#completeTurn(turnId, response);
    return Object.freeze({ turnId, completion });
  }

  async #completeTurn(turnId, response) {
    try {
      const message = await response;
      if (message.type === "web.prompt.error") throw this.#messageError(message);
      if (message.type === "web.prompt.cancelled") {
        throw new WebProtocolError("Web turn was interrupted", "TURN_INTERRUPTED");
      }
      const confidence = message.payload?.confidence;
      if (
        ![
          WebCompletionConfidence.CONFIRMED_BY_UI_STATE,
          WebCompletionConfidence.HEURISTIC,
        ].includes(confidence)
        || typeof message.payload?.text !== "string"
        || !message.payload.text.trim()
      ) {
        throw new WebProtocolError("Web result is not safe for automatic relay", "AMBIGUOUS_COMPLETION");
      }
      const parsed = parseFinalControllerPacket(message.payload.text);
      this.#acceptReturnedBinding(message.payload?.session);
      this.#emitRuntimeEvent(this.#runtimeEvent("TURN_COMPLETED", turnId, {
        confidence,
        packetType: parsed.packet.type,
        evidence: message.payload.evidence ?? null,
      }));
      return Object.freeze({
        turnId,
        text: parsed.body,
        rawText: message.payload.text,
        packet: parsed.packet,
        packetText: parsed.packetText,
        confidence,
        evidence: message.payload.evidence ?? null,
        binding: this.#transport.snapshot.binding,
      });
    } catch (error) {
      const ambiguous = AMBIGUOUS_WEB_TURN_CODES.has(error?.code);
      if (this.#failureInvalidatesSession(error)) this.#ready = false;
      this.#emitRuntimeEvent(this.#runtimeEvent(
        error?.code === "TURN_INTERRUPTED" ? "TURN_INTERRUPTED" : "TURN_FAILED",
        turnId,
        {
          code: error?.code || "WEB_EXTENSION_ERROR",
          ambiguous,
          recoveryRequired: ambiguous,
        },
      ));
      throw error;
    } finally {
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
    }
  }

  /** @param {{turnId?: string}} [input] */
  async interrupt({ turnId } = {}) {
    if (typeof turnId !== "string" || !turnId) {
      throw new WebProtocolError("turnId is required for interrupt", "INVALID_WEB_TURN");
    }
    if (!this.#pending.has(turnId)) {
      throw new WebProtocolError("The requested Web turn is not active", "TURN_NOT_ACTIVE");
    }
    const existing = this.#interrupts.get(turnId);
    if (existing) return existing.promise;
    let resolveInterrupt;
    let rejectInterrupt;
    const promise = new Promise((resolve, reject) => {
      resolveInterrupt = resolve;
      rejectInterrupt = reject;
    });
    const timer = setTimeout(() => {
      this.#interrupts.delete(turnId);
      rejectInterrupt(new WebProtocolError(
        "Web turn interruption was not confirmed",
        "INTERRUPT_NOT_CONFIRMED",
      ));
    }, 15_000);
    this.#interrupts.set(turnId, {
      promise,
      resolve: resolveInterrupt,
      reject: rejectInterrupt,
      timer,
    });
    try {
      this.#transport.send({ type: "web.cancel", requestId: turnId });
    } catch (error) {
      clearTimeout(timer);
      this.#interrupts.delete(turnId);
      rejectInterrupt(error);
    }
    return promise;
  }

  /** @param {{turnId?: string}} [input] */
  async acknowledgeDelivery({ turnId } = {}) {
    if (typeof turnId !== "string" || !turnId) {
      throw new WebProtocolError("turnId is required for delivery acknowledgement", "INVALID_WEB_TURN");
    }
    this.#transport.send({ type: "web.delivery.ack", requestId: turnId });
  }

  async close() {
    this.#ready = false;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new WebProtocolError("Web session closed", "EXTENSION_DISCONNECTED"));
    }
    this.#pending.clear();
    this.#activeTurnId = null;
    for (const entry of this.#interrupts.values()) {
      clearTimeout(entry.timer);
      entry.reject(new WebProtocolError("Web session closed", "EXTENSION_DISCONNECTED"));
    }
    this.#interrupts.clear();
    this.#transport.close();
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("RuntimeEventListener must be a function");
    this.#events.on("runtimeEvent", listener);
    return () => this.#events.off("runtimeEvent", listener);
  }

  onDiagnostic(listener) {
    if (typeof listener !== "function") throw new TypeError("Diagnostic listener must be a function");
    this.#events.on("diagnostic", listener);
    return () => this.#events.off("diagnostic", listener);
  }

  #bindingPayload(binding, additional = {}) {
    return {
      sessionId: binding.sessionId,
      runId: binding.runId,
      conversationUrl: binding.conversationUrl,
      conversationId: binding.conversationId,
      ...additional,
    };
  }

  #acceptReturnedBinding(
    value,
    {
      expectedBinding = this.#transport.snapshot.binding,
      allowTabRelocation = false,
    } = {},
  ) {
    if (!value) {
      throw new WebProtocolError(
        "Web response did not include observed session binding",
        "WEB_SESSION_BINDING_MISSING",
      );
    }
    const current = expectedBinding;
    if (!current) {
      throw new WebProtocolError(
        "A returned Web binding cannot establish unrequested session identity",
        "WEB_SESSION_BINDING_MISMATCH",
      );
    }
    const next = createWebSessionBinding(value);
    for (const key of ["sessionId", "runId", "conversationUrl", "conversationId"]) {
      if (next[key] !== current[key]) {
        throw new WebProtocolError(
          `Returned Web binding changed immutable ${key}`,
          "WEB_SESSION_BINDING_MISMATCH",
        );
      }
    }
    if (
      !allowTabRelocation
      && (next.tabId !== current.tabId || next.windowId !== current.windowId)
    ) {
      throw new WebProtocolError(
        "Returned Web binding changed the active tab during a bound operation",
        "WEB_SESSION_BINDING_MISMATCH",
      );
    }
    if (next.bindingStatus !== WebBindingStatus.BOUND) {
      throw new WebProtocolError(
        "Returned Web binding is no longer exact",
        "WEB_SESSION_BINDING_MISMATCH",
      );
    }
    this.#transport.setBinding(next);
  }

  #request(message, expectedTypes, timeoutMs, explicitRequestId = null) {
    const requestId = explicitRequestId ?? `web_${randomUUID()}`;
    if (this.#pending.has(requestId)) {
      throw new WebProtocolError("A Web request with this ID is already pending", "DUPLICATE_WEB_REQUEST");
    }
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      this.#pending.delete(requestId);
      if (message.type === "web.prompt") {
        this.#ambiguousTurnId = requestId;
        rejectRequest(new WebProtocolError(
          "Web prompt timed out after submission; its outcome is ambiguous",
          "WEB_TURN_AMBIGUOUS",
        ));
        return;
      }
      rejectRequest(new WebProtocolError("Web extension response timed out", "WEB_RESPONSE_TIMEOUT"));
    }, timeoutMs);
    this.#pending.set(requestId, {
      resolve: resolveRequest,
      reject: rejectRequest,
      expectedTypes,
      requestType: message.type,
      timer,
    });
    try {
      this.#transport.send({ ...message, requestId });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(requestId);
      throw error;
    }
    return promise;
  }

  #onMessage(message) {
    if (message.type === "web.prompt.progress") {
      this.#emitRuntimeEvent(this.#runtimeEvent("TEXT_DELTA", message.requestId ?? null, {
        text: typeof message.payload?.text === "string" ? message.payload.text : "",
        evidence: message.payload?.evidence ?? null,
      }));
      return;
    }
    if (message.type === "web.manual-intervention") {
      const pending = this.#pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.requestId);
        this.#ready = false;
        this.#ambiguousTurnId = message.requestId;
        pending.reject(new WebProtocolError(
          "Manual intervention was detected in the bound conversation",
          "MANUAL_INTERVENTION_DETECTED",
          message.payload ?? null,
        ));
      }
      this.#settleInterrupt(message.requestId, false, "MANUAL_INTERVENTION_DETECTED");
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending || !pending.expectedTypes.has(message.type)) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);

    if (message.type === "web.prompt.cancelled") {
      this.#settleInterrupt(message.requestId, true);
    } else {
      this.#settleInterrupt(message.requestId, false, "INTERRUPT_NOT_CONFIRMED");
    }

    pending.resolve(message);
  }

  #messageError(message) {
    return new WebProtocolError(
      message.payload?.message || "ChatGPT Web extension operation failed",
      message.payload?.code || "WEB_EXTENSION_ERROR",
      message.payload?.details ?? null,
    );
  }

  #runtimeEvent(type, turnId, payload) {
    return Object.freeze({
      type,
      occurredAt: new Date().toISOString(),
      sessionId: this.#transport.snapshot.binding?.sessionId ?? null,
      turnId,
      payload: Object.freeze(structuredClone(payload)),
    });
  }

  #emitRuntimeEvent(event) {
    validateRuntimeEventType(event?.type);
    this.#events.emit("runtimeEvent", event);
  }

  #handleTransportRuntimeEvent(event) {
    this.#emitRuntimeEvent(event);
    if (event.type !== "SESSION_DISCONNECTED") return;
    this.#ready = false;
    for (const [requestId, pending] of this.#pending.entries()) {
      clearTimeout(pending.timer);
      if (pending.requestType === "web.prompt") {
        this.#ambiguousTurnId = requestId;
        pending.reject(new WebProtocolError(
          "Web extension disconnected after prompt submission; its outcome is ambiguous",
          "WEB_TURN_AMBIGUOUS",
        ));
      } else {
        pending.reject(new WebProtocolError("Web extension disconnected", "EXTENSION_DISCONNECTED"));
      }
    }
    this.#pending.clear();
    this.#activeTurnId = null;
    for (const interrupt of this.#interrupts.values()) {
      clearTimeout(interrupt.timer);
      interrupt.reject(new WebProtocolError("Web extension disconnected", "EXTENSION_DISCONNECTED"));
    }
    this.#interrupts.clear();
  }

  #assertNoAmbiguousTurn() {
    if (this.#ambiguousTurnId !== null) {
      throw new WebProtocolError(
        `Web turn ${this.#ambiguousTurnId} requires recovery before another operation`,
        "WEB_TURN_AMBIGUOUS_UNRESOLVED",
      );
    }
  }

  #beginSessionOperation(operation) {
    this.#assertNoAmbiguousTurn();
    if (
      this.#activeTurnId !== null
      || this.#sessionOperation !== null
      || this.#pending.size > 0
    ) {
      throw new WebProtocolError(
        "A Web session operation is already active",
        "WEB_SESSION_BUSY",
      );
    }
    this.#sessionOperation = operation;
  }

  #failureInvalidatesSession(error) {
    return SESSION_INVALIDATING_CODES.has(error?.code);
  }

  #settleInterrupt(turnId, confirmed, code = "INTERRUPT_NOT_CONFIRMED") {
    const interrupt = this.#interrupts.get(turnId);
    if (!interrupt) return;
    clearTimeout(interrupt.timer);
    this.#interrupts.delete(turnId);
    if (confirmed) {
      interrupt.resolve();
    } else {
      interrupt.reject(new WebProtocolError("Web turn interruption was not confirmed", code));
    }
  }
}
