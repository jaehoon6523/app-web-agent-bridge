import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  buildProposalArtifact,
} from "../src/domain/contracts.js";
import { buildAgentMessage } from "../src/domain/agent-messages.js";
import { evaluateConsensus } from "../src/domain/consensus.js";
import {
  AgentActor,
  AgentPacketType,
  AgentMessageKind,
  RunOutcomeType,
} from "../src/domain/vocabulary.js";

const objectiveHash = sha256Text("Agree on a safe implementation");
const policyHash = sha256Text("policy-v1");

function proposal(overrides = {}) {
  return buildProposalArtifact({
    proposalId: "proposal-001",
    runId: "run-001",
    authorActor: AgentActor.CODEX_AGENT,
    title: "Deterministic relay",
    body: "Store each validated response before forwarding it.",
    assumptions: [],
    decisions: ["Use optimistic concurrency"],
    createdFromMessageId: "message-proposal",
    ...overrides,
  });
}

function acceptance({
  actor,
  acceptedProposalHash,
  sequence,
  blockingFindings = [],
  messageObjectiveHash = objectiveHash,
  messagePolicyHash = policyHash,
  runId = "run-001",
}) {
  const packet = {
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: acceptedProposalHash,
    blocking_findings: blockingFindings,
  };
  return buildAgentMessage({
    messageId: `message-${sequence}`,
    runId,
    sequence,
    actor,
    sessionId: `session-${actor}`,
    turnId: `turn-${sequence}`,
    kind: AgentMessageKind.ACCEPTANCE,
    content: JSON.stringify(packet),
    normalizedPacket: packet,
    objectiveHash: messageObjectiveHash,
    policyHash: messagePolicyHash,
    createdAt: `2026-09-04T00:00:0${sequence}.000Z`,
  });
}

function consensusInput(overrides = {}) {
  const artifact = proposal();
  return {
    runId: "run-001",
    messages: [
      acceptance({
        actor: AgentActor.CODEX_AGENT,
        acceptedProposalHash: artifact.proposalHash,
        sequence: 2,
      }),
      acceptance({
        actor: AgentActor.CHATGPT_WEB_AGENT,
        acceptedProposalHash: artifact.proposalHash,
        sequence: 3,
      }),
    ],
    proposals: [artifact],
    objectiveHash,
    policyHash,
    policyViolation: false,
    ...overrides,
  };
}

test("consensus requires both actors to ACCEPT the same persisted proposal", () => {
  const input = consensusInput();
  const result = evaluateConsensus(input);
  assert.deepEqual(result, {
    type: RunOutcomeType.CONSENSUS,
    proposalHash: input.proposals[0].proposalHash,
  });
  assert.ok(Object.isFrozen(result));
});

test("one actor, mismatched proposal hashes, and blocking findings cannot complete", () => {
  const input = consensusInput();
  assert.equal(evaluateConsensus({ ...input, messages: input.messages.slice(0, 1) }), null);

  const otherHash = sha256Text("a proposal that was not persisted");
  assert.equal(evaluateConsensus({
    ...input,
    messages: [
      input.messages[0],
      acceptance({
        actor: AgentActor.CHATGPT_WEB_AGENT,
        acceptedProposalHash: otherHash,
        sequence: 4,
      }),
    ],
  }), null);

  assert.equal(evaluateConsensus({
    ...input,
    messages: [
      input.messages[0],
      acceptance({
        actor: AgentActor.CHATGPT_WEB_AGENT,
        acceptedProposalHash: input.proposals[0].proposalHash,
        blockingFindings: ["Unresolved persistence race"],
        sequence: 4,
      }),
    ],
  }), null);
});

test("an ACCEPT hash must resolve to a valid ProposalArtifact from the same run", () => {
  const input = consensusInput();
  assert.equal(evaluateConsensus({ ...input, proposals: [] }), null);

  const tampered = {
    ...input.proposals[0],
    body: "This body no longer matches the proposal hash.",
  };
  assert.equal(evaluateConsensus({ ...input, proposals: [tampered] }), null);

  const otherRun = proposal({ runId: "run-002", proposalId: "proposal-002" });
  const otherRunPackets = input.messages.map((message, index) => acceptance({
    actor: message.actor,
    acceptedProposalHash: otherRun.proposalHash,
    sequence: index + 5,
    runId: "run-001",
  }));
  assert.equal(evaluateConsensus({
    ...input,
    messages: otherRunPackets,
    proposals: [otherRun],
  }), null);
});

