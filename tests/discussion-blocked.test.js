import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../src/domain/canonical-json.js";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import { calculateDomainEventHash } from "../src/persistence/event-chain.js";
import {
  setRunBlocker,
  transitionRunState,
} from "../src/domain/run-state-machine.js";
import {
  AgentBlockedReason,
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  OperationalBlockerReason,
  RunBlockerType,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import { RunService } from "../src/orchestration/run-service.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";
import { providerReceiptForSession } from "./support/discussion-provider-receipt.js";

const T0 = "2026-09-04T06:00:00.000Z";

function fixture(t, runId) {
  const directory = mkdtempSync(join(tmpdir(), "discussion-blocked-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  let id = 0;
  let tick = 0;
  const idFactory = () => String(++id).padStart(4, "0");
  const clock = () => `2026-09-04T06:00:${String(tick++).padStart(2, "0")}.000Z`;
  const service = new RunService({ store, idFactory, clock });
  const created = service.createRun({
    runId,
    objective: "Stop safely when an Agent reports a Controller-owned gate",
    policy: createDiscussionRunPolicy(),
  });
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const codex = actor === AgentActor.CODEX_AGENT;
    store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId: codex ? `${runId}-codex` : `${runId}-web`,
        runId,
        actor,
        provider: codex ? SessionProvider.CODEX_APP_SERVER : SessionProvider.CHATGPT_WEB,
        externalSessionId: codex ? "thread-codex" : "conversation-web",
        externalLocator: codex ? null : "https://chatgpt.com/c/conversation-web",
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
  const controller = new DiscussionController({ store, idFactory, clock });
  const started = controller.start({ runId, expectedVersion: created.version });
  const claimed = controller.claimNext({
    runId,
    expectedRunVersion: started.run.version,
  });
  const submitted = controller.markSubmitted({
    runId,
    expectedRunVersion: started.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: providerReceiptForSession(
      store,
      `${runId}-codex`,
      "external-blocked",
    ),
  });
  return {
    controller,
    filename,
    service,
    store,
    run: submitted.run,
    delivery: submitted.delivery,
  };
}

function blockedPacket(reasonCode) {
  return {
    type: AgentPacketType.BLOCKED,
    reason_code: reasonCode,
    description: `Controller handling is required for ${reasonCode}.`,
    required_decisions: ["Resolve the exact Controller gate."],
  };
}

function recordBlocked(context, reasonCode) {
  const packet = blockedPacket(reasonCode);
  return context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: context.delivery.deliveryId,
    expectedDeliveryVersion: context.delivery.version,
    sessionId: `${context.run.runId}-codex`,
    turnId: "external-blocked",
    content: `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`,
    packet,
  });
}

function forgeLastEvent(filename, sourceEventType, mutatePayload, replacementEventType = null) {
  const database = new DatabaseSync(filename);
  const row = database.prepare(`
    SELECT run_id, sequence, event_id, event_type, payload_json,
           previous_hash, created_at
    FROM domain_events
    WHERE event_type = ?
    ORDER BY sequence DESC LIMIT 1
  `).get(sourceEventType);
  const payload = JSON.parse(row.payload_json);
  mutatePayload(payload);
  const eventType = replacementEventType ?? row.event_type;
  const payloadJson = canonicalJson(payload);
  const eventHash = calculateDomainEventHash(row.previous_hash, {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    runId: row.run_id,
    eventType,
    payload,
    createdAt: row.created_at,
  });
  database.prepare(`
    UPDATE domain_events SET event_type = ?, payload_json = ?, event_hash = ?
    WHERE run_id = ? AND sequence = ?
  `).run(eventType, payloadJson, eventHash, row.run_id, row.sequence);
  database.prepare(`
    UPDATE runs SET run_json = ?, last_event_hash = ? WHERE run_id = ?
  `).run(canonicalJson(payload.run), eventHash, row.run_id);
  database.prepare(`
    UPDATE run_projections
    SET projection_json = ?, last_event_hash = ? WHERE run_id = ?
  `).run(canonicalJson(payload.run), eventHash, row.run_id);
  database.close();
}

function forgeLastBlockedEvent(filename, mutatePayload) {
  forgeLastEvent(filename, "AGENT_RESPONSE_BLOCKED", mutatePayload);
}

function forgeBlockedResponseHistoryAsHeldSessionAuth(filename) {
  const database = new DatabaseSync(filename);
  const storedRow = database.prepare(`
    SELECT run_id, sequence, event_id, event_type, payload_json,
           previous_hash, created_at
    FROM domain_events
    WHERE event_type = 'AGENT_RESPONSE_STORED'
    ORDER BY sequence DESC LIMIT 1
  `).get();
  const finalRow = database.prepare(`
    SELECT run_id, sequence, event_id, event_type, payload_json,
           previous_hash, created_at
    FROM domain_events
    WHERE event_type = 'AGENT_RESPONSE_BLOCKED'
    ORDER BY sequence DESC LIMIT 1
  `).get();
  const precedingRow = database.prepare(`
    SELECT run_id, sequence, event_id, event_type, payload_json,
           previous_hash, created_at
    FROM domain_events
    WHERE run_id = ? AND sequence < ?
    ORDER BY sequence DESC LIMIT 1
  `).get(storedRow.run_id, storedRow.sequence);
  const blocker = {
    type: RunBlockerType.SESSION_AUTH,
    actor: AgentActor.CODEX_AGENT,
  };
  const precedingPayload = JSON.parse(precedingRow.payload_json);
  precedingPayload.run.blocker = blocker;
  const precedingPayloadJson = canonicalJson(precedingPayload);
  const precedingHash = calculateDomainEventHash(precedingRow.previous_hash, {
    sequence: Number(precedingRow.sequence),
    eventId: precedingRow.event_id,
    runId: precedingRow.run_id,
    eventType: precedingRow.event_type,
    payload: precedingPayload,
    createdAt: precedingRow.created_at,
  });
  database.prepare(`
    UPDATE domain_events SET payload_json = ?, event_hash = ?
    WHERE run_id = ? AND sequence = ?
  `).run(
    precedingPayloadJson,
    precedingHash,
    precedingRow.run_id,
    precedingRow.sequence,
  );

  const storedPayload = JSON.parse(storedRow.payload_json);
  storedPayload.run.blocker = blocker;
  storedPayload.details.disposition = "HELD";
  const storedPayloadJson = canonicalJson(storedPayload);
  const storedHash = calculateDomainEventHash(precedingHash, {
    sequence: Number(storedRow.sequence),
    eventId: storedRow.event_id,
    runId: storedRow.run_id,
    eventType: storedRow.event_type,
    payload: storedPayload,
    createdAt: storedRow.created_at,
  });
  database.prepare(`
    UPDATE domain_events SET payload_json = ?, previous_hash = ?, event_hash = ?
    WHERE run_id = ? AND sequence = ?
  `).run(
    storedPayloadJson,
    precedingHash,
    storedHash,
    storedRow.run_id,
    storedRow.sequence,
  );

  const finalPayload = JSON.parse(finalRow.payload_json);
  finalPayload.run.blocker = blocker;
  finalPayload.details = {
    messageId: finalPayload.details.messageId,
    plannedDisposition: "BLOCKED",
    blocker,
  };
  const finalEventType = "AGENT_RESPONSE_HELD_FOR_BLOCKER";
  const finalPayloadJson = canonicalJson(finalPayload);
  const finalHash = calculateDomainEventHash(storedHash, {
    sequence: Number(finalRow.sequence),
    eventId: finalRow.event_id,
    runId: finalRow.run_id,
    eventType: finalEventType,
    payload: finalPayload,
    createdAt: finalRow.created_at,
  });
  database.prepare(`
    UPDATE domain_events
    SET event_type = ?, payload_json = ?, previous_hash = ?, event_hash = ?
    WHERE run_id = ? AND sequence = ?
  `).run(
    finalEventType,
    finalPayloadJson,
    storedHash,
    finalHash,
    finalRow.run_id,
    finalRow.sequence,
  );
  database.prepare(`
    UPDATE runs SET run_json = ?, last_event_hash = ? WHERE run_id = ?
  `).run(canonicalJson(finalPayload.run), finalHash, finalRow.run_id);
  database.prepare(`
    UPDATE run_projections
    SET projection_json = ?, last_event_hash = ? WHERE run_id = ?
  `).run(canonicalJson(finalPayload.run), finalHash, finalRow.run_id);
  database.close();
}

test("Agent BLOCKED reasons create only a user-decision gate", (t) => {
  for (const [index, reasonCode] of Object.values(AgentBlockedReason).entries()) {
    const context = fixture(t, `run-agent-blocked-${index}`);
    const result = recordBlocked(context, reasonCode);

    assert.equal(result.run.phase, RunPhase.HUMAN_GATE);
    assert.equal(result.run.blocker.type, RunBlockerType.USER_DECISION);
    assert.equal(result.delivery.state, DeliveryState.RESPONSE_COMPLETED);
    assert.equal(result.nextDelivery, null);
    assert.equal(result.outcome, null);
    assert.equal(context.store.listAgentMessages(context.run.runId).length, 1);
    assert.equal(context.store.listAgentPackets(context.run.runId).length, 1);
    assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 1);
    assert.equal(context.store.listApprovals({ runId: context.run.runId }).length, 0);
    assert.equal(context.store.listRecoveryOperations({ runId: context.run.runId }).length, 0);
    assert.equal(
      context.store.listDomainEvents(context.run.runId).at(-1).eventType,
      "AGENT_RESPONSE_BLOCKED",
    );
    context.store.close();

    const reopened = new SqliteStore(context.filename);
    assert.deepEqual(reopened.verifyControlSideRecordLinks(), {
      valid: true,
      sideRecords: 0,
    });
    assert.equal(reopened.getRunOutcome(context.run.runId), null);
    reopened.close();
  }
});

