import { canonicalJson, sha256Text } from "../domain/canonical-json.js";
import {
  buildAgentTurnInput,
  validateAgentMessage,
  validateAgentTurnInput,
} from "../domain/agent-messages.js";
import { validateAgentRun, validateProposalArtifact } from "../domain/contracts.js";
import { assertProtocolRepairPolicyBinding } from "../domain/protocol-repair-policy.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentTurnInputKind,
  RunMode,
  RunPhase,
} from "../domain/vocabulary.js";
import { buildControllerPrompt, otherActor } from "./controller-prompt.js";
import {
  buildProtocolRepairPayload,
  buildProtocolRepairTurnInput,
  validateProtocolFailureDecision,
  validateProtocolRepairPayload,
} from "./protocol-failure.js";

export const DISCUSSION_PROMPT_TEMPLATE_VERSION = "controller-prompt-v1";

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function proposalForMessage(message, proposalArtifact) {
  const isProposal = message.kind === AgentMessageKind.PROPOSAL
    || message.kind === AgentMessageKind.REVISION;
  if (!isProposal) {
    if (proposalArtifact !== null) {
      throw new TypeError("proposalArtifact is only valid for proposal/revision messages.");
    }
    return null;
  }
  validateProposalArtifact(proposalArtifact);
  if (
    proposalArtifact.runId !== message.runId
    || canonicalJson({
      summary: proposalArtifact.summary,
      body: proposalArtifact.body,
      assumptions: proposalArtifact.assumptions,
      openDecisions: proposalArtifact.openDecisions,
    }) !== canonicalJson({
      summary: message.normalizedPacket.summary,
      body: message.normalizedPacket.body,
      assumptions: message.normalizedPacket.assumptions,
      openDecisions: message.normalizedPacket.open_decisions,
    })
  ) {
    throw new TypeError("proposalArtifact does not match its source AgentMessage.");
  }
  return proposalArtifact;
}

function assertTurnInputRunBinding(run, turnInput) {
  if (
    turnInput.runId !== run.runId
    || turnInput.objectiveHash !== run.objectiveHash
    || turnInput.policyHash !== run.policyHash
  ) {
    throw new TypeError("AgentTurnInput does not match the current run binding.");
  }
}

function sourceForRejectedInput(rejectedTurnInput, sourceMessage) {
  if (rejectedTurnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    if (sourceMessage !== null) {
      throw new TypeError("INITIAL_OBJECTIVE rejection must not include a source message.");
    }
    return null;
  }
  if (rejectedTurnInput.kind !== AgentTurnInputKind.PEER_RELAY) {
    throw new TypeError(
      "Protocol repair requires a rejected INITIAL_OBJECTIVE or PEER_RELAY input.",
    );
  }
  validateAgentMessage(sourceMessage);
  if (
    sourceMessage.messageId !== rejectedTurnInput.sourceMessageId
    || sourceMessage.runId !== rejectedTurnInput.runId
    || sourceMessage.objectiveHash !== rejectedTurnInput.objectiveHash
    || sourceMessage.policyHash !== rejectedTurnInput.policyHash
    || sourceMessage.actor === rejectedTurnInput.targetActor
  ) {
    throw new TypeError("Rejected PEER_RELAY source does not match its turn input.");
  }
  return sourceMessage;
}

function assertRepairOrigin(run, repairTargetActor, repairPayload, rejectedTurnInput, sourceMessage) {
  validateProtocolRepairPayload(repairPayload);
  if (rejectedTurnInput === null || rejectedTurnInput === undefined) {
    throw new TypeError("Protocol repair requires its rejected turn input context.");
  }
  validateAgentTurnInput(rejectedTurnInput);
  assertTurnInputRunBinding(run, rejectedTurnInput);
  if (rejectedTurnInput.targetActor !== repairTargetActor) {
    throw new TypeError("Protocol repair target must match the rejected turn target.");
  }
  const source = sourceForRejectedInput(rejectedTurnInput, sourceMessage);
  assertProtocolRepairPolicyBinding({
    repairPayload,
    rejectedTurnInput,
    sourceMessage: source,
  });
  return source;
}

