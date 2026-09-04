import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../src/domain/canonical-json.js";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  AgentSessionStatus,
  RunOutcomeType,
  RunPhase,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import { RunService } from "../src/orchestration/run-service.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T04:00:00.000Z";

function packetContent(packet) {
  return `<controller_packet>\n${canonicalJson(packet)}\n</controller_packet>`;
}

function proposal(body) {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Durable two-agent loop",
    body,
    assumptions: [],
    open_decisions: [],
  };
}

function critique(proposalRefHash) {
  return {
    type: AgentPacketType.CRITIQUE,
    target_proposal_sha256: proposalRefHash,
    blocking_findings: ["Persist the response and next outbox atomically."],
    non_blocking_findings: [],
    requested_changes: ["Add one Controller-owned transaction."],
  };
}

function accept(proposalRefHash) {
  return {
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: proposalRefHash,
    blocking_findings: [],
  };
}

function fixture(t, { maxTurns = 12, runId = "run-five-turns" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "discussion-loop-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  let id = 0;
  let tick = 0;
  const idFactory = () => String(++id).padStart(4, "0");
  const clock = () => `2026-09-04T04:00:${String(tick++).padStart(2, "0")}.000Z`;
  const service = new RunService({ store, idFactory, clock });
  const run = service.createRun({
    runId,
    objective: "Produce and independently accept one durable proposal",
    policy: createDiscussionRunPolicy({ maxTurns }),
  });
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const codex = actor === AgentActor.CODEX_AGENT;
    store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId: codex ? "session-codex" : "session-web",
        runId: run.runId,
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
  const started = controller.start({ runId: run.runId, expectedVersion: run.version });
  return { controller, filename, service, store, run: started.run };
}

function requestRuntimeApproval(context, approvalId = "approval-in-flight") {
  const requested = context.service.requestRuntimeApproval({
    runId: context.run.runId,
    expectedVersion: context.run.version,
    approvalId,
    scope: { operationId: `${approvalId}-operation` },
  });
  context.run = requested.run;
  return requested;
}

function submitTurn(context, turnNumber) {
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  assert(claimed, `turn ${turnNumber} must have one dispatchable delivery`);
  assert.equal(claimed.state, DeliveryState.DISPATCHING);
  const input = context.store.getAgentTurnInput(claimed.inputId);
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { accepted: true, externalTurnId: `external-turn-${turnNumber}` },
  });
  context.run = submitted.run;
  return { input, submitted };
}

function executeTurn(context, packet, turnNumber) {
  const { input, submitted } = submitTurn(context, turnNumber);
  const sessionId = input.targetActor === AgentActor.CODEX_AGENT
    ? "session-codex"
    : "session-web";
  const completed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: submitted.run.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId,
    turnId: `external-turn-${turnNumber}`,
    content: packetContent(packet),
    packet,
  });
  context.run = completed.run;
  return completed;
}

function runFirstFourTurns(context) {
  const first = executeTurn(context, proposal("Persist each response before relaying it."), 1);
  const firstRef = first.proposalArtifact.proposalRefHash;
  const second = executeTurn(context, critique(firstRef), 2);
  assert.equal(second.message.kind, AgentMessageKind.CRITIQUE);
  const third = executeTurn(
    context,
    proposal("Persist each response and its conditional next outbox in one transaction."),
    3,
  );
  assert.equal(third.message.kind, AgentMessageKind.REVISION);
  const finalRef = third.proposalArtifact.proposalRefHash;
  const fourth = executeTurn(context, accept(finalRef), 4);
  assert.equal(fourth.message.actor, AgentActor.CHATGPT_WEB_AGENT);
  return finalRef;
}

