import { randomUUID } from "node:crypto";
import { agentPacketHash, validateAgentPacket } from "../domain/agent-packets.js";
import {
  AgentPacketRejectionRecoverability,
  buildAgentPacketRejectedEvent,
} from "../domain/agent-packet-rejection.js";
import { sha256CanonicalJson } from "../domain/canonical-json.js";
import { parseFinalControllerPacketEnvelope } from "../domain/controller-packet-envelope.js";
import { validateAgentTurnInput } from "../domain/agent-messages.js";
import { validateAgentRun } from "../domain/contracts.js";
import { deriveProtocolRepairPolicy } from "../domain/protocol-repair-policy.js";
import {
  createRunOutcome,
  startClaimedAgentTurn,
  transitionRunState,
} from "../domain/run-state-machine.js";
import {
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunBlockerType,
  RunOutcomeType,
  RunPhase,
} from "../domain/vocabulary.js";
import { runOutcomeHash } from "../persistence/run-outcomes.js";
import { DeliveryState } from "../persistence/schema.js";
import {
  DiscussionResponseDisposition,
  planDiscussionResponse,
} from "./discussion-response.js";
import {
  buildInitialDiscussionTurn,
  buildPeerDiscussionTurn,
  buildProtocolRepairDiscussionTurn,
} from "./discussion-turns.js";
import {
  discussionSubmissionEvidence,
  discussionTurnEvidence,
} from "./discussion-turn-evidence.js";
import {
  ProtocolFailureDecisionStatus,
  decideAgentPacketRejection,
} from "./protocol-failure.js";
import {
  assertSessionTurnIdAvailable,
  assertPacketReference,
  responseMeaningContext,
  responseReference,
  sourceMessageForInput,
} from "./discussion-response-context.js";
import {
  discussionResponseEventDetails,
  markDiscussionSessionWaiting,
} from "./discussion-response-evidence.js";
import { markDiscussionResponseStarted } from "./discussion-response-start.js";
import {
  holdDiscussionForExistingBlocker,
  planBlockedDiscussionTransition,
} from "./discussion-blocked.js";
import { parseDiscussionRuntimeEvidence } from "./discussion-runtime-evidence.js";
import {
  markDiscussionSessionRunning,
  requireSubmittedDiscussionSession,
  sessionForDiscussionSubmission,
} from "./discussion-session-binding.js";

const READY_SESSION_STATES = new Set([
  AgentSessionStatus.READY,
  AgentSessionStatus.WAITING,
]);
const PENDING_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: new Set([
    RunPhase.CODEX_TURN_PENDING,
    RunPhase.WEB_TO_CODEX_PENDING,
  ]),
  [AgentActor.CHATGPT_WEB_AGENT]: new Set([
    RunPhase.CODEX_TO_WEB_PENDING,
  ]),
});

const RUNNING_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_TURN_RUNNING,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_TURN_RUNNING,
});

const RESPONSE_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_RESPONSE_STORED,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_RESPONSE_STORED,
});

const MAX_TURNS_REACHED = "MAX_TURNS_REACHED";

export class DiscussionControllerError extends Error {
  constructor(message, code = "DISCUSSION_CONTROLLER_ERROR") {
    super(message);
    this.name = "DiscussionControllerError";
    this.code = code;
  }
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function requireExpectedRun(store, runId, expectedVersion) {
  const run = store.getRun(runId);
  if (!run) throw new DiscussionControllerError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
  validateAgentRun(run);
  if (run.version !== expectedVersion) {
    throw new DiscussionControllerError(
      `Run ${runId} expected version ${expectedVersion}, observed ${run.version}.`,
      "RUN_VERSION_CONFLICT",
    );
  }
  return run;
}

function requireExpectedDelivery(store, deliveryId, expectedVersion) {
  const delivery = store.getDelivery(deliveryId);
  if (!delivery) {
    throw new DiscussionControllerError(
      `Delivery ${deliveryId} does not exist.`,
      "DELIVERY_NOT_FOUND",
    );
  }
  if (delivery.version !== expectedVersion) {
    throw new DiscussionControllerError(
      `Delivery ${deliveryId} expected version ${expectedVersion}, observed ${delivery.version}.`,
      "DELIVERY_VERSION_CONFLICT",
    );
  }
  return delivery;
}

function assertReadySessions(store, runId) {
  const sessions = store.listAgentSessions(runId);
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const matches = sessions.filter((session) => session.actor === actor);
    if (matches.length !== 1 || !READY_SESSION_STATES.has(matches[0].status)) {
      throw new DiscussionControllerError(
        `Run ${runId} requires one ready ${actor} session.`,
        "DISCUSSION_SESSIONS_NOT_READY",
      );
    }
  }
}