function buildInput({
  run,
  inputId,
  targetActor,
  kind,
  sourceMessageId,
  instructionId,
  payload,
  prompt,
  createdAt,
}) {
  return buildAgentTurnInput({
    inputId,
    runId: run.runId,
    targetActor,
    kind,
    sourceMessageId,
    instructionId,
    promptTemplateVersion: DISCUSSION_PROMPT_TEMPLATE_VERSION,
    payload,
    promptHash: sha256Text(prompt),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt,
  });
}

export function buildInitialDiscussionTurn({ run, inputId, createdAt, relayLimits }) {
  validateAgentRun(run);
  requiredString(inputId, "inputId");
  requiredString(createdAt, "createdAt");
  if (run.mode !== RunMode.DISCUSSION || run.currentTurn !== 0) {
    throw new TypeError("INITIAL_OBJECTIVE requires a new DISCUSSION run.");
  }
  const instructionId = "initial-objective";
  const prompt = buildControllerPrompt({
    instructionId,
    inputKind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    actor: AgentActor.CODEX_AGENT,
    mode: run.mode,
    objective: run.objective,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    turnNumber: 1,
    maxTurns: run.maxTurns,
    relayLimits,
  });
  const turnInput = buildInput({
    run,
    inputId,
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId,
    payload: {
      objective: run.objective,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
    },
    prompt,
    createdAt,
  });
  return Object.freeze({ turnInput, prompt });
}

export function buildPeerDiscussionTurn({
  run,
  sourceMessage,
  proposalArtifact = null,
  inputId,
  createdAt,
  relayLimits,
}) {
  validateAgentRun(run);
  validateAgentMessage(sourceMessage);
  requiredString(inputId, "inputId");
  requiredString(createdAt, "createdAt");
  if (run.mode !== RunMode.DISCUSSION || sourceMessage.runId !== run.runId) {
    throw new TypeError("peer message must belong to the current DISCUSSION run.");
  }
  const proposal = proposalForMessage(sourceMessage, proposalArtifact);
  const targetActor = otherActor(sourceMessage.actor);
  const instructionId = "review-peer-message";
  const prompt = buildControllerPrompt({
    instructionId,
    inputKind: AgentTurnInputKind.PEER_RELAY,
    actor: targetActor,
    mode: run.mode,
    objective: run.objective,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    turnNumber: run.currentTurn + 1,
    maxTurns: run.maxTurns,
    peerMessage: sourceMessage,
    peerProposalRefHash: proposal?.proposalRefHash ?? null,
    relayLimits,
  });
  const payload = {
    sourceMessageId: sourceMessage.messageId,
    sourceMessageKind: sourceMessage.kind,
    sourceContentHash: sourceMessage.contentHash,
    normalizedPacket: sourceMessage.normalizedPacket,
    proposalRefHash: proposal?.proposalRefHash ?? null,
  };
  const turnInput = buildInput({
    run,
    inputId,
    targetActor,
    kind: AgentTurnInputKind.PEER_RELAY,
    sourceMessageId: sourceMessage.messageId,
    instructionId,
    payload,
    prompt,
    createdAt,
  });
  return Object.freeze({ turnInput, prompt });
}

export function buildProtocolRepairDiscussionTurn({
  run,
  decision,
  rejectedTurnInput,
  sourceMessage = null,
  inputId,
  instructionId,
  createdAt,
  relayLimits,
}) {
  validateAgentRun(run);
  validateProtocolFailureDecision(decision);
  requiredString(inputId, "inputId");
  requiredString(instructionId, "instructionId");
  requiredString(createdAt, "createdAt");
  if (run.mode !== RunMode.DISCUSSION) {
    throw new TypeError("PROTOCOL_REPAIR requires a DISCUSSION run.");
  }
  const repairPayload = buildProtocolRepairPayload(decision);
  const targetActor = decision.repairContext.targetActor;
  const requiredPhase = targetActor === AgentActor.CODEX_AGENT
    ? RunPhase.CODEX_RESPONSE_STORED
    : RunPhase.WEB_RESPONSE_STORED;
  if (run.phase !== requiredPhase || run.activeActor !== null) {
    throw new TypeError(
      `PROTOCOL_REPAIR for ${targetActor} requires ${requiredPhase}.`,
    );
  }
  if (
    decision.repairContext.runId !== run.runId
    || decision.repairContext.objectiveHash !== run.objectiveHash
    || decision.repairContext.policyHash !== run.policyHash
  ) {
    throw new TypeError("Protocol repair decision does not match the current run binding.");
  }
  assertRepairOrigin(
    run,
    targetActor,
    repairPayload,
    rejectedTurnInput,
    sourceMessage,
  );
  const prompt = buildControllerPrompt({
    instructionId,
    inputKind: AgentTurnInputKind.PROTOCOL_REPAIR,
    actor: targetActor,
    mode: run.mode,
    objective: run.objective,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    turnNumber: run.currentTurn + 1,
    maxTurns: run.maxTurns,
    protocolRepair: repairPayload,
    relayLimits,
  });
  const turnInput = buildProtocolRepairTurnInput(decision, {
    inputId,
    instructionId,
    promptTemplateVersion: DISCUSSION_PROMPT_TEMPLATE_VERSION,
    promptHash: sha256Text(prompt),
    createdAt,
  });
  return Object.freeze({ turnInput, prompt });
}

