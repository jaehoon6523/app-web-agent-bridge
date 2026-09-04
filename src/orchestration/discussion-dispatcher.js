import { validateAgentTurnInput } from "../domain/agent-messages.js";
import { AgentPacketParserStage } from "../domain/agent-packet-rejection.js";
import { DiscussionPacketSchema } from "../domain/packet-json-schemas.js";
import {
  AgentActor,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunPhase,
} from "../domain/vocabulary.js";
import { scanStartupRecovery } from "./recovery-scan.js";
import { rematerializeDiscussionPrompt } from "./discussion-turns.js";
import {
  DiscussionRuntimeResponseError,
  normalizeDiscussionRuntimeCompletion,
} from "./discussion-runtime-response.js";
import { DiscussionRuntimeEventConsumer } from "./discussion-runtime-events.js";
import { bindDiscussionProviderReceipt } from "./discussion-session-binding.js";
import { buildDiscussionRuntimeEvidence } from "./discussion-runtime-evidence.js";

const TERMINAL_PHASES = new Set([
  RunPhase.COMPLETE,
  RunPhase.FAILED,
  RunPhase.CANCELLED,
]);
const READY_SESSION_STATES = new Set([
  AgentSessionStatus.READY,
  AgentSessionStatus.WAITING,
]);

export class DiscussionDispatcherError extends Error {
  constructor(message, code = "DISCUSSION_DISPATCHER_ERROR", details = null) {
    super(message);
    this.name = "DiscussionDispatcherError";
    this.code = code;
    this.details = details;
  }
}

async function runPostCommitEffect(binding, payload, committed) {
  if (binding.afterDurableResponse === undefined) return;
  try {
    await binding.afterDurableResponse(payload);
  } catch {
    throw new DiscussionDispatcherError(
      "A post-commit runtime effect failed after the response was durably recorded.",
      "POST_COMMIT_EFFECT_FAILED",
      Object.freeze({
        responseStatus: committed.status,
        responseRecorded: true,
        runId: committed.run.runId,
        runVersion: committed.run.version,
        deliveryId: committed.delivery.deliveryId,
        deliveryState: committed.delivery.state,
        nextDeliveryId: committed.nextDelivery?.deliveryId ?? null,
      }),
    );
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function validateDependencies({ store, controller, sessions, artifactStore }) {
  for (const method of [
    "getRun",
    "getDelivery",
    "getAgentTurnInput",
    "getAgentMessage",
    "getProposalArtifactBySourceMessage",
    "listAgentSessions",
    "listDispatchableDeliveries",
  ]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`DiscussionOutboxDispatcher requires store.${method}().`);
    }
  }
  for (const method of [
    "claimNext",
    "markSubmitted",
    "markResponseStarted",
    "recordValidResponse",
    "recordInvalidResponse",
  ]) {
    if (typeof controller?.[method] !== "function") {
      throw new TypeError(`DiscussionOutboxDispatcher requires controller.${method}().`);
    }
  }
  if (artifactStore !== null && typeof artifactStore?.put !== "function") {
    throw new TypeError("artifactStore must expose put or be null.");
  }
  for (const actor of Object.values(AgentActor)) {
    const binding = sessions?.[actor];
    if (
      binding === null
      || typeof binding !== "object"
      || typeof binding.sessionId !== "string"
      || binding.session?.actor !== actor
      || typeof binding.session?.submitTurn !== "function"
      || typeof binding.session?.onEvent !== "function"
      || (
        binding.afterDurableResponse !== undefined
        && typeof binding.afterDurableResponse !== "function"
      )
    ) {
      throw new TypeError(`Invalid discussion runtime binding for ${actor}.`);
    }
  }
}

function sourceContext(store, turnInput) {
  if (turnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    return { sourceMessage: null, proposalArtifact: null, rejectedTurnInput: null };
  }
  if (turnInput.kind === AgentTurnInputKind.PEER_RELAY) {
    const sourceMessage = store.getAgentMessage(turnInput.sourceMessageId);
    return {
      sourceMessage,
      proposalArtifact: sourceMessage === null
        ? null
        : store.getProposalArtifactBySourceMessage(sourceMessage.messageId),
      rejectedTurnInput: null,
    };
  }
  if (turnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR) {
    const rejectedDelivery = store.getDelivery(turnInput.payload?.rejectedDeliveryId);
    const rejectedTurnInput = rejectedDelivery === null
      ? null
      : store.getAgentTurnInput(rejectedDelivery.inputId);
    const sourceMessage = rejectedTurnInput?.sourceMessageId === null
      || rejectedTurnInput?.sourceMessageId === undefined
      ? null
      : store.getAgentMessage(rejectedTurnInput.sourceMessageId);
    return { sourceMessage, proposalArtifact: null, rejectedTurnInput };
  }
  throw new DiscussionDispatcherError(
    `Unsupported discussion input kind ${turnInput.kind}.`,
    "DISCUSSION_INPUT_KIND_UNSUPPORTED",
  );
}

