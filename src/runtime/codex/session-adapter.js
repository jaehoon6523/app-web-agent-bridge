import { EventEmitter } from "node:events";
import path from "node:path";
import {
  assertStrictOutputSchema,
  buildCodexSandboxPolicy,
  compileOutputSchema,
  copyValidationErrors,
  jsonClone,
  requireAbsoluteRoot,
  validateApprovalPolicy,
} from "./configuration.js";
import {
  CodexAuthoritativeOutputInvalidError,
  CodexAuthoritativeOutputMissingError,
  CodexConfigurationError,
  CodexProtocolError,
  CodexSessionStateError,
  CodexThreadPersistenceError,
  CodexTransportClosedError,
  CodexTurnAmbiguousError,
  CodexTurnFailedError,
  CodexTurnInterruptedError,
} from "./errors.js";
import { CodexEventNormalizer } from "./event-normalizer.js";

/** @typedef {Record<string, any>} CodexSessionRecord */

/**
 * @typedef {{
 *   manager?: any,
 *   workspaceRoot?: string,
 *   mode?: string,
 *   readableRoots?: string[],
 *   approvalPolicy?: any,
 *   networkAccess?: boolean,
 *   model?: any,
 *   effort?: any,
 *   persistThreadId?: ((binding: CodexSessionRecord) => any),
 *   normalizer?: CodexEventNormalizer,
 * }} CodexSessionOptions
 */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** @param {any} thread */
function inspectThreadResult(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress") || null;
  const completedTurn = [...turns].reverse().find((turn) => turn?.status === "completed") || null;
  const terminalTurn = [...turns].reverse().find((turn) =>
    ["completed", "interrupted", "failed"].includes(turn?.status),
  ) || null;
  const runtimeActive = thread?.status?.type === "active";
  return Object.freeze({
    threadId: typeof thread?.id === "string" ? thread.id : null,
    runtimeStatus: thread?.status?.type || null,
    activeTurnId: typeof activeTurn?.id === "string" ? activeTurn.id : null,
    lastCompletedTurnId: typeof completedTurn?.id === "string" ? completedTurn.id : null,
    lastTerminalTurnId: typeof terminalTurn?.id === "string" ? terminalTurn.id : null,
    lastTerminalStatus: terminalTurn?.status || null,
    activeTurnUnidentified: runtimeActive && !activeTurn,
    turns,
  });
}

/** @param {CodexSessionRecord} [params] */
function extractTurnId(params = {}) {
  return params.turnId || params.turn?.id || null;
}

/** @param {CodexSessionRecord} [params] */
function extractThreadId(params = {}) {
  return params.threadId || params.thread?.id || null;
}

/**
 * @param {any} turn
 * @param {any[]} observedMessages
 */
function extractCompletedAgentMessages(turn, observedMessages) {
  const fromTurn = Array.isArray(turn?.items)
    ? turn.items.filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
    : [];
  const combined = [...observedMessages, ...fromTurn];
  const final = [...combined].reverse().find((item) => item.phase === "final_answer");
  const selected = final || combined.at(-1) || null;
  return typeof selected?.text === "string" && selected.text.trim() !== ""
    ? selected.text.trim()
    : null;
}

export class CodexSessionAdapter {
  /** @type {any} */
  #manager;
  #workspaceRoot;
  #mode;
  #approvalPolicy;
  /** @type {any} */
  #model;
  /** @type {any} */
  #effort;
  /** @type {any} */
  #sandboxPolicy;
  /** @type {(binding: CodexSessionRecord) => any} */
  #persistThreadId;
  #events = new EventEmitter();
  #normalizer;
  #threadId = null;
  #sessionId = null;
  #status = "CREATING";
  /** @type {any} */
  #activeTurn = null;
  /** @type {any} */
  #ambiguousTurn = null;
  /** @type {any} */
  #recoverableTurn = null;
  #lastCompletedTurnId = null;
  /** @type {Set<string>} */
  #terminalTurnIds = new Set();
  #closed = false;
  /** @type {Array<[any, string, (...args: any[]) => void]>} */
  #listeners = [];
  /** @type {Set<string>} */
  #sessionReadyEmitted = new Set();
  #bindingPersisted = false;

