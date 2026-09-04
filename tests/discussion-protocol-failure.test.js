import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentPacketParserStage } from "../src/domain/agent-packet-rejection.js";
import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../src/domain/canonical-json.js";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunOutcomeType,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import {
  AGENT_PROTOCOL_REPAIR_EXHAUSTED,
  ProtocolFailureDecisionStatus,
} from "../src/orchestration/protocol-failure.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import {
  DISCUSSION_RUNTIME_EVIDENCE_SCHEMA,
  buildDiscussionRuntimeEvidence,
} from "../src/orchestration/discussion-runtime-evidence.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import { RunService } from "../src/orchestration/run-service.js";
import { calculateDomainEventHash } from "../src/persistence/event-chain.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";
import { providerReceiptForSession } from "./support/discussion-provider-receipt.js";

const T0 = "2026-09-04T05:00:00.000Z";

function fixture(t, maxTurns = 12) {
  const directory = mkdtempSync(join(tmpdir(), "discussion-repair-"));
  const filename = join(directory, "controller.sqlite");
  const artifactStore = new ArtifactStore(join(directory, "artifacts"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  let id = 0;
  let tick = 0;
  const idFactory = () => String(++id).padStart(4, "0");
  const clock = () => `2026-09-04T05:00:${String(tick++).padStart(2, "0")}.000Z`;
  const runService = new RunService({ store, idFactory, clock });
  const created = runService.createRun({
    runId: "run-protocol-repair",
    objective: "Recover one malformed Agent packet without peer relay",
    policy: createDiscussionRunPolicy({ maxTurns }),
  });
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const codex = actor === AgentActor.CODEX_AGENT;
    store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId: codex ? "session-codex" : "session-web",
        runId: created.runId,
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
  const controller = new DiscussionController({ store, idFactory, clock, artifactStore });
  const started = controller.start({ runId: created.runId, expectedVersion: created.version });
  return {
    controller,
    artifactStore,
    filename,
    runService,
    store,
    run: started.run,
  };
}

function claimAndSubmit(context, number) {
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  assert(claimed);
  const input = context.store.getAgentTurnInput(claimed.inputId);
  const sessionId = input.targetActor === AgentActor.CODEX_AGENT
    ? "session-codex"
    : "session-web";
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: providerReceiptForSession(
      context.store,
      sessionId,
      `external-${number}`,
    ),
  });
  context.run = submitted.run;
  return { ...submitted, input };
}

function reject(context, submitted, number, observedCandidatePacketType = undefined) {
  const sessionId = submitted.input.targetActor === AgentActor.CODEX_AGENT
    ? "session-codex"
    : "session-web";
  const parserStage = AgentPacketParserStage.SCHEMA_VALIDATION;
  const rawText = observedCandidatePacketType === undefined
    ? "{}"
    : canonicalJson({ type: observedCandidatePacketType });
  const rawResponseArtifactHash = context.artifactStore.put(
    buildDiscussionRuntimeEvidence({
      actor: submitted.input.targetActor,
      parserStage,
      rawText,
    }),
    { mimeType: "application/json", redacted: true },
  ).sha256;
  const input = {
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId,
    turnId: `external-${number}`,
    parserStage,
    errorCode: "INVALID_AGENT_PACKET_SCHEMA",
    errorSummary: "The final packet did not match its strict schema.",
    rawResponseArtifactHash,
  };
  const result = context.controller.recordInvalidResponse(input);
  context.run = result.run;
  return result;
}

