import {
  SHA256_DIGEST_PATTERN,
  validateProposalArtifact,
  validateRelayMessage,
} from "./contracts.js";
import {
  AgentActor,
  AgentPacketType,
  RelayMessageKind,
  RunOutcomeType,
} from "./vocabulary.js";
import { createRunOutcome } from "./run-state-machine.js";

function requireHash(value, name) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a sha256:<64 lowercase hex> digest.`);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function latestEnvelopeByActor(packets, runId) {
  const latest = new Map();
  const sequences = new Set();
  for (const envelope of packets) {
    if (!isObject(envelope)) continue;
    if (envelope.runId !== runId) continue;
    if (
      envelope.fromActor !== AgentActor.CODEX_AGENT
      && envelope.fromActor !== AgentActor.CHATGPT_WEB_AGENT
    ) {
      continue;
    }
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) return null;
    if (sequences.has(envelope.sequence)) return null;
    sequences.add(envelope.sequence);
    const previous = latest.get(envelope.fromActor);
    if (!previous || envelope.sequence > previous.sequence) {
      // Select before validating the packet. That makes a newer malformed or
      // non-ACCEPT response supersede stale consent instead of falling back.
      latest.set(envelope.fromActor, envelope);
    }
  }
  return latest;
}

function validatedAcceptance(envelope) {
  try {
    validateRelayMessage(envelope);
  } catch {
    return null;
  }
  if (envelope.kind !== RelayMessageKind.ACCEPTANCE) return null;
  const packet = envelope.normalizedPacket;
  if (packet?.type !== AgentPacketType.ACCEPT) return null;
  if (packet.blocking_findings.length !== 0) return null;
  return packet;
}

function hasPersistedProposal(proposals, proposalHash, runId) {
  return proposals.some((artifact) => {
    try {
      validateProposalArtifact(artifact);
    } catch {
      return false;
    }
    return artifact.proposalHash === proposalHash && artifact.runId === runId;
  });
}

export function evaluateConsensus({
  runId,
  packets,
  proposals,
  objectiveHash,
  policyHash,
  policyViolation,
}) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("runId must be a non-empty string.");
  }
  if (!Array.isArray(packets)) throw new TypeError("packets must be a RelayMessage array.");
  if (!Array.isArray(proposals)) throw new TypeError("proposals must be a ProposalArtifact array.");
  requireHash(objectiveHash, "objectiveHash");
  requireHash(policyHash, "policyHash");
  if (typeof policyViolation !== "boolean") {
    throw new TypeError("policyViolation must be a boolean.");
  }
  if (policyViolation) return null;

  const latest = latestEnvelopeByActor(packets, runId);
  if (latest === null) return null;
  const codexEnvelope = latest.get(AgentActor.CODEX_AGENT);
  const webEnvelope = latest.get(AgentActor.CHATGPT_WEB_AGENT);
  if (!codexEnvelope || !webEnvelope) return null;
  if (
    codexEnvelope.objectiveHash !== objectiveHash
    || codexEnvelope.policyHash !== policyHash
    || webEnvelope.objectiveHash !== objectiveHash
    || webEnvelope.policyHash !== policyHash
  ) {
    return null;
  }

  const codexAccept = validatedAcceptance(codexEnvelope);
  const webAccept = validatedAcceptance(webEnvelope);
  if (!codexAccept || !webAccept) return null;
  if (codexEnvelope.runId !== runId || webEnvelope.runId !== runId) return null;

  const proposalHash = codexAccept.accepted_proposal_sha256;
  if (proposalHash !== webAccept.accepted_proposal_sha256) return null;
  if (!hasPersistedProposal(proposals, proposalHash, runId)) return null;

  return createRunOutcome({
    type: RunOutcomeType.CONSENSUS,
    proposalHash,
  });
}
