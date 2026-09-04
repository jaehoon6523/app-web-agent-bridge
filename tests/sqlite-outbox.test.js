import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../src/domain/canonical-json.js";
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
import {
  DeliveryState,
  DeliveryTransitionError,
  OptimisticConcurrencyError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";

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
  saveInput(store, makeTurnInput(run));
  const claimed = store.claimNextPendingDelivery({ claimedAt: T1 });
  assert.equal(claimed.state, DeliveryState.DISPATCHING);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(store.claimNextPendingDelivery({ claimedAt: T1 }), null);
  const submitted = store.transitionDelivery({
    deliveryId: claimed.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: claimed.version,
    nextState: DeliveryState.SUBMITTED,
    providerReceipt: { externalTurnId: "turn-01" },
    updatedAt: T2,
  });
  assert.equal(submitted.state, DeliveryState.SUBMITTED);
  store.close();

  const reopened = new SqliteStore(filename);
  assert.deepEqual(reopened.listDispatchableDeliveries(), []);
  assert.equal(reopened.claimNextPendingDelivery({ claimedAt: T3 }), null);
  reopened.close();
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
  const { store, run } = openStore(t);
  saveInput(store, makeTurnInput(run));
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
});

test("startup integrity verification detects AgentMessage metadata tampering", (t) => {
  const { filename, store, run } = openStore(t);
  const input = makeTurnInput(run);
  saveInput(store, input);
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