test("Agent operational claims are rejected without canonical state mutation", (t) => {
  const claims = [...Object.values(OperationalBlockerReason), "POLICY_VIOLATION"];
  for (const [index, reasonCode] of claims.entries()) {
    const context = fixture(t, `run-rejected-operational-claim-${index}`);
    const before = {
      run: context.store.getRun(context.run.runId),
      delivery: context.store.getDelivery(context.delivery.deliveryId),
      sessions: context.store.listAgentSessions(context.run.runId),
      events: context.store.listDomainEvents(context.run.runId),
    };

    assert.throws(
      () => recordBlocked(context, reasonCode),
      (error) => error.code === "INVALID_AGENT_PACKET",
    );
    assert.deepEqual(context.store.getRun(context.run.runId), before.run);
    assert.deepEqual(context.store.getDelivery(context.delivery.deliveryId), before.delivery);
    assert.deepEqual(context.store.listAgentSessions(context.run.runId), before.sessions);
    assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
    assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
    assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);
    assert.equal(context.store.listApprovals({ runId: context.run.runId }).length, 0);
    assert.equal(context.store.listRecoveryOperations({ runId: context.run.runId }).length, 0);
    assert.equal(context.store.getRunOutcome(context.run.runId), null);
    context.store.close();
  }
});

