import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { agentPacketHash } from "../src/domain/agent-packets.js";
import { buildAgentMessage, buildAgentTurnInput } from "../src/domain/agent-messages.js";
import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../src/domain/canonical-json.js";
import {
  createAgentRun,
  createAgentSessionRecord,
  createProposalArtifact,
} from "../src/domain/contracts.js";
import { createRunOutcome } from "../src/domain/run-state-machine.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunMode,
  RunOutcomeType,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { getAgentMessageByInputEntity } from "../src/persistence/agent-communications.js";
import { verifyDiscussionResponseLinksEntity } from "../src/persistence/discussion-response-links.js";
import {
  EventChainIntegrityError,
  PersistenceError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";
import { getProposalArtifactByReferenceEntity } from "../src/persistence/proposal-artifacts.js";
import { runOutcomeHash } from "../src/persistence/run-outcomes.js";
import { providerReceiptForSession } from "./support/discussion-provider-receipt.js";
import { discussionSubmissionEvidence } from "../src/orchestration/discussion-turn-evidence.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";
const ERRORS = { EventChainIntegrityError, PersistenceError };

function runLimits() {
  return {
    maxTurns: 12,
    maxProtocolRepairs: 1,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function makeRun() {
  return createAgentRun({
    runId: "run-response-links",
    mode: RunMode.DISCUSSION,
    objective: "Verify one durable response graph",
    policyHash: sha256Text("policy"),
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

function makeSession(runId, actor) {
  return createAgentSessionRecord({
    sessionId: actor === AgentActor.CODEX_AGENT ? "session-codex" : "session-web",
    runId,
    actor,
    provider: actor === AgentActor.CODEX_AGENT
      ? SessionProvider.CODEX_APP_SERVER
      : SessionProvider.CHATGPT_WEB,
    externalSessionId: actor === AgentActor.CODEX_AGENT
      ? "thread-codex"
      : "conversation-web",
    externalLocator: actor === AgentActor.CODEX_AGENT
      ? null
      : "https://chatgpt.com/c/conversation-web",
    status: AgentSessionStatus.READY,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: T0,
    version: 1,
  });
}

function makeInput(run, {
  inputId,
  actor,
  kind,
  sourceMessageId,
  createdAt,
}) {
  return buildAgentTurnInput({
    inputId,
    runId: run.runId,
    targetActor: actor,
    kind,
    sourceMessageId,
    instructionId: kind === AgentTurnInputKind.INITIAL_OBJECTIVE
      ? "discuss-objective"
      : "review-peer-proposal",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: kind === AgentTurnInputKind.INITIAL_OBJECTIVE
      ? { objective: run.objective }
      : { sourceMessageId },
    promptHash: sha256Text(`prompt:${inputId}`),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt,
  });
}

function proposalPacket() {
  return {
    type: "PROPOSAL",
    summary: "Keep response writes atomic",
    body: "Persist and link every durable response row in one transaction.",
    assumptions: ["The Controller is the only writer"],
    open_decisions: [],
  };
}

function makeMessage(run, input, packet) {
  return buildAgentMessage({
    messageId: "message-response",
    runId: run.runId,
    sequence: 1,
    actor: input.targetActor,
    sessionId: "session-codex",
    turnId: "turn-response",
    kind: AgentMessageKind.PROPOSAL,
    content: `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`,
    normalizedPacket: packet,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
}

function makeArtifact(message) {
  const packet = message.normalizedPacket;
  return createProposalArtifact({
    proposalId: "proposal-response",
    runId: message.runId,
    authorActor: message.actor,
    sourceMessageId: message.messageId,
    sourceSessionId: message.sessionId,
    sourceTurnId: message.turnId,
    summary: packet.summary,
    body: packet.body,
    assumptions: packet.assumptions,
    openDecisions: packet.open_decisions,
    objectiveHash: message.objectiveHash,
    policyHash: message.policyHash,
    createdAt: message.createdAt,
  });
}

function openFixture(t, disposition = "RELAY", { omitResponseEvent = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-response-links-"));
  const filename = join(directory, "controller.sqlite");
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
  store.createAgentSession({
    session: {
      ...makeSession(run.runId, AgentActor.CODEX_AGENT),
      sessionId: "session-codex-alternate",
    },
    createdAt: T0,
    updatedAt: T0,
  });

  const input = makeInput(run, {
    inputId: "input-response",
    actor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    createdAt: T0,
  });
  store.saveAgentTurnInputWithDelivery({
    turnInput: input,
    deliveryId: "delivery-response",
    idempotencyKey: "idempotency-response",
    createdAt: T0,
  });
  const packet = proposalPacket();
  const message = makeMessage(run, input, packet);
  store.saveAgentMessage({ inputId: input.inputId, message });
  store.saveAgentPacket({
    packetId: "packet-response",
    runId: run.runId,
    messageId: message.messageId,
    packet,
    createdAt: T0,
  });
  const proposal = makeArtifact(message);
  store.saveProposalArtifact(proposal);

  let next = null;
  let outcome = null;
  if (disposition === "RELAY") {
    const nextInput = makeInput(run, {
      inputId: "input-next",
      actor: AgentActor.CHATGPT_WEB_AGENT,
      kind: AgentTurnInputKind.PEER_RELAY,
      sourceMessageId: message.messageId,
      createdAt: T1,
    });
    store.saveAgentTurnInputWithDelivery({
      turnInput: nextInput,
      deliveryId: "delivery-next",
      idempotencyKey: "idempotency-next",
      createdAt: T1,
    });
    next = { inputId: nextInput.inputId, deliveryId: "delivery-next" };
  } else {
    outcome = createRunOutcome({
      type: RunOutcomeType.CONSENSUS,
      proposalHash: proposal.proposalRefHash,
    });
  }

  const details = {
    deliveryId: "delivery-response",
    inputId: input.inputId,
    messageId: message.messageId,
    messageHash: sha256CanonicalJson(message),
    messageContentHash: message.contentHash,
    packetId: "packet-response",
    packetHash: agentPacketHash(packet),
    proposal: {
      proposalId: proposal.proposalId,
      proposalContentHash: proposal.proposalContentHash,
      proposalRefHash: proposal.proposalRefHash,
      reused: false,
    },
    next,
    outcome: outcome === null ? null : {
      type: outcome.type,
      hash: runOutcomeHash(outcome),
    },
    disposition,
  };
  let sourceDelivery = store.claimNextPendingDelivery({
    runId: run.runId,
    claimedAt: T0,
  });
  sourceDelivery = store.transitionDelivery({
    deliveryId: sourceDelivery.deliveryId,
    expectedState: sourceDelivery.state,
    expectedVersion: sourceDelivery.version,
    nextState: "SUBMITTED",
    providerReceipt: providerReceiptForSession(
      store,
      message.sessionId,
      message.turnId,
    ),
    updatedAt: T0,
  });
  const runningRun = createAgentRun({
    ...run,
    phase: RunPhase.CODEX_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
    version: 2,
    updatedAt: T0,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: run.version,
    eventId: "turn-submitted",
    eventType: "AGENT_TURN_SUBMITTED",
    payload: {
      run: runningRun,
      details: discussionSubmissionEvidence({
        turnInput: input,
        deliveryId: sourceDelivery.deliveryId,
        sessionId: message.sessionId,
        turnId: message.turnId,
        providerReceipt: sourceDelivery.providerReceipt,
        attemptCount: sourceDelivery.attemptCount,
      }),
    },
    createdAt: T0,
    nextRun: runningRun,
  });
  const responseRun = createAgentRun({
    ...runningRun,
    phase: RunPhase.CODEX_RESPONSE_STORED,
    activeActor: null,
    currentTurn: 1,
    version: 3,
    updatedAt: T1,
  });
  sourceDelivery = store.transitionDelivery({
    deliveryId: sourceDelivery.deliveryId,
    expectedState: sourceDelivery.state,
    expectedVersion: sourceDelivery.version,
    nextState: "RESPONSE_COMPLETED",
    updatedAt: T1,
  });
  if (disposition === "RELAY") {
    store.transitionDelivery({
      deliveryId: sourceDelivery.deliveryId,
      expectedState: sourceDelivery.state,
      expectedVersion: sourceDelivery.version,
      nextState: "RELAYED",
      updatedAt: T1,
    });
  }
  if (!omitResponseEvent) {
    store.appendEventAndUpdateProjection({
      runId: run.runId,
      expectedVersion: runningRun.version,
      eventId: "response-stored",
      eventType: "AGENT_RESPONSE_STORED",
      payload: { run: responseRun, details },
      createdAt: T1,
      nextRun: responseRun,
    });
  }
  if (outcome !== null && !omitResponseEvent) {
    const finalRun = createAgentRun({
      ...responseRun,
      phase: RunPhase.COMPLETE,
      version: 4,
      updatedAt: T1,
    });
    store.appendEventAndUpdateProjection({
      runId: run.runId,
      expectedVersion: responseRun.version,
      eventId: "run-completed",
      eventType: "RUN_COMPLETED",
      payload: {
        run: finalRun,
        details: { outcome, outcomeHash: runOutcomeHash(outcome) },
      },
      createdAt: T1,
      nextRun: finalRun,
    });
    store.saveRunOutcome({ runId: run.runId, outcome, createdAt: T1 });
  }
  store.close();

  const database = new DatabaseSync(filename);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, details, input, message, proposal };
}

function replaceDetails(database, transform) {
  const row = database.prepare(`
    SELECT payload_json FROM domain_events WHERE event_type = 'AGENT_RESPONSE_STORED'
  `).get();
  const payload = JSON.parse(row.payload_json);
  payload.details = transform(payload.details);
  database.prepare(`
    UPDATE domain_events SET payload_json = ? WHERE event_type = 'AGENT_RESPONSE_STORED'
  `).run(canonicalJson(payload));
}

function replaceSubmissionDetails(database, transform) {
  const row = database.prepare(`
    SELECT payload_json FROM domain_events WHERE event_type = 'AGENT_TURN_SUBMITTED'
  `).get();
  const payload = JSON.parse(row.payload_json);
  payload.details = transform(payload.details);
  database.prepare(`
    UPDATE domain_events SET payload_json = ? WHERE event_type = 'AGENT_TURN_SUBMITTED'
  `).run(canonicalJson(payload));
}

test("discussion response links bind a RELAY event to every durable row", (t) => {
  const { database, input, message, proposal } = openFixture(t);

  assert.deepEqual(
    getAgentMessageByInputEntity(database, input.inputId, ERRORS),
    message,
  );
  assert.deepEqual(
    getProposalArtifactByReferenceEntity(
      database,
      proposal.runId,
      proposal.proposalRefHash,
      ERRORS,
    ),
    proposal,
  );
  assert.deepEqual(
    verifyDiscussionResponseLinksEntity(database, ERRORS),
    { valid: true, responses: 1 },
  );
});

test("discussion response links bind a COMPLETE event to its RunOutcome", (t) => {
  const { database } = openFixture(t, "COMPLETE");
  assert.deepEqual(
    verifyDiscussionResponseLinksEntity(database, ERRORS),
    { valid: true, responses: 1 },
  );
});

test("discussion response detail schema is exact and disposition-aware", (t) => {
  const { database } = openFixture(t);
  replaceDetails(database, (details) => ({ ...details, unsupported: true }));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    (error) => error instanceof EventChainIntegrityError && /invalid details/.test(error.message),
  );
});

test("a BLOCKED response cannot carry a canonical outcome", (t) => {
  const { database } = openFixture(t, "BLOCKED");
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    (error) => error instanceof EventChainIntegrityError
      && /BLOCKED forbids next and outcome/.test(error.cause?.message ?? ""),
  );
});

test("discussion response links reject validly shaped but stale hashes", (t) => {
  const { database } = openFixture(t);
  replaceDetails(database, (details) => ({
    ...details,
    messageContentHash: sha256Text("stale-message-content"),
  }));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    (error) => error instanceof EventChainIntegrityError
      && /message\/input link is inconsistent/.test(error.message),
  );
});

test("discussion response links hash-bind complete AgentMessage metadata", (t) => {
  const { database, message } = openFixture(t);
  const changedTurnId = "turn-response-forged";
  const changedMessage = { ...message, turnId: changedTurnId };
  const originalReceipt = JSON.parse(database.prepare(`
    SELECT provider_receipt_json FROM delivery_attempts WHERE delivery_id = ?
  `).get("delivery-response").provider_receipt_json);
  const changedReceipt = { ...originalReceipt, externalTurnId: changedTurnId };
  database.prepare(`
    UPDATE agent_messages SET turn_id = ?, message_json = ? WHERE message_id = ?
  `).run(changedTurnId, canonicalJson(changedMessage), message.messageId);
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = ? WHERE delivery_id = ?
  `).run(canonicalJson(changedReceipt), "delivery-response");
  replaceSubmissionDetails(database, (details) => ({
    ...details,
    turnId: changedTurnId,
    providerReceiptHash: sha256CanonicalJson(changedReceipt),
  }));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /message\/input link is inconsistent/u,
  );
});

test("discussion response links bind the response to the submitted session", (t) => {
  const { database, message } = openFixture(t);
  const changedMessage = {
    ...message,
    sessionId: "session-codex-alternate",
  };
  database.prepare(`
    UPDATE agent_messages SET session_id = ?, message_json = ? WHERE message_id = ?
  `).run(changedMessage.sessionId, canonicalJson(changedMessage), message.messageId);
  replaceDetails(database, (details) => ({
    ...details,
    messageHash: sha256CanonicalJson(changedMessage),
  }));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /submission\/message session and turn attribution is inconsistent/u,
  );
});

test("discussion response links reject provider receipt mutation", (t) => {
  const { database } = openFixture(t);
  const originalReceipt = JSON.parse(database.prepare(`
    SELECT provider_receipt_json FROM delivery_attempts WHERE delivery_id = ?
  `).get("delivery-response").provider_receipt_json);
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = ? WHERE delivery_id = ?
  `).run(
    canonicalJson({ ...originalReceipt, forged: true }),
    "delivery-response",
  );
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /current provider receipt does not match its latest submission evidence/u,
  );
});

test("discussion response links reject a false proposal reuse claim", (t) => {
  const { database } = openFixture(t);
  replaceDetails(database, (details) => ({
    ...details,
    proposal: { ...details.proposal, reused: true },
  }));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    (error) => error instanceof EventChainIntegrityError
      && /reused flag/.test(error.message),
  );
});

test("discussion response links reject a source delivery state inconsistent with disposition", (t) => {
  const relay = openFixture(t);
  relay.database.prepare(`
    UPDATE delivery_attempts SET state = 'RESPONSE_COMPLETED'
    WHERE delivery_id = 'delivery-response'
  `).run();
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(relay.database, ERRORS),
    /source delivery state RESPONSE_COMPLETED does not match RELAY/u,
  );
});

test("discussion response links reject an AgentMessage without response evidence", (t) => {
  const { database } = openFixture(t, "RELAY", { omitResponseEvent: true });
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /has no exact hash-chained discussion response evidence/u,
  );
});

