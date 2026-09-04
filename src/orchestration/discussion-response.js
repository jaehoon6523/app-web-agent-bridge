import { validateAgentPacket } from "../domain/agent-packets.js";
import {
  buildAgentMessage,
  validateAgentMessage,
  validateAgentTurnInput,
} from "../domain/agent-messages.js";
import { evaluateConsensus } from "../domain/consensus.js";
import {
  buildProposalArtifact,
  validateAgentRun,
  validateProposalArtifact,
} from "../domain/contracts.js";
import {
  assertDiscussionPacketTypeAllowed,
  blockedRoutingResult,
} from "../domain/discussion-actions.js";
import { assertProtocolRepairPolicyBinding } from "../domain/protocol-repair-policy.js";
import { createRunOutcome } from "../domain/run-state-machine.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  AgentTurnInputKind,
  RunOutcomeType,
  RunPhase,
} from "../domain/vocabulary.js";
import { otherActor } from "./controller-prompt.js";
import { validateProtocolRepairPayload } from "./protocol-failure.js";

export const DiscussionResponseDisposition = Object.freeze({
  RELAY: "RELAY",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  HELD: "HELD",
});

export class DiscussionResponseError extends TypeError {
  constructor(message, code = "INVALID_DISCUSSION_RESPONSE") {
    super(message);
    this.name = "DiscussionResponseError";
    this.code = code;
  }
}

const RUNNING_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_TURN_RUNNING,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_TURN_RUNNING,
});

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiscussionResponseError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new DiscussionResponseError(`${name} must be an array.`);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function sourceMessageForInput(turnInput, messages) {
  if (turnInput.kind !== AgentTurnInputKind.PEER_RELAY) return null;
  const source = messages.find((message) => message.messageId === turnInput.sourceMessageId);
  if (!source) {
    throw new DiscussionResponseError(
      `PEER_RELAY source ${turnInput.sourceMessageId} is not present.`,
      "SOURCE_MESSAGE_NOT_FOUND",
    );
  }
  validateAgentMessage(source);
  if (
    source.runId !== turnInput.runId
    || source.objectiveHash !== turnInput.objectiveHash
    || source.policyHash !== turnInput.policyHash
    || source.actor === turnInput.targetActor
  ) {
    throw new DiscussionResponseError(
      "PEER_RELAY source does not match the current run route.",
      "SOURCE_MESSAGE_ROUTE_MISMATCH",
    );
  }
  return source;
}

function requireRepairResponseContext(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscussionResponseError(
      "PROTOCOL_REPAIR requires its rejected delivery and turn input context.",
      "PROTOCOL_REPAIR_CONTEXT_REQUIRED",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new DiscussionResponseError(
      "Protocol repair context must be a plain string-keyed object.",
      "INVALID_PROTOCOL_REPAIR_CONTEXT",
    );
  }
  const expected = new Set(["rejectedDeliveryId", "rejectedTurnInput"]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new DiscussionResponseError(
        `Protocol repair context contains unsupported property ${JSON.stringify(key)}.`,
        "INVALID_PROTOCOL_REPAIR_CONTEXT",
      );
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new DiscussionResponseError(
        `Protocol repair context is missing ${JSON.stringify(key)}.`,
        "INVALID_PROTOCOL_REPAIR_CONTEXT",
      );
    }
  }
  requiredString(value.rejectedDeliveryId, "repairContext.rejectedDeliveryId");
  validateAgentTurnInput(value.rejectedTurnInput);
  return value;
}