test("one malformed response reserves one same-actor repair and a strict repair can relay", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const rejected = reject(context, first, 1, AgentPacketType.PROPOSAL);

  assert.equal(rejected.protocolFailureStatus, ProtocolFailureDecisionStatus.REPAIR_REQUIRED);
  assert.equal(rejected.run.phase, RunPhase.CODEX_RESPONSE_STORED);
  assert.equal(rejected.run.currentTurn, 1);
  assert.equal(rejected.delivery.state, DeliveryState.RESPONSE_COMPLETED);
  assert.equal(rejected.nextDelivery.turnInput.kind, AgentTurnInputKind.PROTOCOL_REPAIR);
  assert.equal(rejected.nextDelivery.turnInput.targetActor, AgentActor.CODEX_AGENT);
  assert.equal(rejected.nextDelivery.turnInput.sourceMessageId, null);
  assert.deepEqual(rejected.nextDelivery.turnInput.payload.allowedPacketTypes, [
    AgentPacketType.PROPOSAL,
    AgentPacketType.BLOCKED,
  ]);
  assert.match(rejected.nextDelivery.turnInput.payload.repairPolicyHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(rejected.rejectionEvent.repair, {
    inputId: rejected.nextDelivery.turnInput.inputId,
    inputHash: sha256CanonicalJson(rejected.nextDelivery.turnInput),
    deliveryId: rejected.nextDelivery.deliveryId,
    idempotencyKeyHash: sha256Text(rejected.nextDelivery.idempotencyKey),
    targetActor: AgentActor.CODEX_AGENT,
    sourceMessageId: null,
  });
  assert.equal(rejected.counters.protocolRepairsUsed, 1);
  assert.equal(rejected.counters.consecutiveActorFailures, 1);
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);

  const repair = claimAndSubmit(context, 2);
  assert.equal(repair.input.kind, AgentTurnInputKind.PROTOCOL_REPAIR);
  assert.equal(repair.run.phase, RunPhase.CODEX_TURN_RUNNING);
  const packet = {
    type: AgentPacketType.PROPOSAL,
    summary: "Recovered proposal",
    body: "Persist the repaired proposal, then relay it exactly once.",
    assumptions: [],
    open_decisions: [],
  };
  const completed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: repair.delivery.deliveryId,
    expectedDeliveryVersion: repair.delivery.version,
    sessionId: "session-codex",
    turnId: "external-2",
    content: `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`,
    packet,
  });
  context.run = completed.run;

  assert.equal(completed.message.kind, AgentMessageKind.PROPOSAL);
  assert.equal(completed.run.phase, RunPhase.CODEX_TO_WEB_PENDING);
  assert.equal(completed.run.currentTurn, 2);
  assert.equal(completed.nextDelivery.turnInput.targetActor, AgentActor.CHATGPT_WEB_AGENT);
  assert.equal(completed.delivery.state, DeliveryState.RELAYED);
  assert.equal(context.store.getRunLimits(context.run.runId).consecutiveActorFailures, 0);
  assert.deepEqual(context.store.verifyEventChains(context.run.runId).valid, true);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(
    reopened.verifyTurnQueueLinks(),
    { valid: true, queuedTurns: 2, submittedTurns: 2 },
  );
  reopened.close();
});

test("deleting a queued protocol repair is detected on reopen", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const rejected = reject(context, first, 1, AgentPacketType.PROPOSAL);
  const repair = rejected.rejectionEvent.repair;
  context.store.close();

  const database = new DatabaseSync(context.filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("DELETE FROM delivery_attempts WHERE delivery_id = ?").run(repair.deliveryId);
  database.prepare("DELETE FROM agent_turn_inputs WHERE input_id = ?").run(repair.inputId);
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /protocol repair input\/delivery link is inconsistent/u,
  );
});

test("coherent repair input and idempotency tampering is detected on reopen", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const rejected = reject(context, first, 1, AgentPacketType.PROPOSAL);
  const repair = context.store.getAgentTurnInput(rejected.rejectionEvent.repair.inputId);
  context.store.close();

  const forged = { ...repair, promptHash: sha256Text("forged repair prompt") };
  const database = new DatabaseSync(context.filename);
  database.prepare(`
    UPDATE agent_turn_inputs
    SET prompt_hash = ?, input_json = ?
    WHERE input_id = ?
  `).run(forged.promptHash, canonicalJson(forged), forged.inputId);
  database.prepare(`
    UPDATE delivery_attempts
    SET idempotency_key = ?
    WHERE delivery_id = ?
  `).run("forged-repair-idempotency", rejected.rejectionEvent.repair.deliveryId);
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /protocol repair input\/delivery link is inconsistent/u,
  );
});

