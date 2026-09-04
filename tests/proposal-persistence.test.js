import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import {
  createAgentRun,
  createAgentSessionRecord,
  createProposalArtifact,
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
  EventChainIntegrityError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";

function proposalPacket() {
  return {
    type: "PROPOSAL",
    summary: "Bounded proposal",
    body: "Persist the Controller-owned proposal identity.",
    assumptions: ["The source message is durable"],
    open_decisions: [],
  };
}

function makeRun() {
  return createAgentRun({
    runId: "run-proposals",
    mode: RunMode.DISCUSSION,
    objective: "Agree on a durable proposal",
    policyHash: sha256Text("run-policy-v1"),
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 12,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function runLimits() {
  return {
    maxTurns: 12,
    maxProtocolRepairs: 1,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function makeSession(runId, actor) {
  return createAgentSessionRecord({
    sessionId: actor === AgentActor.CODEX_AGENT ? "session-codex" : "session-web",
    runId,
    actor,
    provider: actor === AgentActor.CODEX_AGENT
      ? SessionProvider.CODEX_APP_SERVER
      : SessionProvider.CHATGPT_WEB,
    externalSessionId: null,
    externalLocator: null,
    status: AgentSessionStatus.READY,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: T0,
    version: 1,
  });
}

function initialInput(run) {
  return buildAgentTurnInput({
    inputId: "input-initial",
    runId: run.runId,
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId: "discuss-objective",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { objective: run.objective },
    promptHash: sha256Text("initial prompt"),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
}

function peerInput(run, sourceMessageId) {
  return buildAgentTurnInput({
    inputId: "input-peer",
    runId: run.runId,
    targetActor: AgentActor.CHATGPT_WEB_AGENT,
    kind: AgentTurnInputKind.PEER_RELAY,
    sourceMessageId,
    instructionId: "review-peer-proposal",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { sourceMessageId },
    promptHash: sha256Text("peer prompt"),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T1,
  });
}

function makeMessage(run, {
  messageId = "message-codex",
  sequence = 1,
  actor = AgentActor.CODEX_AGENT,
  sessionId = "session-codex",
  turnId = "turn-codex",
  kind = AgentMessageKind.PROPOSAL,
  packet = proposalPacket(),
  createdAt = T0,
} = {}) {
  return buildAgentMessage({
    messageId,
    runId: run.runId,
    sequence,
    actor,
    sessionId,
    turnId,
    kind,
    content: canonicalJson(packet),
    normalizedPacket: packet,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt,
  });
}

function artifactFrom(message, proposalId = `proposal-${message.messageId}`, overrides = {}) {
  const packet = message.normalizedPacket;
  return createProposalArtifact({
    proposalId,
    runId: message.runId,
    authorActor: message.actor,
    sourceMessageId: message.messageId,
    sourceSessionId: message.sessionId,
    sourceTurnId: message.turnId,
    summary: packet.summary ?? "Not a proposal",
    body: packet.body ?? "Not a proposal",
    assumptions: packet.assumptions ?? [],
    openDecisions: packet.open_decisions ?? [],
    objectiveHash: message.objectiveHash,
    policyHash: message.policyHash,
    createdAt: message.createdAt,
    ...overrides,
  });
}

function openFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-proposals-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, { runLimits: runLimits() });
  for (const actor of Object.values(AgentActor)) {
    store.createAgentSession({
      session: makeSession(run.runId, actor),
      createdAt: T0,
      updatedAt: T0,
    });
  }
  return { filename, run, store };
}

function saveMessage(store, input, message, suffix) {
  store.saveAgentTurnInputWithDelivery({
    turnInput: input,
    deliveryId: `delivery-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    createdAt: input.createdAt,
  });
  store.saveAgentMessage({ inputId: input.inputId, message });
}

test("proposal artifacts survive restart and retain exact source provenance", (t) => {
  const { filename, run, store } = openFixture(t);
  const message = makeMessage(run);
  saveMessage(store, initialInput(run), message, "initial");
  const artifact = artifactFrom(message);

  assert.deepEqual(store.saveProposalArtifact(artifact), artifact);
  assert.deepEqual(store.getProposalArtifact(artifact.proposalId), artifact);
  assert.deepEqual(
    store.getProposalArtifactBySourceMessage(message.messageId),
    artifact,
  );
  assert.deepEqual(store.listProposalArtifacts(run.runId), [artifact]);
  assert.deepEqual(store.verifyProposalArtifacts(), { valid: true, artifacts: 1 });
  store.close();

  // This is an entity-level persistence fixture, not a complete discussion
  // transaction. Verify the proposal owner explicitly without treating the
  // deliberately omitted response/queue events as production history.
  const reopened = new SqliteStore({ filename, verifyOnOpen: false });
  assert.deepEqual(reopened.verifyProposalArtifacts(), { valid: true, artifacts: 1 });
  assert.deepEqual(reopened.getProposalArtifact(artifact.proposalId), artifact);
  assert.deepEqual(reopened.listProposalArtifacts(run.runId), [artifact]);
  reopened.close();
});

test("proposal persistence rejects non-proposal sources and provenance/content drift", (t) => {
  const { run, store } = openFixture(t);
  const critiquePacket = {
    type: "CRITIQUE",
    target_proposal_sha256: sha256Text("proposal-ref"),
    blocking_findings: [],
    non_blocking_findings: [],
    requested_changes: [],
  };
  const critique = makeMessage(run, {
    kind: AgentMessageKind.CRITIQUE,
    packet: critiquePacket,
  });
  saveMessage(store, initialInput(run), critique, "critique");
  assert.throws(
    () => store.saveProposalArtifact(artifactFrom(critique)),
    (error) => error.code === "PROPOSAL_SOURCE_KIND_MISMATCH",
  );
  store.close();
});

test("proposal persistence rejects drift and permits one artifact per source message", (t) => {
  const { run, store } = openFixture(t);
  const message = makeMessage(run);
  saveMessage(store, initialInput(run), message, "initial");
  const artifact = artifactFrom(message);

  assert.throws(
    () => store.saveProposalArtifact(artifactFrom(message, "proposal-wrong-session", {
      sourceSessionId: "session-web",
    })),
    (error) => error.code === "PROPOSAL_SOURCE_MISMATCH",
  );
  assert.throws(
    () => store.saveProposalArtifact(artifactFrom(message, "proposal-wrong-content", {
      body: "A body the source AgentMessage did not contain.",
    })),
    (error) => error.code === "PROPOSAL_SOURCE_MISMATCH",
  );

  store.saveProposalArtifact(artifact);
  assert.throws(
    () => store.saveProposalArtifact(artifactFrom(message, "proposal-duplicate-source")),
    (error) => error.code === "PROPOSAL_SOURCE_ALREADY_USED",
  );
  store.close();
});

test("a run stores one canonical artifact for a proposal reference", (t) => {
  const { run, store } = openFixture(t);
  const codexMessage = makeMessage(run);
  saveMessage(store, initialInput(run), codexMessage, "initial");
  const webMessage = makeMessage(run, {
    messageId: "message-web",
    sequence: 2,
    actor: AgentActor.CHATGPT_WEB_AGENT,
    sessionId: "session-web",
    turnId: "turn-web",
    kind: AgentMessageKind.REVISION,
    createdAt: T1,
  });
  saveMessage(store, peerInput(run, codexMessage.messageId), webMessage, "peer");

  const first = artifactFrom(codexMessage, "proposal-first");
  const second = artifactFrom(webMessage, "proposal-second");
  assert.equal(first.proposalRefHash, second.proposalRefHash);
  store.saveProposalArtifact(first);
  assert.throws(
    () => store.saveProposalArtifact(second),
    (error) => error.code === "PROPOSAL_REFERENCE_ALREADY_EXISTS",
  );
  assert.deepEqual(store.listProposalArtifacts(run.runId), [first]);
  store.close();
});

test("startup verification rejects tampered proposal artifact JSON", (t) => {
  const { filename, run, store } = openFixture(t);
  const message = makeMessage(run);
  saveMessage(store, initialInput(run), message, "initial");
  const artifact = artifactFrom(message);
  store.saveProposalArtifact(artifact);
  store.close();

  const database = new DatabaseSync(filename);
  const tampered = artifactFrom(message, artifact.proposalId, {
    body: "Tampered after persistence.",
  });
  database.prepare(`
    UPDATE proposal_artifacts SET artifact_json = ? WHERE proposal_id = ?
  `).run(canonicalJson(tampered), artifact.proposalId);
  database.close();

  assert.throws(
    () => new SqliteStore(filename),
    EventChainIntegrityError,
  );
});
