import { randomUUID } from "node:crypto";
import { createAgentSessionRecord } from "../domain/contracts.js";
import {
  AgentActor,
  AgentSessionStatus,
  SessionProvider,
} from "../domain/vocabulary.js";
import { DiscussionController } from "./discussion-controller.js";
import { DiscussionOutboxDispatcher } from "./discussion-dispatcher.js";
import { RunService } from "./run-service.js";

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireFactory(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

function requireStore(store) {
  for (const method of ["createAgentSession", "getAgentSession", "upsertAgentSession"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`LiveDiscussionComposition requires store.${method}().`);
    }
  }
  return store;
}

function runtimeActor(runtime, expectedActor) {
  if (runtime?.actor !== expectedActor || typeof runtime?.externalSessionId !== "string"
    || runtime.externalSessionId.length === 0) {
    throw new LiveDiscussionCompositionError(
      `Runtime did not expose the expected durable ${expectedActor} session identity.`,
      "RUNTIME_IDENTITY_UNAVAILABLE",
    );
  }
}

export class LiveDiscussionCompositionError extends Error {
  constructor(message, code = "LIVE_DISCUSSION_COMPOSITION_ERROR", details = null) {
    super(message);
    this.name = "LiveDiscussionCompositionError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Provisions exact runtime sessions before the durable Controller queues the
 * first delivery. Construction has no provider side effects; only
 * provisionRun() can start external sessions.
 */
export class LiveDiscussionComposition {
  #store;
  #artifactStore;
  #createCodexSession;
  #createWebSession;
  #clock;
  #idFactory;
  #runService;
  #controller;
  #dispatchers = new Map();

  /** @param {{store: any, artifactStore: any, createCodexSession: (input: any) => any, createWebSession: (input: any) => any, clock?: () => string, idFactory?: () => string}} options */
  constructor({
    store,
    artifactStore,
    createCodexSession,
    createWebSession,
    clock = () => new Date().toISOString(),
    idFactory = randomUUID,
  }) {
    this.#store = requireStore(store);
    if (artifactStore === null || typeof artifactStore?.put !== "function") {
      throw new TypeError("LiveDiscussionComposition requires an artifactStore.");
    }
    this.#artifactStore = artifactStore;
    this.#createCodexSession = requireFactory(createCodexSession, "createCodexSession");
    this.#createWebSession = requireFactory(createWebSession, "createWebSession");
    this.#clock = requireFactory(clock, "clock");
    this.#idFactory = requireFactory(idFactory, "idFactory");
    this.#runService = new RunService({
      store,
      clock,
      idFactory: /** @type {any} */ (idFactory),
    });
    this.#controller = new DiscussionController({
      store,
      artifactStore,
      clock,
      idFactory: /** @type {any} */ (idFactory),
    });
  }

  get runService() {
    return this.#runService;
  }

  get controller() {
    return this.#controller;
  }

  getDispatcher(runId) {
    nonEmpty(runId, "runId");
    return this.#dispatchers.get(runId) ?? null;
  }

  /** @param {{runId?: string, objective: string, policy: any, webBinding: any}} input */
  async provisionRun({ runId, objective, policy, webBinding }) {
    const runInput = { objective, policy };
    if (runId !== undefined) runInput.runId = runId;
    const run = this.#runService.createRun(runInput);
    const codexSessionId = `session_codex_${this.#idFactory()}`;
    const webSessionId = `session_web_${this.#idFactory()}`;
    this.#createSession({
      sessionId: codexSessionId,
      runId: run.runId,
      actor: AgentActor.CODEX_AGENT,
      provider: SessionProvider.CODEX_APP_SERVER,
    });
    this.#createSession({
      sessionId: webSessionId,
      runId: run.runId,
      actor: AgentActor.CHATGPT_WEB_AGENT,
      provider: SessionProvider.CHATGPT_WEB,
    });

    const codex = this.#createCodexSession({
      run,
      sessionId: codexSessionId,
      persistThreadBinding: (binding) => this.#persistCodexThreadBinding({
        sessionId: codexSessionId,
        runId: run.runId,
        binding,
      }),
    });
    if (typeof codex?.start !== "function") {
      throw new LiveDiscussionCompositionError("Codex runtime cannot start a session.", "CODEX_RUNTIME_INVALID");
    }
    try {
      await codex.start();
      runtimeActor(codex, AgentActor.CODEX_AGENT);
      this.#markReady({
        sessionId: codexSessionId,
        externalSessionId: codex.externalSessionId,
        externalLocator: null,
      });
    } catch (cause) {
      throw new LiveDiscussionCompositionError(
        "Codex session provisioning did not complete; no discussion delivery was queued.",
        "CODEX_SESSION_PROVISIONING_FAILED",
        { runId: run.runId, sessionId: codexSessionId, cause },
      );
    }

    const web = this.#createWebSession({ run, sessionId: webSessionId });
    if (typeof web?.start !== "function") {
      throw new LiveDiscussionCompositionError("Web runtime cannot start a session.", "WEB_RUNTIME_INVALID");
    }
    try {
      const binding = await web.start({ binding: webBinding });
      runtimeActor(web, AgentActor.CHATGPT_WEB_AGENT);
      this.#markReady({
        sessionId: webSessionId,
        externalSessionId: web.externalSessionId,
        externalLocator: binding?.conversationUrl ?? null,
      });
    } catch (cause) {
      throw new LiveDiscussionCompositionError(
        "ChatGPT Web session provisioning did not complete; no discussion delivery was queued.",
        "WEB_SESSION_PROVISIONING_FAILED",
        { runId: run.runId, sessionId: webSessionId, cause },
      );
    }

    const dispatcher = new DiscussionOutboxDispatcher({
      store: this.#store,
      controller: this.#controller,
      artifactStore: this.#artifactStore,
      sessions: {
        [AgentActor.CODEX_AGENT]: { sessionId: codexSessionId, session: codex },
        [AgentActor.CHATGPT_WEB_AGENT]: { sessionId: webSessionId, session: web },
      },
    });
    const started = this.#controller.start({ runId: run.runId, expectedVersion: run.version });
    this.#dispatchers.set(run.runId, dispatcher);
    return Object.freeze({ run: started.run, codexSessionId, webSessionId, dispatcher });
  }

  /** @param {{runId: string, maxDispatches?: number}} input */
  async dispatchUntilSettled({ runId, maxDispatches }) {
    const dispatcher = this.getDispatcher(runId);
    if (dispatcher === null) {
      throw new LiveDiscussionCompositionError("No live dispatcher is provisioned for this run.", "DISPATCHER_NOT_FOUND");
    }
    return dispatcher.runUntilSettled({ runId, maxDispatches });
  }

  close() {
    for (const dispatcher of this.#dispatchers.values()) dispatcher.close();
    this.#dispatchers.clear();
  }

  #createSession({ sessionId, runId, actor, provider }) {
    const at = this.#clock();
    this.#store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId,
        runId,
        actor,
        provider,
        externalSessionId: null,
        externalLocator: null,
        status: AgentSessionStatus.CREATING,
        activeTurnId: null,
        lastCompletedTurnId: null,
        lastObservedAt: null,
        version: 1,
      }),
      createdAt: at,
      updatedAt: at,
    });
  }

  #persistCodexThreadBinding({ sessionId, runId, binding }) {
    if (binding?.actor !== AgentActor.CODEX_AGENT || typeof binding?.threadId !== "string") {
      throw new LiveDiscussionCompositionError("Codex thread binding is invalid.", "CODEX_THREAD_BINDING_INVALID");
    }
    const current = this.#store.getAgentSession(sessionId);
    if (current === null || current.runId !== runId) {
      throw new LiveDiscussionCompositionError("Codex session record is missing.", "CODEX_SESSION_RECORD_MISSING");
    }
    this.#updateSession(current, {
      externalSessionId: binding.threadId,
      lastObservedAt: this.#clock(),
    });
  }

  #markReady({ sessionId, externalSessionId, externalLocator }) {
    const current = this.#store.getAgentSession(sessionId);
    if (current === null) {
      throw new LiveDiscussionCompositionError("Runtime session record is missing.", "SESSION_RECORD_MISSING");
    }
    this.#updateSession(current, {
      externalSessionId,
      externalLocator,
      status: AgentSessionStatus.READY,
      lastObservedAt: this.#clock(),
    });
  }

  #updateSession(current, patch) {
    const updatedAt = this.#clock();
    return this.#store.upsertAgentSession({
      session: createAgentSessionRecord({
        ...current,
        ...patch,
        version: current.version + 1,
      }),
      expectedVersion: current.version,
      updatedAt,
    });
  }
}