export class DiscussionController {
  #store;
  #artifactStore;
  #clock;
  #idFactory;
  #relayLimits;

  constructor({
    store,
    clock = () => new Date().toISOString(),
    idFactory = randomUUID,
    relayLimits = undefined,
    artifactStore = null,
  }) {
    if (
      !store
      || typeof store.withTransaction !== "function"
      || typeof store.appendEventAndUpdateProjection !== "function"
    ) {
      throw new TypeError("DiscussionController requires a compatible SQLite store.");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("clock and idFactory must be functions.");
    }
    if (
      artifactStore !== null
      && (
        typeof artifactStore?.verify !== "function"
        || typeof artifactStore?.read !== "function"
      )
    ) {
      throw new TypeError("artifactStore must expose verify/read or be null.");
    }
    this.#store = store;
    this.#artifactStore = artifactStore;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#relayLimits = relayLimits;
  }

  #id(prefix) {
    return `${prefix}_${this.#idFactory()}`;
  }

  #appendTransition(current, next, eventType, details, createdAt) {
    this.#store.appendEventAndUpdateProjection({
      runId: current.runId,
      expectedVersion: current.version,
      eventId: this.#id("event"),
      eventType,
      payload: { run: next, details },
      createdAt,
      nextRun: next,
    });
  }

  start({ runId, expectedVersion }) {
    requireNonEmptyString(runId, "runId");
    requirePositiveInteger(expectedVersion, "expectedVersion");
    return this.#store.withTransaction(() => {
      const current = requireExpectedRun(this.#store, runId, expectedVersion);
      if (current.phase !== RunPhase.CREATED || current.paused) {
        throw new DiscussionControllerError(
          "A discussion can only start from an unpaused CREATED run.",
          "DISCUSSION_START_PHASE_MISMATCH",
        );
      }
      assertReadySessions(this.#store, runId);
      const at = this.#clock();
      const starting = transitionRunState(current, {
        to: RunPhase.STARTING_SESSIONS,
        expectedVersion: current.version,
        updatedAt: at,
      });
      const pending = transitionRunState(starting, {
        to: RunPhase.CODEX_TURN_PENDING,
        expectedVersion: starting.version,
        updatedAt: at,
      });
      const materialized = buildInitialDiscussionTurn({
        run: pending,
        inputId: this.#id("input"),
        createdAt: at,
        relayLimits: this.#relayLimits,
      });
      const nextDelivery = {
        turnInput: materialized.turnInput,
        deliveryId: this.#id("delivery"),
        idempotencyKey: this.#id("idempotency"),
        createdAt: at,
      };
      this.#appendTransition(current, starting, "DISCUSSION_SESSIONS_READY", {}, at);
      this.#store.saveAgentTurnInputWithDelivery(nextDelivery);
      this.#appendTransition(
        starting,
        pending,
        "AGENT_TURN_QUEUED",
        discussionTurnEvidence(nextDelivery),
        at,
      );
      return Object.freeze({ run: pending, ...nextDelivery, prompt: materialized.prompt });
    });
  }

  claimNext({ runId, expectedRunVersion }) {
    requireNonEmptyString(runId, "runId");
    requirePositiveInteger(expectedRunVersion, "expectedRunVersion");
    return this.#store.withTransaction(() => {
      const run = requireExpectedRun(this.#store, runId, expectedRunVersion);
      const pending = this.#store.listDispatchableDeliveries({ runId, limit: 2 });
      if (pending.length === 0) return null;
      if (pending.length > 1) {
        throw new DiscussionControllerError(
          `Run ${runId} has multiple pending discussion deliveries.`,
          "MULTIPLE_PENDING_DISCUSSION_DELIVERIES",
        );
      }
      if (run.paused || run.blocker !== null) return null;
      const turnInput = this.#store.getAgentTurnInput(pending[0].inputId);
      validateAgentTurnInput(turnInput);
      const correctPhase = turnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR
        ? run.phase === RESPONSE_PHASE_BY_ACTOR[turnInput.targetActor]
        : PENDING_PHASE_BY_ACTOR[turnInput.targetActor]?.has(run.phase) === true;
      if (!correctPhase) {
        throw new DiscussionControllerError(
          `Run phase ${run.phase} cannot claim ${turnInput.kind} for ${turnInput.targetActor}.`,
          "RUN_DELIVERY_ROUTE_MISMATCH",
        );
      }
      if (run.currentTurn >= run.maxTurns) {
        throw new DiscussionControllerError(
          `Run ${runId} has reached maxTurns (${run.maxTurns}).`,
          "RUN_TURN_LIMIT_REACHED",
        );
      }
      return this.#store.claimNextPendingDelivery({
        runId,
        claimedAt: this.#clock(),
      });
    });
  }

  markSubmitted({
    runId,
    expectedRunVersion,
    deliveryId,
    expectedDeliveryVersion,
    providerReceipt,
  }) {
    requireNonEmptyString(runId, "runId");
    requirePositiveInteger(expectedRunVersion, "expectedRunVersion");
    requireNonEmptyString(deliveryId, "deliveryId");
    requirePositiveInteger(expectedDeliveryVersion, "expectedDeliveryVersion");
    requirePlainObject(providerReceipt, "providerReceipt");
    return this.#store.withTransaction(() => {
      const run = requireExpectedRun(this.#store, runId, expectedRunVersion);
      const delivery = requireExpectedDelivery(
        this.#store,
        deliveryId,
        expectedDeliveryVersion,
      );
      if (delivery.runId !== runId || delivery.state !== DeliveryState.DISPATCHING) {
        throw new DiscussionControllerError(
          "Only the run's claimed DISPATCHING delivery can be submitted.",
          "DELIVERY_SUBMISSION_STATE_MISMATCH",
        );
      }
      const turnInput = this.#store.getAgentTurnInput(delivery.inputId);
      validateAgentTurnInput(turnInput);
      const externalTurnId = requireNonEmptyString(
        providerReceipt.externalTurnId,
        "providerReceipt.externalTurnId",
      );
      const session = sessionForDiscussionSubmission(
        this.#store,
        run,
        turnInput,
        providerReceipt,
      );
      assertSessionTurnIdAvailable(this.#store, session, externalTurnId);
      const protocolRepair = turnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR;
      if (!protocolRepair && !PENDING_PHASE_BY_ACTOR[turnInput.targetActor]?.has(run.phase)) {
        throw new DiscussionControllerError(
          `Run phase ${run.phase} cannot submit ${turnInput.targetActor}.`,
          "RUN_DELIVERY_ROUTE_MISMATCH",
        );
      }
      const at = this.#clock();
      const running = startClaimedAgentTurn(run, {
        actor: turnInput.targetActor,
        kind: turnInput.kind,
        expectedVersion: run.version,
        updatedAt: at,
      });
      const submitted = this.#store.transitionDelivery({
        deliveryId,
        expectedState: DeliveryState.DISPATCHING,
        expectedVersion: delivery.version,
        nextState: DeliveryState.SUBMITTED,
        providerReceipt,
        updatedAt: at,
      });
      const runningSession = markDiscussionSessionRunning(
        this.#store,
        session,
        externalTurnId,
        at,
      );
      this.#appendTransition(
        run,
        running,
        protocolRepair ? "PROTOCOL_REPAIR_TURN_STARTED" : "AGENT_TURN_SUBMITTED",
        discussionSubmissionEvidence({
          turnInput, deliveryId, sessionId: session.sessionId,
          turnId: externalTurnId, providerReceipt: submitted.providerReceipt,
          attemptCount: submitted.attemptCount,
        }),
        at,
      );
      return Object.freeze({
        run: running,
        delivery: submitted,
        turnInput,
        session: runningSession,
      });
    });
  }

  markResponseStarted(input) {
    return markDiscussionResponseStarted({
      ...input,
      store: this.#store,
      clock: this.#clock,
    });
  }

  recordInvalidResponse({
    runId,
    expectedRunVersion,
    deliveryId,
    expectedDeliveryVersion,
    sessionId,
    turnId,
    parserStage,
    errorCode,
    errorSummary,
    rawResponseArtifactHash,
  }) {
    requireNonEmptyString(runId, "runId");
    requirePositiveInteger(expectedRunVersion, "expectedRunVersion");
    requireNonEmptyString(deliveryId, "deliveryId");
    requirePositiveInteger(expectedDeliveryVersion, "expectedDeliveryVersion");
    requireNonEmptyString(sessionId, "sessionId");
    requireNonEmptyString(turnId, "turnId");
    requireNonEmptyString(parserStage, "parserStage");
    requireNonEmptyString(errorCode, "errorCode");
    requireNonEmptyString(errorSummary, "errorSummary");
    requireNonEmptyString(rawResponseArtifactHash, "rawResponseArtifactHash");
    if (this.#artifactStore === null) {
      throw new DiscussionControllerError(
        "Invalid responses require a verified sanitized runtime-response evidence artifact.",
        "RAW_RESPONSE_ARTIFACT_VERIFIER_REQUIRED",
      );
    }
    this.#artifactStore.verify(rawResponseArtifactHash);
    const runtimeEvidenceText = this.#artifactStore
      .read(rawResponseArtifactHash)
      .toString("utf8");

    return this.#store.withTransaction(() => {
      const run = requireExpectedRun(this.#store, runId, expectedRunVersion);
      const delivery = requireExpectedDelivery(
        this.#store,
        deliveryId,
        expectedDeliveryVersion,
      );
      if (
        delivery.runId !== runId
        || !new Set([DeliveryState.SUBMITTED, DeliveryState.RESPONSE_STARTED]).has(delivery.state)
      ) {
        throw new DiscussionControllerError(
          "An invalid response requires this run's submitted or started delivery.",
          "DELIVERY_RESPONSE_STATE_MISMATCH",
        );
      }
      const turnInput = this.#store.getAgentTurnInput(delivery.inputId);
      validateAgentTurnInput(turnInput);
      parseDiscussionRuntimeEvidence(runtimeEvidenceText, {
        actor: turnInput.targetActor,
        parserStage,
      });
      if (
        run.phase !== RUNNING_PHASE_BY_ACTOR[turnInput.targetActor]
        || run.activeActor !== turnInput.targetActor
      ) {
        throw new DiscussionControllerError(
          "The rejected response input does not match the active run actor.",
          "RUN_RESPONSE_ROUTE_MISMATCH",
        );
      }
      const session = requireSubmittedDiscussionSession({
        store: this.#store,
        run,
        turnInput,
        delivery,
        sessionId,
        turnId,
      });
      if (
        this.#store.getAgentMessageByInput(turnInput.inputId) !== null
        || this.#store.getAgentPacketRejectionByDelivery(deliveryId) !== null
      ) {
        throw new DiscussionControllerError(
          `Input ${turnInput.inputId} already has a terminal response.`,
          "AGENT_RESPONSE_ALREADY_STORED",
        );
      }

      const priorMessages = this.#store.listAgentMessages(runId);
      const responseContext = responseMeaningContext(
        this.#store,
        turnInput,
        priorMessages,
        this.#store.listProposalArtifacts(runId),
      );
      const repairPolicy = deriveProtocolRepairPolicy({
        rejectedTurnInput: responseContext.semanticTurnInput,
        sourceMessage: responseContext.sourceMessage,
      });
      const counters = this.#store.getRunLimits(runId);
      const at = this.#clock();
      const decision = decideAgentPacketRejection({
        confirmedAttribution: {
          runId,
          actor: turnInput.targetActor,
          sessionId,
          turnId,
          deliveryId,
          objectiveHash: run.objectiveHash,
          policyHash: run.policyHash,
        },
        parserStage,
        errorCode,
        errorSummary,
        rawResponseArtifactHash,
        limits: counters.limits,
        protocolRepairsUsed: counters.protocolRepairsUsed,
        repairPolicy,
        createdAt: at,
      });
      const responseStored = transitionRunState(run, {
        to: RESPONSE_PHASE_BY_ACTOR[turnInput.targetActor],
        expectedVersion: run.version,
        updatedAt: at,
      });
      const turnLimitReached = responseStored.currentTurn >= responseStored.maxTurns
        && decision.status !== ProtocolFailureDecisionStatus.FAILED;
      let rejectionEvent = turnLimitReached
        ? buildAgentPacketRejectedEvent({
          ...decision.rejectionEvent,
          protocolRepairsUsed: counters.protocolRepairsUsed,
          recoverability: AgentPacketRejectionRecoverability.EXHAUSTED,
        })
        : decision.rejectionEvent;

      this.#store.transitionDelivery({
        deliveryId,
        expectedState: delivery.state,
        expectedVersion: delivery.version,
        nextState: DeliveryState.RESPONSE_COMPLETED,
        updatedAt: at,
      });
      const waitingSession = markDiscussionSessionWaiting(this.#store, session, turnId, at);
      let updatedCounters = this.#store.recordConsecutiveActorFailure({
        runId,
        expectedCounterVersion: counters.counterVersion,
        updatedAt: at,
      });
      let finalRun = responseStored;
      let checking = null;
      let nextDelivery = null;
      let outcome = null;
      const heldForBlocker = responseStored.blocker !== null
        && (turnLimitReached
          || decision.status !== ProtocolFailureDecisionStatus.REPAIR_REQUIRED);

      if (heldForBlocker) {
        finalRun = holdDiscussionForExistingBlocker({ run: responseStored, updatedAt: at });
      } else if (turnLimitReached) {
        outcome = createRunOutcome({
          type: RunOutcomeType.INCONCLUSIVE,
          reason: MAX_TURNS_REACHED,
          unresolvedFindings: [`AGENT_PACKET_REJECTED:${errorCode}`],
        });
        checking = transitionRunState(responseStored, {
          to: RunPhase.CONSENSUS_CHECK,
          expectedVersion: responseStored.version,
          updatedAt: at,
        });
        finalRun = transitionRunState(checking, {
          to: RunPhase.COMPLETE,
          blocker: null,
          expectedVersion: checking.version,
          updatedAt: at,
        });
      } else if (decision.status === ProtocolFailureDecisionStatus.REPAIR_REQUIRED) {
        updatedCounters = this.#store.recordProtocolRepair({
          runId,
          expectedCounterVersion: updatedCounters.counterVersion,
          updatedAt: at,
        });
        const originalSource = sourceMessageForInput(turnInput, priorMessages);
        const materialized = buildProtocolRepairDiscussionTurn({
          run: responseStored,
          decision,
          rejectedTurnInput: turnInput,
          sourceMessage: originalSource,
          inputId: this.#id("input"),
          instructionId: "repair-agent-packet",
          createdAt: at,
          relayLimits: this.#relayLimits,
        });
        nextDelivery = {
          turnInput: materialized.turnInput,
          deliveryId: this.#id("delivery"),
          idempotencyKey: this.#id("idempotency"),
          createdAt: at,
          prompt: materialized.prompt,
        };
        this.#store.saveAgentTurnInputWithDelivery({
          turnInput: nextDelivery.turnInput,
          deliveryId: nextDelivery.deliveryId,
          idempotencyKey: nextDelivery.idempotencyKey,
          createdAt: nextDelivery.createdAt,
        });
        rejectionEvent = buildAgentPacketRejectedEvent({
          ...rejectionEvent,
          repair: discussionTurnEvidence(nextDelivery),
        });
      } else if (decision.status === ProtocolFailureDecisionStatus.FAILED) {
        outcome = decision.outcome;
        finalRun = transitionRunState(responseStored, {
          to: RunPhase.FAILED,
          blocker: null,
          expectedVersion: responseStored.version,
          updatedAt: at,
        });
      } else {
        const decisionId = `decision_${sha256CanonicalJson({
          runId,
          deliveryId,
          reason: decision.reason,
        }).slice(7)}`;
        finalRun = transitionRunState(responseStored, {
          to: RunPhase.HUMAN_GATE,
          blocker: {
            type: RunBlockerType.USER_DECISION,
            decisionIds: [decisionId],
          },
          expectedVersion: responseStored.version,
          updatedAt: at,
        });
      }

      this.#appendTransition(
        run,
        responseStored,
        rejectionEvent.eventType,
        rejectionEvent,
        at,
      );
      if (heldForBlocker) {
        this.#appendTransition(
          responseStored,
          finalRun,
          "AGENT_INVALID_RESPONSE_HELD_FOR_BLOCKER",
          {
            deliveryId,
            protocolFailureStatus: turnLimitReached ? MAX_TURNS_REACHED : decision.status,
            blocker: finalRun.blocker,
          },
          at,
        );
      } else if (turnLimitReached) {
        this.#appendTransition(responseStored, checking, "CONSENSUS_CHECKED", {
          disposition: RunOutcomeType.INCONCLUSIVE,
          reason: MAX_TURNS_REACHED,
        }, at);
        this.#appendTransition(checking, finalRun, "RUN_COMPLETED", {
          outcome,
          outcomeHash: runOutcomeHash(outcome),
        }, at);
        this.#store.saveRunOutcome({ runId, outcome, createdAt: at });
      } else if (decision.status === ProtocolFailureDecisionStatus.FAILED) {
        this.#appendTransition(responseStored, finalRun, "RUN_COMPLETED", {
          outcome,
          outcomeHash: runOutcomeHash(outcome),
        }, at);
        this.#store.saveRunOutcome({ runId, outcome, createdAt: at });
      } else if (decision.status === ProtocolFailureDecisionStatus.AUTHORITY_REQUIRED) {
        this.#appendTransition(responseStored, finalRun, "AGENT_PROTOCOL_AUTHORITY_REQUIRED", {
          deliveryId,
          reason: decision.reason,
          blocker: finalRun.blocker,
        }, at);
      }

      return Object.freeze({
        run: finalRun,
        delivery: this.#store.getDelivery(deliveryId),
        rejectionEvent,
        protocolFailureStatus: turnLimitReached ? MAX_TURNS_REACHED : decision.status,
        counters: updatedCounters,
        session: waitingSession,
        nextDelivery,
        outcome: outcome === null ? null : this.#store.getRunOutcome(runId),
      });
    });
  }

  recordValidResponse({
    runId,
    expectedRunVersion,
    deliveryId,
    expectedDeliveryVersion,
    sessionId,
    turnId,
    content,
    packet,
  }) {
    requireNonEmptyString(runId, "runId");
    requirePositiveInteger(expectedRunVersion, "expectedRunVersion");
    requireNonEmptyString(deliveryId, "deliveryId");
    requirePositiveInteger(expectedDeliveryVersion, "expectedDeliveryVersion");
    requireNonEmptyString(sessionId, "sessionId");
    requireNonEmptyString(turnId, "turnId");
    requireNonEmptyString(content, "content");
    validateAgentPacket(packet);
    const parsedPacket = parseFinalControllerPacketEnvelope(content).packet;
    if (agentPacketHash(parsedPacket) !== agentPacketHash(packet)) {
      throw new DiscussionControllerError(
        "The supplied packet does not match the final controller packet in content.",
        "AGENT_RESPONSE_PACKET_CONTENT_MISMATCH",
      );
    }
    packet = parsedPacket;

    return this.#store.withTransaction(() => {
      const run = requireExpectedRun(this.#store, runId, expectedRunVersion);
      const delivery = requireExpectedDelivery(
        this.#store,
        deliveryId,
        expectedDeliveryVersion,
      );
      if (
        delivery.runId !== runId
        || !new Set([DeliveryState.SUBMITTED, DeliveryState.RESPONSE_STARTED]).has(delivery.state)
      ) {
        throw new DiscussionControllerError(
          "A valid response requires this run's submitted or started delivery.",
          "DELIVERY_RESPONSE_STATE_MISMATCH",
        );
      }
      const turnInput = this.#store.getAgentTurnInput(delivery.inputId);
      validateAgentTurnInput(turnInput);
      if (
        run.phase !== RUNNING_PHASE_BY_ACTOR[turnInput.targetActor]
        || run.activeActor !== turnInput.targetActor
      ) {
        throw new DiscussionControllerError(
          "The response input does not match the active run actor.",
          "RUN_RESPONSE_ROUTE_MISMATCH",
        );
      }
      const session = requireSubmittedDiscussionSession({
        store: this.#store,
        run,
        turnInput,
        delivery,
        sessionId,
        turnId,
      });
      if (this.#store.getAgentMessageByInput(turnInput.inputId) !== null) {
        throw new DiscussionControllerError(
          `Input ${turnInput.inputId} already produced a message.`,
          "AGENT_RESPONSE_ALREADY_STORED",
        );
      }

      const priorMessages = this.#store.listAgentMessages(runId);
      const proposals = this.#store.listProposalArtifacts(runId);
      const {
        sourceMessage,
        sourceProposal,
        repairContext,
      } = responseMeaningContext(this.#store, turnInput, priorMessages, proposals);
      assertPacketReference(packet, responseReference(sourceMessage, sourceProposal));

      const at = this.#clock();
      const packetId = this.#id("packet");
      const plan = planDiscussionResponse({
        run,
        turnInput,
        sessionId,
        turnId,
        content,
        packet,
        priorMessages,
        persistedProposals: proposals,
        messageId: this.#id("message"),
        proposalId: packet.type === AgentPacketType.PROPOSAL
          ? this.#id("proposal")
          : null,
        createdAt: at,
        repairContext,
      });

      const responseStored = transitionRunState(run, {
        to: RESPONSE_PHASE_BY_ACTOR[plan.message.actor],
        expectedVersion: run.version,
        updatedAt: at,
      });
      let finalRun;
      let checking = null;
      let nextDelivery = null;
      let outcome = plan.outcome;
      let disposition = plan.disposition;

      if (
        responseStored.blocker !== null
        && new Set([
          DiscussionResponseDisposition.BLOCKED,
          DiscussionResponseDisposition.COMPLETE,
        ]).has(plan.disposition)
      ) {
        checking = transitionRunState(responseStored, {
          to: RunPhase.CONSENSUS_CHECK,
          expectedVersion: responseStored.version,
          updatedAt: at,
        });
        finalRun = holdDiscussionForExistingBlocker({ run: checking, updatedAt: at });
        disposition = DiscussionResponseDisposition.HELD;
        outcome = null;
      } else if (plan.disposition === DiscussionResponseDisposition.BLOCKED) {
        const blocked = planBlockedDiscussionTransition({
          run: responseStored,
          message: plan.message,
          updatedAt: at,
        });
        finalRun = blocked.state;
        outcome = blocked.outcome;
      } else {
        checking = transitionRunState(responseStored, {
          to: RunPhase.CONSENSUS_CHECK,
          expectedVersion: responseStored.version,
          updatedAt: at,
        });
        if (plan.disposition === DiscussionResponseDisposition.RELAY) {
          const materialized = buildPeerDiscussionTurn({
            run: checking,
            sourceMessage: plan.message,
            proposalArtifact: plan.proposalArtifact,
            inputId: this.#id("input"),
            createdAt: at,
            relayLimits: this.#relayLimits,
          });
          nextDelivery = {
            turnInput: materialized.turnInput,
            deliveryId: this.#id("delivery"),
            idempotencyKey: this.#id("idempotency"),
            createdAt: at,
            prompt: materialized.prompt,
          };
          const pendingPhase = plan.message.actor === AgentActor.CODEX_AGENT
            ? RunPhase.CODEX_TO_WEB_PENDING
            : RunPhase.WEB_TO_CODEX_PENDING;
          finalRun = transitionRunState(checking, {
            to: pendingPhase,
            sourceActor: plan.message.actor,
            expectedVersion: checking.version,
            updatedAt: at,
          });
        } else {
          finalRun = transitionRunState(checking, {
            to: RunPhase.COMPLETE,
            blocker: null,
            expectedVersion: checking.version,
            updatedAt: at,
          });
        }
      }

      const responseDetails = discussionResponseEventDetails({
        delivery,
        turnInput,
        plan,
        packetId,
        nextDelivery,
        outcome,
        disposition,
      });
      this.#store.transitionDelivery({
        deliveryId,
        expectedState: delivery.state,
        expectedVersion: delivery.version,
        nextState: DeliveryState.RESPONSE_COMPLETED,
        updatedAt: at,
      });
      const waitingSession = markDiscussionSessionWaiting(this.#store, session, turnId, at);
      this.#store.saveAgentMessage({ inputId: turnInput.inputId, message: plan.message });
      this.#store.saveAgentPacket({
        packetId,
        runId,
        messageId: plan.message.messageId,
        packet: plan.message.normalizedPacket,
        createdAt: at,
      });
      if (plan.proposalArtifact !== null && !plan.proposalReused) {
        this.#store.saveProposalArtifact(plan.proposalArtifact);
      }
      const limits = this.#store.getRunLimits(runId);
      this.#store.resetConsecutiveActorFailures({
        runId,
        expectedCounterVersion: limits.counterVersion,
        updatedAt: at,
      });
      this.#appendTransition(run, responseStored, "AGENT_RESPONSE_STORED", responseDetails, at);

      if (checking !== null) {
        this.#appendTransition(responseStored, checking, "CONSENSUS_CHECKED", {
          disposition,
          outcomeHash: outcome === null ? null : runOutcomeHash(outcome),
        }, at);
      }
      if (nextDelivery !== null) {
        this.#store.saveAgentTurnInputWithDelivery({
          turnInput: nextDelivery.turnInput,
          deliveryId: nextDelivery.deliveryId,
          idempotencyKey: nextDelivery.idempotencyKey,
          createdAt: nextDelivery.createdAt,
        });
        this.#appendTransition(
          checking,
          finalRun,
          "AGENT_TURN_QUEUED",
          discussionTurnEvidence(nextDelivery),
          at,
        );
        const completed = this.#store.getDelivery(deliveryId);
        this.#store.transitionDelivery({
          deliveryId,
          expectedState: DeliveryState.RESPONSE_COMPLETED,
          expectedVersion: completed.version,
          nextState: DeliveryState.RELAYED,
          updatedAt: at,
        });
      } else if (disposition === DiscussionResponseDisposition.HELD) {
        this.#appendTransition(checking, finalRun, "AGENT_RESPONSE_HELD_FOR_BLOCKER", {
          messageId: plan.message.messageId,
          plannedDisposition: plan.disposition,
          blocker: finalRun.blocker,
        }, at);
      } else if (
        plan.disposition === DiscussionResponseDisposition.BLOCKED
        && outcome === null
      ) {
        this.#appendTransition(responseStored, finalRun, "AGENT_RESPONSE_BLOCKED", {
          messageId: plan.message.messageId,
          reasonCode: plan.message.normalizedPacket.reason_code,
          blocker: finalRun.blocker,
          sideRecord: null,
        }, at);
      } else {
        this.#appendTransition(checking ?? responseStored, finalRun, "RUN_COMPLETED", {
          outcome,
          outcomeHash: runOutcomeHash(outcome),
        }, at);
      }
      if (outcome !== null) {
        this.#store.saveRunOutcome({ runId, outcome, createdAt: at });
      }

      return Object.freeze({
        run: finalRun,
        delivery: this.#store.getDelivery(deliveryId),
        message: plan.message,
        packet: this.#store.getAgentPacket(packetId),
        proposalArtifact: plan.proposalArtifact,
        proposalReused: plan.proposalReused,
        session: waitingSession,
        nextDelivery,
        outcome: outcome === null ? null : this.#store.getRunOutcome(runId),
      });
    });
  }
}