test("discussion response links reject duplicate evidence for one response", (t) => {
  const { database } = openFixture(t);
  const original = database.prepare(`
    SELECT payload_json, created_at FROM domain_events
    WHERE event_type = 'AGENT_RESPONSE_STORED'
  `).get();
  database.prepare(`
    INSERT INTO domain_events (
      run_id, sequence, event_id, event_type, payload_json,
      previous_hash, event_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "run-response-links",
    99,
    "duplicate-response-stored",
    "AGENT_RESPONSE_STORED",
    original.payload_json,
    sha256Text("previous"),
    sha256Text("duplicate"),
    original.created_at,
  );
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /duplicates response evidence/u,
  );
});

test("discussion response links reject a response event with the wrong run phase", (t) => {
  const { database } = openFixture(t);
  const row = database.prepare(`
    SELECT payload_json FROM domain_events WHERE event_type = 'AGENT_RESPONSE_STORED'
  `).get();
  const payload = JSON.parse(row.payload_json);
  payload.run = {
    ...payload.run,
    phase: RunPhase.CODEX_TO_WEB_PENDING,
  };
  database.prepare(`
    UPDATE domain_events SET payload_json = ? WHERE event_type = 'AGENT_RESPONSE_STORED'
  `).run(canonicalJson(payload));
  assert.throws(
    () => verifyDiscussionResponseLinksEntity(database, ERRORS),
    /run state does not match the stored Agent response/u,
  );
});

test("non-discussion event payloads are outside this verifier", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-response-links-ignore-"));
  const filename = join(directory, "controller.sqlite");
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, { runLimits: runLimits() });
  store.close();

  const database = new DatabaseSync(filename);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.prepare(`
    UPDATE domain_events SET payload_json = 'not-json' WHERE event_type = 'RUN_CREATED'
  `).run();
  assert.deepEqual(
    verifyDiscussionResponseLinksEntity(database, ERRORS),
    { valid: true, responses: 0 },
  );
});
