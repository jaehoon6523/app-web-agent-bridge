import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  createAgentRun,
  createAgentSessionRecord,
  createRelayMessage,
} from "../src/domain/contracts.js";
import {
  AgentActor,
  AgentSessionStatus,
  RelayMessageKind,
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

function makeMessage(run, sequence, messageId, fromActor = AgentActor.CODEX_AGENT) {
  const toActor = fromActor === AgentActor.CODEX_AGENT
    ? AgentActor.CHATGPT_WEB_AGENT
    : AgentActor.CODEX_AGENT;
  const packet = {
    type: "PROPOSAL",
    proposal_id: `proposal-${sequence}`,
    proposal_sha256: sha256Text(`proposal-${sequence}`),
    summary: `Proposal ${sequence}`,
    body: `proposal ${sequence}`,
    assumptions: [],
    open_decisions: [],
  };
  return createRelayMessage({
    messageId,
    runId: run.runId,
    sequence,
    fromActor,
    toActor,
    sourceSessionId: fromActor === AgentActor.CODEX_AGENT
      ? "codex-session-01"
      : "web-session-01",
    sourceTurnId: null,
    inReplyTo: null,
    kind: RelayMessageKind.PROPOSAL,
    content: `proposal ${sequence}`,
    normalizedPacket: packet,
    objectiveHash: run.objectiveHash,
    policyHash: run.policyHash,
    createdAt: T0,
  });
}

function tempDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-outbox-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return filename;
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
  store.createAgentSession({
    session: createAgentSessionRecord({
      sessionId: "codex-session-01",
      runId: run.runId,
      actor: AgentActor.CODEX_AGENT,
      provider: SessionProvider.CODEX_APP_SERVER,
      externalSessionId: "thread-01",
      externalLocator: null,
      status: AgentSessionStatus.READY,
      activeTurnId: null,
      lastCompletedTurnId: null,
      lastObservedAt: T0,
      version: 1,
    }),
    createdAt: T0,
    updatedAt: T0,
  });
  store.createAgentSession({
    session: createAgentSessionRecord({
      sessionId: "web-session-01",
      runId: run.runId,
      actor: AgentActor.CHATGPT_WEB_AGENT,
      provider: SessionProvider.CHATGPT_WEB,
      externalSessionId: "conversation-01",
      externalLocator: "https://chatgpt.com/c/conversation-01",
      status: AgentSessionStatus.READY,
      activeTurnId: null,
      lastCompletedTurnId: null,
      lastObservedAt: T0,
      version: 1,
    }),
    createdAt: T0,
    updatedAt: T0,
  });
  return { filename, store, run };
}

test("relay message and PENDING delivery are committed atomically", (t) => {
  const { store, run } = openStore(t);
  const first = makeMessage(run, 1, "message-01");
  const second = {
    ...makeMessage(run, 2, "message-02", AgentActor.CHATGPT_WEB_AGENT),
    inReplyTo: first.messageId,
  };

  const delivery = store.saveRelayMessageWithDelivery({
    message: first,
    deliveryId: "delivery-01",
    idempotencyKey: "idempotency-01",
  });
  assert.equal(delivery.state, DeliveryState.PENDING);
  assert.deepEqual(store.getRelayMessage(first.messageId), first);

  assert.throws(() => store.saveRelayMessageWithDelivery({
    message: second,
    deliveryId: "delivery-02",
    idempotencyKey: "idempotency-01",
  }), /UNIQUE constraint failed/);

  assert.equal(store.getRelayMessage(second.messageId), null);
  assert.equal(store.getDelivery("delivery-02"), null);
  assert.deepEqual(store.listRelayMessages(run.runId), [first]);
  store.close();
});

