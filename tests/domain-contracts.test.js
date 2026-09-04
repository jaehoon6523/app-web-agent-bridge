import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPacketType,
  agentPacketHash,
  parseAgentPacket,
  validateAgentPacket,
} from "../src/domain/agent-packets.js";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  DomainContractError,
  AgentCommunicationContractError,
  buildAgentMessage,
  buildAgentRun,
  buildAgentSessionRecord,
  buildAgentTurnInput,
  buildProposalArtifact,
  proposalContentHash,
  proposalContentHashInput,
  proposalRefHash,
  proposalRefHashInput,
  validateAgentMessage,
  validateAgentRun,
  validateAgentSessionRecord,
  validateAgentTurnInput,
  validateProposalArtifact,
  validateRunBlocker,
} from "../src/domain/contracts.js";
import {
  AGENT_PACKET_JSON_SCHEMAS,
  DiscussionPacketSchema,
  packetJsonSchema,
} from "../src/domain/packet-json-schemas.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentSessionStatus,
  AgentTurnInputKind,
  HumanGateReason,
  RunMode,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";

const policyHash = sha256Text("policy-v1");
const objective = "Reach a reviewable proposal";

function proposalPacket() {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Small proposal",
    body: "Implement the bounded change.",
    assumptions: [],
    open_decisions: [],
  };
}

