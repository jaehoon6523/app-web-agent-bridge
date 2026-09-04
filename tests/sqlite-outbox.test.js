import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun, createAgentSessionRecord } from "../src/domain/contracts.js";
import { buildAgentMessage, buildAgentTurnInput } from "../src/domain/agent-messages.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunMode,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import {
  discussionSubmissionEvidence,
  discussionTurnEvidence,
} from "../src/orchestration/discussion-turn-evidence.js";
import {
  DeliveryState,
  DeliveryTransitionError,
  OptimisticConcurrencyError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";
import { providerReceiptForSession } from "./support/discussion-provider-receipt.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";
const T2 = "2026-09-04T00:02:00.000Z";
const T3 = "2026-09-04T00:03:00.000Z";
const T4 = "2026-09-04T00:04:00.000Z";

function makeRun() {
  return createAgentRun({
    runId: "run-outbox",
    mode: RunMode.DISCUSSION,
    objective: "Reach a structured consensus",
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

function makeTurnInput(run, {
  inputId = "input-01",
  targetActor = AgentActor.CODEX_AGENT,
  kind = AgentTurnInputKind.INITIAL_OBJECTIVE,
  sourceMessageId = null,
  createdAt = T0,
} = {}) {
  return buildAgentTurnInput({
    inputId,
    runId: run.runId,
    targetActor,
    kind,
    sourceMessageId,
    instructionId: kind === AgentTurnInputKind.INITIAL_OBJECTIVE
      ? "discuss-objective"
      : "review-peer-message",
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

function proposalPacket(sequence = 1) {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: `Proposal ${sequence}`,
    body: `Body ${sequence}`,
    assumptions: [],
    open_decisions: [],
  };
}

function makeMessage(run, {
  messageId = "message-01",
  sequence = 1,
  actor = AgentActor.CODEX_AGENT,
  sessionId = "codex-session-01",
  turnId = "turn-01",
  packet = proposalPacket(sequence),
  createdAt = T1,
} = {}) {
  return buildAgentMessage({
    messageId,
    runId: run.runId,
    sequence,
    actor,
    sessionId,
    turnId,
    kind: AgentMessageKind.PROPOSAL,
    content: JSON.stringify(packet),
    normalizedPacket: packet,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt,
  });
}

function tempDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-outbox-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return filename;
}

function createSession(store, run, actor) {
  const codex = actor === AgentActor.CODEX_AGENT;
  store.createAgentSession({
    session: createAgentSessionRecord({
      sessionId: codex ? "codex-session-01" : "web-session-01",
      runId: run.runId,
      actor,
      provider: codex ? SessionProvider.CODEX_APP_SERVER : SessionProvider.CHATGPT_WEB,
      externalSessionId: codex ? "thread-01" : "conversation-01",
      externalLocator: codex ? null : "https://chatgpt.com/c/conversation-01",
      status: AgentSessionStatus.READY,
      activeTurnId: null,
      lastCompletedTurnId: null,
      lastObservedAt: T0,
      version: 1,
    }),
    createdAt: T0,
    updatedAt: T0,
  });
}

function openStore(t) {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, {
    runLimits: {
      maxTurns: run.maxTurns,
      maxProtocolRepairs: 1,
      maxDeliveryAttempts: 3,
      maxConsecutiveActorFailures: 2,
    },
  });
  createSession(store, run, AgentActor.CODEX_AGENT);
  createSession(store, run, AgentActor.CHATGPT_WEB_AGENT);
  return { filename, store, run };
}

function saveInput(store, turnInput, suffix = "01") {
  return store.saveAgentTurnInputWithDelivery({
    turnInput,
    deliveryId: `delivery-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    createdAt: turnInput.createdAt,
  });
}

function saveQueuedInitialInput(store, run, suffix = "01") {
  const turnInput = makeTurnInput(run, { inputId: `input-${suffix}` });
  const request = {
    turnInput,
    deliveryId: `delivery-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    createdAt: turnInput.createdAt,
  };
  const delivery = store.saveAgentTurnInputWithDelivery(request);
  const queued = createAgentRun({
    ...run,
    phase: RunPhase.CODEX_TURN_PENDING,
    version: run.version + 1,
    updatedAt: turnInput.createdAt,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: run.version,
    eventId: `event-queue-${suffix}`,
    eventType: "AGENT_TURN_QUEUED",
    payload: { run: queued, details: discussionTurnEvidence(request) },
    createdAt: turnInput.createdAt,
    nextRun: queued,
  });
  return { delivery, queued, turnInput };
}

function markCodexSessionRunning(store, turnId) {
  const session = store.getAgentSession("codex-session-01");
  return store.updateAgentSession({
    session: createAgentSessionRecord({
      ...session,
      status: AgentSessionStatus.RUNNING,
      activeTurnId: turnId,
      lastObservedAt: T2,
      version: session.version + 1,
    }),
    expectedVersion: session.version,
    updatedAt: T2,
  });
}

function submitQueuedInitialInput(store, run, suffix, turnId) {
  const queuedFixture = saveQueuedInitialInput(store, run, suffix);
  const claimed = store.claimNextPendingDelivery({ runId: run.runId, claimedAt: T1 });
  const submitted = store.transitionDelivery({
    deliveryId: claimed.deliveryId,
    expectedState: claimed.state,
    expectedVersion: claimed.version,
    nextState: DeliveryState.SUBMITTED,
    providerReceipt: providerReceiptForSession(
      store,
      "codex-session-01",
      turnId,
    ),
    updatedAt: T2,
  });
  const running = createAgentRun({
    ...queuedFixture.queued,
    phase: RunPhase.CODEX_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
    version: queuedFixture.queued.version + 1,
    updatedAt: T2,
  });
  markCodexSessionRunning(store, turnId);
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: queuedFixture.queued.version,
    eventId: `event-submitted-${suffix}`,
    eventType: "AGENT_TURN_SUBMITTED",
    payload: {
      run: running,
      details: discussionSubmissionEvidence({
        turnInput: queuedFixture.turnInput,
        deliveryId: submitted.deliveryId,
        sessionId: "codex-session-01",
        turnId,
        providerReceipt: submitted.providerReceipt,
        attemptCount: submitted.attemptCount,
      }),
    },
    createdAt: T2,
    nextRun: running,
  });
  return { ...queuedFixture, running, submitted };
}

test("AgentTurnInput and PENDING delivery are committed atomically", (t) => {
  const { store, run } = openStore(t);
  const first = makeTurnInput(run);
  const delivery = saveInput(store, first);
  assert.equal(delivery.state, DeliveryState.PENDING);
  assert.equal(delivery.inputId, first.inputId);
  assert.deepEqual(store.getAgentTurnInput(first.inputId), first);

  const duplicateKey = makeTurnInput(run, {
    inputId: "input-02",
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
  });
  assert.throws(() => store.saveAgentTurnInputWithDelivery({
    turnInput: duplicateKey,
    deliveryId: "delivery-02",
    idempotencyKey: "idempotency-01",
    createdAt: T1,
  }), /UNIQUE constraint failed/);
  assert.equal(store.getAgentTurnInput(duplicateKey.inputId), null);
  assert.equal(store.getDelivery("delivery-02"), null);
  assert.deepEqual(store.listAgentTurnInputs(run.runId), [first]);
  store.close();
});

test("startup rejects a non-repair input with no queue event", (t) => {
  const { filename, store, run } = openStore(t);
  saveInput(store, makeTurnInput(run));
  store.close();

  assert.throws(
    () => new SqliteStore(filename),
    /non-repair turn input without exact queue evidence/u,
  );
});

test("AgentMessage is bound to one input and does not create a next delivery", (t) => {
  const { store, run } = openStore(t);
  const input = makeTurnInput(run);
  saveInput(store, input);
  const message = makeMessage(run);
  assert.deepEqual(store.saveAgentMessage({ inputId: input.inputId, message }), message);
  assert.deepEqual(store.getAgentMessage(message.messageId), message);
  assert.deepEqual(store.listAgentMessages(run.runId), [message]);
  assert.equal(store.listDeliveries(run.runId).length, 1);

  assert.throws(
    () => store.saveAgentMessage({
      inputId: input.inputId,
      message: makeMessage(run, {
        messageId: "message-duplicate",
        sequence: 2,
        turnId: "turn-02",
      }),
    }),
    /UNIQUE constraint failed/,
  );
  assert.equal(store.getAgentMessage("message-duplicate"), null);
  store.close();
});

test("PEER_RELAY requires an existing opposite-actor AgentMessage", (t) => {
  const { store, run } = openStore(t);
  const initial = makeTurnInput(run);
  saveInput(store, initial);
  const message = makeMessage(run);
  store.saveAgentMessage({ inputId: initial.inputId, message });

  const peerInput = makeTurnInput(run, {
    inputId: "input-web-01",
    targetActor: AgentActor.CHATGPT_WEB_AGENT,
    kind: AgentTurnInputKind.PEER_RELAY,
    sourceMessageId: message.messageId,
    createdAt: T2,
  });
  assert.equal(saveInput(store, peerInput, "web-01").inputId, peerInput.inputId);

  const wrongRoute = makeTurnInput(run, {
    inputId: "input-wrong-route",
    kind: AgentTurnInputKind.PEER_RELAY,
    sourceMessageId: message.messageId,
    createdAt: T3,
  });
  assert.throws(
    () => saveInput(store, wrongRoute, "wrong-route"),
    (error) => error.code === "SOURCE_MESSAGE_ROUTE_MISMATCH",
  );
  store.close();
});

test("claim is deterministic and SUBMITTED delivery is not retried after reopen", (t) => {
  const { filename, store, run } = openStore(t);
  const queuedFixture = saveQueuedInitialInput(store, run);
  const claimed = store.claimNextPendingDelivery({ claimedAt: T1 });
  assert.equal(claimed.state, DeliveryState.DISPATCHING);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(store.claimNextPendingDelivery({ claimedAt: T1 }), null);
  const submitted = store.transitionDelivery({
    deliveryId: claimed.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: claimed.version,
    nextState: DeliveryState.SUBMITTED,
    providerReceipt: providerReceiptForSession(
      store,
      "codex-session-01",
      "turn-01",
    ),
    updatedAt: T2,
  });
  assert.equal(submitted.state, DeliveryState.SUBMITTED);
  markCodexSessionRunning(store, submitted.providerReceipt.externalTurnId);
  const running = createAgentRun({
    ...queuedFixture.queued,
    phase: RunPhase.CODEX_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
    version: queuedFixture.queued.version + 1,
    updatedAt: T2,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: queuedFixture.queued.version,
    eventId: "event-submitted-01",
    eventType: "AGENT_TURN_SUBMITTED",
    payload: {
      run: running,
      details: discussionSubmissionEvidence({
        turnInput: queuedFixture.turnInput,
        deliveryId: submitted.deliveryId,
        sessionId: "codex-session-01",
        turnId: submitted.providerReceipt.externalTurnId,
        providerReceipt: submitted.providerReceipt,
        attemptCount: submitted.attemptCount,
      }),
    },
    createdAt: T2,
    nextRun: running,
  });
  store.close();

  const reopened = new SqliteStore(filename);
  assert.deepEqual(reopened.listDispatchableDeliveries(), []);
  assert.equal(reopened.claimNextPendingDelivery({ claimedAt: T3 }), null);
  reopened.close();

  const database = new DatabaseSync(filename);
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = ? WHERE delivery_id = ?
  `).run(
    canonicalJson({
      ...submitted.providerReceipt,
      forged: true,
    }),
    submitted.deliveryId,
  );
  assert.throws(
    () => new SqliteStore(filename),
    /current provider receipt does not match its latest submission evidence/u,
  );
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = NULL WHERE delivery_id = ?
  `).run(submitted.deliveryId);
  assert.throws(
    () => new SqliteStore(filename),
    /state SUBMITTED requires a provider receipt and submission evidence/u,
  );
  database.prepare(`
    UPDATE delivery_attempts SET state = ?, provider_receipt_json = ? WHERE delivery_id = ?
  `).run(
    DeliveryState.PENDING,
    canonicalJson(submitted.providerReceipt),
    submitted.deliveryId,
  );
  database.close();
  assert.throws(
    () => new SqliteStore(filename),
    /state PENDING must not retain a provider receipt/u,
  );
});

test("startup rejects a provider receipt without submission evidence", (t) => {
  const { filename, store, run } = openStore(t);
  saveQueuedInitialInput(store, run);
  const claimed = store.claimNextPendingDelivery({ claimedAt: T1 });
  store.transitionDelivery({
    deliveryId: claimed.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: claimed.version,
    nextState: DeliveryState.SUBMITTED,
    providerReceipt: providerReceiptForSession(
      store,
      "codex-session-01",
      "turn-without-submission-event",
    ),
    updatedAt: T2,
  });
  store.close();

  assert.throws(
    () => new SqliteStore(filename),
    /provider receipt without hash-chained submission evidence/u,
  );
});

test("startup rejects a lost current-attempt receipt after submission", (t) => {
  for (const targetState of [DeliveryState.FAILED, DeliveryState.AMBIGUOUS]) {
    const { filename, store, run } = openStore(t);
    const { submitted } = submitQueuedInitialInput(
      store,
      run,
      targetState.toLowerCase(),
      `turn-${targetState.toLowerCase()}`,
    );
    store.transitionDelivery({
      deliveryId: submitted.deliveryId,
      expectedState: submitted.state,
      expectedVersion: submitted.version,
      nextState: targetState,
      updatedAt: T3,
    });
    store.close();

    const database = new DatabaseSync(filename);
    database.prepare(`
      UPDATE delivery_attempts SET provider_receipt_json = NULL WHERE delivery_id = ?
    `).run(submitted.deliveryId);
    database.close();
    assert.throws(
      () => new SqliteStore(filename),
      new RegExp(`state ${targetState} lost its current-attempt provider receipt`, "u"),
    );
  }
});

test("delivery transitions reject stale state, stale version, and duplicate terminal transition", (t) => {
  const { store, run } = openStore(t);
  saveInput(store, makeTurnInput(run));
  let delivery = store.claimNextPendingDelivery({ claimedAt: T1 });
  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.PENDING,
    expectedVersion: delivery.version,
    nextState: DeliveryState.DISPATCHING,
    updatedAt: T2,
  }), (error) => error instanceof DeliveryTransitionError);
  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: 1,
    nextState: DeliveryState.SUBMITTED,
    updatedAt: T2,
  }), OptimisticConcurrencyError);
  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: delivery.state,
    expectedVersion: delivery.version,
    nextState: DeliveryState.SUBMITTED,
    updatedAt: T2,
  }), /providerReceipt is required for a SUBMITTED delivery/u);

  for (const nextState of [
    DeliveryState.SUBMITTED,
    DeliveryState.RESPONSE_STARTED,
    DeliveryState.RESPONSE_COMPLETED,
    DeliveryState.RELAYED,
  ]) {
    delivery = store.transitionDelivery({
      deliveryId: delivery.deliveryId,
      expectedState: delivery.state,
      expectedVersion: delivery.version,
      nextState,
      ...(nextState === DeliveryState.SUBMITTED
        ? {
            providerReceipt: providerReceiptForSession(
              store,
              "codex-session-01",
              "turn-transition-chain",
            ),
          }
        : {}),
      updatedAt: T3,
    });
  }
  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.RELAYED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.RELAYED,
    updatedAt: T4,
  }), (error) => error.code === "INVALID_DELIVERY_TRANSITION");
  store.close();
});