test("startup re-derives and rejects a coherently forged repair policy", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const rejected = reject(context, first, 1, AgentPacketType.PROPOSAL);
  const repair = context.store.getAgentTurnInput(rejected.rejectionEvent.repair.inputId);
  context.store.close();

  const forged = {
    ...repair,
    payload: {
      ...repair.payload,
      allowedPacketTypes: [AgentPacketType.BLOCKED],
      repairPolicyHash: sha256Text("forged repair authority"),
    },
  };
  forged.payloadHash = sha256CanonicalJson(forged.payload);
  const forgedInputHash = sha256CanonicalJson(forged);
  const database = new DatabaseSync(context.filename);
  database.prepare(`
    UPDATE agent_turn_inputs
    SET payload_hash = ?, input_json = ?
    WHERE input_id = ?
  `).run(forged.payloadHash, canonicalJson(forged), forged.inputId);
  const row = database.prepare(`
    SELECT run_id, sequence, event_id, event_type, payload_json,
           previous_hash, created_at
    FROM domain_events
    WHERE event_type = 'AGENT_PACKET_REJECTED'
    ORDER BY sequence DESC LIMIT 1
  `).get();
  const payload = JSON.parse(row.payload_json);
  payload.details.repair.inputHash = forgedInputHash;
  const eventHash = calculateDomainEventHash(row.previous_hash, {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    runId: row.run_id,
    eventType: row.event_type,
    payload,
    createdAt: row.created_at,
  });
  database.prepare(`
    UPDATE domain_events SET payload_json = ?, event_hash = ?
    WHERE run_id = ? AND sequence = ?
  `).run(canonicalJson(payload), eventHash, row.run_id, row.sequence);
  database.prepare(`
    UPDATE runs SET last_event_hash = ? WHERE run_id = ?
  `).run(eventHash, row.run_id);
  database.prepare(`
    UPDATE run_projections SET last_event_hash = ? WHERE run_id = ?
  `).run(eventHash, row.run_id);
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /protocol repair policy binding is inconsistent/u,
  );
});

test("a provider turn id rejected earlier cannot be reused by the same session", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  reject(context, first, 1, AgentPacketType.PROPOSAL);
  const repair = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(repair.deliveryId),
    session: context.store.getAgentSession("session-codex"),
    events: context.store.listDomainEvents(context.run.runId),
  };

  assert.throws(() => context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: repair.deliveryId,
    expectedDeliveryVersion: repair.version,
    providerReceipt: providerReceiptForSession(
      context.store,
      "session-codex",
      "external-1",
    ),
  }), (error) => error.code === "AGENT_SESSION_TURN_ID_REUSED");

  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(repair.deliveryId), before.delivery);
  assert.deepEqual(context.store.getAgentSession("session-codex"), before.session);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(reopened.verifyAgentPacketRejections(), { valid: true, rejections: 1 });
  reopened.close();
});

test("invalid response handling refuses an unverified runtime-evidence artifact boundary", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const withoutArtifactVerifier = new DiscussionController({ store: context.store });
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(first.delivery.deliveryId),
    session: context.store.getAgentSession("session-codex"),
    events: context.store.listDomainEvents(context.run.runId),
  };

  assert.throws(() => withoutArtifactVerifier.recordInvalidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: first.delivery.deliveryId,
    expectedDeliveryVersion: first.delivery.version,
    sessionId: "session-codex",
    turnId: "external-1",
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The packet was invalid.",
    rawResponseArtifactHash: context.artifactStore.put(
      buildDiscussionRuntimeEvidence({
        actor: AgentActor.CODEX_AGENT,
        parserStage: AgentPacketParserStage.JSON_PARSE,
        rawText: "not-json",
      }),
      { mimeType: "application/json", redacted: true },
    ).sha256,
  }), (error) => error.code === "RAW_RESPONSE_ARTIFACT_VERIFIER_REQUIRED");

  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(first.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.getAgentSession("session-codex"), before.session);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  context.store.close();
});

