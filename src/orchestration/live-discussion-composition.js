import { randomUUID } from "node:crypto";
import { createAgentSessionRecord } from "../domain/contracts.js";
import {
  canonicalConversationUrl,
  createWebSessionBinding,
  extractConversationId,
} from "../runtime/web/binding.js";
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
 * Builds the Controller-owned first-run binding from a user-selected existing
 * ChatGPT conversation URL. The extension must later prove there is exactly
 * one tab displaying this conversation before it becomes BOUND.
 */
/** @param {{runId: string, sessionId: string, conversationUrl: string}} input */
export function createInitialWebSessionBinding({ runId, sessionId, conversationUrl }) {
  nonEmpty(runId, "runId");
  nonEmpty(sessionId, "sessionId");
  const canonicalUrl = canonicalConversationUrl(conversationUrl);
  const conversationId = extractConversationId(canonicalUrl);
  if (canonicalUrl === null || conversationId === null) {
    throw new LiveDiscussionCompositionError(
      "A canonical https://chatgpt.com/c/<conversation-id> URL is required.",
      "CHATGPT_CONVERSATION_URL_INVALID",
    );
  }
  return createWebSessionBinding({
    sessionId,
    runId,
    tabId: null,
    windowId: null,
    conversationUrl: canonicalUrl,
    conversationId,
    title: null,
    lastObservedUserMessageId: null,
    lastObservedAssistantMessageId: null,
    bindingStatus: "NEEDS_REBIND",
  });
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
  #runtimeSessions = new Map();

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

  getRuntimeSessions(runId) {
    return this.#runtimeSessions.get(runId) ?? null;
  }

  async restorePendingRun(runId) {
    if (this.#runtimeSessions.has(runId)) return;
    const run = this.#store.getRun(runId);
    const deliveries = this.#store.listDeliveries(runId);
    if (!run || run.blocker || !deliveries.some((d) => d.state === "PENDING")
      || deliveries.some((d) => !["PENDING", "RELAYED", "RESPONSE_COMPLETED"].includes(d.state))) {
      throw new LiveDiscussionCompositionError("Only confirmed unsent pending work can be resumed.", "RECOVERY_REQUIRED");
    }
    const records = this.#store.listAgentSessions(runId);
    const codexRecord = records.find((s) => s.actor === AgentActor.CODEX_AGENT);
    const webRecord = records.find((s) => s.actor === AgentActor.CHATGPT_WEB_AGENT);
    if (!codexRecord?.externalSessionId || !webRecord?.externalLocator) {
      throw new LiveDiscussionCompositionError("Persisted session identities are missing.", "RECOVERY_REQUIRED");
    }
    const web = this.#createWebSession({ run, sessionId: webRecord.sessionId });
    await web.resume({ binding: createInitialWebSessionBinding({
      runId, sessionId: webRecord.sessionId, conversationUrl: webRecord.externalLocator,
    }) });
    runtimeActor(web, AgentActor.CHATGPT_WEB_AGENT);
    if (web.externalSessionId !== webRecord.externalSessionId) throw new Error("Web conversation changed.");
    const codex = this.#createCodexSession({ run, sessionId: codexRecord.sessionId,
      persistThreadBinding: (binding) => this.#persistCodexThreadBinding({ sessionId: codexRecord.sessionId, runId, binding }),
    });
    try {
      await codex.resume({ threadId: codexRecord.externalSessionId });
      if (codex.activeTurnId || codex.externalSessionId !== codexRecord.externalSessionId) {
        throw new LiveDiscussionCompositionError("Provider still has an active or different turn.", "RECOVERY_REQUIRED");
      }
      this.#markReady({ sessionId: codexRecord.sessionId, externalSessionId: codexRecord.externalSessionId, externalLocator: null });
      this.#markReady({ sessionId: webRecord.sessionId, externalSessionId: webRecord.externalSessionId, externalLocator: webRecord.externalLocator });
      const dispatcher = new DiscussionOutboxDispatcher({
        store: this.#store, controller: this.#controller, artifactStore: this.#artifactStore,
        sessions: {
          CODEX_AGENT: { sessionId: codexRecord.sessionId, session: codex },
          CHATGPT_WEB_AGENT: { sessionId: webRecord.sessionId, session: web,
            afterDurableResponse: typeof web.acknowledgeDelivery === "function" ? ({ turnId }) => web.acknowledgeDelivery({ turnId }) : undefined },
        },
      });
      this.#dispatchers.set(runId, dispatcher);
      this.#runtimeSessions.set(runId, { CODEX_AGENT: codex, CHATGPT_WEB_AGENT: web });
    } catch (error) {
      await codex.close();
      throw error;
    }
  }

  /** @param {{runId?: string, objective: string, policy: any, webConversationUrl: string}} input */
  async provisionRun({ runId, objective, policy, webConversationUrl }) {
    const runInput = { objective, policy };
    if (runId !== undefined) runInput.runId = runId;
    let { run } = this.#runService.prepareRun(runInput);
    const codexSessionId = `session_codex_${this.#idFactory()}`;
    const webSessionId = `session_web_${this.#idFactory()}`;
    const webBinding = createInitialWebSessionBinding({
      runId: run.runId,
      sessionId: webSessionId,
      conversationUrl: webConversationUrl,
    });
    const web = this.#createWebSession({ run, sessionId: webSessionId });
    const beginWebSession = webBinding?.tabId === null ? web?.resume : web?.start;
    if (typeof beginWebSession !== "function") {
      throw new LiveDiscussionCompositionError("Web runtime cannot start or resume a session.", "WEB_RUNTIME_INVALID");
    }
    let binding;
    try {
      // First-run URL binding deliberately resumes only an exact existing
      // conversation. The extension rejects zero or multiple matching tabs.
      binding = await beginWebSession.call(web, { binding: webBinding });
      runtimeActor(web, AgentActor.CHATGPT_WEB_AGENT);
    } catch (cause) {
      throw new LiveDiscussionCompositionError(
        "ChatGPT Web session provisioning did not complete; no discussion delivery was queued.",
        "WEB_SESSION_PROVISIONING_FAILED",
        { cause },
      );
    }

    this.#store.withTransaction(() => {
      run = this.#runService.createRun({ ...runInput, runId: run.runId });
      this.#createSession({ sessionId: codexSessionId, runId: run.runId,
        actor: AgentActor.CODEX_AGENT, provider: SessionProvider.CODEX_APP_SERVER });
      this.#createSession({ sessionId: webSessionId, runId: run.runId,
        actor: AgentActor.CHATGPT_WEB_AGENT, provider: SessionProvider.CHATGPT_WEB });
      this.#markReady({ sessionId: webSessionId, externalSessionId: web.externalSessionId,
        externalLocator: binding?.conversationUrl ?? null });
    });

    // Do not start a Codex thread until exact Web conversation binding is
    // proven. A missing login, invalid URL, or ambiguous tabs must be a
    // no-provider-side-effect failure.
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

    const dispatcher = new DiscussionOutboxDispatcher({
      store: this.#store,
      controller: this.#controller,
      artifactStore: this.#artifactStore,
      sessions: {
        [AgentActor.CODEX_AGENT]: { sessionId: codexSessionId, session: codex },
        [AgentActor.CHATGPT_WEB_AGENT]: {
          sessionId: webSessionId,
          session: web,
          afterDurableResponse: typeof web.acknowledgeDelivery === "function"
            ? ({ turnId }) => web.acknowledgeDelivery({ turnId })
            : undefined,
        },
      },
    });
    const started = this.#controller.start({ runId: run.runId, expectedVersion: run.version });
    this.#dispatchers.set(run.runId, dispatcher);
    this.#runtimeSessions.set(run.runId, { CODEX_AGENT: codex, CHATGPT_WEB_AGENT: web });
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
    this.#runtimeSessions.clear();
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
