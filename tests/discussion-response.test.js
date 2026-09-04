import assert from "node:assert/strict";
import test from "node:test";
import { AgentPacketParserStage } from "../src/domain/agent-packet-rejection.js";
import { buildAgentMessage } from "../src/domain/agent-messages.js";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { buildAgentRun } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  RunMode,
  RunOutcomeType,
  RunPhase,
} from "../src/domain/vocabulary.js";
import {
  DiscussionResponseDisposition,
  planDiscussionResponse,
} from "../src/orchestration/discussion-response.js";
import {
  buildInitialDiscussionTurn,
  buildPeerDiscussionTurn,
  buildProtocolRepairDiscussionTurn,
  rematerializeDiscussionPrompt,
} from "../src/orchestration/discussion-turns.js";
import { decideAgentPacketRejection } from "../src/orchestration/protocol-failure.js";

const T0 = "2026-09-04T03:00:00.000Z";
const OBJECTIVE = "Reach one hash-bound proposal";
const OBJECTIVE_HASH = sha256Text(OBJECTIVE);
const POLICY_HASH = sha256Text("policy");

function run({
  phase = RunPhase.CODEX_TURN_RUNNING,
  actor = AgentActor.CODEX_AGENT,
  currentTurn = 0,
  version = 3,
  maxTurns = 12,
} = {}) {
  return buildAgentRun({
    runId: "run-discussion",
    mode: RunMode.DISCUSSION,
    objective: OBJECTIVE,
    objectiveHash: OBJECTIVE_HASH,
    policyHash: POLICY_HASH,
    phase,
    activeActor: actor,
    maxTurns,
    currentTurn,
    paused: false,
    blocker: null,
    version,
    createdAt: T0,
    updatedAt: T0,
  });
}

function proposalPacket(body = "Use a durable, conditional relay.") {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Durable relay",
    body,
    assumptions: [],
    open_decisions: [],
  };
}

function packetContent(packet) {
  return `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`;
}

function repairDecision({
  actor,
  deliveryId,
  expectedPacketType,
  turnId = `turn-rejected-${actor}`,
}) {
  return decideAgentPacketRejection({
    confirmedAttribution: {
      runId: "run-discussion",
      actor,
      sessionId: `session-rejected-${actor}`,
      turnId,
      deliveryId,
      objectiveHash: OBJECTIVE_HASH,
      policyHash: POLICY_HASH,
    },
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_PACKET_JSON",
    errorSummary: "The final packet was not valid JSON.",
    rawResponseArtifactHash: sha256Text(`redacted-${deliveryId}`),
    limits: createDiscussionRunPolicy().limits,
    protocolRepairsUsed: 0,
    expectedPacketType,
    createdAt: T0,
  });
}

test("an initial proposal becomes a Controller-owned artifact and conditional peer relay", () => {
  const current = run();
  const initial = buildInitialDiscussionTurn({
    run: current,
    inputId: "input-1",
    createdAt: T0,
  });
  const packet = proposalPacket();
  const plan = planDiscussionResponse({
    run: current,
    turnInput: initial.turnInput,
    sessionId: "session-codex",
    turnId: "turn-codex-1",
    content: packetContent(packet),
    packet,
    priorMessages: [],
    persistedProposals: [],
    messageId: "message-1",
    proposalId: "proposal-1",
    createdAt: T0,
  });

  assert.equal(plan.message.kind, "PROPOSAL");
  assert.equal(plan.proposalArtifact.sourceMessageId, plan.message.messageId);
  assert.equal(plan.disposition, DiscussionResponseDisposition.RELAY);
  assert.equal(plan.nextActor, AgentActor.CHATGPT_WEB_AGENT);

  const afterResponse = run({
    phase: RunPhase.CODEX_RESPONSE_STORED,
    actor: null,
    currentTurn: 1,
    version: 4,
  });
  const peer = buildPeerDiscussionTurn({
    run: afterResponse,
    sourceMessage: plan.message,
    proposalArtifact: plan.proposalArtifact,
    inputId: "input-2",
    createdAt: "2026-09-04T03:00:01.000Z",
  });
  assert.equal(peer.turnInput.targetActor, AgentActor.CHATGPT_WEB_AGENT);
  assert.equal(
    peer.turnInput.payload.proposalRefHash,
    plan.proposalArtifact.proposalRefHash,
  );
  assert.match(peer.prompt, new RegExp(plan.proposalArtifact.proposalRefHash));
  assert.equal(rematerializeDiscussionPrompt({
    run: afterResponse,
    turnInput: peer.turnInput,
    sourceMessage: plan.message,
    proposalArtifact: plan.proposalArtifact,
  }), peer.prompt);
});