test("invalid response handling rejects arbitrary or context-forged evidence artifacts", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const arbitraryHash = context.artifactStore.put(
    "an arbitrary artifact is not runtime-response evidence",
    { mimeType: "text/plain", redacted: true },
  ).sha256;
  const wrongActorHash = context.artifactStore.put(
    buildDiscussionRuntimeEvidence({
      actor: AgentActor.CHATGPT_WEB_AGENT,
      parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
      rawText: canonicalJson({ type: AgentPacketType.PROPOSAL }),
    }),
    { mimeType: "application/json", redacted: true },
  ).sha256;
  const forgedUntypedCandidateHash = context.artifactStore.put(
    canonicalJson({
      actor: AgentActor.CODEX_AGENT,
      observedCandidatePacketType: AgentPacketType.PROPOSAL,
      parserStage: AgentPacketParserStage.JSON_PARSE,
      schema: DISCUSSION_RUNTIME_EVIDENCE_SCHEMA,
    }),
    { mimeType: "application/json", redacted: true },
  ).sha256;
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(first.delivery.deliveryId),
    session: context.store.getAgentSession("session-codex"),
    events: context.store.listDomainEvents(context.run.runId),
  };

  for (const [rawResponseArtifactHash, parserStage, code] of [
    [arbitraryHash, AgentPacketParserStage.SCHEMA_VALIDATION, "RUNTIME_EVIDENCE_INVALID_JSON"],
    [wrongActorHash, AgentPacketParserStage.SCHEMA_VALIDATION, "RUNTIME_EVIDENCE_CONTEXT_MISMATCH"],
    [
      forgedUntypedCandidateHash,
      AgentPacketParserStage.JSON_PARSE,
      "INVALID_DISCUSSION_RUNTIME_EVIDENCE",
    ],
  ]) {
    assert.throws(() => context.controller.recordInvalidResponse({
      runId: context.run.runId,
      expectedRunVersion: context.run.version,
      deliveryId: first.delivery.deliveryId,
      expectedDeliveryVersion: first.delivery.version,
      sessionId: "session-codex",
      turnId: "external-1",
      parserStage,
      errorCode: "INVALID_AGENT_PACKET_SCHEMA",
      errorSummary: "The packet was invalid.",
      rawResponseArtifactHash,
    }), (error) => error.code === code);
  }

  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(first.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.getAgentSession("session-codex"), before.session);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  context.store.close();
});

test("a second malformed response exhausts repair and durably fails without a peer message", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  reject(context, first, 1, AgentPacketType.PROPOSAL);
  const repair = claimAndSubmit(context, 2);
  const failed = reject(context, repair, 2);

  assert.equal(failed.protocolFailureStatus, ProtocolFailureDecisionStatus.FAILED);
  assert.equal(failed.run.phase, RunPhase.FAILED);
  assert.equal(failed.run.currentTurn, 2);
  assert.equal(failed.nextDelivery, null);
  assert.equal(failed.delivery.state, DeliveryState.RESPONSE_COMPLETED);
  assert.equal(failed.counters.protocolRepairsUsed, 1);
  assert.equal(failed.counters.consecutiveActorFailures, 2);
  assert.deepEqual(failed.outcome.outcome, {
    type: RunOutcomeType.FAILED,
    errorCode: AGENT_PROTOCOL_REPAIR_EXHAUSTED,
  });
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 0);
  assert.equal(context.store.listAgentPackets(context.run.runId).length, 0);
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 2);
  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  }), null);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.equal(reopened.getRun(context.run.runId).phase, RunPhase.FAILED);
  assert.equal(
    reopened.getRunOutcome(context.run.runId).outcome.errorCode,
    AGENT_PROTOCOL_REPAIR_EXHAUSTED,
  );
  assert.equal(reopened.listDispatchableDeliveries({ runId: context.run.runId }).length, 0);
  reopened.close();
});