test("startup rejects an Agent BLOCKED event forged into a session-auth fact", (t) => {
  const context = fixture(t, "run-forged-agent-auth");
  recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  context.store.close();

  forgeLastBlockedEvent(context.filename, (payload) => {
    payload.run.blocker = {
      type: RunBlockerType.SESSION_AUTH,
      actor: AgentActor.CODEX_AGENT,
    };
    payload.details.blocker = payload.run.blocker;
  });

  assert.throws(
    () => new SqliteStore(context.filename),
    /Agent BLOCKED must create only a user-decision blocker/u,
  );
});

test("startup binds each BLOCKED response to its exact finalization event type", (t) => {
  for (const replacementEventType of [
    "AGENT_RESPONSE_HELD_FOR_BLOCKER",
    "FORGED_AGENT_RESPONSE_FINALIZATION",
  ]) {
    const context = fixture(
      t,
      `run-forged-agent-finalization-${replacementEventType.toLowerCase()}`,
    );
    recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
    context.store.close();

    forgeLastEvent(
      context.filename,
      "AGENT_RESPONSE_BLOCKED",
      (payload) => {
        if (replacementEventType === "AGENT_RESPONSE_HELD_FOR_BLOCKER") {
          payload.run.blocker = {
            type: RunBlockerType.SESSION_AUTH,
            actor: AgentActor.CODEX_AGENT,
          };
          payload.details = {
            messageId: payload.details.messageId,
            plannedDisposition: "BLOCKED",
            blocker: payload.run.blocker,
          };
        }
      },
      replacementEventType,
    );

    assert.throws(
      () => new SqliteStore(context.filename),
      /does not match its stored response disposition|has no exact AGENT_RESPONSE_BLOCKED/u,
    );
  }
});