test("response planning enforces the state action matrix before creating a message", () => {
  const current = run();
  const initial = buildInitialDiscussionTurn({
    run: current,
    inputId: "input-invalid",
    createdAt: T0,
  });
  const invalid = {
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: sha256Text("not-yet-proposed"),
    blocking_findings: [],
  };
  assert.throws(
    () => planDiscussionResponse({
      run: current,
      turnInput: initial.turnInput,
      sessionId: "session-codex",
      turnId: "turn-invalid",
      content: packetContent(invalid),
      packet: invalid,
      priorMessages: [],
      persistedProposals: [],
      messageId: "message-invalid",
      createdAt: T0,
    }),
    (error) => error.code === "DISCUSSION_PACKET_TYPE_NOT_ALLOWED",
  );
});

test("response planning binds the exact running phase and active actor to the turn input", () => {
  const initial = buildInitialDiscussionTurn({
    run: run(),
    inputId: "input-route-mismatch",
    createdAt: T0,
  });
  assert.throws(
    () => planDiscussionResponse({
      run: run({
        phase: RunPhase.WEB_TURN_RUNNING,
        actor: AgentActor.CHATGPT_WEB_AGENT,
      }),
      turnInput: initial.turnInput,
      sessionId: "session-codex",
      turnId: "turn-route-mismatch",
      content: packetContent(proposalPacket()),
      packet: proposalPacket(),
      priorMessages: [],
      persistedProposals: [],
      messageId: "message-route-mismatch",
      proposalId: "proposal-route-mismatch",
      createdAt: T0,
    }),
    (error) => error.code === "TURN_INPUT_RUN_PHASE_MISMATCH",
  );
});

test("protocol repair prompt rematerializes and an initial repaired proposal keeps PROPOSAL meaning", () => {
  const rejectedTurn = buildInitialDiscussionTurn({
    run: run(),
    inputId: "input-rejected-initial",
    createdAt: T0,
  });
  const stored = run({
    phase: RunPhase.CODEX_RESPONSE_STORED,
    actor: null,
    currentTurn: 1,
  });
  const decision = repairDecision({
    actor: AgentActor.CODEX_AGENT,
    deliveryId: "delivery-rejected-initial",
    expectedPacketType: AgentPacketType.PROPOSAL,
  });
  const repair = buildProtocolRepairDiscussionTurn({
    run: stored,
    decision,
    rejectedTurnInput: rejectedTurn.turnInput,
    inputId: "input-repair-initial",
    instructionId: "repair-initial-proposal",
    createdAt: T0,
  });
  assert.equal(rematerializeDiscussionPrompt({
    run: stored,
    turnInput: repair.turnInput,
    rejectedTurnInput: rejectedTurn.turnInput,
  }), repair.prompt);
  assert.throws(() => rematerializeDiscussionPrompt({
    run: stored,
    turnInput: repair.turnInput,
  }), /rejected turn input context/u);

  const packet = proposalPacket("The repaired initial proposal.");
  const planned = planDiscussionResponse({
    run: run({
      phase: RunPhase.CODEX_TURN_RUNNING,
      actor: AgentActor.CODEX_AGENT,
      currentTurn: 1,
    }),
    turnInput: repair.turnInput,
    repairContext: {
      rejectedDeliveryId: decision.rejectionEvent.deliveryId,
      rejectedTurnInput: rejectedTurn.turnInput,
    },
    sessionId: "session-codex",
    turnId: "turn-repaired-initial",
    content: packetContent(packet),
    packet,
    priorMessages: [],
    persistedProposals: [],
    messageId: "message-repaired-initial",
    proposalId: "proposal-repaired-initial",
    createdAt: T0,
  });
  assert.equal(planned.message.kind, AgentMessageKind.PROPOSAL);
});