test("fake CODEX/WEB sessions complete the exact five-turn durable consensus vertical", (t) => {
  const context = fixture(t);
  const finalRef = runFirstFourTurns(context);
  const fifth = executeTurn(context, accept(finalRef), 5);

  assert.equal(fifth.run.phase, RunPhase.COMPLETE);
  assert.equal(fifth.run.currentTurn, 5);
  assert.equal(fifth.nextDelivery, null);
  assert.equal(fifth.delivery.state, DeliveryState.RESPONSE_COMPLETED);
  assert.deepEqual(fifth.outcome.outcome, {
    type: RunOutcomeType.CONSENSUS,
    proposalHash: finalRef,
  });
  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  }), null);

  const inputs = context.store.listAgentTurnInputs(context.run.runId);
  const messages = context.store.listAgentMessages(context.run.runId);
  const packets = context.store.listAgentPackets(context.run.runId);
  const proposals = context.store.listProposalArtifacts(context.run.runId);
  const deliveries = context.store.listDeliveries(context.run.runId);
  assert.equal(inputs.length, 5);
  assert.equal(messages.length, 5);
  assert.equal(packets.length, 5);
  assert.equal(proposals.length, 2);
  assert.equal(deliveries.length, 5);
  assert.deepEqual(messages.map((message) => message.kind), [
    AgentMessageKind.PROPOSAL,
    AgentMessageKind.CRITIQUE,
    AgentMessageKind.REVISION,
    AgentMessageKind.ACCEPTANCE,
    AgentMessageKind.ACCEPTANCE,
  ]);
  assert.deepEqual(deliveries.map((delivery) => delivery.state), [
    DeliveryState.RELAYED,
    DeliveryState.RELAYED,
    DeliveryState.RELAYED,
    DeliveryState.RELAYED,
    DeliveryState.RESPONSE_COMPLETED,
  ]);
  assert.deepEqual(context.store.verifyEventChains(context.run.runId), {
    valid: true,
    runCount: 1,
    eventCount: context.store.listDomainEvents(context.run.runId).length,
  });
  assert.equal(
    context.store.rebuildRunProjection(context.run.runId, { compare: true }).replaced,
    false,
  );

  context.store.close();
  const reopened = new SqliteStore(context.filename);
  assert.equal(reopened.getRun(context.run.runId).phase, RunPhase.COMPLETE);
  assert.equal(reopened.getRun(context.run.runId).currentTurn, 5);
  assert.equal(reopened.getRunOutcome(context.run.runId).outcome.proposalHash, finalRef);
  assert.equal(reopened.listDispatchableDeliveries({ runId: context.run.runId }).length, 0);
  reopened.close();
});

for (const tamper of [
  {
    label: "active turn",
    mutate: (session) => ({ ...session, activeTurnId: "forged-active-turn" }),
  },
  {
    label: "running status",
    mutate: (session) => ({
      ...session,
      status: AgentSessionStatus.WAITING,
      activeTurnId: null,
    }),
  },
]) {
  test(`startup rejects a submitted session with a forged ${tamper.label}`, (t) => {
    const context = fixture(t, { runId: `run-forged-${tamper.label.replace(" ", "-")}` });
    const { submitted } = submitTurn(context, 1);
    context.store.close();

    const database = new DatabaseSync(context.filename);
    const forged = tamper.mutate(submitted.session);
    database.prepare("UPDATE agent_sessions SET session_json = ? WHERE session_id = ?")
      .run(canonicalJson(forged), forged.sessionId);
    database.close();

    assert.throws(
      () => new SqliteStore(context.filename),
      /current in-flight session does not match its submitted turn/u,
    );
  });
}

test("a pending approval holds final consensus without clearing the blocker or queuing turn six", (t) => {
  const context = fixture(t, { runId: "run-held-consensus" });
  const finalRef = runFirstFourTurns(context);
  const { submitted } = submitTurn(context, 5);
  const approval = requestRuntimeApproval(context, "approval-final-consensus");
  const packet = accept(finalRef);
  const held = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId: "session-codex",
    turnId: "external-turn-5",
    content: packetContent(packet),
    packet,
  });

  assert.equal(held.run.phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(held.run.blocker, approval.run.blocker);
  assert.equal(held.nextDelivery, null);
  assert.equal(held.outcome, null);
  assert.equal(context.store.getRunOutcome(context.run.runId), null);
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 5);
  assert.equal(context.store.listDeliveries(context.run.runId).length, 5);
  assert.equal(context.store.listApprovals({ runId: context.run.runId })[0].status, "PENDING");
  assert.equal(
    context.store.listDomainEvents(context.run.runId).at(-1).eventType,
    "AGENT_RESPONSE_HELD_FOR_BLOCKER",
  );
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.equal(reopened.getRun(context.run.runId).phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(scanStartupRecovery(reopened)[0].reasons.map((item) => item.type), [
    "APPROVAL_PENDING",
  ]);
  reopened.close();
});