test("startup requires Controller-owned evidence for a held operational blocker", (t) => {
  const context = fixture(t, "run-forged-held-history");
  recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  context.store.close();

  forgeBlockedResponseHistoryAsHeldSessionAuth(context.filename);

  assert.throws(
    () => new SqliteStore(context.filename),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE"
      && /held blocker has no Controller-owned creation evidence/u.test(
        `${error.message} ${error.cause?.message ?? ""}`,
      ),
  );
});

test("startup rejects Agent BLOCKED decision ids forged away from their message", (t) => {
  const context = fixture(t, "run-forged-agent-decisions");
  recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  context.store.close();

  forgeLastBlockedEvent(context.filename, (payload) => {
    payload.run.blocker.decisionIds = ["decision_forged"];
    payload.details.blocker = payload.run.blocker;
  });

  assert.throws(
    () => new SqliteStore(context.filename),
    /Agent BLOCKED decision ids do not match their message evidence/u,
  );
});

test("startup rejects an operational side record forged onto Agent BLOCKED", (t) => {
  const context = fixture(t, "run-forged-agent-side-record");
  recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  context.store.close();

  forgeLastBlockedEvent(context.filename, (payload) => {
    payload.details.sideRecord = {
      type: "APPROVAL",
      id: "approval-forged",
      hash: null,
    };
  });

  assert.throws(
    () => new SqliteStore(context.filename),
    /Agent BLOCKED must not declare an operational side record/u,
  );
});

test("an existing approval blocker holds a later BLOCKED response without being replaced", (t) => {
  const context = fixture(t, "run-blocker-collision");
  const requested = context.service.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId: "approval-existing",
    scope: { operationId: "operation-existing" },
  });
  context.run = requested.run;
  const result = recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);

  assert.equal(result.run.phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(result.run.blocker, requested.run.blocker);
  assert.equal(result.nextDelivery, null);
  assert.equal(result.outcome, null);
  assert.equal(context.store.getRunOutcome(context.run.runId), null);
  assert.equal(context.store.listApprovals({ runId: context.run.runId }).length, 1);
  assert.equal(
    context.store.listDomainEvents(context.run.runId).at(-1).eventType,
    "AGENT_RESPONSE_HELD_FOR_BLOCKER",
  );
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const finding = scanStartupRecovery(reopened)[0];
  assert.equal(finding.phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(finding.reasons.map((item) => item.type), ["APPROVAL_PENDING"]);
  reopened.close();
});

test("startup rejects a held Agent response that changes its pre-existing blocker", (t) => {
  const context = fixture(t, "run-forged-held-blocker");
  const requested = context.service.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId: "approval-held-forged",
    scope: { operationId: "operation-held-forged" },
  });
  context.run = requested.run;
  recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  context.store.close();

  forgeLastEvent(
    context.filename,
    "AGENT_RESPONSE_HELD_FOR_BLOCKER",
    (payload) => {
      payload.run.blocker = {
        type: RunBlockerType.SESSION_AUTH,
        actor: AgentActor.CODEX_AGENT,
      };
      payload.details.blocker = payload.run.blocker;
    },
  );

  assert.throws(
    () => new SqliteStore(context.filename),
    /held response changed its pre-existing blocker/u,
  );
});

test("a held-response event failure rolls back the response and preserves the existing approval", (t) => {
  const context = fixture(t, "run-held-rollback");
  const requested = context.service.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId: "approval-held-rollback",
    scope: { operationId: "operation-held-rollback" },
  });
  context.run = requested.run;
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(context.delivery.deliveryId),
    events: context.store.listDomainEvents(context.run.runId),
  };
  const database = new DatabaseSync(context.filename);
  database.exec(`
    CREATE TRIGGER reject_held_event_for_atomicity_test
    BEFORE INSERT ON domain_events
    WHEN NEW.event_type = 'AGENT_RESPONSE_HELD_FOR_BLOCKER'
    BEGIN
      SELECT RAISE(ABORT, 'injected held response event failure');
    END;
  `);
  database.close();

  assert.throws(
    () => recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED),
    /injected held response event failure/u,
  );
  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(context.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);
  assert.equal(context.store.listApprovals({ runId: context.run.runId }).length, 1);
  context.store.close();
});