test("stale objective or policy bindings and policy violations prevent consensus", () => {
  const input = consensusInput();
  assert.equal(evaluateConsensus({
    ...input,
    objectiveHash: sha256Text("new objective"),
  }), null);
  assert.equal(evaluateConsensus({
    ...input,
    policyHash: sha256Text("policy-v2"),
  }), null);
  assert.equal(evaluateConsensus({ ...input, policyViolation: true }), null);
  assert.throws(
    () => evaluateConsensus({ ...input, policyViolation: undefined }),
    /policyViolation/i,
  );
});

test("a newer stale response supersedes an older ACCEPT instead of reviving stale consent", () => {
  const input = consensusInput();
  const staleObjective = sha256Text("new objective not bound to this run");
  const stale = acceptance({
    actor: AgentActor.CODEX_AGENT,
    acceptedProposalHash: input.proposals[0].proposalHash,
    sequence: 100,
    messageObjectiveHash: staleObjective,
  });
  assert.equal(evaluateConsensus({
    ...input,
    messages: [...input.messages, stale],
    objectiveHash,
    policyHash,
    policyViolation: false,
  }), null);
});

test("the latest invalid normalized packet cannot fall back to an earlier ACCEPT", () => {
  const input = consensusInput();
  const invalidLatest = structuredClone(input.messages[0]);
  invalidLatest.messageId = "message-invalid-latest";
  invalidLatest.sequence = 4;
  invalidLatest.normalizedPacket.unowned_completion_flag = true;

  assert.equal(evaluateConsensus({
    ...input,
    messages: [...input.messages, invalidLatest],
  }), null);

  assert.equal(evaluateConsensus({
    ...input,
    messages: [invalidLatest, ...input.messages],
  }), null, "AgentMessage.sequence, not caller array order, determines the latest packet");
});

test("consensus binds messages to one requested run and rejects duplicate run sequences", () => {
  const input = consensusInput();
  const foreign = input.messages.map((message, index) => acceptance({
    actor: message.actor,
    acceptedProposalHash: input.proposals[0].proposalHash,
    sequence: index + 20,
    runId: "run-foreign",
  }));
  assert.deepEqual(evaluateConsensus({ ...input, messages: [...foreign, ...input.messages] }), {
    type: RunOutcomeType.CONSENSUS,
    proposalHash: input.proposals[0].proposalHash,
  });

  const duplicateSequence = acceptance({
    actor: AgentActor.CHATGPT_WEB_AGENT,
    acceptedProposalHash: input.proposals[0].proposalHash,
    sequence: input.messages[0].sequence,
  });
  assert.equal(evaluateConsensus({
    ...input,
    messages: [input.messages[0], duplicateSequence],
  }), null);
  assert.throws(() => evaluateConsensus({ ...input, runId: "" }), /runId/i);
});

test("a PROPOSAL packet does not substitute for the persisted ProposalArtifact", () => {
  const input = consensusInput();
  const artifact = input.proposals[0];
  const proposalPacket = {
    type: AgentPacketType.PROPOSAL,
    summary: artifact.title,
    body: artifact.body,
    assumptions: artifact.assumptions,
    open_decisions: artifact.decisions,
  };
  const proposalMessage = buildAgentMessage({
    messageId: "message-proposal",
    runId: artifact.runId,
    sequence: 1,
    actor: AgentActor.CODEX_AGENT,
    sessionId: "session-codex",
    turnId: "turn-1",
    kind: AgentMessageKind.PROPOSAL,
    content: JSON.stringify(proposalPacket),
    normalizedPacket: proposalPacket,
    objectiveHash,
    policyHash,
    createdAt: "2026-09-04T00:00:01.000Z",
  });

  assert.equal(evaluateConsensus({
    ...input,
    messages: [proposalMessage, ...input.messages],
    proposals: [],
  }), null);
});