test("a pending approval holds a final max-turn result instead of orphaning its side record", (t) => {
  const context = fixture(t, { maxTurns: 2, runId: "run-held-max-turn" });
  const first = executeTurn(context, proposal("Review this proposal on the last turn."), 1);
  const { submitted } = submitTurn(context, 2);
  const approval = requestRuntimeApproval(context, "approval-final-limit");
  const packet = critique(first.proposalArtifact.proposalRefHash);
  const held = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId: "session-web",
    turnId: "external-turn-2",
    content: packetContent(packet),
    packet,
  });

  assert.equal(held.run.currentTurn, 2);
  assert.equal(held.run.phase, RunPhase.HUMAN_GATE);
  assert.deepEqual(held.run.blocker, approval.run.blocker);
  assert.equal(held.nextDelivery, null);
  assert.equal(held.outcome, null);
  assert.equal(context.store.getRunOutcome(context.run.runId), null);
  assert.equal(context.store.listAgentTurnInputs(context.run.runId).length, 2);
  assert.equal(context.store.listDeliveries(context.run.runId).length, 2);
  assert.deepEqual(context.store.verifyEventChains(context.run.runId).valid, true);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(scanStartupRecovery(reopened)[0].reasons.map((item) => item.type), [
    "APPROVAL_PENDING",
  ]);
  reopened.close();
});

test("a late outcome insert failure rolls the whole final response back", (t) => {
  const context = fixture(t);
  const finalRef = runFirstFourTurns(context);
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { accepted: true, externalTurnId: "external-turn-5" },
  });
  context.run = submitted.run;
  const before = {
    run: context.store.getRun(context.run.runId),
    delivery: context.store.getDelivery(submitted.delivery.deliveryId),
    events: context.store.listDomainEvents(context.run.runId),
    messages: context.store.listAgentMessages(context.run.runId),
    packets: context.store.listAgentPackets(context.run.runId),
    proposals: context.store.listProposalArtifacts(context.run.runId),
    limits: context.store.getRunLimits(context.run.runId),
  };

  const database = new DatabaseSync(context.filename);
  database.exec(`
    CREATE TRIGGER reject_outcome_for_atomicity_test
    BEFORE INSERT ON run_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'injected run outcome failure');
    END;
  `);
  database.close();

  assert.throws(() => context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId: "session-codex",
    turnId: "external-turn-5",
    content: packetContent(accept(finalRef)),
    packet: accept(finalRef),
  }), /injected run outcome failure/u);

  assert.deepEqual(context.store.getRun(context.run.runId), before.run);
  assert.deepEqual(context.store.getDelivery(submitted.delivery.deliveryId), before.delivery);
  assert.deepEqual(context.store.listDomainEvents(context.run.runId), before.events);
  assert.deepEqual(context.store.listAgentMessages(context.run.runId), before.messages);
  assert.deepEqual(context.store.listAgentPackets(context.run.runId), before.packets);
  assert.deepEqual(context.store.listProposalArtifacts(context.run.runId), before.proposals);
  assert.deepEqual(context.store.getRunLimits(context.run.runId), before.limits);
  assert.equal(context.store.getRunOutcome(context.run.runId), null);
  context.store.close();
});