test("a repaired proposal after a rejected critique response keeps REVISION meaning", () => {
  const critiquePacket = {
    type: AgentPacketType.CRITIQUE,
    target_proposal_sha256: sha256Text("proposal-under-review"),
    blocking_findings: ["Clarify recovery."],
    non_blocking_findings: [],
    requested_changes: ["Add recovery detail."],
  };
  const critique = buildAgentMessage({
    messageId: "message-web-critique",
    runId: "run-discussion",
    sequence: 1,
    actor: AgentActor.CHATGPT_WEB_AGENT,
    sessionId: "session-web",
    turnId: "turn-web-critique",
    kind: AgentMessageKind.CRITIQUE,
    content: packetContent(critiquePacket),
    normalizedPacket: critiquePacket,
    objectiveHash: OBJECTIVE_HASH,
    policyHash: POLICY_HASH,
    createdAt: T0,
  });
  const rejectedTurn = buildPeerDiscussionTurn({
    run: run({
      phase: RunPhase.WEB_RESPONSE_STORED,
      actor: null,
      currentTurn: 2,
    }),
    sourceMessage: critique,
    inputId: "input-rejected-revision",
    createdAt: T0,
  });
  const stored = run({
    phase: RunPhase.CODEX_RESPONSE_STORED,
    actor: null,
    currentTurn: 3,
  });
  const decision = repairDecision({
    actor: AgentActor.CODEX_AGENT,
    deliveryId: "delivery-rejected-revision",
    expectedPacketType: AgentPacketType.PROPOSAL,
  });
  const repair = buildProtocolRepairDiscussionTurn({
    run: stored,
    decision,
    rejectedTurnInput: rejectedTurn.turnInput,
    sourceMessage: critique,
    inputId: "input-repair-revision",
    instructionId: "repair-revision",
    createdAt: T0,
  });
  const packet = proposalPacket("The repaired revision.");
  const planned = planDiscussionResponse({
    run: run({
      phase: RunPhase.CODEX_TURN_RUNNING,
      actor: AgentActor.CODEX_AGENT,
      currentTurn: 3,
    }),
    turnInput: repair.turnInput,
    repairContext: {
      rejectedDeliveryId: decision.rejectionEvent.deliveryId,
      rejectedTurnInput: rejectedTurn.turnInput,
    },
    sessionId: "session-codex",
    turnId: "turn-repaired-revision",
    content: packetContent(packet),
    packet,
    priorMessages: [critique],
    persistedProposals: [],
    messageId: "message-repaired-revision",
    proposalId: "proposal-repaired-revision",
    createdAt: T0,
  });
  assert.equal(planned.message.kind, AgentMessageKind.REVISION);
  assert.throws(
    () => planDiscussionResponse({
      run: run({
        phase: RunPhase.CODEX_TURN_RUNNING,
        actor: AgentActor.CODEX_AGENT,
        currentTurn: 3,
      }),
      turnInput: repair.turnInput,
      repairContext: {
        rejectedDeliveryId: "another-delivery",
        rejectedTurnInput: rejectedTurn.turnInput,
      },
      sessionId: "session-codex",
      turnId: "turn-repaired-revision-mismatch",
      content: packetContent(packet),
      packet,
      priorMessages: [critique],
      persistedProposals: [],
      messageId: "message-repaired-revision-mismatch",
      proposalId: "proposal-repaired-revision-mismatch",
      createdAt: T0,
    }),
    (error) => error.code === "PROTOCOL_REPAIR_DELIVERY_MISMATCH",
  );
});

test("the second matching ACCEPT completes only the same persisted proposal reference", () => {
  const firstRun = run();
  const initial = buildInitialDiscussionTurn({
    run: firstRun,
    inputId: "input-proposal",
    createdAt: T0,
  });
  const proposal = planDiscussionResponse({
    run: firstRun,
    turnInput: initial.turnInput,
    sessionId: "session-codex",
    turnId: "turn-proposal",
    content: packetContent(proposalPacket()),
    packet: proposalPacket(),
    priorMessages: [],
    persistedProposals: [],
    messageId: "message-proposal",
    proposalId: "proposal-final",
    createdAt: T0,
  });
  const proposalRef = proposal.proposalArtifact.proposalRefHash;
  const webInput = buildPeerDiscussionTurn({
    run: run({ phase: RunPhase.CODEX_RESPONSE_STORED, actor: null, currentTurn: 1 }),
    sourceMessage: proposal.message,
    proposalArtifact: proposal.proposalArtifact,
    inputId: "input-web-accept",
    createdAt: T0,
  });
  const accept = {
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: proposalRef,
    blocking_findings: [],
  };
  const web = planDiscussionResponse({
    run: run({
      phase: RunPhase.WEB_TURN_RUNNING,
      actor: AgentActor.CHATGPT_WEB_AGENT,
      currentTurn: 1,
    }),
    turnInput: webInput.turnInput,
    sessionId: "session-web",
    turnId: "turn-web-accept",
    content: packetContent(accept),
    packet: accept,
    priorMessages: [proposal.message],
    persistedProposals: [proposal.proposalArtifact],
    messageId: "message-web-accept",
    createdAt: T0,
  });
  assert.equal(web.disposition, DiscussionResponseDisposition.RELAY);

  const codexInput = buildPeerDiscussionTurn({
    run: run({ phase: RunPhase.WEB_RESPONSE_STORED, actor: null, currentTurn: 2 }),
    sourceMessage: web.message,
    inputId: "input-codex-accept",
    createdAt: T0,
  });
  const codex = planDiscussionResponse({
    run: run({
      phase: RunPhase.CODEX_TURN_RUNNING,
      actor: AgentActor.CODEX_AGENT,
      currentTurn: 2,
    }),
    turnInput: codexInput.turnInput,
    sessionId: "session-codex",
    turnId: "turn-codex-accept",
    content: packetContent(accept),
    packet: accept,
    priorMessages: [proposal.message, web.message],
    persistedProposals: [proposal.proposalArtifact],
    messageId: "message-codex-accept",
    createdAt: T0,
  });
  assert.equal(codex.disposition, DiscussionResponseDisposition.COMPLETE);
  assert.deepEqual(codex.outcome, {
    type: RunOutcomeType.CONSENSUS,
    proposalHash: proposalRef,
  });
  assert.equal(codex.nextActor, null);
});
