import {
  RuntimeEventType,
  validateRuntimeEventType,
} from "../runtime/runtime-events.js";
import { AgentActor } from "../domain/vocabulary.js";

const TURN_SCOPED_EVENTS = new Set([
  RuntimeEventType.TURN_STARTED,
  RuntimeEventType.TEXT_DELTA,
  RuntimeEventType.TOOL_STARTED,
  RuntimeEventType.TOOL_COMPLETED,
  RuntimeEventType.APPROVAL_REQUESTED,
  RuntimeEventType.TURN_COMPLETED,
  RuntimeEventType.TURN_INTERRUPTED,
  RuntimeEventType.TURN_FAILED,
]);
const TERMINAL_EVENTS = new Set([
  RuntimeEventType.TURN_COMPLETED,
  RuntimeEventType.TURN_INTERRUPTED,
  RuntimeEventType.TURN_FAILED,
]);

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

export class DiscussionRuntimeEventError extends Error {
  constructor(message, code = "DISCUSSION_RUNTIME_EVENT_ERROR", details = null) {
    super(message);
    this.name = "DiscussionRuntimeEventError";
    this.code = code;
    this.details = details;
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function withTimeout(promise, timeoutMs, message, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new DiscussionRuntimeEventError(message, code)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DiscussionRuntimeEventConsumer {
  #active = null;
  #bindings = new Map();
  #settledTurns = new Set();
  #unsubscribers = [];
  #startTimeoutMs;
  #completionTimeoutMs;

  /** @param {{
   *   sessions?: Record<string, any>,
   *   startTimeoutMs?: number,
   *   completionTimeoutMs?: number
   * }} [options] */
  constructor({
    sessions,
    startTimeoutMs = 30_000,
    completionTimeoutMs = 330_000,
  } = {}) {
    if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) {
      throw new TypeError("sessions must be an actor-indexed object.");
    }
    if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1) {
      throw new TypeError("startTimeoutMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(completionTimeoutMs) || completionTimeoutMs < 1) {
      throw new TypeError("completionTimeoutMs must be a positive safe integer.");
    }
    this.#startTimeoutMs = startTimeoutMs;
    this.#completionTimeoutMs = completionTimeoutMs;
    for (const [actor, binding] of Object.entries(sessions)) {
      if (
        binding === null
        || typeof binding !== "object"
        || typeof binding.sessionId !== "string"
        || typeof binding.session?.onEvent !== "function"
      ) {
        throw new TypeError(`Invalid runtime binding for ${actor}.`);
      }
      this.#bindings.set(actor, binding);
      const unsubscribe = binding.session.onEvent((event) => {
        this.#observe(actor, binding, event);
      });
      if (typeof unsubscribe === "function") this.#unsubscribers.push(unsubscribe);
    }
  }

  arm({ runId, deliveryId, inputId, actor, sessionId, externalSessionId = null }) {
    if (this.#active !== null) {
      throw new DiscussionRuntimeEventError(
        "Only one discussion runtime turn may be active.",
        "DISCUSSION_RUNTIME_BUSY",
      );
    }
    for (const [value, name] of [
      [runId, "runId"],
      [deliveryId, "deliveryId"],
      [inputId, "inputId"],
      [actor, "actor"],
      [sessionId, "sessionId"],
    ]) requiredString(value, name);
    const binding = this.#bindings.get(actor);
    if (!binding || binding.sessionId !== sessionId) {
      throw new DiscussionRuntimeEventError(
        "Runtime binding does not match the persisted Agent session.",
        "RUNTIME_SESSION_BINDING_MISMATCH",
      );
    }
    const started = deferred();
    const terminal = deferred();
    const failed = deferred();
    const active = {
      runId,
      deliveryId,
      inputId,
      actor,
      sessionId,
      externalSessionId,
      turnId: null,
      started,
      terminal,
      failed,
      terminalEvent: null,
      responseStarted: false,
      responseStartedHandler: null,
      responseStartedPersisted: false,
    };
    this.#active = active;
    return Object.freeze({
      confirmTurn: (turnId) => this.#confirmTurn(active, turnId),
      awaitCompletion: (completion) => this.#awaitCompletion(active, completion),
      onResponseStarted: (handler) => this.#setResponseStartedHandler(active, handler),
      settle: () => this.#settle(active),
      abandon: () => this.#abandon(active),
      get responseStarted() { return active.responseStarted; },
    });
  }

  close() {
    if (this.#active !== null) {
      const active = this.#active;
      this.#failActive(active, new DiscussionRuntimeEventError(
        "Runtime event consumer closed with an active turn.",
        "RUNTIME_EVENT_CONSUMER_CLOSED",
      ));
      this.#active = null;
    }
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  #observe(actor, binding, event) {
    try {
      validateRuntimeEventType(event?.type);
    } catch {
      return;
    }
    const active = this.#active;
    if (active === null) return;
    if (actor !== active.actor || binding.sessionId !== active.sessionId) return;

    if (event.type === RuntimeEventType.SESSION_READY) return;
    if (event.type === RuntimeEventType.SESSION_DISCONNECTED) {
      this.#failActive(active, new DiscussionRuntimeEventError(
        "The active runtime session disconnected.",
        "RUNTIME_SESSION_DISCONNECTED",
      ));
      return;
    }
    if (!TURN_SCOPED_EVENTS.has(event.type)) return;
    if (typeof event.turnId !== "string" || event.turnId.length === 0) {
      this.#failActive(active, new DiscussionRuntimeEventError(
        "A turn-scoped runtime event has no turnId.",
        "RUNTIME_EVENT_TURN_ID_MISSING",
      ));
      return;
    }
    if (this.#settledTurns.has(`${active.sessionId}\u0000${event.turnId}`)) return;

    if (actor === AgentActor.CODEX_AGENT) {
      if (typeof event.threadId !== "string" || event.threadId.length === 0) {
        this.#failActive(active, new DiscussionRuntimeEventError(
          "A Codex turn event has no external thread identity.",
          "RUNTIME_EVENT_SESSION_IDENTITY_MISSING",
        ));
        return;
      }
      if (event.threadId !== active.externalSessionId) return;
    }
    if (actor === AgentActor.CHATGPT_WEB_AGENT) {
      if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
        this.#failActive(active, new DiscussionRuntimeEventError(
          "A Web turn event has no persisted session identity.",
          "RUNTIME_EVENT_SESSION_IDENTITY_MISSING",
        ));
        return;
      }
      if (event.sessionId !== active.sessionId) return;
    }

    if (event.type === RuntimeEventType.TURN_STARTED) {
      if (active.turnId === null) {
        active.turnId = event.turnId;
        active.started.resolve(event);
      } else if (active.turnId !== event.turnId) {
        this.#failActive(active, new DiscussionRuntimeEventError(
          "The runtime emitted conflicting turn start identities.",
          "RUNTIME_TURN_START_MISMATCH",
        ));
      }
      return;
    }
    if (active.turnId === null || event.turnId !== active.turnId) return;
    if (event.type === RuntimeEventType.TEXT_DELTA) {
      active.responseStarted = true;
      this.#persistResponseStarted(active);
      return;
    }
    if (event.type === RuntimeEventType.APPROVAL_REQUESTED) {
      this.#failActive(active, new DiscussionRuntimeEventError(
        "Runtime approval requires a trusted evidence producer before relay can continue.",
        "RUNTIME_APPROVAL_EVIDENCE_UNSUPPORTED",
      ));
      return;
    }
    if (!TERMINAL_EVENTS.has(event.type)) return;
    if (active.terminalEvent !== null) return;
    active.terminalEvent = event;
    active.terminal.resolve(event);
  }

  #failActive(active, error) {
    if (this.#active !== active) return;
    active.failed.reject(error);
  }

  #setResponseStartedHandler(active, handler) {
    if (this.#active !== active) {
      throw new DiscussionRuntimeEventError(
        "Cannot bind response-start persistence to an inactive turn.",
        "RUNTIME_TURN_NOT_ACTIVE",
      );
    }
    if (typeof handler !== "function") {
      throw new TypeError("response-start handler must be a function.");
    }
    if (active.responseStartedHandler !== null) {
      throw new DiscussionRuntimeEventError(
        "Response-start persistence is already bound for this turn.",
        "RUNTIME_RESPONSE_STARTED_HANDLER_DUPLICATE",
      );
    }
    active.responseStartedHandler = handler;
    this.#persistResponseStarted(active);
  }

  #persistResponseStarted(active) {
    if (
      !active.responseStarted
      || active.responseStartedPersisted
      || active.responseStartedHandler === null
    ) return;
    try {
      const result = active.responseStartedHandler();
      if (result !== undefined && typeof result?.then === "function") {
        throw new DiscussionRuntimeEventError(
          "Response-start persistence must be synchronous.",
          "RUNTIME_RESPONSE_STARTED_HANDLER_ASYNC",
        );
      }
      active.responseStartedPersisted = true;
    } catch (error) {
      this.#failActive(active, error);
    }
  }

  async #confirmTurn(active, turnId) {
    requiredString(turnId, "turnId");
    const startedEvent = await withTimeout(
      Promise.race([active.started.promise, active.failed.promise]),
      this.#startTimeoutMs,
      "Runtime did not emit TURN_STARTED.",
      "RUNTIME_TURN_START_TIMEOUT",
    );
    if (this.#active !== active || startedEvent.turnId !== turnId) {
      throw new DiscussionRuntimeEventError(
        "Runtime turn handle does not match TURN_STARTED.",
        "RUNTIME_TURN_HANDLE_MISMATCH",
      );
    }
    return startedEvent;
  }

  async #awaitCompletion(active, completion) {
    if (completion === null || typeof completion?.then !== "function") {
      throw new DiscussionRuntimeEventError(
        "Runtime turn handle has no completion promise.",
        "RUNTIME_COMPLETION_PROMISE_MISSING",
      );
    }
    const completionOutcome = Promise.resolve(completion).then(
      (value) => ({ fulfilled: true, value }),
      (error) => ({ fulfilled: false, error }),
    );
    const deadline = Date.now() + this.#completionTimeoutMs;
    const terminalEvent = await withTimeout(
      Promise.race([active.terminal.promise, active.failed.promise]),
      this.#completionTimeoutMs,
      "Runtime did not produce a correlated terminal event and completion.",
      "RUNTIME_COMPLETION_TIMEOUT",
    );
    if (terminalEvent.type !== RuntimeEventType.TURN_COMPLETED) {
      throw new DiscussionRuntimeEventError(
        `Runtime turn ended with ${terminalEvent.type}.`,
        "RUNTIME_TURN_NOT_COMPLETED",
        terminalEvent,
      );
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    const outcome = await withTimeout(
      Promise.race([completionOutcome, active.failed.promise]),
      remainingMs,
      "Runtime did not produce a correlated terminal event and completion.",
      "RUNTIME_COMPLETION_TIMEOUT",
    );
    if (outcome.fulfilled === false) throw outcome.error;
    return Object.freeze({ terminalEvent, completion: outcome.value });
  }

  #settle(active) {
    if (this.#active !== active) return;
    if (typeof active.turnId === "string") {
      this.#settledTurns.add(`${active.sessionId}\u0000${active.turnId}`);
      while (this.#settledTurns.size > 1_000) {
        this.#settledTurns.delete(this.#settledTurns.values().next().value);
      }
    }
    this.#active = null;
  }

  #abandon(active) {
    if (this.#active === active) this.#active = null;
  }
}