test("an identical revised proposal reuses the Controller-owned run reference", (t) => {
  const context = fixture(t);
  const body = "Keep one canonical proposal identity for identical normalized content.";
  const first = executeTurn(context, proposal(body), 1);
  const firstRef = first.proposalArtifact.proposalRefHash;
  executeTurn(context, critique(firstRef), 2);
  const revised = executeTurn(context, proposal(body), 3);

  assert.equal(revised.message.kind, AgentMessageKind.REVISION);
  assert.equal(revised.proposalReused, true);
  assert.equal(revised.proposalArtifact.proposalId, first.proposalArtifact.proposalId);
  assert.equal(revised.proposalArtifact.proposalRefHash, firstRef);
  assert.equal(context.store.listProposalArtifacts(context.run.runId).length, 1);
  const occurrenceEvents = context.store.listDomainEvents(context.run.runId)
    .filter((event) => (
      event.eventType === "AGENT_RESPONSE_STORED"
      && event.payload.details.proposal?.proposalRefHash === firstRef
    ));
  assert.deepEqual(
    occurrenceEvents.map((event) => ({
      messageId: event.payload.details.messageId,
      reused: event.payload.details.proposal.reused,
    })),
    [
      { messageId: first.message.messageId, reused: false },
      { messageId: revised.message.messageId, reused: true },
    ],
    "each source message retains an explicit event link to the one canonical proposal",
  );
  assert.deepEqual(context.store.verifyDiscussionResponseLinks(), {
    valid: true,
    responses: 3,
  });
  context.store.close();
  const reopened = new SqliteStore(context.filename);
  assert.equal(reopened.listProposalArtifacts(context.run.runId).length, 1);
  assert.deepEqual(reopened.verifyDiscussionResponseLinks(), {
    valid: true,
    responses: 3,
  });
  reopened.close();
});

test("claiming a pending turn is versioned and leaves paused runs untouched", (t) => {
  const context = fixture(t);
  const pendingDelivery = context.store.listDeliveries(context.run.runId)[0];
  const staleVersion = context.run.version;
  context.run = context.service.pause({
    runId: context.run.runId,
    expectedVersion: context.run.version,
  });

  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  }), null);
  assert.equal(
    context.store.getDelivery(pendingDelivery.deliveryId).state,
    DeliveryState.PENDING,
  );
  assert.throws(() => context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: staleVersion,
  }), (error) => error.code === "RUN_VERSION_CONFLICT");

  context.run = context.service.resume({
    runId: context.run.runId,
    expectedVersion: context.run.version,
  });
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  assert.equal(claimed.deliveryId, pendingDelivery.deliveryId);
  assert.equal(claimed.state, DeliveryState.DISPATCHING);
  context.store.close();
});

test("pause during an active turn stores the response and holds the queued peer delivery", (t) => {
  const context = fixture(t);
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { accepted: true, externalTurnId: "paused-turn-1" },
  });
  const paused = context.service.pause({
    runId: context.run.runId,
    expectedVersion: submitted.run.version,
  });
  const completed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: paused.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId: "session-codex",
    turnId: "paused-turn-1",
    content: packetContent(proposal("Queue this proposal while paused.")),
    packet: proposal("Queue this proposal while paused."),
  });

  assert.equal(completed.run.paused, true);
  assert.equal(completed.run.phase, RunPhase.CODEX_TO_WEB_PENDING);
  assert.equal(completed.nextDelivery.turnInput.targetActor, AgentActor.CHATGPT_WEB_AGENT);
  assert.equal(completed.nextDelivery.turnInput.kind, "PEER_RELAY");
  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: completed.run.version,
  }), null);
  assert.equal(
    context.store.getDelivery(completed.nextDelivery.deliveryId).state,
    DeliveryState.PENDING,
  );

  const resumed = context.service.resume({
    runId: context.run.runId,
    expectedVersion: completed.run.version,
  });
  const peer = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: resumed.version,
  });
  assert.equal(peer.deliveryId, completed.nextDelivery.deliveryId);
  assert.equal(peer.state, DeliveryState.DISPATCHING);
  context.store.close();
});

