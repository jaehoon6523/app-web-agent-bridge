import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPacketType,
  ProtocolErrorPacketAuthorityGapError,
  agentPacketHash,
  parseAgentPacket,
  validateAgentPacket,
} from "../src/domain/agent-packets.js";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  DomainContractError,
  buildAgentRun,
  buildAgentSessionRecord,
  buildProposalArtifact,
  buildRelayMessage,
  proposalArtifactHash,
  validateAgentRun,
  validateAgentSessionRecord,
  validateProposalArtifact,
  validateRelayMessage,
  validateRunBlocker,
} from "../src/domain/contracts.js";
import {
  AGENT_PACKET_JSON_SCHEMAS,
  DiscussionPacketSchema,
  packetJsonSchema,
} from "../src/domain/packet-json-schemas.js";
import {
  AgentActor,
  AgentSessionStatus,
  HumanGateReason,
  RelayMessageKind,
  RunMode,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";

const policyHash = sha256Text("policy-v1");
const objective = "Reach a reviewable proposal";

function proposalPacket(proposalHash = sha256Text("proposal-reference")) {
  return {
    type: AgentPacketType.PROPOSAL,
    proposal_id: "proposal-1",
    proposal_sha256: proposalHash,
    summary: "Small proposal",
    body: "Implement the bounded change.",
    assumptions: [],
    open_decisions: [],
  };
}

test("canonical vocabulary exposes only the authorized string values", () => {
  assert.deepEqual(Object.values(AgentActor), ["CODEX_AGENT", "CHATGPT_WEB_AGENT"]);
  assert.equal(RunMode.CODE_CHANGE, "CODE_CHANGE");
  assert.equal(RunPhase.CONSENSUS_CHECK, "CONSENSUS_CHECK");
  assert.equal(HumanGateReason.POLICY_VIOLATION, "POLICY_VIOLATION");
  assert.equal(SessionProvider.CHATGPT_WEB, "CHATGPT_WEB");
});

test("AgentRun builder derives objectiveHash and validator rejects drift or extra fields", () => {
  const run = buildAgentRun({
    runId: "run-1",
    mode: RunMode.DISCUSSION,
    objective,
    policyHash,
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 8,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  });

  assert.equal(run.objectiveHash, sha256Text(objective));
  assert.equal(validateAgentRun(run), run);
  assert.ok(Object.isFrozen(run));

  assert.throws(
    () => validateAgentRun({ ...run, objectiveHash: sha256Text("different") }),
    (error) => error instanceof DomainContractError && error.code === "HASH_MISMATCH",
  );
  assert.throws(() => validateAgentRun({ ...run, shadowState: true }), /unsupported property/);
  assert.throws(() => validateAgentRun({ ...run, currentTurn: 9 }), /must not exceed maxTurns/);
});

test("AgentRun contract rejects phase, actor, and blocker contradictions", () => {
  const base = buildAgentRun({
    runId: "run-invariant",
    mode: RunMode.DISCUSSION,
    objective,
    policyHash,
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 8,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  });
  assert.throws(
    () => buildAgentRun({
      ...base,
      phase: RunPhase.WEB_TURN_RUNNING,
      activeActor: AgentActor.CODEX_AGENT,
    }),
    (error) => error.code === "RUN_ACTOR_PHASE_MISMATCH",
  );
  assert.throws(
    () => validateAgentRun({
      ...base,
      phase: RunPhase.CODEX_TO_WEB_PENDING,
      currentTurn: 2,
    }),
    (error) => error.code === "RUN_TURN_PHASE_MISMATCH",
  );
  assert.throws(
    () => buildAgentRun({ ...base, phase: RunPhase.HUMAN_GATE, blocker: null }),
    (error) => error.code === "RUN_BLOCKER_REQUIRED",
  );
});

test("RunBlocker is a closed discriminated union", () => {
  const blockers = [
    { type: "RUNTIME_APPROVAL", approvalId: "approval-1" },
    { type: "USER_DECISION", decisionIds: ["decision-1"] },
    { type: "SESSION_AUTH", actor: AgentActor.CHATGPT_WEB_AGENT },
    { type: "RECOVERY_CONFIRMATION", operationId: "operation-1" },
  ];
  blockers.forEach((blocker) => assert.equal(validateRunBlocker(blocker), blocker));
  assert.throws(
    () => validateRunBlocker({ ...blockers[0], description: "invented" }),
    /unsupported property/,
  );
  assert.throws(() => validateRunBlocker({ type: "UNKNOWN" }), /unknown RunBlocker type/);
});

test("AgentSessionRecord preserves explicitly nullable provider observations", () => {
  const record = buildAgentSessionRecord({
    sessionId: "session-1",
    runId: "run-1",
    actor: AgentActor.CODEX_AGENT,
    provider: SessionProvider.CODEX_APP_SERVER,
    externalSessionId: null,
    externalLocator: null,
    status: AgentSessionStatus.CREATING,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: null,
    version: 1,
  });
  assert.equal(validateAgentSessionRecord(record), record);
  assert.throws(
    () => validateAgentSessionRecord({ ...record, status: "CONNECTED" }),
    /AgentSessionStatus/,
  );
  assert.throws(
    () => validateAgentSessionRecord({ ...record, externalLocator: undefined }),
    /non-empty string/,
  );
});

test("all defined agent packet variants are strict and canonical-hashable", () => {
  const packets = [
    proposalPacket(),
    {
      type: AgentPacketType.CRITIQUE,
      target_proposal_sha256: sha256Text("proposal-reference"),
      blocking_findings: ["Missing rollback evidence"],
      non_blocking_findings: [],
      requested_changes: ["Add the evidence"],
    },
    {
      type: AgentPacketType.ACCEPT,
      accepted_proposal_sha256: sha256Text("proposal-reference"),
      blocking_findings: [],
    },
    {
      type: AgentPacketType.BLOCKED,
      reason_code: HumanGateReason.PRODUCT_DECISION_REQUIRED,
      description: "One product choice remains.",
      required_decisions: ["Choose retention behavior"],
    },
  ];

  for (const packet of packets) {
    assert.equal(validateAgentPacket(packet), packet);
    assert.match(agentPacketHash(packet), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(parseAgentPacket(JSON.stringify(packet)), packet);
  }

  assert.throws(
    () => validateAgentPacket({ ...proposalPacket(), extra: true }),
    /unsupported property/,
  );
  assert.throws(
    () => validateAgentPacket({ ...proposalPacket(), assumptions: [{}] }),
    /non-empty string/,
  );
});

test("PROTOCOL_ERROR remains explicit but fail-closed until its fields have an owner", () => {
  assert.equal(AgentPacketType.PROTOCOL_ERROR, "PROTOCOL_ERROR");
  assert.throws(
    () => parseAgentPacket('{"type":"PROTOCOL_ERROR"}'),
    (error) => error instanceof ProtocolErrorPacketAuthorityGapError
      && error.code === "PROTOCOL_ERROR_PACKET_SCHEMA_UNDEFINED",
  );
});

test("ProposalArtifact hash binds every stable artifact field except itself", () => {
  const artifact = buildProposalArtifact({
    proposalId: "proposal-1",
    runId: "run-1",
    authorActor: AgentActor.CODEX_AGENT,
    title: "Bounded implementation",
    body: "Implement the exact authorized fields.",
    assumptions: ["The policy hash is frozen"],
    decisions: ["Use strict additionalProperties behavior"],
    createdFromMessageId: "message-1",
  });

  assert.equal(artifact.proposalHash, proposalArtifactHash(artifact));
  assert.equal(validateProposalArtifact(artifact), artifact);
  assert.throws(
    () => validateProposalArtifact({ ...artifact, body: "silently changed" }),
    (error) => error instanceof DomainContractError && error.code === "HASH_MISMATCH",
  );
  assert.throws(
    () => buildProposalArtifact({
      proposalId: "proposal-2",
      runId: "run-1",
      authorActor: AgentActor.CODEX_AGENT,
      title: "Unowned decision schema",
      body: "Do not invent it.",
      assumptions: [],
      decisions: [{ id: "not-authorized" }],
      createdFromMessageId: "message-2",
    }),
    /non-empty string/,
  );
});

test("RelayMessage builder binds raw content while retaining a validated packet", () => {
  const packet = proposalPacket();
  const content = JSON.stringify(packet);
  const message = buildRelayMessage({
    messageId: "message-1",
    runId: "run-1",
    sequence: 1,
    fromActor: AgentActor.CODEX_AGENT,
    toActor: AgentActor.CHATGPT_WEB_AGENT,
    sourceSessionId: "session-1",
    sourceTurnId: "turn-1",
    inReplyTo: null,
    kind: RelayMessageKind.PROPOSAL,
    content,
    normalizedPacket: packet,
    objectiveHash: sha256Text(objective),
    policyHash,
    createdAt: "2026-09-04T00:01:00.000Z",
  });

  assert.equal(message.contentHash, sha256Text(content));
  assert.equal(validateRelayMessage(message), message);
  assert.ok(Object.isFrozen(message.normalizedPacket));
  assert.throws(
    () => validateRelayMessage({ ...message, content: `${content}\n` }),
    (error) => error instanceof DomainContractError && error.code === "HASH_MISMATCH",
  );
  assert.throws(
    () => validateRelayMessage({ ...message, normalizedPacket: { type: "PROTOCOL_ERROR" } }),
    ProtocolErrorPacketAuthorityGapError,
  );
  assert.throws(
    () => validateRelayMessage({
      ...message,
      kind: RelayMessageKind.ACCEPTANCE,
    }),
    (error) => error.code === "RELAY_PACKET_KIND_MISMATCH",
  );
  assert.throws(
    () => validateRelayMessage({ ...message, normalizedPacket: null }),
    (error) => error.code === "RELAY_PACKET_REQUIRED",
  );
  assert.throws(
    () => validateRelayMessage({
      ...message,
      kind: RelayMessageKind.INITIAL_OBJECTIVE,
      normalizedPacket: null,
    }),
    (error) => error.code === "INITIAL_OBJECTIVE_PROVENANCE_UNDEFINED",
  );
});

test("Codex output schemas are closed and omit undefined PROTOCOL_ERROR", () => {
  assert.deepEqual(Object.keys(AGENT_PACKET_JSON_SCHEMAS), [
    "PROPOSAL",
    "CRITIQUE",
    "ACCEPT",
    "BLOCKED",
  ]);
  for (const schema of Object.values(AGENT_PACKET_JSON_SCHEMAS)) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  }
  assert.equal(DiscussionPacketSchema.oneOf.length, 4);
  const clone = packetJsonSchema("ACCEPT");
  clone.properties.type.enum[0] = "BROKEN";
  assert.equal(AGENT_PACKET_JSON_SCHEMAS.ACCEPT.properties.type.enum[0], "ACCEPT");
  assert.throws(
    () => packetJsonSchema("PROTOCOL_ERROR"),
    (error) => error.code === "PROTOCOL_ERROR_PACKET_SCHEMA_UNDEFINED",
  );
});