test("canonical vocabulary exposes only the authorized string values", () => {
  assert.deepEqual(Object.values(AgentActor), ["CODEX_AGENT", "CHATGPT_WEB_AGENT"]);
  assert.deepEqual(Object.values(AgentPacketType), ["PROPOSAL", "CRITIQUE", "ACCEPT", "BLOCKED"]);
  assert.deepEqual(Object.values(AgentMessageKind), [
    "PROPOSAL",
    "CRITIQUE",
    "REVISION",
    "ACCEPTANCE",
    "BLOCKER",
  ]);
  assert.deepEqual(Object.values(AgentTurnInputKind), [
    "INITIAL_OBJECTIVE",
    "PEER_RELAY",
    "PROTOCOL_REPAIR",
    "USER_STEER",
  ]);
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
  const proposalRefHash = sha256Text("proposal-reference");
  const packets = [
    proposalPacket(),
    {
      type: AgentPacketType.CRITIQUE,
      target_proposal_sha256: proposalRefHash,
      blocking_findings: ["Missing rollback evidence"],
      non_blocking_findings: [],
      requested_changes: ["Add the evidence"],
    },
    {
      type: AgentPacketType.ACCEPT,
      accepted_proposal_sha256: proposalRefHash,
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
  assert.throws(
    () => validateAgentPacket({
      ...proposalPacket(),
      proposal_id: "provider-computed-id",
      proposal_sha256: proposalRefHash,
    }),
    /unsupported property/,
  );
});

test("finding, open-decision, and request text is normalized without reordering or deduplication", () => {
  const decomposed = "Cafe\u0301";
  const normalized = "Caf\u00e9";
  const proposal = parseAgentPacket({
    ...proposalPacket(),
    open_decisions: [`  ${decomposed}  `, ` ${decomposed} `],
  });
  assert.deepEqual(proposal.open_decisions, [normalized, normalized]);

  const critique = parseAgentPacket({
    type: AgentPacketType.CRITIQUE,
    target_proposal_sha256: sha256Text("proposal-reference"),
    blocking_findings: ["  first  ", " first "],
    non_blocking_findings: [` ${decomposed} `],
    requested_changes: ["  change  "],
  });
  assert.deepEqual(critique.blocking_findings, ["first", "first"]);
  assert.deepEqual(critique.non_blocking_findings, [normalized]);
  assert.deepEqual(critique.requested_changes, ["change"]);

  const accept = parseAgentPacket({
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: sha256Text("proposal-reference"),
    blocking_findings: ["  finding  "],
  });
  assert.deepEqual(accept.blocking_findings, ["finding"]);

  const blocked = parseAgentPacket({
    type: AgentPacketType.BLOCKED,
    reason_code: HumanGateReason.PRODUCT_DECISION_REQUIRED,
    description: "A decision is required.",
    required_decisions: ["  decide  "],
  });
  assert.deepEqual(blocked.required_decisions, ["decide"]);
});

test("finding, open-decision, and request arrays may be empty but reject blank items", () => {
  const cases = [
    { ...proposalPacket(), open_decisions: [" \t\r\n "] },
    {
      type: AgentPacketType.CRITIQUE,
      target_proposal_sha256: sha256Text("proposal-reference"),
      blocking_findings: ["\u00a0"],
      non_blocking_findings: [],
      requested_changes: [],
    },
    {
      type: AgentPacketType.CRITIQUE,
      target_proposal_sha256: sha256Text("proposal-reference"),
      blocking_findings: [],
      non_blocking_findings: [],
      requested_changes: ["   "],
    },
    {
      type: AgentPacketType.ACCEPT,
      accepted_proposal_sha256: sha256Text("proposal-reference"),
      blocking_findings: ["\n"],
    },
    {
      type: AgentPacketType.BLOCKED,
      reason_code: HumanGateReason.PRODUCT_DECISION_REQUIRED,
      description: "A decision is required.",
      required_decisions: ["\t"],
    },
  ];
  for (const packet of cases) {
    assert.throws(() => parseAgentPacket(packet), /must be a non-blank string/);
  }

  assert.deepEqual(parseAgentPacket(proposalPacket()).open_decisions, []);
});

test("PROTOCOL_ERROR is not an Agent packet type", () => {
  assert.equal(Object.hasOwn(AgentPacketType, "PROTOCOL_ERROR"), false);
  assert.throws(
    () => parseAgentPacket('{"type":"PROTOCOL_ERROR"}'),
    (error) => error.code === "INVALID_AGENT_PACKET" && /unknown packet type/.test(error.message),
  );
});

test("ProposalArtifact uses Controller-owned content and run-bound reference hashes", () => {
  const artifact = buildProposalArtifact({
    proposalId: "proposal-1",
    runId: "run-1",
    authorActor: AgentActor.CODEX_AGENT,
    sourceMessageId: "message-1",
    sourceSessionId: "session-codex",
    sourceTurnId: "turn-1",
    summary: "Bounded implementation",
    body: "Implement the exact authorized fields.",
    assumptions: ["The policy hash is frozen"],
    openDecisions: ["  Preserve order  ", " Preserve order "],
    objectiveHash: sha256Text("objective-v1"),
    policyHash,
    createdAt: "2026-09-04T00:00:20.000Z",
  });

  assert.deepEqual(artifact.openDecisions, ["Preserve order", "Preserve order"]);
  assert.deepEqual(proposalContentHashInput(artifact), {
    schema: "proposal-content-v1",
    summary: artifact.summary,
    body: artifact.body,
    assumptions: artifact.assumptions,
    openDecisions: artifact.openDecisions,
  });
  assert.deepEqual(proposalRefHashInput(artifact), {
    schema: "proposal-ref-v1",
    runId: artifact.runId,
    objectiveHash: artifact.objectiveHash,
    policyHash: artifact.policyHash,
    proposalContentHash: artifact.proposalContentHash,
  });
  assert.equal(artifact.proposalContentHash, proposalContentHash(artifact));
  assert.equal(artifact.proposalRefHash, proposalRefHash(artifact));
  assert.equal(validateProposalArtifact(artifact), artifact);
  assert.throws(
    () => validateProposalArtifact({ ...artifact, body: "silently changed" }),
    (error) => error instanceof DomainContractError && error.code === "HASH_MISMATCH",
  );
  assert.throws(
    () => validateProposalArtifact({ ...artifact, policyHash: sha256Text("policy-v2") }),
    (error) => error instanceof DomainContractError && error.code === "HASH_MISMATCH",
  );

  const differentProvenance = buildProposalArtifact({
    ...artifact,
    proposalId: "proposal-2",
    sourceMessageId: "message-2",
    sourceSessionId: "session-web",
    sourceTurnId: "turn-2",
    createdAt: "2026-09-04T00:00:21.000Z",
    proposalContentHash: undefined,
    proposalRefHash: undefined,
  });
  assert.equal(differentProvenance.proposalContentHash, artifact.proposalContentHash);
  assert.equal(differentProvenance.proposalRefHash, artifact.proposalRefHash);

  const reboundToAnotherRun = buildProposalArtifact({
    ...artifact,
    proposalId: "proposal-3",
    runId: "run-2",
    sourceMessageId: "message-3",
    sourceTurnId: "turn-3",
    proposalContentHash: undefined,
    proposalRefHash: undefined,
  });
  assert.equal(reboundToAnotherRun.proposalContentHash, artifact.proposalContentHash);
  assert.notEqual(reboundToAnotherRun.proposalRefHash, artifact.proposalRefHash);

  assert.throws(
    () => buildProposalArtifact({
      proposalId: "proposal-4",
      runId: "run-1",
      authorActor: AgentActor.CODEX_AGENT,
      sourceMessageId: "message-2",
      sourceSessionId: "session-codex",
      sourceTurnId: "turn-2",
      summary: "Unowned decision schema",
      body: "Do not invent it.",
      assumptions: [],
      openDecisions: [{ id: "not-authorized" }],
      objectiveHash: sha256Text("objective-v1"),
      policyHash,
      createdAt: "2026-09-04T00:00:22.000Z",
    }),
    /non-blank string/,
  );
  assert.throws(
    () => buildProposalArtifact({
      ...artifact,
      proposalId: "proposal-5",
      openDecisions: ["   "],
      proposalContentHash: undefined,
      proposalRefHash: undefined,
    }),
    /non-blank string/,
  );
  assert.throws(
    () => buildProposalArtifact({ ...artifact, title: "legacy field" }),
    /unsupported property/,
  );
});

test("Controller AgentTurnInput and provider AgentMessage are separate hash-bound contracts", () => {
  const objectiveHash = sha256Text(objective);
  const turnInput = buildAgentTurnInput({
    inputId: "input-1",
    runId: "run-1",
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId: "discuss-objective",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { objective },
    promptHash: sha256Text("rendered prompt"),
    objectiveHash,
    policyHash,
    createdAt: "2026-09-04T00:00:30.000Z",
  });
  assert.equal(validateAgentTurnInput(turnInput), turnInput);
  assert.match(turnInput.payloadHash, /^sha256:[0-9a-f]{64}$/);
  assert.throws(
    () => validateAgentTurnInput({ ...turnInput, payload: { objective: "changed" } }),
    (error) => error instanceof AgentCommunicationContractError
      && error.code === "HASH_MISMATCH",
  );
  assert.throws(
    () => buildAgentTurnInput({
      ...turnInput,
      inputId: "input-peer",
      kind: AgentTurnInputKind.PEER_RELAY,
      sourceMessageId: null,
    }),
    (error) => error.code === "TURN_INPUT_SOURCE_REQUIRED",
  );

  const packet = proposalPacket();
  const content = JSON.stringify(packet);
  const message = buildAgentMessage({
    messageId: "message-1",
    runId: "run-1",
    sequence: 1,
    actor: AgentActor.CODEX_AGENT,
    sessionId: "session-1",
    turnId: "turn-1",
    kind: AgentMessageKind.PROPOSAL,
    content,
    normalizedPacket: packet,
    objectiveHash,
    policyHash,
    createdAt: "2026-09-04T00:01:00.000Z",
  });

  assert.equal(message.contentHash, sha256Text(content));
  assert.equal(validateAgentMessage(message), message);
  assert.ok(Object.isFrozen(message.normalizedPacket));
  assert.throws(
    () => validateAgentMessage({ ...message, content: `${content}\n` }),
    (error) => error instanceof AgentCommunicationContractError
      && error.code === "HASH_MISMATCH",
  );
  assert.throws(
    () => validateAgentMessage({ ...message, normalizedPacket: { type: "PROTOCOL_ERROR" } }),
    (error) => error.code === "INVALID_AGENT_PACKET",
  );
  assert.throws(
    () => validateAgentMessage({
      ...message,
      kind: AgentMessageKind.ACCEPTANCE,
    }),
    (error) => error.code === "AGENT_MESSAGE_PACKET_KIND_MISMATCH",
  );
  assert.throws(
    () => validateAgentMessage({ ...message, sourceMessageId: null }),
    /unsupported property/,
  );
});

test("Codex output schemas expose only the four closed provider packet contracts", () => {
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
  assert.deepEqual(Object.keys(AGENT_PACKET_JSON_SCHEMAS.PROPOSAL.properties), [
    "type",
    "summary",
    "body",
    "assumptions",
    "open_decisions",
  ]);
  assert.equal(
    AGENT_PACKET_JSON_SCHEMAS.PROPOSAL.properties.open_decisions.items.pattern,
    "\\S",
  );
  const clone = packetJsonSchema("ACCEPT");
  clone.properties.type.enum[0] = "BROKEN";
  assert.equal(AGENT_PACKET_JSON_SCHEMAS.ACCEPT.properties.type.enum[0], "ACCEPT");
  assert.throws(
    () => packetJsonSchema("PROTOCOL_ERROR"),
    (error) => error.code === "UNKNOWN_AGENT_PACKET_TYPE",
  );
});