test("typed diagnostic evidence cannot choose protocol repair authority", (t) => {
  const policies = [];
  for (const observedCandidatePacketType of [
    AgentPacketType.PROPOSAL,
    AgentPacketType.BLOCKED,
    AgentPacketType.ACCEPT,
    AgentPacketType.CRITIQUE,
    undefined,
  ]) {
    const context = fixture(t);
    const first = claimAndSubmit(context, 1);
    const rejected = reject(context, first, 1, observedCandidatePacketType);
    assert.equal(rejected.protocolFailureStatus, ProtocolFailureDecisionStatus.REPAIR_REQUIRED);
    const payload = rejected.nextDelivery.turnInput.payload;
    assert.deepEqual(payload.allowedPacketTypes, [
      AgentPacketType.PROPOSAL,
      AgentPacketType.BLOCKED,
    ]);
    assert.equal(Object.hasOwn(payload, "expectedPacketType"), false);
    policies.push(canonicalJson({
      allowedPacketTypes: payload.allowedPacketTypes,
      repairPolicyHash: payload.repairPolicyHash,
    }));
    context.store.close();

    const reopened = new SqliteStore(context.filename);
    assert.deepEqual(
      reopened.getAgentTurnInput(rejected.nextDelivery.turnInput.inputId).payload,
      payload,
    );
    assert.deepEqual(reopened.verifyAgentPacketRejections(), { valid: true, rejections: 1 });
    reopened.close();
  }
  assert.equal(new Set(policies).size, 1);
});

test("a response turn must match the Controller-recorded session turn exactly", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(first.delivery.deliveryId),
    session: context.store.getAgentSession("session-codex"),
    events: context.store.listDomainEvents(context.run.runId),
  };

  assert.throws(() => context.controller.recordInvalidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: first.delivery.deliveryId,
    expectedDeliveryVersion: first.delivery.version,
    sessionId: "session-codex",
    turnId: "forged-turn",
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The packet was invalid.",
    rawResponseArtifactHash: context.artifactStore.put(
      buildDiscussionRuntimeEvidence({
        actor: AgentActor.CODEX_AGENT,
        parserStage: AgentPacketParserStage.JSON_PARSE,
        rawText: "not-json",
      }),
      { mimeType: "application/json", redacted: true },
    ).sha256,
  }), (error) => error.code === "AGENT_SESSION_TURN_MISMATCH");

  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(first.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.getAgentSession("session-codex"), before.session);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  context.store.close();
});

test("an invalid final allowed turn ends INCONCLUSIVE instead of queuing an over-budget repair", (t) => {
  const context = fixture(t, 2);
  const first = claimAndSubmit(context, 1);
  const proposalPacket = {
    type: AgentPacketType.PROPOSAL,
    summary: "One-turn proposal",
    body: "The second and final allowed turn must review this proposal.",
    assumptions: [],
    open_decisions: [],
  };
  const proposed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: first.delivery.deliveryId,
    expectedDeliveryVersion: first.delivery.version,
    sessionId: "session-codex",
    turnId: "external-1",
    content: `<controller_packet>\n${canonicalJson(proposalPacket)}\n</controller_packet>`,
    packet: proposalPacket,
  });
  context.run = proposed.run;
  const second = claimAndSubmit(context, 2);
  const result = reject(context, second, 2, AgentPacketType.CRITIQUE);

  assert.equal(result.run.phase, RunPhase.COMPLETE);
  assert.equal(result.run.currentTurn, 2);
  assert.equal(result.nextDelivery, null);
  assert.equal(result.counters.protocolRepairsUsed, 0);
  assert.deepEqual(result.outcome.outcome, {
    type: RunOutcomeType.INCONCLUSIVE,
    reason: "MAX_TURNS_REACHED",
    unresolvedFindings: ["AGENT_PACKET_REJECTED:INVALID_AGENT_PACKET_SCHEMA"],
  });
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 2);
  context.store.close();
});

