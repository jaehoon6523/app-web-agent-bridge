import { agentPacketHash } from "../domain/agent-packets.js";
import { sha256CanonicalJson } from "../domain/canonical-json.js";
import { AgentSessionStatus } from "../domain/vocabulary.js";
import { runOutcomeHash } from "../persistence/run-outcomes.js";

export function markDiscussionSessionWaiting(store, session, turnId, updatedAt) {
  return store.upsertAgentSession({
    session: {
      ...session,
      status: AgentSessionStatus.WAITING,
      activeTurnId: null,
      lastCompletedTurnId: turnId,
      lastObservedAt: updatedAt,
      version: session.version + 1,
    },
    expectedVersion: session.version,
    updatedAt,
  });
}

export function discussionResponseEventDetails({
  delivery,
  turnInput,
  plan,
  packetId,
  nextDelivery,
  outcome,
  disposition = plan.disposition,
}) {
  const proposal = plan.proposalArtifact === null ? null : {
    proposalId: plan.proposalArtifact.proposalId,
    proposalContentHash: plan.proposalArtifact.proposalContentHash,
    proposalRefHash: plan.proposalArtifact.proposalRefHash,
    reused: plan.proposalReused,
  };
  return Object.freeze({
    deliveryId: delivery.deliveryId,
    inputId: turnInput.inputId,
    messageId: plan.message.messageId,
    messageHash: sha256CanonicalJson(plan.message),
    messageContentHash: plan.message.contentHash,
    packetId,
    packetHash: agentPacketHash(plan.message.normalizedPacket),
    proposal,
    next: nextDelivery === null ? null : {
      inputId: nextDelivery.turnInput.inputId,
      deliveryId: nextDelivery.deliveryId,
    },
    outcome: outcome === null ? null : {
      type: outcome.type,
      hash: runOutcomeHash(outcome),
    },
    disposition,
  });
}