function runtimeBinding(store, sessions, runId, turnInput) {
  const persisted = store.listAgentSessions(runId).filter(({ actor }) => (
    actor === turnInput.targetActor
  ));
  const binding = sessions[turnInput.targetActor];
  if (
    persisted.length !== 1
    || persisted[0].sessionId !== binding.sessionId
    || !READY_SESSION_STATES.has(persisted[0].status)
    || typeof persisted[0].externalSessionId !== "string"
    || persisted[0].externalSessionId.length === 0
  ) {
    throw new DiscussionDispatcherError(
      `Input ${turnInput.inputId} has no exact ready runtime session binding.`,
      "RUNTIME_SESSION_BINDING_MISMATCH",
    );
  }
  if (
    typeof binding.session.externalSessionId === "string"
    && persisted[0].externalSessionId !== binding.session.externalSessionId
  ) {
    throw new DiscussionDispatcherError(
      "Runtime external session identity does not match persistence.",
      "RUNTIME_EXTERNAL_SESSION_MISMATCH",
    );
  }
  return { binding, persisted: persisted[0] };
}

const PACKET_CONTEXT_REJECTION_STAGE = new Map([
  ["DISCUSSION_PACKET_TYPE_NOT_ALLOWED", AgentPacketParserStage.DOMAIN_VALIDATION],
  ["PROPOSAL_REFERENCE_MISMATCH", AgentPacketParserStage.HASH_BINDING],
]);

function packetContextRejection(error, normalized) {
  const parserStage = PACKET_CONTEXT_REJECTION_STAGE.get(error?.code);
  if (parserStage === undefined || normalized === null) return null;
  return new DiscussionRuntimeResponseError(
    "Agent response conflicts with the frozen discussion context.",
    {
      code: error.code,
      parserStage,
      rawText: normalized.rawText,
      recordablePacketRejection: true,
      cause: error,
    },
  );
}

function currentWriteContext(store, runId, deliveryId) {
  const run = store.getRun(runId);
  const delivery = store.getDelivery(deliveryId);
  if (run === null || delivery === null) {
    throw new DiscussionDispatcherError(
      "The active run or delivery disappeared before its runtime result was stored.",
      "RUNTIME_WRITE_CONTEXT_MISSING",
    );
  }
  return { run, delivery };
}

export class DiscussionOutboxDispatcher {
  #store;
  #controller;
  #sessions;
  #artifactStore;
  #relayLimits;
  #events;
  #dispatching = false;