test("startup rejects a coherently forged RunService approval scope", (t) => {
  const context = fixture(t, "run-forged-service-approval");
  context.service.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId: "approval-service-forged",
    scope: { operationId: "operation-original" },
  });
  context.store.close();

  const database = new DatabaseSync(context.filename);
  const row = database.prepare(`
    SELECT approval_json FROM approvals WHERE approval_id = ?
  `).get("approval-service-forged");
  const forged = JSON.parse(row.approval_json);
  forged.scope = { operationId: "operation-forged" };
  forged.scopeHash = sha256CanonicalJson(forged.scope);
  database.prepare(`
    UPDATE approvals SET approval_json = ? WHERE approval_id = ?
  `).run(canonicalJson(forged), "approval-service-forged");
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /does not match its creation evidence/u,
  );
});

test("startup rejects a runtime approval blocker without its pending side record", (t) => {
  const context = fixture(t, "run-missing-approval-record");
  const forged = setRunBlocker(context.run, {
    expectedVersion: context.run.version,
    blocker: {
      type: RunBlockerType.RUNTIME_APPROVAL,
      approvalId: "approval-missing",
    },
    updatedAt: T0,
  });
  context.store.appendEventAndUpdateProjection({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    eventId: "event-forged-approval-blocker",
    eventType: "FORGED_APPROVAL_BLOCKER_FOR_INTEGRITY_TEST",
    payload: { run: forged, details: {} },
    createdAt: T0,
    nextRun: forged,
  });
  context.store.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /active runtime approval blocker has no exact pending side record/u,
  );
});

test("startup rejects a recovery blocker without its pending side record", (t) => {
  const context = fixture(t, "run-missing-recovery-record");
  const forged = transitionRunState(context.run, {
    to: RunPhase.RECOVERY_REQUIRED,
    blocker: {
      type: RunBlockerType.RECOVERY_CONFIRMATION,
      operationId: "recovery-missing",
    },
    expectedVersion: context.run.version,
    updatedAt: T0,
  });
  context.store.appendEventAndUpdateProjection({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    eventId: "event-forged-recovery-blocker",
    eventType: "FORGED_RECOVERY_BLOCKER_FOR_INTEGRITY_TEST",
    payload: { run: forged, details: {} },
    createdAt: T0,
    nextRun: forged,
  });
  context.store.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /active recovery confirmation blocker has no exact pending side record/u,
  );
});

test("response content cannot be routed using a different caller-supplied packet", (t) => {
  const context = fixture(t, "run-content-packet-binding");
  const beforeRun = context.store.getRun(context.run.runId);
  const beforeDelivery = context.store.getDelivery(context.delivery.deliveryId);
  const contentPacket = blockedPacket(AgentBlockedReason.PRODUCT_DECISION_REQUIRED);
  const assertedPacket = {
    type: AgentPacketType.PROPOSAL,
    summary: "Fabricated proposal",
    body: "This must not replace the BLOCKED packet present in the response content.",
    assumptions: [],
    open_decisions: [],
  };

  assert.throws(() => context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: context.delivery.deliveryId,
    expectedDeliveryVersion: context.delivery.version,
    sessionId: `${context.run.runId}-codex`,
    turnId: "external-blocked",
    content: `<controller_packet>\n${canonicalJson(contentPacket)}\n</controller_packet>`,
    packet: assertedPacket,
  }), (error) => error.code === "AGENT_RESPONSE_PACKET_CONTENT_MISMATCH");

  assert.deepEqual(context.store.getRun(context.run.runId), beforeRun);
  assert.deepEqual(context.store.getDelivery(context.delivery.deliveryId), beforeDelivery);
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);
  assert.equal(context.store.listProposalArtifacts(context.run.runId).length, 0);
  context.store.close();
});

test("a late BLOCKED event failure rolls the response transaction back", (t) => {
  const context = fixture(t, "run-blocked-rollback");
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(context.delivery.deliveryId),
    limits: context.store.getRunLimits(context.run.runId),
    events: context.store.listDomainEvents(context.run.runId),
  };
  const database = new DatabaseSync(context.filename);
  database.exec(`
    CREATE TRIGGER reject_blocked_event_for_atomicity_test
    BEFORE INSERT ON domain_events
    WHEN NEW.event_type = 'AGENT_RESPONSE_BLOCKED'
    BEGIN
      SELECT RAISE(ABORT, 'injected blocked event failure');
    END;
  `);
  database.close();

  assert.throws(
    () => recordBlocked(context, AgentBlockedReason.PRODUCT_DECISION_REQUIRED),
    /injected blocked event failure/u,
  );
  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(context.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.getRunLimits(context.run.runId), before.limits);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);
  assert.equal(context.store.listApprovals({ runId: context.run.runId }).length, 0);
  context.store.close();
});
