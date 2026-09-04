import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_PACKET_REJECTED_EVENT_TYPE,
  AgentPacketParserStage,
  AgentPacketRejectionRecoverability,
  buildAgentPacketRejectedEvent,
} from "../src/domain/agent-packet-rejection.js";
import { buildAgentMessage, buildAgentTurnInput } from "../src/domain/agent-messages.js";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun, createAgentSessionRecord } from "../src/domain/contracts.js";
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
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import {
  discussionSubmissionEvidence,
  discussionTurnEvidence,
} from "../src/orchestration/discussion-turn-evidence.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";
const T2 = "2026-09-04T00:02:00.000Z";

function limits() {
  return {
    maxTurns: 12,
    maxProtocolRepairs: 1,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-rejection-links-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  const run = createAgentRun({
    runId: "run-rejection",
    mode: RunMode.DISCUSSION,
    objective: "Reject one malformed provider packet",
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
  store.createRun(run, { runLimits: limits() });

  const session = createAgentSessionRecord({
    sessionId: "session-codex",
    runId: run.runId,
    actor: AgentActor.CODEX_AGENT,
    provider: SessionProvider.CODEX_APP_SERVER,
    externalSessionId: "thread-codex",
    externalLocator: null,
    status: AgentSessionStatus.READY,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: T0,
    version: 1,
  });
  store.createAgentSession({ session, createdAt: T0, updatedAt: T0 });

  const turnInput = buildAgentTurnInput({
    inputId: "input-rejection",
    runId: run.runId,
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId: "discuss-objective",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { objective: run.objective },
    promptHash: sha256Text("rendered prompt"),
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
  const queuedRequest = {
    turnInput,
    deliveryId: "delivery-rejection",
    idempotencyKey: "idempotency-rejection",
    createdAt: T0,
  };
  store.saveAgentTurnInputWithDelivery(queuedRequest);
  const queued = createAgentRun({
    ...run,
    phase: RunPhase.CODEX_TURN_PENDING,
    version: 2,
    updatedAt: T0,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: run.version,
    eventId: "event-rejection-queued",
    eventType: "AGENT_TURN_QUEUED",
    payload: { run: queued, details: discussionTurnEvidence(queuedRequest) },
    createdAt: T0,
    nextRun: queued,
  });
  let delivery = store.claimNextPendingDelivery({ runId: run.runId, claimedAt: T0 });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: delivery.state,
    expectedVersion: delivery.version,
    nextState: "SUBMITTED",
    providerReceipt: { externalTurnId: "turn-rejection" },
    updatedAt: T0,
  });
  const running = createAgentRun({
    ...queued,
    phase: RunPhase.CODEX_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
    version: 3,
    updatedAt: T0,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: queued.version,
    eventId: "event-rejection-submitted",
    eventType: "AGENT_TURN_SUBMITTED",
    payload: {
      run: running,
      details: discussionSubmissionEvidence({
        turnInput,
        deliveryId: delivery.deliveryId,
        sessionId: session.sessionId,
        turnId: "turn-rejection",
        providerReceipt: delivery.providerReceipt,
        attemptCount: delivery.attemptCount,
      }),
    },
    createdAt: T0,
    nextRun: running,
  });
  store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: delivery.state,
    expectedVersion: delivery.version,
    nextState: "RESPONSE_COMPLETED",
    updatedAt: T1,
  });

  const rejection = buildAgentPacketRejectedEvent({
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    runId: run.runId,
    actor: AgentActor.CODEX_AGENT,
    sessionId: session.sessionId,
    turnId: "turn-rejection",
    deliveryId: "delivery-rejection",
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The final packet was not valid JSON.",
    rawResponseArtifactHash: sha256Text("redacted raw response artifact"),
    protocolRepairsUsed: 1,
    recoverability: AgentPacketRejectionRecoverability.EXHAUSTED,
    createdAt: T1,
  });
  const responseStored = createAgentRun({
    ...running,
    phase: RunPhase.CODEX_RESPONSE_STORED,
    activeActor: null,
    currentTurn: 1,
    version: 4,
    updatedAt: T1,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: running.version,
    eventId: "event-rejection",
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    payload: { run: responseStored, details: rejection },
    createdAt: T1,
    nextRun: responseStored,
  });
  return { filename, rejection, responseStored, store };
}

test("a canonical packet rejection settles one exact delivery without storing raw output", (t) => {
  const { filename, rejection, store } = fixture(t);
  assert.deepEqual(store.getAgentPacketRejectionByDelivery(rejection.deliveryId), rejection);
  assert.deepEqual(store.verifyAgentPacketRejections(), { valid: true, rejections: 1 });
  assert.deepEqual(scanStartupRecovery(store), []);
  assert.equal(Object.hasOwn(rejection, "rawResponse"), false);
  store.close();

  const reopened = new SqliteStore(filename);
  assert.deepEqual(reopened.getAgentPacketRejectionByDelivery(rejection.deliveryId), rejection);
  assert.equal(reopened.getAgentPacketRejectionByDelivery("delivery-absent"), null);
  reopened.close();
});

test("a rejection remains bound to the submitted provider turn", (t) => {
  const { filename, rejection, store } = fixture(t);
  store.close();
  const database = new DatabaseSync(filename);
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = ? WHERE delivery_id = ?
  `).run(
    canonicalJson({ externalTurnId: "turn-rejection-forged" }),
    rejection.deliveryId,
  );
  database.close();

  const unchecked = new SqliteStore({ filename, verifyOnOpen: false });
  assert.throws(
    () => unchecked.verifyAgentPacketRejections(),
    /provider receipt\/rejection turn link is inconsistent/u,
  );
  unchecked.close();
});

test("a rejection remains bound to the submitted same-actor session", (t) => {
  const { filename, rejection, responseStored, store } = fixture(t);
  const alternate = createAgentSessionRecord({
    sessionId: "session-codex-alternate",
    runId: responseStored.runId,
    actor: AgentActor.CODEX_AGENT,
    provider: SessionProvider.CODEX_APP_SERVER,
    externalSessionId: "thread-codex-alternate",
    externalLocator: null,
    status: AgentSessionStatus.READY,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: T0,
    version: 1,
  });
  store.createAgentSession({ session: alternate, createdAt: T0, updatedAt: T0 });
  store.close();

  const database = new DatabaseSync(filename);
  const row = database.prepare(`
    SELECT payload_json FROM domain_events WHERE event_type = ?
  `).get(AGENT_PACKET_REJECTED_EVENT_TYPE);
  const payload = JSON.parse(row.payload_json);
  payload.details = { ...payload.details, sessionId: alternate.sessionId };
  database.prepare(`
    UPDATE domain_events SET payload_json = ? WHERE event_type = ?
  `).run(canonicalJson(payload), AGENT_PACKET_REJECTED_EVENT_TYPE);
  database.close();

  const unchecked = new SqliteStore({ filename, verifyOnOpen: false });
  assert.throws(
    () => unchecked.verifyAgentPacketRejections(),
    /submission\/rejection session and turn attribution is inconsistent/u,
  );
  assert.equal(rejection.actor, alternate.actor);
  unchecked.close();
});

test("duplicate rejection events for one delivery fail closed", (t) => {
  const { rejection, responseStored, store } = fixture(t);
  const duplicate = buildAgentPacketRejectedEvent({ ...rejection, createdAt: T2 });
  const next = createAgentRun({
    ...responseStored,
    version: responseStored.version + 1,
    updatedAt: T2,
  });
  store.appendEventAndUpdateProjection({
    runId: next.runId,
    expectedVersion: responseStored.version,
    eventId: "event-rejection-duplicate",
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    payload: { run: next, details: duplicate },
    createdAt: T2,
    nextRun: next,
  });
  assert.throws(
    () => store.getAgentPacketRejectionByDelivery(rejection.deliveryId),
    (error) => error instanceof EventChainIntegrityError && /duplicates delivery/u.test(error.message),
  );
  assert.throws(() => store.verifyAgentPacketRejections(), /duplicates delivery/u);
  store.close();
});

test("a rejection event cannot claim the wrong actor response phase", (t) => {
  const { filename, store } = fixture(t);
  store.close();
  const database = new DatabaseSync(filename);
  const row = database.prepare(`
    SELECT payload_json FROM domain_events WHERE event_type = ?
  `).get(AGENT_PACKET_REJECTED_EVENT_TYPE);
  const payload = JSON.parse(row.payload_json);
  payload.run = { ...payload.run, phase: RunPhase.WEB_RESPONSE_STORED };
  database.prepare(`
    UPDATE domain_events SET payload_json = ? WHERE event_type = ?
  `).run(canonicalJson(payload), AGENT_PACKET_REJECTED_EVENT_TYPE);
  database.close();

  const unchecked = new SqliteStore({ filename, verifyOnOpen: false });
  assert.throws(
    () => unchecked.verifyAgentPacketRejections(),
    (error) => error instanceof EventChainIntegrityError
      && /event run state does not match the rejected Agent response/u
        .test(error.cause?.message ?? ""),
  );
  unchecked.close();
});

test("a rejected input cannot also own a canonical AgentMessage", (t) => {
  const { rejection, responseStored, store } = fixture(t);
  const packet = {
    type: "PROPOSAL",
    summary: "Conflicting valid output",
    body: "This message must not coexist with the rejection.",
    assumptions: [],
    open_decisions: [],
  };
  const message = buildAgentMessage({
    messageId: "message-conflict",
    runId: responseStored.runId,
    sequence: 1,
    actor: rejection.actor,
    sessionId: rejection.sessionId,
    turnId: rejection.turnId,
    kind: AgentMessageKind.PROPOSAL,
    content: "conflicting valid output",
    normalizedPacket: packet,
    objectiveHash: responseStored.objectiveHash,
    policyHash: responseStored.policyHash,
    createdAt: T2,
  });
  store.saveAgentMessage({ inputId: "input-rejection", message });
  assert.throws(
    () => store.getAgentPacketRejectionByDelivery(rejection.deliveryId),
    /conflicts with canonical AgentMessage/u,
  );
  assert.throws(() => store.verifyAgentPacketRejections(), /conflicts with canonical AgentMessage/u);
  store.close();
});

test("rejection lookup rejects forged actor/session attribution", (t) => {
  const { rejection, responseStored, store } = fixture(t);
  store.close();

  // Rebuild the fixture with an independently valid event whose actor does not
  // own the durable input. This is an integrity failure, not an absent result.
  const directory = mkdtempSync(join(tmpdir(), "agent-rejection-forgery-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const forgedStore = new SqliteStore(filename);
  const originalRun = createAgentRun({
    ...responseStored,
    phase: RunPhase.CREATED,
    currentTurn: 0,
    version: 1,
    updatedAt: T0,
  });
  forgedStore.createRun(originalRun, { runLimits: limits() });
  const codex = createAgentSessionRecord({
    sessionId: "session-codex",
    runId: originalRun.runId,
    actor: AgentActor.CODEX_AGENT,
    provider: SessionProvider.CODEX_APP_SERVER,
    externalSessionId: null,
    externalLocator: null,
    status: AgentSessionStatus.READY,
    activeTurnId: null,
    lastCompletedTurnId: null,
    lastObservedAt: T0,
    version: 1,
  });
  const web = createAgentSessionRecord({
    ...codex,
    sessionId: "session-web",
    actor: AgentActor.CHATGPT_WEB_AGENT,
    provider: SessionProvider.CHATGPT_WEB,
  });
  forgedStore.createAgentSession({ session: codex, createdAt: T0, updatedAt: T0 });
  forgedStore.createAgentSession({ session: web, createdAt: T0, updatedAt: T0 });
  const input = buildAgentTurnInput({
    inputId: "input-rejection",
    runId: originalRun.runId,
    targetActor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.INITIAL_OBJECTIVE,
    sourceMessageId: null,
    instructionId: "discuss-objective",
    promptTemplateVersion: "discussion-prompt-v1",
    payload: { objective: originalRun.objective },
    promptHash: sha256Text("rendered prompt"),
    objectiveHash: originalRun.objectiveHash,
    policyHash: originalRun.policyHash,
    createdAt: T0,
  });
  const queuedRequest = {
    turnInput: input,
    deliveryId: rejection.deliveryId,
    idempotencyKey: "forged-idempotency",
    createdAt: T0,
  };
  forgedStore.saveAgentTurnInputWithDelivery(queuedRequest);
  const queued = createAgentRun({
    ...originalRun,
    phase: RunPhase.CODEX_TURN_PENDING,
    version: 2,
    updatedAt: T0,
  });
  forgedStore.appendEventAndUpdateProjection({
    runId: originalRun.runId,
    expectedVersion: originalRun.version,
    eventId: "event-forged-queue",
    eventType: "AGENT_TURN_QUEUED",
    payload: { run: queued, details: discussionTurnEvidence(queuedRequest) },
    createdAt: T0,
    nextRun: queued,
  });
  let delivery = forgedStore.claimNextPendingDelivery({ runId: originalRun.runId, claimedAt: T0 });
  delivery = forgedStore.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: delivery.state,
    expectedVersion: delivery.version,
    nextState: "SUBMITTED",
    providerReceipt: { externalTurnId: rejection.turnId },
    updatedAt: T0,
  });
  const running = createAgentRun({
    ...queued,
    phase: RunPhase.CODEX_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
    version: 3,
    updatedAt: T0,
  });
  forgedStore.appendEventAndUpdateProjection({
    runId: originalRun.runId,
    expectedVersion: queued.version,
    eventId: "event-forged-submitted",
    eventType: "AGENT_TURN_SUBMITTED",
    payload: {
      run: running,
      details: discussionSubmissionEvidence({
        turnInput: input,
        deliveryId: delivery.deliveryId,
        sessionId: codex.sessionId,
        turnId: rejection.turnId,
        providerReceipt: delivery.providerReceipt,
        attemptCount: delivery.attemptCount,
      }),
    },
    createdAt: T0,
    nextRun: running,
  });
  forgedStore.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: delivery.state,
    expectedVersion: delivery.version,
    nextState: "RESPONSE_COMPLETED",
    updatedAt: T1,
  });
  const forged = buildAgentPacketRejectedEvent({
    ...rejection,
    actor: AgentActor.CHATGPT_WEB_AGENT,
    sessionId: web.sessionId,
  });
  const next = createAgentRun({
    ...running,
    phase: RunPhase.WEB_RESPONSE_STORED,
    activeActor: null,
    currentTurn: 1,
    version: 4,
    updatedAt: T1,
  });
  forgedStore.appendEventAndUpdateProjection({
    runId: originalRun.runId,
    expectedVersion: running.version,
    eventId: "event-forged-attribution",
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    payload: { run: next, details: forged },
    createdAt: T1,
    nextRun: next,
  });
  assert.throws(
    () => forgedStore.getAgentPacketRejectionByDelivery(rejection.deliveryId),
    /delivery\/input attribution is inconsistent/u,
  );
  forgedStore.close();
});