function responseMeaningContext(turnInput, messages, repairContext) {
  if (turnInput.kind !== AgentTurnInputKind.PROTOCOL_REPAIR) {
    if (repairContext !== null) {
      throw new DiscussionResponseError(
        "repairContext is only valid for PROTOCOL_REPAIR.",
        "UNEXPECTED_PROTOCOL_REPAIR_CONTEXT",
      );
    }
    return {
      semanticTurnInput: turnInput,
      semanticSourceMessage: sourceMessageForInput(turnInput, messages),
    };
  }

  validateProtocolRepairPayload(turnInput.payload);
  const context = requireRepairResponseContext(repairContext);
  const rejectedTurnInput = context.rejectedTurnInput;
  if (context.rejectedDeliveryId !== turnInput.payload.rejectedDeliveryId) {
    throw new DiscussionResponseError(
      "Protocol repair context does not match the rejected delivery.",
      "PROTOCOL_REPAIR_DELIVERY_MISMATCH",
    );
  }
  if (
    rejectedTurnInput.runId !== turnInput.runId
    || rejectedTurnInput.targetActor !== turnInput.targetActor
    || rejectedTurnInput.objectiveHash !== turnInput.objectiveHash
    || rejectedTurnInput.policyHash !== turnInput.policyHash
  ) {
    throw new DiscussionResponseError(
      "Protocol repair input is not bound to its rejected turn input.",
      "PROTOCOL_REPAIR_ORIGIN_MISMATCH",
    );
  }
  const sourceMessage = sourceMessageForInput(rejectedTurnInput, messages);
  assertProtocolRepairPolicyBinding({
    repairPayload: turnInput.payload,
    rejectedTurnInput,
    sourceMessage,
  });
  return {
    semanticTurnInput: rejectedTurnInput,
    semanticSourceMessage: sourceMessage,
  };
}

function messageKindForPacket(turnInput, sourceMessage, packet) {
  switch (packet.type) {
    case AgentPacketType.PROPOSAL:
      if (turnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
        return AgentMessageKind.PROPOSAL;
      }
      if (
        turnInput.kind === AgentTurnInputKind.PEER_RELAY
        && sourceMessage?.kind === AgentMessageKind.CRITIQUE
      ) {
        return AgentMessageKind.REVISION;
      }
      throw new DiscussionResponseError(
        "A PROPOSAL packet does not have an authorized Proposal/Revision meaning in this input context.",
        "PROPOSAL_MESSAGE_KIND_AMBIGUOUS",
      );
    case AgentPacketType.CRITIQUE:
      return AgentMessageKind.CRITIQUE;
    case AgentPacketType.ACCEPT:
      return AgentMessageKind.ACCEPTANCE;
    case AgentPacketType.BLOCKED:
      return AgentMessageKind.BLOCKER;
    default:
      throw new DiscussionResponseError("Unsupported AgentPacket type.");
  }
}

function nextMessageSequence(messages) {
  let expected = 1;
  for (const message of messages) {
    validateAgentMessage(message);
    if (message.sequence !== expected) {
      throw new DiscussionResponseError(
        `AgentMessage sequence ${message.sequence} must be ${expected}.`,
        "AGENT_MESSAGE_SEQUENCE_MISMATCH",
      );
    }
    expected += 1;
  }
  return expected;
}

function matchingProposal(proposals, candidate) {
  return proposals.find((proposal) => {
    validateProposalArtifact(proposal);
    return proposal.runId === candidate.runId
      && proposal.proposalRefHash === candidate.proposalRefHash;
  }) ?? null;
}

function unresolvedFindings(messages) {
  const latestByActor = new Map();
  for (const message of messages) latestByActor.set(message.actor, message);
  const findings = [];
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const packet = latestByActor.get(actor)?.normalizedPacket;
    if (packet?.type === AgentPacketType.CRITIQUE) {
      findings.push(...packet.blocking_findings);
    }
  }
  return findings;
}

/**
 * Plans one already-attributed, strict provider response. This function does
 * not persist anything. The store-owned compound transaction must re-check
 * every binding before making this plan canonical.
 */
