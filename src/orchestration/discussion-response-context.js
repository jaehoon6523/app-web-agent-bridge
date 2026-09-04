import { validateAgentMessage, validateAgentTurnInput } from "../domain/agent-messages.js";
import { assertDiscussionPacketTypeAllowed } from "../domain/discussion-actions.js";
import {
  AgentMessageKind,
  AgentPacketType,
  AgentTurnInputKind,
} from "../domain/vocabulary.js";
import { DeliveryState } from "../persistence/schema.js";

export class DiscussionResponseContextError extends TypeError {
  constructor(message, code = "DISCUSSION_RESPONSE_CONTEXT_ERROR") {
    super(message);
    this.name = "DiscussionResponseContextError";
    this.code = code;
  }
}

export function assertSessionTurnIdAvailable(store, session, turnId) {
  const completedTurnReused = session.lastCompletedTurnId === turnId;
  const receiptTurnReused = store.listDeliveries(session.runId).some((delivery) => {
    const input = store.getAgentTurnInput(delivery.inputId);
    return input?.targetActor === session.actor
      && delivery.providerReceipt?.externalTurnId === turnId;
  });
  const messageReused = store.listAgentMessages(session.runId).some((message) => (
    message.sessionId === session.sessionId && message.turnId === turnId
  ));
  const rejectionReused = store.listDeliveries(session.runId).some((delivery) => {
    const rejection = store.getAgentPacketRejectionByDelivery(delivery.deliveryId);
    return rejection?.sessionId === session.sessionId && rejection.turnId === turnId;
  });
  if (completedTurnReused || receiptTurnReused || messageReused || rejectionReused) {
    throw new DiscussionResponseContextError(
      `Agent session ${session.sessionId} already attributed provider turn ${turnId}.`,
      "AGENT_SESSION_TURN_ID_REUSED",
    );
  }
}