test("an in-flight response is stored while a blocker holds its queued peer delivery", (t) => {
  const context = fixture(t);
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { accepted: true, externalTurnId: "blocked-turn-1" },
  });
  context.run = submitted.run;
  const blocked = requestRuntimeApproval(context).run;
  const packet = proposal("Store this response before waiting for the approval.");
  const completed = context.controller.recordValidResponse({
    runId: context.run.runId,
    expectedRunVersion: blocked.version,
    deliveryId: submitted.delivery.deliveryId,
    expectedDeliveryVersion: submitted.delivery.version,
    sessionId: "session-codex",
    turnId: "blocked-turn-1",
    content: packetContent(packet),
    packet,
  });

  assert.equal(completed.run.phase, RunPhase.CODEX_TO_WEB_PENDING);
  assert.deepEqual(completed.run.blocker, blocked.blocker);
  assert.equal(completed.nextDelivery.deliveryId.length > 0, true);
  assert.equal(
    context.store.getDelivery(completed.nextDelivery.deliveryId).state,
    DeliveryState.PENDING,
  );
  assert.equal(context.store.listAgentMessages(context.run.runId).length, 1);
  assert.equal(context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: completed.run.version,
  }), null);

  context.store.close();

  const reopened = new SqliteStore(context.filename);
  assert.deepEqual(scanStartupRecovery(reopened)[0].reasons.map((item) => item.type), [
    "APPROVAL_PENDING",
  ]);
  reopened.close();
});

for (const priorState of [
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.AMBIGUOUS,
]) {
  test(`a reopened run rejects an unbound ${priorState} delivery`, (t) => {
    const context = fixture(t);
    const first = executeTurn(context, proposal("Create the receipt-reuse fixture."), 1);
    executeTurn(context, critique(first.proposalArtifact.proposalRefHash), 2);
    const canonicalDelivery = context.store.listDispatchableDeliveries({
      runId: context.run.runId,
      limit: 1,
    })[0];
    const canonicalInput = context.store.getAgentTurnInput(canonicalDelivery.inputId);
    context.store.saveAgentTurnInputWithDelivery({
      turnInput: {
        ...canonicalInput,
        inputId: `input-prior-${priorState}`,
      },
      deliveryId: `delivery-0000-${priorState}`,
      idempotencyKey: `idempotency-prior-${priorState}`,
      createdAt: canonicalInput.createdAt,
    });
    let prior = context.store.claimNextPendingDelivery({
      runId: context.run.runId,
      claimedAt: T0,
    });
    assert.equal(prior.deliveryId, `delivery-0000-${priorState}`);
    prior = context.store.transitionDelivery({
      deliveryId: prior.deliveryId,
      expectedState: prior.state,
      expectedVersion: prior.version,
      nextState: DeliveryState.SUBMITTED,
      providerReceipt: { externalTurnId: "persisted-code-turn" },
      updatedAt: T0,
    });
    if (priorState !== DeliveryState.SUBMITTED) {
      prior = context.store.transitionDelivery({
        deliveryId: prior.deliveryId,
        expectedState: prior.state,
        expectedVersion: prior.version,
        nextState: priorState,
        updatedAt: T0,
      });
    }
    context.store.close();

    assert.throws(
      () => new SqliteStore(context.filename),
      /non-repair turn input without exact queue evidence/u,
    );
  });
}

test("a reopened valid history cannot reuse a RELAYED CODEX provider turn id", (t) => {
  const context = fixture(t);
  const first = executeTurn(context, proposal("Persist the first provider receipt."), 1);
  executeTurn(context, critique(first.proposalArtifact.proposalRefHash), 2);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const controller = new DiscussionController({ store: reopened });
  const claimed = controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  assert.throws(() => controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { externalTurnId: "external-turn-1" },
  }), (error) => error.code === "AGENT_SESSION_TURN_ID_REUSED");
  reopened.close();
});

test("the same provider turn id remains distinct across CODEX and WEB actors", (t) => {
  const context = fixture(t);
  const first = executeTurn(context, proposal("Keep provider turn ids actor-scoped."), 1);
  const claimed = context.controller.claimNext({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
  });
  const submitted = context.controller.markSubmitted({
    runId: context.run.runId,
    expectedRunVersion: context.run.version,
    deliveryId: claimed.deliveryId,
    expectedDeliveryVersion: claimed.version,
    providerReceipt: { externalTurnId: "external-turn-1" },
  });
  assert.equal(submitted.turnInput.targetActor, AgentActor.CHATGPT_WEB_AGENT);
  assert.equal(submitted.session.sessionId, "session-web");
  assert.equal(submitted.delivery.providerReceipt.externalTurnId, "external-turn-1");
  assert.equal(first.message.turnId, "external-turn-1");
  context.store.close();
});