test("run event, projection, relay packet, and outbox commit as one transaction", (t) => {
  const { store, run } = openStore(t);
  const first = makeMessage(run, 1, "message-compound-01");
  const next = createAgentRun({
    ...run,
    phase: RunPhase.STARTING_SESSIONS,
    version: 2,
    updatedAt: T1,
  });
  const committed = store.appendEventProjectRelayPacketAndDelivery({
    event: {
      runId: run.runId,
      expectedVersion: run.version,
      eventId: "event-compound-01",
      eventType: "RELAY_PACKET_STORED",
      createdAt: T1,
      nextRun: next,
    },
    message: first,
    packetId: "packet-compound",
    deliveryId: "delivery-compound-01",
    idempotencyKey: "idempotency-compound-01",
  });
  assert.equal(committed.event.sequence, 2);
  assert.deepEqual(committed.message, first);
  assert.deepEqual(committed.packet.packet, first.normalizedPacket);
  assert.equal(committed.delivery.state, DeliveryState.PENDING);
  assert.deepEqual(store.getRun(run.runId), next);
  assert.equal(store.listDomainEvents(run.runId).at(-1).payload.details.relayMessage.messageId, first.messageId);

  const second = {
    ...makeMessage(next, 2, "message-compound-02", AgentActor.CHATGPT_WEB_AGENT),
    inReplyTo: first.messageId,
  };
  const thirdVersion = createAgentRun({ ...next, version: 3, updatedAt: T2 });
  assert.throws(() => store.appendEventProjectRelayPacketAndDelivery({
    event: {
      runId: run.runId,
      expectedVersion: next.version,
      eventId: "event-compound-rollback",
      eventType: "RELAY_PACKET_STORED",
      createdAt: T2,
      nextRun: thirdVersion,
    },
    message: second,
    packetId: "packet-compound",
    deliveryId: "delivery-compound-02",
    idempotencyKey: "idempotency-compound-02",
  }), /UNIQUE constraint failed/u);

  assert.deepEqual(store.getRun(run.runId), next);
  assert.equal(store.getRelayMessage(second.messageId), null);
  assert.equal(store.getDelivery("delivery-compound-02"), null);
  assert.equal(store.listDomainEvents(run.runId).length, 2);
  store.close();
});

test("startup verification detects tampering in event-linked relay rows", (t) => {
  const { filename, store, run } = openStore(t);
  const message = makeMessage(run, 1, "message-linked-tamper");
  const next = createAgentRun({
    ...run,
    phase: RunPhase.STARTING_SESSIONS,
    version: 2,
    updatedAt: T1,
  });
  store.appendEventProjectRelayPacketAndDelivery({
    event: {
      runId: run.runId,
      expectedVersion: run.version,
      eventId: "event-linked-tamper",
      eventType: "RELAY_PACKET_STORED",
      createdAt: T1,
      nextRun: next,
    },
    message,
    packetId: "packet-linked-tamper",
    deliveryId: "delivery-linked-tamper",
    idempotencyKey: "idempotency-linked-tamper",
  });
  store.close();

  const database = new DatabaseSync(filename);
  database.prepare("UPDATE relay_messages SET message_json = ? WHERE message_id = ?")
    .run("{}", message.messageId);
  database.close();
  assert.throws(
    () => new SqliteStore(filename),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE"
      && /event-linked relay message/u.test(error.message),
  );
});

test("claim is deterministic and SUBMITTED delivery is not retried after reopen", (t) => {
  const { filename, store, run } = openStore(t);
  store.saveRelayMessageWithDelivery({
    message: makeMessage(run, 1, "message-01"),
    deliveryId: "delivery-01",
    idempotencyKey: "idempotency-01",
  });

  const claimed = store.claimNextPendingDelivery({ claimedAt: T1 });
  assert.equal(claimed.state, DeliveryState.DISPATCHING);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(claimed.version, 2);
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
  assert.deepEqual(submitted.providerReceipt, { externalTurnId: "turn-01" });
  assert.deepEqual(store.listDispatchableDeliveries(), []);
  store.close();

  const reopened = new SqliteStore(filename);
  assert.equal(reopened.getDelivery("delivery-01").state, DeliveryState.SUBMITTED);
  assert.deepEqual(reopened.listDispatchableDeliveries(), []);
  assert.equal(reopened.claimNextPendingDelivery({ claimedAt: T3 }), null);
  reopened.close();
});

test("delivery transitions reject stale state, stale version, and a second relay", (t) => {
  const { store, run } = openStore(t);
  store.saveRelayMessageWithDelivery({
    message: makeMessage(run, 1, "message-01"),
    deliveryId: "delivery-01",
    idempotencyKey: "idempotency-01",
  });
  let delivery = store.claimNextPendingDelivery({ claimedAt: T1 });

  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.PENDING,
    expectedVersion: delivery.version,
    nextState: DeliveryState.DISPATCHING,
    updatedAt: T2,
  }), (error) => error instanceof DeliveryTransitionError
    && error.code === "DELIVERY_STATE_CONFLICT");

  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: 1,
    nextState: DeliveryState.SUBMITTED,
    updatedAt: T2,
  }), OptimisticConcurrencyError);

  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: delivery.version,
    nextState: DeliveryState.SUBMITTED,
    updatedAt: T2,
  });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.SUBMITTED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.RESPONSE_STARTED,
    updatedAt: T3,
  });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.RESPONSE_STARTED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.RESPONSE_COMPLETED,
    updatedAt: T4,
  });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.RESPONSE_COMPLETED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.RELAYED,
    updatedAt: T4,
  });
  assert.equal(delivery.state, DeliveryState.RELAYED);

  assert.throws(() => store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.RELAYED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.RELAYED,
    updatedAt: T4,
  }), (error) => error instanceof DeliveryTransitionError
    && error.code === "INVALID_DELIVERY_TRANSITION");
  assert.equal(store.getDelivery(delivery.deliveryId).state, DeliveryState.RELAYED);
  store.close();
});