export function sourceMessageForInput(turnInput, messages) {
  if (turnInput.sourceMessageId === null) return null;
  const source = messages.find((message) => message.messageId === turnInput.sourceMessageId)
    ?? null;
  if (source === null) {
    throw new DiscussionResponseContextError(
      `Source message ${turnInput.sourceMessageId} does not exist.`,
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
    throw new DiscussionResponseContextError(
      "The source message does not match its AgentTurnInput route.",
      "SOURCE_MESSAGE_ROUTE_MISMATCH",
    );
  }
  return source;
}

function proposalForSource(turnInput, sourceMessage, proposals) {
  if (
    sourceMessage === null
    || (
      sourceMessage.kind !== AgentMessageKind.PROPOSAL
      && sourceMessage.kind !== AgentMessageKind.REVISION
    )
  ) {
    return null;
  }
  const proposalRefHash = turnInput.payload?.proposalRefHash ?? null;
  const proposal = proposals.find((item) => item.proposalRefHash === proposalRefHash) ?? null;
  if (proposal === null) {
    throw new DiscussionResponseContextError(
      `Proposal source ${sourceMessage.messageId} has no persisted artifact.`,
      "PROPOSAL_ARTIFACT_NOT_FOUND",
    );
  }
  return proposal;
}

export function responseMeaningContext(store, turnInput, messages, proposals) {
  if (turnInput.kind !== AgentTurnInputKind.PROTOCOL_REPAIR) {
    const sourceMessage = sourceMessageForInput(turnInput, messages);
    return {
      semanticTurnInput: turnInput,
      sourceMessage,
      sourceProposal: proposalForSource(turnInput, sourceMessage, proposals),
      repairContext: null,
    };
  }

  const rejectedDeliveryId = turnInput.payload?.rejectedDeliveryId;
  const rejectedDelivery = store.getDelivery(rejectedDeliveryId);
  if (
    rejectedDelivery === null
    || rejectedDelivery.runId !== turnInput.runId
    || rejectedDelivery.state !== DeliveryState.RESPONSE_COMPLETED
  ) {
    throw new DiscussionResponseContextError(
      "PROTOCOL_REPAIR does not reference a completed rejected delivery.",
      "PROTOCOL_REPAIR_ORIGIN_MISMATCH",
    );
  }
  const rejection = store.getAgentPacketRejectionByDelivery(rejectedDeliveryId);
  if (
    rejection === null
    || rejection.runId !== turnInput.runId
    || rejection.actor !== turnInput.targetActor
  ) {
    throw new DiscussionResponseContextError(
      "PROTOCOL_REPAIR has no canonical rejection event for its origin.",
      "PROTOCOL_REPAIR_REJECTION_NOT_FOUND",
    );
  }
  const rejectedTurnInput = store.getAgentTurnInput(rejectedDelivery.inputId);
  validateAgentTurnInput(rejectedTurnInput);
  if (
    rejectedTurnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR
    || rejectedTurnInput.runId !== turnInput.runId
    || rejectedTurnInput.targetActor !== turnInput.targetActor
  ) {
    throw new DiscussionResponseContextError(
      "PROTOCOL_REPAIR origin is not an original discussion turn.",
      "PROTOCOL_REPAIR_ORIGIN_MISMATCH",
    );
  }
  const sourceMessage = sourceMessageForInput(rejectedTurnInput, messages);
  return {
    semanticTurnInput: rejectedTurnInput,
    sourceMessage,
    sourceProposal: proposalForSource(rejectedTurnInput, sourceMessage, proposals),
    repairContext: { rejectedDeliveryId, rejectedTurnInput },
  };
}

export function responseReference(sourceMessage, sourceProposal) {
  if (sourceMessage === null) return null;
  validateAgentMessage(sourceMessage);
  switch (sourceMessage.kind) {
    case AgentMessageKind.PROPOSAL:
    case AgentMessageKind.REVISION:
      if (sourceProposal === null) {
        throw new DiscussionResponseContextError(
          `Proposal source ${sourceMessage.messageId} has no persisted artifact.`,
          "PROPOSAL_ARTIFACT_NOT_FOUND",
        );
      }
      return sourceProposal.proposalRefHash;
    case AgentMessageKind.CRITIQUE:
      return sourceMessage.normalizedPacket.target_proposal_sha256;
    case AgentMessageKind.ACCEPTANCE:
      return sourceMessage.normalizedPacket.accepted_proposal_sha256;
    default:
      return null;
  }
}

export function assertPacketReference(packet, expectedReference) {
  if (packet.type === AgentPacketType.CRITIQUE) {
    if (expectedReference === null || packet.target_proposal_sha256 !== expectedReference) {
      throw new DiscussionResponseContextError(
        "CRITIQUE does not target the Controller-provided proposal reference.",
        "PROPOSAL_REFERENCE_MISMATCH",
      );
    }
  }
  if (packet.type === AgentPacketType.ACCEPT) {
    if (expectedReference === null || packet.accepted_proposal_sha256 !== expectedReference) {
      throw new DiscussionResponseContextError(
        "ACCEPT does not target the Controller-provided proposal reference.",
        "PROPOSAL_REFERENCE_MISMATCH",
      );
    }
  }
}

export function expectedPacketTypeForRejection(turnInput, sourceMessage, requestedType) {
  if (turnInput.kind === AgentTurnInputKind.PROTOCOL_REPAIR) {
    const expected = turnInput.payload?.expectedPacketType ?? null;
    if (requestedType !== null && requestedType !== expected) {
      throw new DiscussionResponseContextError(
        "A rejected protocol repair must retain its frozen expected packet type.",
        "PROTOCOL_REPAIR_EXPECTATION_MISMATCH",
      );
    }
    return expected;
  }
  if (requestedType === null) return null;
  assertDiscussionPacketTypeAllowed({
    inputKind: turnInput.kind,
    peerMessageKind: sourceMessage?.kind ?? null,
    expectedPacketType: null,
  }, requestedType);
  return requestedType;
}