test("startup rejects deletion of the initial queue rows retained by its event", (t) => {
  const context = fixture(t, { runId: "run-deleted-queue" });
  const [input] = context.store.listAgentTurnInputs(context.run.runId);
  const [delivery] = context.store.listDeliveries(context.run.runId);
  context.store.close();

  const database = new DatabaseSync(context.filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("DELETE FROM delivery_attempts WHERE delivery_id = ?").run(delivery.deliveryId);
  database.prepare("DELETE FROM agent_turn_inputs WHERE input_id = ?").run(input.inputId);
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /input\/delivery evidence is inconsistent/u,
  );
});

test("startup rejects a coherently forged initial input retained by queue evidence", (t) => {
  const context = fixture(t, { runId: "run-forged-queue" });
  const [input] = context.store.listAgentTurnInputs(context.run.runId);
  context.store.close();

  const forged = {
    ...input,
    payload: { objective: "Forged objective" },
    payloadHash: sha256CanonicalJson({ objective: "Forged objective" }),
    promptHash: sha256Text("forged prompt"),
  };
  const database = new DatabaseSync(context.filename);
  database.prepare(`
    UPDATE agent_turn_inputs
    SET payload_hash = ?, prompt_hash = ?, input_json = ?
    WHERE input_id = ?
  `).run(
    forged.payloadHash,
    forged.promptHash,
    canonicalJson(forged),
    input.inputId,
  );
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /input\/delivery evidence is inconsistent/u,
  );
});

test("startup rejects a provider receipt changed after submission evidence", (t) => {
  const context = fixture(t, { runId: "run-forged-provider-receipt" });
  const completed = executeTurn(context, proposal("Bind the provider receipt."), 1);
  context.store.close();

  const database = new DatabaseSync(context.filename);
  database.prepare(`
    UPDATE delivery_attempts SET provider_receipt_json = ? WHERE delivery_id = ?
  `).run(
    canonicalJson({ accepted: true, externalTurnId: "external-turn-1", forged: true }),
    completed.delivery.deliveryId,
  );
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /current provider receipt does not match its latest submission evidence/u,
  );
});

test("terminal consensus rejects and detects any additional delivery", (t) => {
  const context = fixture(t, { runId: "run-terminal-no-next" });
  const first = executeTurn(context, proposal("Create proposal X."), 1);
  executeTurn(context, critique(first.proposalArtifact.proposalRefHash), 2);
  const revised = executeTurn(context, proposal("Create accepted proposal Y."), 3);
  executeTurn(context, accept(revised.proposalArtifact.proposalRefHash), 4);
  const completed = executeTurn(context, accept(revised.proposalArtifact.proposalRefHash), 5);
  assert.equal(completed.run.phase, RunPhase.COMPLETE);

  const source = context.store.listAgentTurnInputs(context.run.runId).at(-1);
  const forged = { ...source, inputId: "input-after-terminal" };
  assert.throws(() => context.store.saveAgentTurnInputWithDelivery({
    turnInput: forged,
    deliveryId: "delivery-after-terminal",
    idempotencyKey: "idempotency-after-terminal",
    createdAt: forged.createdAt,
  }), (error) => error.code === "TERMINAL_RUN_INPUT_FORBIDDEN");
  context.store.close();

  const database = new DatabaseSync(context.filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare(`
    INSERT INTO agent_turn_inputs (
      input_id, run_id, target_actor, kind, source_message_id,
      payload_hash, prompt_hash, input_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    forged.inputId,
    forged.runId,
    forged.targetActor,
    forged.kind,
    forged.sourceMessageId,
    forged.payloadHash,
    forged.promptHash,
    canonicalJson(forged),
    forged.createdAt,
  );
  database.prepare(`
    INSERT INTO delivery_attempts (
      delivery_id, run_id, input_id, idempotency_key, state,
      attempt_count, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(
    "delivery-after-terminal",
    forged.runId,
    forged.inputId,
    "idempotency-after-terminal",
    DeliveryState.PENDING,
    forged.createdAt,
    forged.createdAt,
  );
  database.close();

  assert.throws(
    () => new SqliteStore(context.filename),
    /non-repair turn input without exact queue evidence|retains unsettled delivery/u,
  );
});