test("FAILED delivery requires an explicit retry transition before dispatch", (t) => {
  const { store, run } = openStore(t);
  store.saveRelayMessageWithDelivery({
    message: makeMessage(run, 1, "message-01"),
    deliveryId: "delivery-01",
    idempotencyKey: "idempotency-01",
  });
  let delivery = store.claimNextPendingDelivery({ claimedAt: T1 });
  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.DISPATCHING,
    expectedVersion: delivery.version,
    nextState: DeliveryState.FAILED,
    error: { code: "TRANSPORT_FAILURE" },
    updatedAt: T2,
  });
  assert.deepEqual(store.listDispatchableDeliveries(), []);

  delivery = store.transitionDelivery({
    deliveryId: delivery.deliveryId,
    expectedState: DeliveryState.FAILED,
    expectedVersion: delivery.version,
    nextState: DeliveryState.PENDING,
    updatedAt: T3,
  });
  assert.equal(delivery.state, DeliveryState.PENDING);
  assert.equal(delivery.providerReceipt, null);
  assert.equal(delivery.error, null);
  assert.equal(store.listDispatchableDeliveries().length, 1);
  const reclaimed = store.claimNextPendingDelivery({ claimedAt: T4 });
  assert.equal(reclaimed.attemptCount, 2);
  store.close();
});

test("an exhausted delivery stays FAILED and cannot starve a later outbox item", (t) => {
  const { store, run } = openStore(t);
  store.saveRelayMessageWithDelivery({
    message: makeMessage(run, 1, "message-limit"),
    deliveryId: "delivery-limit",
    idempotencyKey: "idempotency-limit",
  });

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

  assert.throws(
    () => store.transitionDelivery({
      deliveryId: delivery.deliveryId,
      expectedState: DeliveryState.FAILED,
      expectedVersion: delivery.version,
      nextState: DeliveryState.PENDING,
      updatedAt: T4,
    }),
    (error) => error.code === "RUN_LIMIT_EXCEEDED"
      && error.limitName === "maxDeliveryAttempts",
  );
  assert.equal(store.getDelivery("delivery-limit").state, DeliveryState.FAILED);
  assert.equal(store.getDelivery("delivery-limit").attemptCount, 3);

  const nextMessage = {
    ...makeMessage(run, 2, "message-after-limit", AgentActor.CHATGPT_WEB_AGENT),
    inReplyTo: "message-limit",
  };
  store.saveRelayMessageWithDelivery({
    message: nextMessage,
    deliveryId: "delivery-after-limit",
    idempotencyKey: "idempotency-after-limit",
  });
  assert.equal(store.claimNextPendingDelivery({ claimedAt: T4 }).deliveryId, "delivery-after-limit");
  store.close();
});

test("relay persistence verifies run, source session, sequence, reply, and row metadata", (t) => {
  const { filename, store, run } = openStore(t);
  const first = makeMessage(run, 1, "message-01");
  store.saveRelayMessageWithDelivery({
    message: first,
    deliveryId: "delivery-01",
    idempotencyKey: "idempotency-01",
  });

  assert.throws(() => store.saveRelayMessageWithDelivery({
    message: { ...makeMessage(run, 3, "message-gap"), sourceSessionId: "missing-session" },
    deliveryId: "delivery-gap",
    idempotencyKey: "idempotency-gap",
  }), (error) => error.code === "SOURCE_SESSION_NOT_FOUND");
  assert.throws(() => store.saveRelayMessageWithDelivery({
    message: makeMessage(run, 3, "message-gap"),
    deliveryId: "delivery-gap",
    idempotencyKey: "idempotency-gap",
  }), (error) => error.code === "RELAY_SEQUENCE_MISMATCH");

  const second = {
    ...makeMessage(run, 2, "message-02", AgentActor.CHATGPT_WEB_AGENT),
    inReplyTo: first.messageId,
  };
  store.saveRelayMessageWithDelivery({
    message: second,
    deliveryId: "delivery-02",
    idempotencyKey: "idempotency-02",
  });
  store.close();

  const database = new DatabaseSync(filename);
  database.prepare("UPDATE relay_messages SET from_actor = ? WHERE message_id = ?")
    .run(AgentActor.CHATGPT_WEB_AGENT, first.messageId);
  database.close();
  const reopened = new SqliteStore(filename);
  assert.throws(
    () => reopened.getRelayMessage(first.messageId),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE",
  );
  reopened.close();
});
