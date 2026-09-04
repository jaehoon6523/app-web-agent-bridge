import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../src/domain/canonical-json.js";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { RunService } from "../src/orchestration/run-service.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T07:00:00.000Z";

function proposalPacket() {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Atomic response",
    body: "Persist the response graph and conditional outbox in one transaction.",
    assumptions: [],
    open_decisions: [],
  };
}

function fixture(t, suffix) {
  const directory = mkdtempSync(join(tmpdir(), `discussion-atomic-${suffix}-`));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  let id = 0;
  let tick = 0;
  const idFactory = () => `${suffix}-${String(++id).padStart(4, "0")}`;
  const clock = () => `2026-09-04T07:00:${String(tick++).padStart(2, "0")}.000Z`;
  const service = new RunService({ store, idFactory, clock });
  const created = service.createRun({
    runId: `run-atomic-${suffix}`,
    objective: "Prove one response transaction rolls back at every late write boundary",
    policy: createDiscussionRunPolicy(),
  });

  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const codex = actor === AgentActor.CODEX_AGENT;
    store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId: codex ? `session-codex-${suffix}` : `session-web-${suffix}`,
        runId: created.runId,
        actor,
        provider: codex ? SessionProvider.CODEX_APP_SERVER : SessionProvider.CHATGPT_WEB,
        externalSessionId: codex ? `thread-${suffix}` : `conversation-${suffix}`,
        externalLocator: codex ? null : `https://chatgpt.com/c/conversation-${suffix}`,
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
  const started = controller.start({
    runId: created.runId,
    expectedVersion: created.version,
  });
  const claimed = controller.claimNext({
    runId: created.runId,
    expectedRunVersion: started.run.version,
  });
  assert(claimed);
  const submitted = controller.markSubmitted({
    runId: created.runId,
    expectedRunVersion: started.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { accepted: true, externalTurnId: `turn-${suffix}` },
  });
  return {
    controller,
    filename,
    runId: created.runId,
    store,
    submitted,
    sessionId: `session-codex-${suffix}`,
    turnId: `turn-${suffix}`,
  };
}

function snapshot(context) {
  const { runId, store } = context;
  return {
    run: store.getRun(runId),
    projection: store.getRunProjection(runId),
    sessions: store.listAgentSessions(runId),
    limits: store.getRunLimits(runId),
    inputs: store.listAgentTurnInputs(runId),
    deliveries: store.listDeliveries(runId),
    messages: store.listAgentMessages(runId),
    packets: store.listAgentPackets(runId),
    proposals: store.listProposalArtifacts(runId),
    events: store.listDomainEvents(runId),
    outcome: store.getRunOutcome(runId),
    approvals: store.listApprovals({ runId }),
    recoveries: store.listRecoveryOperations({ runId }),
  };
}

function installFault(filename, sql) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function respond(context) {
  const packet = proposalPacket();
  return context.controller.recordValidResponse({
    runId: context.runId,
    expectedRunVersion: context.submitted.run.version,
    deliveryId: context.submitted.delivery.deliveryId,
    expectedDeliveryVersion: context.submitted.delivery.version,
    sessionId: context.sessionId,
    turnId: context.turnId,
    content: `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`,
    packet,
  });
}

const FAULTS = Object.freeze([
  {
    suffix: "packet",
    title: "agent_packets failure after AgentMessage storage rolls back the response",
    error: /injected agent packet failure/u,
    sql: `
      CREATE TRIGGER fail_agent_packet_insert
      BEFORE INSERT ON agent_packets
      BEGIN
        SELECT RAISE(ABORT, 'injected agent packet failure');
      END;
    `,
  },
  {
    suffix: "event",
    title: "event append failure after ProposalArtifact storage rolls back the response",
    error: /injected response event failure/u,
    sql: `
      CREATE TRIGGER fail_response_event_insert
      BEFORE INSERT ON domain_events
      WHEN NEW.event_type = 'AGENT_RESPONSE_STORED'
      BEGIN
        SELECT RAISE(ABORT, 'injected response event failure');
      END;
    `,
  },
  {
    suffix: "next-input",
    title: "next AgentTurnInput insert failure rolls back the response and prior events",
    error: /injected next input failure/u,
    sql: `
      CREATE TRIGGER fail_next_input_insert
      BEFORE INSERT ON agent_turn_inputs
      BEGIN
        SELECT RAISE(ABORT, 'injected next input failure');
      END;
    `,
  },
  {
    suffix: "next-delivery",
    title: "next delivery insert failure rolls back its AgentTurnInput and the response",
    error: /injected next delivery failure/u,
    sql: `
      CREATE TRIGGER fail_next_delivery_insert
      BEFORE INSERT ON delivery_attempts
      BEGIN
        SELECT RAISE(ABORT, 'injected next delivery failure');
      END;
    `,
  },
  {
    suffix: "projection",
    title: "projection update failure after event append rolls back the entire response",
    error: /injected projection update failure/u,
    sql: `
      CREATE TRIGGER fail_response_projection_update
      BEFORE UPDATE ON run_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected projection update failure');
      END;
    `,
  },
]);

for (const fault of FAULTS) {
  test(fault.title, (t) => {
    const context = fixture(t, fault.suffix);
    const before = snapshot(context);
    installFault(context.filename, fault.sql);

    assert.throws(() => respond(context), fault.error);
    assert.deepEqual(snapshot(context), before);
    assert.deepEqual(context.store.verifyEventChains(context.runId), {
      valid: true,
      runCount: 1,
      eventCount: before.events.length,
    });
    assert.deepEqual(context.store.verifyAgentCommunicationLinks(), {
      valid: true,
      turnInputs: before.inputs.length,
      messages: before.messages.length,
      packets: before.packets.length,
      deliveries: before.deliveries.length,
    });
    assert.deepEqual(context.store.verifyProposalArtifacts(), {
      valid: true,
      artifacts: before.proposals.length,
    });
    context.store.close();
  });
}