export function planDiscussionResponse({
  run,
  turnInput,
  sessionId,
  turnId,
  content,
  packet,
  priorMessages,
  persistedProposals,
  messageId,
  proposalId = null,
  createdAt,
  policyViolation = false,
  repairContext = null,
}) {
  validateAgentRun(run);
  validateAgentTurnInput(turnInput);
  validateAgentPacket(packet);
  requireArray(priorMessages, "priorMessages");
  requireArray(persistedProposals, "persistedProposals");
  requiredString(sessionId, "sessionId");
  requiredString(turnId, "turnId");
  requiredString(content, "content");
  requiredString(messageId, "messageId");
  requiredString(createdAt, "createdAt");

  if (
    turnInput.runId !== run.runId
    || turnInput.objectiveHash !== run.objectiveHash
    || turnInput.policyHash !== run.policyHash
  ) {
    throw new DiscussionResponseError(
      "AgentTurnInput is not bound to the current run.",
      "RUN_BINDING_MISMATCH",
    );
  }
  const expectedRunningPhase = RUNNING_PHASE_BY_ACTOR[turnInput.targetActor];
  if (run.phase !== expectedRunningPhase || run.activeActor !== turnInput.targetActor) {
    throw new DiscussionResponseError(
      `AgentTurnInput target ${turnInput.targetActor} is not active in ${run.phase}.`,
      "TURN_INPUT_RUN_PHASE_MISMATCH",
    );
  }
  const { semanticTurnInput, semanticSourceMessage } = responseMeaningContext(
    turnInput,
    priorMessages,
    repairContext,
  );
  assertDiscussionPacketTypeAllowed({
    inputKind: semanticTurnInput.kind,
    peerMessageKind: semanticSourceMessage?.kind ?? null,
  }, packet.type);

  const message = buildAgentMessage({
    messageId,
    runId: run.runId,
    sequence: nextMessageSequence(priorMessages),
    actor: turnInput.targetActor,
    sessionId,
    turnId,
    kind: messageKindForPacket(semanticTurnInput, semanticSourceMessage, packet),
    content,
    normalizedPacket: packet,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt,
  });

  let proposalArtifact = null;
  let proposalReused = false;
  if (packet.type === AgentPacketType.PROPOSAL) {
    requiredString(proposalId, "proposalId");
    const candidate = buildProposalArtifact({
      proposalId,
      runId: run.runId,
      authorActor: message.actor,
      sourceMessageId: message.messageId,
      sourceSessionId: message.sessionId,
      sourceTurnId: message.turnId,
      summary: packet.summary,
      body: packet.body,
      assumptions: packet.assumptions,
      openDecisions: packet.open_decisions,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
      createdAt,
    });
    proposalArtifact = matchingProposal(persistedProposals, candidate) ?? candidate;
    proposalReused = proposalArtifact !== candidate;
  } else if (proposalId !== null) {
    throw new DiscussionResponseError(
      "proposalId is only valid for a PROPOSAL packet.",
      "UNEXPECTED_PROPOSAL_ID",
    );
  }

  const messages = [...priorMessages, message];
  const proposals = proposalArtifact === null || proposalReused
    ? [...persistedProposals]
    : [...persistedProposals, proposalArtifact];
  const consensus = evaluateConsensus({
    runId: run.runId,
    messages,
    proposals,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    policyViolation,
  });

  /** @type {"RELAY" | "COMPLETE" | "BLOCKED"} */
  let disposition = DiscussionResponseDisposition.RELAY;
  let outcome = consensus;
  let blockedRoute = null;
  if (packet.type === AgentPacketType.BLOCKED) {
    disposition = DiscussionResponseDisposition.BLOCKED;
    blockedRoute = blockedRoutingResult(packet.reason_code);
  } else if (outcome !== null) {
    disposition = DiscussionResponseDisposition.COMPLETE;
  } else if (run.currentTurn + 1 >= run.maxTurns) {
    disposition = DiscussionResponseDisposition.COMPLETE;
    outcome = createRunOutcome({
      type: RunOutcomeType.INCONCLUSIVE,
      reason: "MAX_TURNS_REACHED",
      unresolvedFindings: unresolvedFindings(messages),
    });
  }

  return deepFreeze({
    message,
    proposalArtifact,
    proposalReused,
    disposition,
    outcome,
    blockedRoute,
    nextActor: disposition === DiscussionResponseDisposition.RELAY
      ? otherActor(message.actor)
      : null,
  });
}