test("FAILED delivery retries only through explicit PENDING and stops at frozen limit", (t) => {
  const { filename, store, run } = openStore(t);
  saveQueuedInitialInput(store, run);
  let delivery;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    delivery = store.claimNextPendingDelivery({ claimedAt: T1 });
    assert.equal(delivery.attemptCount, attempt);
    delivery = store.transitionDelivery({
      deliveryId: delivery.deliveryId,
      expectedState: DeliveryState.DISPATCHING,
      expectedVersion: delivery.version,
      nextState: DeliveryState.FAILED,
      error: { code: "TRANSPORT_FAILURE" },
      updatedAt: T2,
    });
    if (attempt < 3) {
      delivery = store.transitionDelivery({
        deliveryId: delivery.deliveryId,
        expectedState: DeliveryState.FAILED,
        expectedVersion: delivery.version,
        nextState: DeliveryState.PENDING,
        updatedAt: T3,
      });
    }
  }
  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.FAILED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.PENDING,
    updatedAt: T4,
  }), (error) => error.code === "RUN_LIMIT_EXCEEDED");
  store.close();

  const reopened = new SqliteStore(filename);
  const findings = scanStartupRecovery(reopened);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons, [{
    type: "DELIVERY_ATTEMPTS_EXHAUSTED",
    deliveryId: delivery.deliveryId,
    inputId: delivery.inputId,
    attemptCount: 3,
    maxDeliveryAttempts: 3,
  }]);
  reopened.close();
});