export function rematerializeDiscussionPrompt({
  run,
  turnInput,
  sourceMessage = null,
  proposalArtifact = null,
  rejectedTurnInput = null,
  relayLimits,
}) {
  validateAgentRun(run);
  validateAgentTurnInput(turnInput);
  assertTurnInputRunBinding(run, turnInput);
  let prompt;
  if (turnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    const expectedPayload = {
      objective: run.objective,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
    };
    if (canonicalJson(turnInput.payload) !== canonicalJson(expectedPayload)) {
      throw new TypeError("INITIAL_OBJECTIVE payload does not match the current run.");
    }
    prompt = buildControllerPrompt({
      instructionId: turnInput.instructionId,
      inputKind: turnInput.kind,
      actor: turnInput.targetActor,
      mode: run.mode,
      objective: run.objective,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
      turnNumber: 1,
      maxTurns: run.maxTurns,
      relayLimits,
    });
  } else if (turnInput.kind === AgentTurnInputKind.PEER_RELAY) {
    validateAgentMessage(sourceMessage);
    const proposal = proposalForMessage(sourceMessage, proposalArtifact);
    const expectedPayload = {
      sourceMessageId: sourceMessage.messageId,
      sourceMessageKind: sourceMessage.kind,
      sourceContentHash: sourceMessage.contentHash,
      normalizedPacket: sourceMessage.normalizedPacket,
      proposalRefHash: proposal?.proposalRefHash ?? null,
    };
    if (canonicalJson(turnInput.payload) !== canonicalJson(expectedPayload)) {
      throw new TypeError("PEER_RELAY payload does not match its canonical source message.");
    }
    prompt = buildControllerPrompt({
      instructionId: turnInput.instructionId,
      inputKind: turnInput.kind,
      actor: turnInput.targetActor,
      mode: run.mode,
      objective: run.objective,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
      turnNumber: run.currentTurn + 1,
      maxTurns: run.maxTurns,
      peerMessage: sourceMessage,
      peerProposalRefHash: proposal?.proposalRefHash ?? null,
      relayLimits,
    });
  } else if (turnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR) {
    assertRepairOrigin(
      run,
      turnInput.targetActor,
      turnInput.payload,
      rejectedTurnInput,
      sourceMessage,
    );
    if (proposalArtifact !== null) {
      throw new TypeError("PROTOCOL_REPAIR must not include proposalArtifact.");
    }
    prompt = buildControllerPrompt({
      instructionId: turnInput.instructionId,
      inputKind: turnInput.kind,
      actor: turnInput.targetActor,
      mode: run.mode,
      objective: run.objective,
      objectiveHash: run.objectiveHash,
      policyHash: run.policyHash,
      turnNumber: run.currentTurn + 1,
      maxTurns: run.maxTurns,
      protocolRepair: turnInput.payload,
      relayLimits,
    });
  } else {
    throw new TypeError(`${turnInput.kind} prompt rematerialization is not supported.`);
  }
  if (sha256Text(prompt) !== turnInput.promptHash) {
    throw new TypeError("rematerialized prompt does not match AgentTurnInput.promptHash.");
  }
  return prompt;
}