test("maxTurns also closes an ambiguous final rejection without an impossible authority gate", (t) => {
  const context = fixture(t, 2);
  const first = claimAndSubmit(context, 1);
  const proposalPacket = {
    type: AgentPacketType.PROPOSAL,
    summary: "One-turn proposal",
    body: "The final response cannot consume an unavailable repair turn.",
    assumptions: [],
    open_decisions: [],
  };
  const proposed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: first.delivery.deliveryId,
    expectedDeliveryVersion: first.delivery.version,
    sessionId: "session-codex",
    turnId: "external-1",
    content: `<controller_packet>\n${canonicalJson(proposalPacket)}\n</controller_packet>`,
    packet: proposalPacket,
  });
  context.run = proposed.run;
  const second = claimAndSubmit(context, 2);
  const result = reject(context, second, 2);

  assert.equal(result.protocolFailureStatus, "MAX_TURNS_REACHED");
  assert.equal(result.run.phase, RunPhase.COMPLETE);
  assert.equal(result.run.currentTurn, 2);
  assert.equal(result.run.blocker, null);
  assert.equal(result.nextDelivery, null);
  assert.deepEqual(result.outcome.outcome, {
    type: RunOutcomeType.INCONCLUSIVE,
    reason: "MAX_TURNS_REACHED",
    unresolvedFindings: ["AGENT_PACKET_REJECTED:INVALID_AGENT_PACKET_SCHEMA"],
  });
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 2);
  assert.equal(
    context.store.listDomainEvents(context.run.runId).some(
      (event) => event.eventType === "AGENT_PROTOCOL_AUTHORITY_REQUIRED",
    ),
    false,
  );
  context.store.close();
});

test("an existing approval holds an invalid final response instead of being orphaned", (t) => {
  const context = fixture(t, 2);
  const first = claimAndSubmit(context, 1);
  const proposalPacket = {
    type: AgentPacketType.PROPOSAL,
    summary: "One-turn proposal",
    body: "Keep the pending runtime approval authoritative on the final response.",
    assumptions: [],
    open_decisions: [],
  };
  const proposed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: first.delivery.deliveryId,
    expectedDeliveryVersion: first.delivery.version,
    sessionId: "session-codex",
    turnId: "external-1",
    content: `<controller_packet>\n${canonicalJson(proposalPacket)}\n</controller_packet>`,
    packet: proposalPacket,
  });
  context.run = proposed.run;
  const second = claimAndSubmit(context, 2);
  const approval = context.runService.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId: "approval-invalid-final",
    scope: { operationId: "operation-invalid-final" },
  });
  context.run = approval.run;
  const held = reject(context, second, 2, AgentPacketType.CRITIQUE);

  assert.equal(held.run.phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(held.run.blocker, approval.run.blocker);
  assert.equal(held.nextDelivery, null);
  assert.equal(held.outcome, null);
  assert.equal(context.store.getRunOutcome(context.run.runId), null);
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 2);
  assert.equal(
    context.store.listDomainEvents(context.run.runId).at(-1).eventType,
    "AGENT_INVALID_RESPONSE_HELD_FOR_BLOCKER",
  );
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(scanStartupRecovery(reopened)[0].reasons.map((item) => item.type), [
    "APPROVAL_PENDING",
  ]);
  reopened.close();
});

test("a failed repair outbox insert rolls back delivery, counters, rejection, and run state", (t) => {
  const context = fixture(t);
  const first = claimAndSubmit(context, 1);
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(first.delivery.deliveryId),
    limits: context.store.getRunLimits(context.run.runId),
    events: context.store.listDomainEvents(context.run.runId),
  };
  const database = new DatabaseSync(context.filename);
  database.exec(`
    CREATE TRIGGER reject_repair_input_for_atomicity_test
    BEFORE INSERT ON agent_turn_inputs
    BEGIN
      SELECT RAISE(ABORT, 'injected repair input failure');
    END;
  `);
  database.close();

  assert.throws(
    () => reject(context, first, 1, AgentPacketType.PROPOSAL),
    /injected repair input failure/u,
  );
  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(first.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.getRunLimits(context.run.runId), before.limits);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  assert.equal(context.store.getAgentPacketRejectionByDelivery(first.delivery.deliveryId), null);
  context.store.close();
});