  /** @param {CodexSessionOptions} [options] */
  constructor({
    manager,
    workspaceRoot = manager?.executablePin?.workspaceRoot,
    mode = "DISCUSSION",
    readableRoots = [],
    approvalPolicy = "never",
    networkAccess = false,
    model = null,
    effort = null,
    persistThreadId,
    normalizer = new CodexEventNormalizer(),
  } = {}) {
    if (!manager || typeof manager.ensureReadyForNewOperation !== "function") {
      throw new TypeError("CodexSessionAdapter requires a CodexProcessManager");
    }
    if (typeof persistThreadId !== "function") {
      throw new TypeError("CodexSessionAdapter requires persistThreadId callback");
    }
    const workspace = requireAbsoluteRoot(workspaceRoot, "workspaceRoot");
    if (workspace !== path.resolve(manager.executablePin.workspaceRoot)) {
      throw new CodexConfigurationError(
        "Session workspace must equal the process manager's pinned workspace",
        "CODEX_SESSION_WORKSPACE_MISMATCH",
      );
    }
    this.#manager = manager;
    this.#workspaceRoot = workspace;
    this.#mode = mode;
    this.#approvalPolicy = validateApprovalPolicy(approvalPolicy);
    this.#model = model;
    this.#effort = effort;
    this.#persistThreadId = persistThreadId;
    this.#normalizer = normalizer;
    this.#sandboxPolicy = buildCodexSandboxPolicy({
      mode,
      workspaceRoot: workspace,
      readableRoots,
      networkAccess,
    });
    this.#listen(manager, "notification", (message) => this.#handleNotification(message));
    this.#listen(manager, "approvalRequested", (request) => this.#handleApproval(request));
    this.#listen(manager, "disconnected", (event) => this.#handleDisconnect(event));
    for (const type of ["protocolError", "orphanResponse", "lateResponse", "duplicateResponse"]) {
      this.#listen(manager, type, (detail) => this.#events.emit("diagnostic", { type, detail }));
    }
  }

  get actor() {
    return "CODEX_AGENT";
  }

  get threadId() {
    return this.#threadId;
  }

  // Dispatcher bindings use the provider session identity, not the
  // controller-local session record id. For Codex that identity is threadId.
  get externalSessionId() {
    return this.#threadId;
  }

  get activeTurnId() {
    return this.#activeTurn?.turnId || null;
  }

  get status() {
    return this.#status;
  }

  get pendingApprovals() {
    return Object.freeze(
      (this.#manager.approvalBridge?.pendingApprovals || [])
        .filter((request) => request.threadId === this.#threadId),
    );
  }

  get snapshot() {
    return Object.freeze({
      actor: this.actor,
      provider: "CODEX_APP_SERVER",
      threadId: this.#threadId,
      sessionId: this.#sessionId,
      status: this.#status,
      activeTurnId: this.activeTurnId,
      lastCompletedTurnId: this.#lastCompletedTurnId,
      ambiguousTurn: this.#ambiguousTurn ? { ...this.#ambiguousTurn } : null,
      readScopeEnforced: false,
      readScopeLimitation: "INSTALLED_APP_SERVER_SCHEMA_HAS_NO_RESTRICTED_READ_ROOTS",
      mode: this.#mode,
      workspaceRoot: this.#workspaceRoot,
      sandboxPolicy: this.#sandboxPolicy,
    });
  }

  async start() {
    this.#assertOpen();
    if (this.#threadId) {
      throw new CodexSessionStateError(
        "A session thread already exists; start never replaces it",
        "CODEX_THREAD_ALREADY_BOUND",
      );
    }
    try {
      await this.#manager.ensureReadyForNewOperation();
    } catch (error) {
      if (this.#status !== "DISCONNECTED") this.#status = "FAILED";
      throw error;
    }
    this.#status = "CREATING";
    const params = {
      cwd: this.#workspaceRoot,
      approvalPolicy: this.#approvalPolicy,
      sandbox: this.#mode === "CODE_CHANGE" ? "workspace-write" : "read-only",
      serviceName: "vibe_flow_agent_controller",
    };
    if (this.#model) params.model = this.#model;
    let result;
    try {
      result = await this.#manager.request("thread/start", params, 60_000);
    } catch (error) {
      if (this.#status !== "DISCONNECTED") this.#status = "FAILED";
      throw error;
    }
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string" || threadId === "") {
      this.#status = "FAILED";
      throw new CodexProtocolError(
        "thread/start returned no thread.id",
        "CODEX_THREAD_ID_MISSING",
      );
    }
    this.#threadId = threadId;
    this.#sessionId = result.thread.sessionId || threadId;
    try {
      await this.#persistThreadId({
        actor: this.actor,
        provider: "CODEX_APP_SERVER",
        threadId,
        sessionId: this.#sessionId,
      });
    } catch (cause) {
      this.#bindingPersisted = false;
      this.#status = "FAILED";
      throw new CodexThreadPersistenceError(threadId, cause);
    }
    this.#bindingPersisted = true;
    this.#status = "READY";
    this.#emitSessionReady(threadId);
    return this.snapshot;
  }

  /** @param {{threadId?: string}} [input] */
  async resume({ threadId } = {}) {
    this.#assertOpen();
    if (typeof threadId !== "string" || threadId === "") {
      throw new CodexSessionStateError("resume requires an existing threadId", "CODEX_RESUME_THREAD_ID_REQUIRED");
    }
    if (this.#threadId && this.#threadId !== threadId) {
      throw new CodexSessionStateError(
        "This adapter is already bound to another thread",
        "CODEX_THREAD_BINDING_CONFLICT",
      );
    }
    try {
      await this.#manager.ensureReadyForNewOperation();
    } catch (error) {
      if (this.#status !== "DISCONNECTED") this.#status = "FAILED";
      throw error;
    }
    this.#status = "CREATING";
    this.#bindingPersisted = false;
    let resumed;
    try {
      resumed = await this.#manager.request("thread/resume", { threadId }, 60_000);
    } catch (error) {
      if (this.#status !== "DISCONNECTED") this.#status = "FAILED";
      throw error;
    }
    if (resumed?.thread?.id !== threadId) {
      this.#status = "FAILED";
      throw new CodexProtocolError(
        "thread/resume returned a different thread id",
        "CODEX_RESUME_THREAD_MISMATCH",
        { expectedThreadId: threadId, actualThreadId: resumed?.thread?.id || null },
      );
    }
    this.#threadId = threadId;
    this.#sessionId = resumed.thread.sessionId || threadId;
    try {
      await this.#persistThreadId({
        actor: this.actor,
        provider: "CODEX_APP_SERVER",
        threadId,
        sessionId: this.#sessionId,
      });
    } catch (cause) {
      this.#bindingPersisted = false;
      this.#status = "FAILED";
      throw new CodexThreadPersistenceError(threadId, cause);
    }
    this.#bindingPersisted = true;
    let inspection;
    try {
      inspection = await this.#readThread();
    } catch (error) {
      if (this.#status !== "DISCONNECTED") this.#status = "FAILED";
      throw error;
    }
    this.#applyInspection(inspection);
    this.#emitSessionReady(threadId);
    return Object.freeze({ ...this.snapshot, inspection });
  }

  async inspect() {
    this.#assertOpen();
    if (!this.#threadId) {
      throw new CodexSessionStateError("Cannot inspect before start or resume", "CODEX_THREAD_NOT_BOUND");
    }
    await this.#manager.ensureReadyForNewOperation();
    const inspection = await this.#readThread();
    this.#applyInspection(inspection);
    return inspection;
  }

  /** @param {{text?: string, input?: any[] | null, outputSchema?: any}} [turnInputOptions] */
  async submitTurn({ text, input = null, outputSchema } = {}) {
    this.#assertReadyForTurn();
    const schema = assertStrictOutputSchema(outputSchema);
    const validateOutput = compileOutputSchema(schema);
    const turnInput = input === null ? [{ type: "text", text }] : jsonClone(input, "turn input");
    if (!Array.isArray(turnInput) || turnInput.length === 0) {
      throw new CodexConfigurationError("turn input must be a non-empty array", "CODEX_TURN_INPUT_INVALID");
    }
    if (input === null && (typeof text !== "string" || text.trim() === "")) {
      throw new CodexConfigurationError("turn text must be non-empty", "CODEX_TURN_TEXT_INVALID");
    }
    await this.#manager.ensureReadyForNewOperation();

    const completion = deferred();
    const turnState = {
      threadId: this.#threadId,
      turnId: null,
      completion,
      completedMessages: [],
      interrupt: null,
      startEventEmitted: false,
      outputSchema: schema,
      validateOutput,
    };
    this.#activeTurn = turnState;
    this.#status = "RUNNING";
    const params = {
      threadId: this.#threadId,
      input: turnInput,
      cwd: this.#workspaceRoot,
      approvalPolicy: this.#approvalPolicy,
      sandboxPolicy: this.#sandboxPolicy,
      outputSchema: schema,
    };
    if (this.#model) params.model = this.#model;
    if (this.#effort) params.effort = this.#effort;

    let result;
    try {
      result = await this.#manager.request("turn/start", params, 60_000);
    } catch (error) {
      if (this.#activeTurn === turnState) {
        if (error instanceof CodexTransportClosedError || error.code === "CODEX_RPC_TIMEOUT") {
          this.#markAmbiguous(turnState, error);
        } else {
          this.#activeTurn = null;
          this.#status = "READY";
          completion.reject(error);
        }
      }
      throw error;
    }

    const returnedTurnId = result?.turn?.id;
    if (typeof returnedTurnId !== "string" || returnedTurnId === "") {
      const error = new CodexProtocolError("turn/start returned no turn.id", "CODEX_TURN_ID_MISSING");
      this.#markAmbiguous(turnState, error);
      throw error;
    }
    if (turnState.turnId && turnState.turnId !== returnedTurnId) {
      const error = new CodexProtocolError(
        "turn/start response conflicts with the observed turn id",
        "CODEX_TURN_ID_MISMATCH",
        { observedTurnId: turnState.turnId, returnedTurnId },
      );
      this.#markAmbiguous(turnState, error);
      throw error;
    }
    turnState.turnId = returnedTurnId;
    this.#emitTurnStarted(turnState);
    return Object.freeze({
      threadId: this.#threadId,
      turnId: returnedTurnId,
      completion: completion.promise,
    });
  }

  /** @param {{turnId?: string, text?: string}} [input] */
  async steer({ turnId, text } = {}) {
    this.#assertOpen();
    if (!this.#activeTurn || this.#activeTurn.turnId !== turnId) {
      throw new CodexSessionStateError("steer target is not the active turn", "CODEX_STEER_TURN_MISMATCH");
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new CodexConfigurationError("steer text must be non-empty", "CODEX_STEER_TEXT_INVALID");
    }
    await this.#manager.ensureReadyForNewOperation();
    return this.#manager.request("turn/steer", {
      threadId: this.#threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    });
  }

  /** @param {{operationId?: string, turnId?: string | null}} [input] */
  async interrupt({ operationId, turnId = this.activeTurnId } = {}) {
    this.#assertOpen();
    if (typeof operationId !== "string" || operationId === "") {
      throw new CodexConfigurationError("interrupt requires operationId", "CODEX_INTERRUPT_OPERATION_ID_REQUIRED");
    }
    const active = this.#activeTurn;
    if (!active || typeof active.turnId !== "string" || active.turnId !== turnId) {
      throw new CodexSessionStateError("interrupt target is not the active turn", "CODEX_INTERRUPT_TURN_MISMATCH");
    }
    if (active.interrupt) {
      if (active.interrupt.operationId !== operationId) {
        throw new CodexSessionStateError(
          "A different interrupt operation is already pending",
          "CODEX_INTERRUPT_ALREADY_PENDING",
        );
      }
      return active.interrupt.handle;
    }
    const confirmation = deferred();
    const handle = Object.freeze({
      operationId,
      threadId: this.#threadId,
      turnId,
      rpcAccepted: true,
      confirmation: confirmation.promise,
    });
    active.interrupt = { operationId, confirmation, handle };
    try {
      await this.#manager.ensureReadyForNewOperation();
      await this.#manager.request("turn/interrupt", { threadId: this.#threadId, turnId });
    } catch (error) {
      if (active.interrupt?.operationId === operationId) active.interrupt = null;
      confirmation.reject(error);
      if (
        this.#activeTurn === active
        && (error instanceof CodexTransportClosedError || error.code === "CODEX_RPC_TIMEOUT")
      ) {
        this.#markAmbiguous(active, error);
      }
      throw error;
    }
    return handle;
  }

  /** @param {{requestId?: any, turnId?: any, decision?: any}} [input] */
  respondToApproval({ requestId, turnId, decision } = {}) {
    this.#assertOpen();
    return this.#manager.respondToApproval({
      requestId,
      threadId: this.#threadId,
      turnId,
      decision,
    });
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("Runtime event listener must be a function");
    this.#events.on("runtimeEvent", listener);
    return () => this.#events.off("runtimeEvent", listener);
  }

  onDiagnostic(listener) {
    if (typeof listener !== "function") throw new TypeError("Diagnostic listener must be a function");
    this.#events.on("diagnostic", listener);
    return () => this.#events.off("diagnostic", listener);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [emitter, name, listener] of this.#listeners) emitter.off(name, listener);
    this.#listeners = [];
    this.#status = "CLOSED";
    this.#events.removeAllListeners();
  }

  #assertOpen() {
    if (this.#closed) throw new CodexSessionStateError("Codex session is closed", "CODEX_SESSION_CLOSED");
  }

  #assertReadyForTurn() {
    this.#assertOpen();
    if (!this.#threadId || !["READY", "WAITING"].includes(this.#status)) {
      throw new CodexSessionStateError("Codex session is not ready for a new turn", "CODEX_SESSION_NOT_READY");
    }
    if (this.#activeTurn) {
      throw new CodexSessionStateError("Codex session already has an active turn", "CODEX_TURN_ALREADY_ACTIVE");
    }
    if (this.#ambiguousTurn) {
      throw new CodexSessionStateError(
        "An ambiguous prior turn must be reconciled before a new turn",
        "CODEX_AMBIGUOUS_TURN_UNRESOLVED",
        { ambiguousTurn: this.#ambiguousTurn },
      );
    }
  }

  async #readThread() {
    const result = await this.#manager.request("thread/read", {
      threadId: this.#threadId,
      includeTurns: true,
    }, 60_000);
    if (result?.thread?.id !== this.#threadId) {
      throw new CodexProtocolError(
        "thread/read returned the wrong thread",
        "CODEX_READ_THREAD_MISMATCH",
        { expectedThreadId: this.#threadId, actualThreadId: result?.thread?.id || null },
      );
    }
    return inspectThreadResult(result.thread);
  }

  /** @param {any} inspection */
  #applyInspection(inspection) {
    for (const turn of inspection.turns) {
      if (["completed", "interrupted", "failed"].includes(turn?.status)) {
        this.#rememberTerminalTurn(turn.id);
      }
    }
    const current = this.#activeTurn;
    if (
      current?.turnId
      && inspection.lastTerminalTurnId === current.turnId
      && ["completed", "interrupted", "failed"].includes(inspection.lastTerminalStatus)
    ) {
      const observedTurn = [...inspection.turns].reverse().find((turn) => turn?.id === current.turnId) || {
        id: current.turnId,
        status: inspection.lastTerminalStatus,
        items: [],
      };
      this.#completeTurn(current, observedTurn);
      return;
    }
    if (inspection.activeTurnId) {
      if (current?.turnId === inspection.activeTurnId) {
        this.#status = "RUNNING";
        return;
      }
      this.#ambiguousTurn = null;
      const observedTurn = [...inspection.turns]
        .reverse()
        .find((turn) => turn?.id === inspection.activeTurnId) || null;
      const recoverable = this.#recoverableTurn
        && (!this.#recoverableTurn.turnId || this.#recoverableTurn.turnId === inspection.activeTurnId)
        ? this.#recoverableTurn
        : null;
      let outputSchema = recoverable?.outputSchema || null;
      let validateOutput = recoverable?.validateOutput || null;
      if (!validateOutput && observedTurn?.outputSchema) {
        try {
          outputSchema = assertStrictOutputSchema(observedTurn.outputSchema);
          validateOutput = compileOutputSchema(outputSchema);
        } catch (error) {
          this.#events.emit("diagnostic", {
            type: "recoveredOutputSchemaInvalid",
            detail: { turnId: inspection.activeTurnId, error },
          });
        }
      }
      const completion = deferred();
      this.#activeTurn = {
        threadId: this.#threadId,
        turnId: inspection.activeTurnId,
        completion,
        completedMessages: recoverable?.completedMessages || [],
        interrupt: null,
        startEventEmitted: true,
        recovered: true,
        outputSchema,
        validateOutput,
      };
      this.#recoverableTurn = null;
      this.#status = "RUNNING";
      return;
    }
    this.#activeTurn = null;
    if (inspection.activeTurnUnidentified) {
      if (current) {
        this.#activeTurn = current;
        this.#markAmbiguous(current, new CodexProtocolError(
          "thread/read reports an active turn without its id",
          "CODEX_ACTIVE_TURN_ID_UNKNOWN",
        ));
        return;
      }
      this.#ambiguousTurn = { threadId: this.#threadId, turnId: null, reason: "ACTIVE_TURN_ID_UNKNOWN" };
      this.#status = "DISCONNECTED";
      return;
    }
    if (current) {
      this.#activeTurn = current;
      this.#markAmbiguous(current, new CodexProtocolError(
        "thread/read did not contain the active turn or a terminal result",
        "CODEX_ACTIVE_TURN_DISAPPEARED",
      ));
      return;
    }
    if (this.#ambiguousTurn) this.#ambiguousTurn = null;
    this.#status = "READY";
  }

  /** @param {any} request */
  #handleApproval(request) {
    if (request.threadId !== this.#threadId) return;
    this.#events.emit("runtimeEvent", this.#normalizer.normalizeApproval(request));
  }

  /** @param {any} message */
  #handleNotification(message) {
    const params = message?.params || {};
    const eventThreadId = extractThreadId(params);
    const eventTurnId = extractTurnId(params);
    if (eventThreadId && this.#threadId && eventThreadId !== this.#threadId) return;
    if (message.method === "thread/started") {
      const startedId = params.thread?.id;
      if (this.#bindingPersisted && this.#threadId && startedId === this.#threadId) {
        this.#emitSessionReady(startedId);
      }
      return;
    }

    const active = this.#activeTurn;
    if (eventTurnId && this.#terminalTurnIds.has(eventTurnId) && (!active || active.turnId !== eventTurnId)) {
      this.#events.emit("diagnostic", {
        type: "staleRuntimeEvent",
        detail: { method: message.method, turnId: eventTurnId },
      });
      return;
    }
    if (active && !active.turnId && eventTurnId && (!eventThreadId || eventThreadId === this.#threadId)) {
      active.turnId = eventTurnId;
    }
    if (eventTurnId && active?.turnId && eventTurnId !== active.turnId) return;

    if (message.method === "turn/completed") {
      if (active) this.#completeTurn(active, params.turn || {});
      return;
    }

    const normalized = this.#normalizer.normalizeNotification(message);
    if (normalized && (!normalized.threadId || normalized.threadId === this.#threadId)) {
      if (normalized.type === "TURN_STARTED" && active) active.startEventEmitted = true;
      this.#events.emit("runtimeEvent", normalized);
    }
    if (!active) return;

    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      if (typeof params.item.text === "string" && params.item.text.trim() !== "") {
        active.completedMessages.push({
          id: params.item.id || null,
          text: params.item.text,
          phase: params.item.phase || null,
        });
      }
      return;
    }
  }

  /**
   * @param {any} active
   * @param {any} turn
   */
  #completeTurn(active, turn) {
    if (this.#activeTurn !== active) return;
    const turnId = active.turnId || turn.id || null;
    this.#rememberTerminalTurn(turnId);
    this.#activeTurn = null;
    this.#recoverableTurn = null;
    const status = turn.status;
    if (status === "interrupted") {
      this.#status = "READY";
      this.#emitTerminalEvent(turnId, "interrupted");
      active.interrupt?.confirmation.resolve({
        operationId: active.interrupt.operationId,
        threadId: this.#threadId,
        turnId,
        confirmed: true,
      });
      active.completion.reject(new CodexTurnInterruptedError(this.#threadId, turnId));
      return;
    }
    if (status === "failed") {
      this.#status = "READY";
      const detail = turn.error?.message 
        || turn.error?.codex_error_info 
        || `Codex turn ${turnId} failed`;
      const code = turn.error?.codex_error_info || "CODEX_TURN_FAILED";
      const error = new CodexTurnFailedError(this.#threadId, turnId, detail, turn);

      console.error(`\x1b[31m[Codex Process Error]\x1b[0m ${detail}`);

      this.#emitTerminalEvent(turnId, "failed", { 
        code, 
        message: detail, 
        rawError: turn.error ?? null 
      });
      active.interrupt?.confirmation.reject(error);
      active.completion.reject(error);
      return;
    }
    if (status !== "completed") {
      this.#status = "READY";
      const error = new CodexProtocolError(
        `Codex turn ${turnId} completed with invalid terminal status ${JSON.stringify(status)}`,
        "CODEX_TURN_STATUS_INVALID",
        { threadId: this.#threadId, turnId, status: status ?? null },
      );
      this.#emitTerminalEvent(turnId, "failed", { code: error.code, message: error.message });
      active.interrupt?.confirmation.reject(error);
      active.completion.reject(error);
      return;
    }

    const text = extractCompletedAgentMessages(turn, active.completedMessages);
    if (!text) {
      this.#status = "READY";
      const error = new CodexAuthoritativeOutputMissingError(this.#threadId, turnId);
      this.#emitTerminalEvent(turnId, "failed", { code: error.code, message: error.message });
      active.completion.reject(error);
      return;
    }
    let structuredOutput;
    try {
      structuredOutput = JSON.parse(text);
    } catch (cause) {
      this.#status = "READY";
      const error = new CodexAuthoritativeOutputInvalidError(
        this.#threadId,
        turnId,
        "JSON_PARSE_FAILED",
        { cause },
      );
      this.#emitTerminalEvent(turnId, "failed", { code: error.code, message: error.message });
      active.completion.reject(error);
      return;
    }
    if (typeof active.validateOutput !== "function") {
      this.#status = "READY";
      const error = new CodexAuthoritativeOutputInvalidError(
        this.#threadId,
        turnId,
        "OUTPUT_SCHEMA_UNAVAILABLE",
      );
      this.#emitTerminalEvent(turnId, "failed", { code: error.code, message: error.message });
      active.completion.reject(error);
      return;
    }
    if (!active.validateOutput(structuredOutput)) {
      this.#status = "READY";
      const error = new CodexAuthoritativeOutputInvalidError(
        this.#threadId,
        turnId,
        "SCHEMA_VALIDATION_FAILED",
        { validationErrors: copyValidationErrors(active.validateOutput.errors) },
      );
      this.#emitTerminalEvent(turnId, "failed", { code: error.code, message: error.message });
      active.completion.reject(error);
      return;
    }
    this.#status = "READY";
    this.#lastCompletedTurnId = turnId;
    this.#emitTerminalEvent(turnId, "completed");
    active.completion.resolve(Object.freeze({
      threadId: this.#threadId,
      turnId,
      status: "completed",
      text,
      structuredOutput,
    }));
  }

  /**
   * @param {any} turnId
   * @param {"completed" | "interrupted" | "failed"} status
   * @param {any} [error]
   */
  #emitTerminalEvent(turnId, status, error = null) {
    const event = this.#normalizer.normalizeNotification({
      method: "turn/completed",
      params: {
        threadId: this.#threadId,
        turn: { id: turnId, status, error },
      },
    });
    if (event) this.#events.emit("runtimeEvent", event);
  }

  /** @param {any} turnId */
  #rememberTerminalTurn(turnId) {
    if (typeof turnId !== "string" || turnId === "") return;
    this.#terminalTurnIds.add(turnId);
    while (this.#terminalTurnIds.size > 1_000) {
      this.#terminalTurnIds.delete(this.#terminalTurnIds.values().next().value);
    }
  }

  /** @param {any} event */
  #handleDisconnect(event) {
    if (this.#closed) return;
    const active = this.#activeTurn;
    if (active) this.#markAmbiguous(active, event.error);
    else this.#status = "DISCONNECTED";
    this.#events.emit(
      "runtimeEvent",
      this.#normalizer.normalizeDisconnect({
        threadId: this.#threadId,
        turnId: active?.turnId || null,
        ambiguous: Boolean(active),
      }),
    );
  }

  /**
   * @param {any} active
   * @param {any} cause
   */
  #markAmbiguous(active, cause) {
    if (this.#activeTurn === active) this.#activeTurn = null;
    this.#recoverableTurn = {
      turnId: active.turnId,
      completedMessages: [...active.completedMessages],
      outputSchema: active.outputSchema,
      validateOutput: active.validateOutput,
    };
    const error = new CodexTurnAmbiguousError(this.#threadId, active.turnId, cause);
    this.#ambiguousTurn = {
      threadId: this.#threadId,
      turnId: active.turnId,
      reason: error.code,
    };
    this.#status = "DISCONNECTED";
    active.interrupt?.confirmation.reject(error);
    active.completion.reject(error);
  }

  /** @param {string} threadId */
  #emitSessionReady(threadId) {
    if (this.#sessionReadyEmitted.has(threadId)) return;
    this.#sessionReadyEmitted.add(threadId);
    const event = this.#normalizer.normalizeNotification({
      method: "thread/started",
      params: { thread: { id: threadId } },
    });
    this.#events.emit("runtimeEvent", event);
  }

  /** @param {any} turnState */
  #emitTurnStarted(turnState) {
    if (turnState.startEventEmitted) return;
    turnState.startEventEmitted = true;
    const event = this.#normalizer.normalizeNotification({
      method: "turn/started",
      params: { threadId: this.#threadId, turn: { id: turnState.turnId } },
    });
    this.#events.emit("runtimeEvent", event);
  }

  /**
   * @param {any} emitter
   * @param {string} name
   * @param {(...args: any[]) => void} listener
   */
  #listen(emitter, name, listener) {
    emitter.on(name, listener);
    this.#listeners.push([emitter, name, listener]);
  }
}

/** @param {CodexSessionOptions} options */
export function createCodexAgentSessionAdapter(options) {
  const runtime = new CodexSessionAdapter(options);
  return Object.freeze({
    get actor() { return runtime.actor; },
    get externalSessionId() { return runtime.externalSessionId; },
    get threadId() { return runtime.threadId; },
    get activeTurnId() { return runtime.activeTurnId; },
    get status() { return runtime.status; },
    start: (input) => /** @type {any} */ (runtime).start(input),
    resume: (input) => runtime.resume(input),
    inspect: (input) => /** @type {any} */ (runtime).inspect(input),
    submitTurn: (input) => runtime.submitTurn(input),
    interrupt: (input) => runtime.interrupt(input),
    respondToApproval: (input) => runtime.respondToApproval(input),
    steer: (input) => runtime.steer(input),
    close: (input) => /** @type {any} */ (runtime).close(input),
    onEvent: (listener) => runtime.onEvent(listener),
  });
}

export { inspectThreadResult };