  /** @param {{
   *   store?: any,
   *   controller?: any,
   *   sessions?: Record<string, any>,
   *   artifactStore?: any,
   *   relayLimits?: any,
   *   startEventTimeoutMs?: number,
   *   completionEventTimeoutMs?: number
   * }} [options]
   */
  constructor({
    store,
    controller,
    sessions,
    artifactStore = null,
    relayLimits = undefined,
    startEventTimeoutMs = 30_000,
    completionEventTimeoutMs = 330_000,
  } = {}) {
    validateDependencies({ store, controller, sessions, artifactStore });
    this.#store = store;
    this.#controller = controller;
    this.#sessions = sessions;
    this.#artifactStore = artifactStore;
    this.#relayLimits = relayLimits;
    this.#events = new DiscussionRuntimeEventConsumer({
      sessions,
      startTimeoutMs: startEventTimeoutMs,
      completionTimeoutMs: completionEventTimeoutMs,
    });
  }

  async dispatchNext({ runId }) {
    if (this.#dispatching) {
      throw new DiscussionDispatcherError(
        "Only one discussion delivery may be dispatched at a time.",
        "DISCUSSION_DISPATCHER_BUSY",
      );
    }
    this.#dispatching = true;
    try {
      return await this.#dispatchNextUnlocked({ runId });
    } finally {
      this.#dispatching = false;
    }
  }

  async #dispatchNextUnlocked({ runId }) {
    requiredString(runId, "runId");
    const run = this.#store.getRun(runId);
    if (run === null) {
      throw new DiscussionDispatcherError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
    }
    if (TERMINAL_PHASES.has(run.phase) || run.paused || run.blocker !== null) return null;
    const pending = this.#store.listDispatchableDeliveries({ runId, limit: 2 });
    if (pending.length === 0) return null;
    if (pending.length > 1) {
      throw new DiscussionDispatcherError(
        `Run ${runId} has multiple pending discussion deliveries.`,
        "MULTIPLE_PENDING_DISCUSSION_DELIVERIES",
      );
    }

    const pendingInput = this.#store.getAgentTurnInput(pending[0].inputId);
    validateAgentTurnInput(pendingInput);
    const context = sourceContext(this.#store, pendingInput);
    const prompt = rematerializeDiscussionPrompt({
      run,
      turnInput: pendingInput,
      ...context,
      relayLimits: this.#relayLimits,
    });
    const runtime = runtimeBinding(
      this.#store,
      this.#sessions,
      runId,
      pendingInput,
    );

    const claimed = this.#controller.claimNext({
      runId,
      expectedRunVersion: run.version,
    });
    if (claimed === null) return null;
    if (claimed.deliveryId !== pending[0].deliveryId) {
      throw new DiscussionDispatcherError(
        "The claimed delivery differs from the preflighted delivery.",
        "DISCUSSION_DELIVERY_CLAIM_MISMATCH",
      );
    }
    const turnInput = this.#store.getAgentTurnInput(claimed.inputId);
    if (turnInput.inputId !== pendingInput.inputId) {
      throw new DiscussionDispatcherError(
        "The claimed delivery input differs from its preflighted input.",
        "DISCUSSION_INPUT_CLAIM_MISMATCH",
      );
    }
    const { binding, persisted } = runtime;
    const tracker = this.#events.arm({
      runId,
      deliveryId: claimed.deliveryId,
      inputId: turnInput.inputId,
      actor: turnInput.targetActor,
      sessionId: persisted.sessionId,
      externalSessionId: persisted.externalSessionId,
    });

    let submitted;
    let turnHandle;
    let normalized = null;
    try {
      turnHandle = await binding.session.submitTurn({
        turnId: claimed.deliveryId,
        controllerMessageId: turnInput.inputId,
        runId,
        text: prompt,
        outputSchema: DiscussionPacketSchema,
      });
      await tracker.confirmTurn(turnHandle?.turnId);
      const beforeSubmit = currentWriteContext(this.#store, runId, claimed.deliveryId);
      submitted = this.#controller.markSubmitted({
        runId,
        expectedRunVersion: beforeSubmit.run.version,
        deliveryId: claimed.deliveryId,
        expectedDeliveryVersion: claimed.version,
        providerReceipt: bindDiscussionProviderReceipt(
          { externalTurnId: turnHandle.turnId },
          persisted,
        ),
      });
      tracker.onResponseStarted(() => {
        const current = currentWriteContext(this.#store, runId, claimed.deliveryId);
        this.#controller.markResponseStarted({
          runId,
          expectedRunVersion: current.run.version,
          deliveryId: claimed.deliveryId,
          expectedDeliveryVersion: current.delivery.version,
          sessionId: persisted.sessionId,
          turnId: turnHandle.turnId,
        });
      });
      const observed = await tracker.awaitCompletion(turnHandle.completion);
      normalized = normalizeDiscussionRuntimeCompletion({
        actor: turnInput.targetActor,
        completion: observed.completion,
        turnId: turnHandle.turnId,
        externalSessionId: persisted.externalSessionId,
      });
      let recorded;
      try {
        const current = currentWriteContext(this.#store, runId, claimed.deliveryId);
        recorded = this.#controller.recordValidResponse({
          runId,
          expectedRunVersion: current.run.version,
          deliveryId: claimed.deliveryId,
          expectedDeliveryVersion: current.delivery.version,
          sessionId: persisted.sessionId,
          turnId: turnHandle.turnId,
          content: normalized.content,
          packet: normalized.packet,
        });
      } catch (error) {
        throw packetContextRejection(error, normalized) ?? error;
      }
      tracker.settle();
      const committed = Object.freeze({
        status: "RESPONSE_RECORDED",
        run: recorded.run,
        delivery: recorded.delivery,
        message: recorded.message,
        nextDelivery: recorded.nextDelivery,
        outcome: recorded.outcome,
      });
      await runPostCommitEffect(binding, {
        runId,
        deliveryId: claimed.deliveryId,
        inputId: turnInput.inputId,
        sessionId: persisted.sessionId,
        turnId: turnHandle.turnId,
        valid: true,
      }, committed);
      return committed;
    } catch (error) {
      if (
        error instanceof DiscussionRuntimeResponseError
        && error.recordablePacketRejection === true
        && submitted !== undefined
        && typeof turnHandle?.turnId === "string"
      ) {
        if (this.#artifactStore === null) {
          tracker.abandon();
          throw new DiscussionDispatcherError(
            "Invalid runtime output requires a sanitized runtime-response evidence store.",
            "RAW_RESPONSE_ARTIFACT_STORE_REQUIRED",
          );
        }
        const safeRuntimeEvidence = buildDiscussionRuntimeEvidence({
          actor: turnInput.targetActor,
          parserStage: error.parserStage,
          rawText: error.rawText,
        });
        const artifact = this.#artifactStore.put(safeRuntimeEvidence, {
          mimeType: "application/json; charset=utf-8",
          redacted: true,
        });
        const current = currentWriteContext(this.#store, runId, claimed.deliveryId);
        const rejected = this.#controller.recordInvalidResponse({
          runId,
          expectedRunVersion: current.run.version,
          deliveryId: claimed.deliveryId,
          expectedDeliveryVersion: current.delivery.version,
          sessionId: persisted.sessionId,
          turnId: turnHandle.turnId,
          parserStage: error.parserStage,
          errorCode: error.code,
          errorSummary: "Agent response failed strict protocol validation.",
          rawResponseArtifactHash: artifact.sha256,
        });
        tracker.settle();
        const committed = Object.freeze({
          status: "RESPONSE_REJECTED",
          run: rejected.run,
          delivery: rejected.delivery,
          rejectionEvent: rejected.rejectionEvent,
          nextDelivery: rejected.nextDelivery,
          outcome: rejected.outcome,
        });
        await runPostCommitEffect(binding, {
          runId,
          deliveryId: claimed.deliveryId,
          inputId: turnInput.inputId,
          sessionId: persisted.sessionId,
          turnId: turnHandle.turnId,
          valid: false,
        }, committed);
        return committed;
      }
      tracker.abandon();
      throw error;
    }
  }

  async runUntilSettled({ runId, maxDispatches = 100 }) {
    requiredString(runId, "runId");
    if (!Number.isSafeInteger(maxDispatches) || maxDispatches < 1) {
      throw new TypeError("maxDispatches must be a positive safe integer.");
    }
    let dispatched = 0;
    while (dispatched < maxDispatches) {
      const run = this.#store.getRun(runId);
      if (run === null) {
        throw new DiscussionDispatcherError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
      }
      if (TERMINAL_PHASES.has(run.phase)) {
        return Object.freeze({
          status: run.phase,
          run,
          outcome: this.#store.getRunOutcome(runId),
          dispatched,
        });
      }
      if (run.paused || run.blocker !== null) {
        return Object.freeze({ status: "HELD", run, outcome: null, dispatched });
      }
      if (this.#store.listDispatchableDeliveries({ runId, limit: 1 }).length === 0) {
        const recovery = scanStartupRecovery(this.#store).find((item) => item.runId === runId);
        return Object.freeze({
          status: recovery === undefined ? "IDLE" : "RECOVERY_REQUIRED",
          run,
          outcome: null,
          dispatched,
          recovery: recovery ?? null,
        });
      }
      const result = await this.dispatchNext({ runId });
      if (result === null) continue;
      dispatched += 1;
    }
    const finalRun = this.#store.getRun(runId);
    if (finalRun === null) {
      throw new DiscussionDispatcherError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
    }
    if (TERMINAL_PHASES.has(finalRun.phase)) {
      return Object.freeze({
        status: finalRun.phase,
        run: finalRun,
        outcome: this.#store.getRunOutcome(runId),
        dispatched,
      });
    }
    if (finalRun.paused || finalRun.blocker !== null) {
      return Object.freeze({ status: "HELD", run: finalRun, outcome: null, dispatched });
    }
    throw new DiscussionDispatcherError(
      `Run ${runId} exceeded dispatcher limit ${maxDispatches}.`,
      "DISPATCH_LIMIT_REACHED",
    );
  }

  close() {
    this.#events.close();
  }
}
