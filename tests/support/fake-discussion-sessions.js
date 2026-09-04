import { EventEmitter } from "node:events";
import { canonicalJson } from "../../src/domain/canonical-json.js";
import { AgentActor } from "../../src/domain/vocabulary.js";

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

function packetEnvelope(packet) {
  return `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`;
}

function requireActor(actor) {
  if (!Object.values(AgentActor).includes(actor)) {
    throw new TypeError(`Unsupported fake discussion actor: ${String(actor)}`);
  }
  return actor;
}

function requireStep(step, index) {
  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    throw new TypeError(`Fake discussion step ${index + 1} must be an object.`);
  }
  requireActor(step.actor);
  if (
    !Object.hasOwn(step, "packet")
    && !Object.hasOwn(step, "rawText")
    && typeof step.response !== "function"
  ) {
    throw new TypeError(`Fake discussion step ${index + 1} needs packet, rawText, or response.`);
  }
  return step;
}

function codexEvent(type, { threadId, turnId, fields = {} }) {
  return Object.freeze({
    type,
    sourceMethod: type === "TURN_STARTED"
      ? "turn/started"
      : type === "TEXT_DELTA"
        ? "item/agentMessage/delta"
        : "turn/completed",
    threadId,
    turnId,
    itemId: null,
    ...fields,
  });
}

function webEvent(type, { sessionId, turnId, fields = {} }) {
  return Object.freeze({
    type,
    occurredAt: "2026-09-04T08:00:00.000Z",
    sessionId,
    turnId,
    payload: Object.freeze({ ...fields }),
  });
}

export function controllerEnvelopeFromPrompt(prompt) {
  if (typeof prompt !== "string") throw new TypeError("prompt must be a string");
  const offset = prompt.lastIndexOf("\n\n");
  if (offset < 0) throw new TypeError("Controller prompt has no canonical JSON envelope.");
  return JSON.parse(prompt.slice(offset + 2));
}

/**
 * Test-only provider ledger. New fake session objects may bind to this same
 * ledger after the Controller SQLite store is reopened.
 */
export class ScriptedDiscussionRuntime {
  #steps;
  #nextStep = 0;
  #nextTurn = 0;

  constructor(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new TypeError("ScriptedDiscussionRuntime requires at least one step.");
    }
    this.#steps = steps.map(requireStep);
    this.submissions = [];
  }

  get remainingSteps() {
    return this.#steps.length - this.#nextStep;
  }

  next(actor, input) {
    const index = this.#nextStep;
    const step = this.#steps[index];
    if (!step) throw new Error(`Unexpected ${actor} submission after script completion.`);
    if (step.actor !== actor) {
      throw new Error(`Step ${index + 1} expected ${step.actor}, observed ${actor}.`);
    }
    this.#nextStep += 1;
    this.#nextTurn += 1;
    const submission = {
      index,
      actor,
      input: structuredClone(input),
      turnId: actor === AgentActor.CHATGPT_WEB_AGENT && typeof input?.turnId === "string"
        ? input.turnId
        : `fake-turn-${this.#nextTurn}`,
    };
    this.submissions.push(submission);
    const resolved = typeof step.response === "function"
      ? step.response({ input: submission.input, submission, runtime: this })
      : step;
    return { submission, step: { ...step, ...resolved } };
  }
}

export class FakeDiscussionSession {
  #events = new EventEmitter();
  #runtime;
  #active = null;

  constructor({ actor, sessionId, externalSessionId, runtime }) {
    this.actor = requireActor(actor);
    this.sessionId = sessionId;
    this.externalSessionId = externalSessionId;
    this.#runtime = runtime;
    this.lastTerminalEvent = null;
    this.acknowledgements = [];
  }

  async start() {
    return this.inspect();
  }

  async resume() {
    return this.inspect();
  }

  async inspect() {
    return Object.freeze({
      actor: this.actor,
      sessionId: this.sessionId,
      externalSessionId: this.externalSessionId,
      activeTurnId: this.#active?.submission.turnId ?? null,
    });
  }

  async submitTurn(input) {
    if (this.#active !== null) throw new Error(`${this.actor} already has an active fake turn.`);
    const { submission, step } = this.#runtime.next(this.actor, input);
    const completion = deferred();
    this.#active = { completion, step, submission };

    // Both current production adapters can emit TURN_STARTED before the
    // submitTurn promise gives its handle back to the caller.
    this.emitRuntimeEvent(this.#event("TURN_STARTED", submission.turnId));
    if (step.manual !== true) {
      setImmediate(() => this.completeActive());
    }
    return Object.freeze({ turnId: submission.turnId, completion: completion.promise });
  }

  completeActive() {
    const active = this.#active;
    if (active === null) throw new Error(`${this.actor} has no active fake turn.`);
    const { completion, step, submission } = active;
    const rawText = Object.hasOwn(step, "rawText")
      ? step.rawText
      : packetEnvelope(step.packet);

    this.emitRuntimeEvent(this.#event("TEXT_DELTA", submission.turnId, {
      delta: "non-authoritative fake delta",
    }));
    const terminal = this.#event("TURN_COMPLETED", submission.turnId, {
      packetType: step.packet?.type ?? null,
    });
    this.lastTerminalEvent = terminal;
    // The real adapters emit the terminal event before resolving completion.
    this.emitRuntimeEvent(terminal);
    this.#active = null;

    if (this.actor === AgentActor.CODEX_AGENT) {
      completion.resolve(Object.freeze({
        threadId: this.externalSessionId,
        turnId: submission.turnId,
        status: "completed",
        text: Object.hasOwn(step, "rawText") ? rawText : canonicalJson(step.packet),
        ...(Object.hasOwn(step, "rawText") ? {} : { structuredOutput: step.packet }),
        ...(step.completionOverrides ?? {}),
      }));
      return;
    }
    completion.resolve(Object.freeze({
      turnId: submission.turnId,
      text: Object.hasOwn(step, "body") ? step.body : "",
      rawText,
      ...(step.packet === undefined ? {} : { packet: step.packet }),
      confidence: "CONFIRMED_BY_UI_STATE",
      evidence: { assistantMessageId: `assistant-${submission.turnId}` },
      ...(step.completionOverrides ?? {}),
    }));
  }

  emitRuntimeEvent(event) {
    this.#events.emit("runtimeEvent", event);
  }

  onEvent(listener) {
    this.#events.on("runtimeEvent", listener);
    return () => this.#events.off("runtimeEvent", listener);
  }

  async acknowledgeDelivery(input) {
    this.acknowledgements.push(structuredClone(input));
  }

  async interrupt() {}

  async close() {
    this.#events.removeAllListeners();
  }

  #event(type, turnId, fields = {}) {
    return this.actor === AgentActor.CODEX_AGENT
      ? codexEvent(type, {
        threadId: this.externalSessionId,
        turnId,
        fields: type === "TEXT_DELTA" ? fields : {},
      })
      : webEvent(type, { sessionId: this.sessionId, turnId, fields });
  }
}

export function createFakeDiscussionSessions(runtime) {
  return Object.freeze({
    [AgentActor.CODEX_AGENT]: new FakeDiscussionSession({
      actor: AgentActor.CODEX_AGENT,
      sessionId: "session-codex",
      externalSessionId: "thread-codex",
      runtime,
    }),
    [AgentActor.CHATGPT_WEB_AGENT]: new FakeDiscussionSession({
      actor: AgentActor.CHATGPT_WEB_AGENT,
      sessionId: "session-web",
      externalSessionId: "conversation-web",
      runtime,
    }),
  });
}