test("a retryable FAILED delivery remains failed and visible to startup recovery after reopen", (t) => {
  const { filename, store, run } = openStore(t);
  saveQueuedInitialInput(store, run);
  let delivery = store.claimNextPendingDelivery({ claimedAt: T1 });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: delivery.version,
    nextState: DeliveryState.FAILED,
    error: { code: "PRE_SUBMISSION_CONNECTION_FAILURE", retrySafe: true },
    updatedAt: T2,
  });
  store.close();

  const reopened = new SqliteStore(filename);
  assert.equal(reopened.getDelivery(delivery.deliveryId).state, DeliveryState.FAILED);
  assert.equal(reopened.claimNextPendingDelivery({ claimedAt: T3 }), null);
  const findings = scanStartupRecovery(reopened);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons, [{
    type: "DELIVERY_FAILED_RETRYABLE",
    deliveryId: delivery.deliveryId,
    inputId: delivery.inputId,
    attemptCount: 1,
    maxDeliveryAttempts: 3,
  }]);
  reopened.close();
});

test("startup integrity verification detects AgentMessage metadata tampering", (t) => {
  const { filename, store, run } = openStore(t);
  const input = makeTurnInput(run);
  saveQueuedInitialInput(store, run);
  const message = makeMessage(run);
  store.saveAgentMessage({ inputId: input.inputId, message });
  store.close();

  const database = new DatabaseSync(filename);
  database.prepare("UPDATE agent_messages SET actor = ? WHERE message_id = ?")
    .run(AgentActor.CHATGPT_WEB_AGENT, message.messageId);
  database.close();
  assert.throws(
    () => new SqliteStore(filename),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE"
      && /metadata does not match/u.test(error.message),
  );
});
