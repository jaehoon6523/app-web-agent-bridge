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
import {
  setRunBlocker,
  transitionRunState,
} from "../src/domain/run-state-machine.js";
import {
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  HumanGateReason,
  RunBlockerType,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import { RunService } from "../src/orchestration/run-service.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";

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
    providerReceipt: { externalTurnId: "external-blocked" },
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

test("runtime approval BLOCKED creates one durable approval and no peer delivery", (t) => {
  const context = fixture(t, "run-runtime-approval");
  const result = recordBlocked(context, HumanGateReason.RUNTIME_APPROVAL_REQUIRED);

  assert.equal(result.run.phase, RunPhase.HUMAN_GATE);
  assert.equal(result.run.blocker.type, RunBlockerType.RUNTIME_APPROVAL);
  assert.equal(result.delivery.state, DeliveryState.RESPONSE_COMPLETED);
  assert.equal(result.nextDelivery, null);
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 1);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 1);
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 1);
  const approvals = context.store.listApprovals({ runId: context.run.runId });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, result.run.blocker.approvalId);
  assert.equal(approvals[0].status, "PENDING");
  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: result.run.version,
  }), null);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(reopened.verifyControlSideRecordLinks(), {
    valid: true,
    sideRecords: 1,
  });
  reopened.close();
});

test("policy violation BLOCKED terminates through one exact RUN_COMPLETED outcome", (t) => {
  const context = fixture(t, "run-policy-violation");
  const result = recordBlocked(context, HumanGateReason.POLICY_VIOLATION);

  assert.equal(result.run.phase, RunPhase.FAILED);
  assert.equal(result.run.blocker, null);
  assert.equal(result.outcome.outcome.type, "FAILED");
  assert.equal(result.outcome.outcome.errorCode, HumanGateReason.POLICY_VIOLATION);
  assert.equal(result.nextDelivery, null);
  assert.equal(
    context.store.listDomainEvents(context.run.runId).at(-1).eventType,
    "RUN_COMPLETED",
  );
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.equal(reopened.getRun(context.run.runId).phase, RunPhase.FAILED);
  assert.equal(reopened.getRunOutcome(context.run.runId).outcomeHash, result.outcome.outcomeHash);
  reopened.close();
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
  const result = recordBlocked(context, HumanGateReason.POLICY_VIOLATION);

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
    () => recordBlocked(context, HumanGateReason.PRODUCT_DECISION_REQUIRED),
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

test("recovery ambiguity BLOCKED creates one recovery operation and no peer delivery", (t) => {
  const context = fixture(t, "run-recovery-gate");
  const result = recordBlocked(context, HumanGateReason.RECOVERY_AMBIGUOUS);

  assert.equal(result.run.phase, RunPhase.RECOVERY_REQUIRED);
  assert.equal(result.run.blocker.type, RunBlockerType.RECOVERY_CONFIRMATION);
  assert.equal(result.nextDelivery, null);
  const operations = context.store.listRecoveryOperations({ runId: context.run.runId });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operationId, result.run.blocker.operationId);
  assert.equal(operations[0].status, "PENDING");
  assert.deepEqual(context.store.verifyEventChains(context.run.runId).valid, true);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const findings = scanStartupRecovery(reopened);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].runId, context.run.runId);
  assert.deepEqual(findings[0].reasons, [{
    type: "RECOVERY_OPERATION_PENDING",
    operationId: result.run.blocker.operationId,
    detailsHash: operations[0].detailsHash,
  }]);
  reopened.close();
});

test("startup rejects coherently forged approval scope and scope hash", (t) => {
  const context = fixture(t, "run-forged-approval");
  recordBlocked(context, HumanGateReason.RUNTIME_APPROVAL_REQUIRED);
  context.store.close();

  const database = new DatabaseSync(context.filename);
  const row = database.prepare("SELECT approval_json FROM approvals").get();
  const forged = JSON.parse(row.approval_json);
  forged.scope = { ...forged.scope, requiredDecisions: ["Forged decision"] };
  forged.scopeHash = sha256CanonicalJson(forged.scope);
  database.prepare("UPDATE approvals SET approval_json = ?").run(canonicalJson(forged));
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /does not match its creation evidence/u,
  );
});

test("startup rejects coherently forged recovery details and details hash", (t) => {
  const context = fixture(t, "run-forged-recovery");
  recordBlocked(context, HumanGateReason.RECOVERY_AMBIGUOUS);
  context.store.close();

  const database = new DatabaseSync(context.filename);
  const row = database.prepare("SELECT operation_json FROM recovery_operations").get();
  const forged = JSON.parse(row.operation_json);
  forged.details = { ...forged.details, requiredDecisions: ["Forged recovery"] };
  forged.detailsHash = sha256CanonicalJson(forged.details);
  database.prepare("UPDATE recovery_operations SET operation_json = ?").run(
    canonicalJson(forged),
  );
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /does not match its creation evidence/u,
  );
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
  const contentPacket = blockedPacket(HumanGateReason.PRODUCT_DECISION_REQUIRED);
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

test("a late BLOCKED event failure rolls its approval and response transaction back", (t) => {
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
    () => recordBlocked(context, HumanGateReason.RUNTIME_APPROVAL_REQUIRED),
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
