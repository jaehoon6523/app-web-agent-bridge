import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentPacketHash } from "../src/domain/agent-packets.js";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  createAgentRun,
  createAgentSessionRecord,
} from "../src/domain/contracts.js";
import { buildAgentMessage, buildAgentTurnInput } from "../src/domain/agent-messages.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunMode,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import {
  OptimisticConcurrencyError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";

function makeRun(runId) {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: `Discuss ${runId}`,
    policyHash: sha256Text("policy-v1"),
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 8,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function runLimitsFor(run) {
  return {
    maxTurns: run.maxTurns,
    maxProtocolRepairs: 2,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function makeSession(runId, overrides = {}) {
  return createAgentSessionRecord({
    sessionId: "session-codex",
    runId,
    actor: AgentActor.CODEX_AGENT,
    provider: SessionProvider.CODEX_APP_SERVER,
    externalSessionId: null,
    externalLocator: null,
    status: AgentSessionStatus.CREATING,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: null,
    version: 1,
    ...overrides,
  });
}

function makeTurnInput(run) {
  return buildAgentTurnInput({
    inputId: `input-${run.runId}`,
    runId: run.runId,
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId: "discuss-objective",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { objective: run.objective },
    promptHash: sha256Text(`prompt-${run.runId}`),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
}

function makeMessage(run, messageId = `message-${run.runId}`, normalizedPacket = proposalPacket()) {
  return buildAgentMessage({
    messageId,
    runId: run.runId,
    sequence: 1,
    actor: AgentActor.CODEX_AGENT,
    sessionId: "session-codex",
    turnId: "turn-1",
    kind: AgentMessageKind.PROPOSAL,
    content: "A proposal",
    normalizedPacket,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
}

function proposalPacket() {
  return {
    type: "PROPOSAL",
    summary: "Summary",
    body: "Body",
    assumptions: [],
    open_decisions: [],
  };
}

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-entities-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(join(directory, "controller.sqlite"));
  const runA = makeRun("run-a");
  const runB = makeRun("run-b");
  store.createRun(runA, { runLimits: runLimitsFor(runA) });
  store.createRun(runB, { runLimits: runLimitsFor(runB) });
  return { store, runA, runB };
}

test("agent sessions use exact run ownership and version CAS", (t) => {
  const { store, runA, runB } = openStore(t);
  const original = makeSession(runA.runId);
  assert.deepEqual(store.createAgentSession({
    session: original,
    createdAt: T0,
    updatedAt: T0,
  }), original);
  assert.deepEqual(store.listAgentSessions(runA.runId), [original]);

  const ready = makeSession(runA.runId, {
    status: AgentSessionStatus.READY,
    externalSessionId: "thread-1",
    lastObservedAt: T1,
    version: 2,
  });
  assert.deepEqual(store.updateAgentSession({
    session: ready,
    expectedVersion: 1,
    updatedAt: T1,
  }), ready);
  assert.deepEqual(store.getAgentSession(original.sessionId), ready);

  assert.throws(() => store.updateAgentSession({
    session: ready,
    expectedVersion: 1,
    updatedAt: T1,
  }), OptimisticConcurrencyError);

  const wrongOwner = makeSession(runB.runId, { version: 3 });
  assert.throws(() => store.updateAgentSession({
    session: wrongOwner,
    expectedVersion: 2,
    updatedAt: T1,
  }), (error) => error.code === "RUN_OWNERSHIP_MISMATCH");
  assert.deepEqual(store.listAgentSessions(runB.runId), []);

  const changedIdentity = makeSession(runA.runId, {
    actor: AgentActor.CHATGPT_WEB_AGENT,
    provider: SessionProvider.CHATGPT_WEB,
    version: 3,
  });
  assert.throws(() => store.updateAgentSession({
    session: changedIdentity,
    expectedVersion: 2,
    updatedAt: T1,
  }), (error) => error.code === "IMMUTABLE_METADATA");
  store.close();
});

test("agent packet persistence validates strict packets, hashes, and message ownership", (t) => {
  const { store, runA, runB } = openStore(t);
  store.createAgentSession({
    session: makeSession(runA.runId),
    createdAt: T0,
    updatedAt: T0,
  });
  const packet = proposalPacket();
  const message = makeMessage(runA, `message-${runA.runId}`, packet);
  const turnInput = makeTurnInput(runA);
  store.saveAgentTurnInputWithDelivery({
    turnInput,
    deliveryId: "delivery-a",
    idempotencyKey: "key-a",
    createdAt: T0,
  });
  store.saveAgentMessage({ inputId: turnInput.inputId, message });
  const saved = store.saveAgentPacket({
    packetId: "packet-a",
    runId: runA.runId,
    messageId: message.messageId,
    packet,
    createdAt: T0,
  });
  assert.equal(saved.packetHash, agentPacketHash(packet));
  assert.deepEqual(saved.packet, packet);
  assert.deepEqual(store.listAgentPackets(runA.runId), [saved]);

  assert.throws(() => store.saveAgentPacket({
    packetId: "packet-invalid",
    runId: runA.runId,
    messageId: message.messageId,
    packet: { ...packet, unexpected: true },
    createdAt: T0,
  }), /unsupported property/);
  assert.throws(() => store.saveAgentPacket({
    packetId: "packet-wrong-hash",
    runId: runA.runId,
    messageId: message.messageId,
    packet,
    packetHash: sha256Text("wrong"),
    createdAt: T0,
  }), (error) => error.code === "HASH_MISMATCH");
  assert.throws(() => store.saveAgentPacket({
    packetId: "packet-cross-run",
    runId: runB.runId,
    messageId: message.messageId,
    packet,
    createdAt: T0,
  }), (error) => error.code === "RUN_OWNERSHIP_MISMATCH");
  assert.throws(() => store.saveAgentPacket({
    packetId: "packet-duplicate-message",
    runId: runA.runId,
    messageId: message.messageId,
    packet,
    createdAt: T1,
  }), /UNIQUE constraint failed/);
  store.close();
});

test("approvals preserve opaque scope by hash and reject stale resolution", (t) => {
  const { store, runA, runB } = openStore(t);
  const approval = store.createApproval({
    approvalId: "approval-a",
    runId: runA.runId,
    status: "PENDING",
    scope: { writableRoots: ["workspace"], operationId: "operation-a" },
    createdAt: T0,
    updatedAt: T0,
  });
  assert.match(approval.scopeHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(approval.version, 1);

  assert.throws(() => store.resolveApproval({
    approvalId: approval.approvalId,
    runId: runA.runId,
    expectedStatus: "PENDING",
    expectedVersion: 1,
    expectedScopeHash: sha256Text("not-the-scope"),
    nextStatus: "APPROVED",
    resolution: { decidedBy: "user" },
    updatedAt: T1,
  }), (error) => error.code === "OPAQUE_SCOPE_HASH_CONFLICT");

  const resolved = store.resolveApproval({
    approvalId: approval.approvalId,
    runId: runA.runId,
    expectedStatus: "PENDING",
    expectedVersion: 1,
    expectedScopeHash: approval.scopeHash,
    nextStatus: "APPROVED",
    resolution: { decidedBy: "user" },
    updatedAt: T1,
  });
  assert.equal(resolved.version, 2);
  assert.equal(resolved.status, "APPROVED");
  assert.deepEqual(store.listApprovals({ runId: runA.runId, status: "APPROVED" }), [resolved]);

  assert.throws(() => store.resolveApproval({
    approvalId: approval.approvalId,
    runId: runA.runId,
    expectedStatus: "APPROVED",
    expectedVersion: 1,
    nextStatus: "DECLINED",
    updatedAt: T1,
  }), OptimisticConcurrencyError);
  assert.throws(() => store.resolveApproval({
    approvalId: approval.approvalId,
    runId: runB.runId,
    expectedStatus: "APPROVED",
    expectedVersion: 2,
    nextStatus: "DECLINED",
    updatedAt: T1,
  }), (error) => error.code === "RUN_OWNERSHIP_MISMATCH");
  store.close();
});

test("recovery operations use opaque details and expected status/version CAS", (t) => {
  const { store, runA, runB } = openStore(t);
  const operation = store.createRecoveryOperation({
    operationId: "recovery-a",
    runId: runA.runId,
    status: "PENDING",
    details: { deliveryId: "delivery-a", observed: "AMBIGUOUS" },
    createdAt: T0,
    updatedAt: T0,
  });
  const resolved = store.resolveRecoveryOperation({
    operationId: operation.operationId,
    runId: runA.runId,
    expectedStatus: "PENDING",
    expectedVersion: 1,
    expectedDetailsHash: operation.detailsHash,
    nextStatus: "RESOLVED",
    resolution: { action: "ADOPT_PROVIDER_RESULT" },
    updatedAt: T1,
  });
  assert.equal(resolved.version, 2);
  assert.deepEqual(store.getRecoveryOperation(operation.operationId), resolved);
  assert.deepEqual(store.listRecoveryOperations({ runId: runA.runId }), [resolved]);

  assert.throws(() => store.resolveRecoveryOperation({
    operationId: operation.operationId,
    runId: runA.runId,
    expectedStatus: "PENDING",
    expectedVersion: 1,
    nextStatus: "RESOLVED",
    updatedAt: T1,
  }), (error) => error.code === "RECOVERY_STATUS_CONFLICT");
  assert.throws(() => store.resolveRecoveryOperation({
    operationId: operation.operationId,
    runId: runB.runId,
    expectedStatus: "RESOLVED",
    expectedVersion: 2,
    nextStatus: "CLOSED",
    updatedAt: T1,
  }), (error) => error.code === "RUN_OWNERSHIP_MISMATCH");
  store.close();
});
