import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { sha256Text } from "../src/domain/canonical-json.js";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { CodexDiscussionPacketEnvelopeSchema } from "../src/domain/packet-json-schemas.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
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
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { DiscussionOutboxDispatcher } from "../src/orchestration/discussion-dispatcher.js";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";
import { RunService } from "../src/orchestration/run-service.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";
import {
  ScriptedDiscussionRuntime,
  controllerEnvelopeFromPrompt,
  createFakeDiscussionSessions,
} from "./support/fake-discussion-sessions.js";

const T0 = "2026-09-04T08:00:00.000Z";

function proposal(body) {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Dispatcher-backed discussion",
    body,
    assumptions: [],
    open_decisions: [],
  };
}

function critique(proposalRefHash) {
  return {
    type: AgentPacketType.CRITIQUE,
    target_proposal_sha256: proposalRefHash,
    blocking_findings: ["Persist and relay through the dispatcher."],
    non_blocking_findings: [],
    requested_changes: ["Submit the revised proposal through the same outbox."],
  };
}

function accept(proposalRefHash) {
  return {
    type: AgentPacketType.ACCEPT,
    accepted_proposal_sha256: proposalRefHash,
    blocking_findings: [],
  };
}

function referencedProposal(prompt) {
  const peer = controllerEnvelopeFromPrompt(prompt).peer_message;
  return peer.proposal_ref_sha256
    ?? peer.normalized_packet.accepted_proposal_sha256
    ?? peer.normalized_packet.target_proposal_sha256;
}

function fixture(t, {
  runId,
  steps,
  maxTurns = 12,
  artifactStore = null,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "discussion-dispatcher-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let id = 0;
  let tick = 0;
  const idFactory = () => String(++id).padStart(5, "0");
  const clock = () => new Date(Date.parse(T0) + tick++).toISOString();
  const store = new SqliteStore(filename);
  const service = new RunService({ store, idFactory, clock });
  const created = service.createRun({
    runId,
    objective: "Reach one durable proposal accepted by both independent agents",
    policy: createDiscussionRunPolicy({ maxTurns }),
  });
  for (const actor of [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT]) {
    const codex = actor === AgentActor.CODEX_AGENT;
    store.createAgentSession({
      session: createAgentSessionRecord({
        sessionId: codex ? "session-codex" : "session-web",
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
  const controller = new DiscussionController({ store, artifactStore, idFactory, clock });
  controller.start({ runId, expectedVersion: created.version });
  const runtime = new ScriptedDiscussionRuntime(steps);
  return {
    artifactStore,
    clock,
    controller,
    directory,
    filename,
    idFactory,
    runtime,
    service,
    store,
  };
}

function sessionRegistry(sessions, durableCallbacks = []) {
  return Object.freeze({
    [AgentActor.CODEX_AGENT]: Object.freeze({
      sessionId: "session-codex",
      session: sessions[AgentActor.CODEX_AGENT],
    }),
    [AgentActor.CHATGPT_WEB_AGENT]: Object.freeze({
      sessionId: "session-web",
      session: sessions[AgentActor.CHATGPT_WEB_AGENT],
      afterDurableResponse: async (value) => {
        durableCallbacks.push(value ?? null);
        await sessions[AgentActor.CHATGPT_WEB_AGENT].acknowledgeDelivery(value ?? {});
      },
    }),
  });
}

function dispatcher(context, store, sessions, durableCallbacks = []) {
  return new DiscussionOutboxDispatcher({
    store,
    controller: new DiscussionController({
      store,
      artifactStore: context.artifactStore,
      idFactory: context.idFactory,
      clock: context.clock,
    }),
    sessions: sessionRegistry(sessions, durableCallbacks),
    artifactStore: context.artifactStore,
  });
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fiveTurnScript() {
  return [
    {
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Store proposal X before asking the independent reviewer."),
    },
    {
      actor: AgentActor.CHATGPT_WEB_AGENT,
      response: ({ input }) => ({ packet: critique(referencedProposal(input.text)) }),
    },
    {
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Store revised proposal Y and relay it through the durable outbox."),
    },
    {
      actor: AgentActor.CHATGPT_WEB_AGENT,
      response: ({ input }) => ({ packet: accept(referencedProposal(input.text)) }),
    },
    {
      actor: AgentActor.CODEX_AGENT,
      response: ({ input }) => ({ packet: accept(referencedProposal(input.text)) }),
    },
  ];
}

test("dispatcher resumes the five-turn consensus from a reopened PENDING outbox", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-reopen",
    steps: fiveTurnScript(),
  });
  const firstSessions = createFakeDiscussionSessions(context.runtime);
  const firstDispatcher = dispatcher(context, context.store, firstSessions);

  await firstDispatcher.dispatchNext({ runId: "run-dispatcher-reopen" });
  assert.equal(context.runtime.submissions.length, 1);
  assert.equal(context.store.listAgentMessages("run-dispatcher-reopen").length, 1);
  const pendingBeforeRestart = context.store.listDispatchableDeliveries({
    runId: "run-dispatcher-reopen",
  });
  assert.equal(pendingBeforeRestart.length, 1);
  assert.equal(
    context.store.getAgentTurnInput(pendingBeforeRestart[0].inputId).targetActor,
    AgentActor.CHATGPT_WEB_AGENT,
  );
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const resumedSessions = createFakeDiscussionSessions(context.runtime);
  const durableWebCallbacks = [];
  const resumedDispatcher = dispatcher(
    context,
    reopened,
    resumedSessions,
    durableWebCallbacks,
  );
  await resumedDispatcher.runUntilSettled({
    runId: "run-dispatcher-reopen",
    maxDispatches: 4,
  });

  const run = reopened.getRun("run-dispatcher-reopen");
  const outcome = reopened.getRunOutcome(run.runId);
  assert.equal(run.phase, RunPhase.COMPLETE);
  assert.equal(run.currentTurn, 5);
  assert.deepEqual(outcome.outcome, {
    type: RunOutcomeType.CONSENSUS,
    proposalHash: reopened.listProposalArtifacts(run.runId).at(-1).proposalRefHash,
  });
  assert.deepEqual(
    context.runtime.submissions.map(({ actor }) => actor),
    [
      AgentActor.CODEX_AGENT,
      AgentActor.CHATGPT_WEB_AGENT,
      AgentActor.CODEX_AGENT,
      AgentActor.CHATGPT_WEB_AGENT,
      AgentActor.CODEX_AGENT,
    ],
  );
  assert.equal(context.runtime.remainingSteps, 0);
  assert.equal(reopened.listAgentTurnInputs(run.runId).length, 5);
  assert.equal(reopened.listAgentMessages(run.runId).length, 5);
  assert.equal(reopened.listDeliveries(run.runId).length, 5);
  assert.equal(reopened.listDispatchableDeliveries({ runId: run.runId }).length, 0);
  assert.equal(durableWebCallbacks.length, 2);

  const inputsById = new Map(
    reopened.listAgentTurnInputs(run.runId).map((input) => [input.inputId, input]),
  );
  for (const submission of context.runtime.submissions) {
    const input = inputsById.get(submission.input.controllerMessageId);
    assert(input, "each runtime submission must name its durable AgentTurnInput");
    assert.equal(sha256Text(submission.input.text), input.promptHash);
    if (submission.actor === AgentActor.CODEX_AGENT) {
      assert.deepEqual(submission.input.outputSchema, CodexDiscussionPacketEnvelopeSchema);
    }
  }
  for (const delivery of reopened.listDeliveries(run.runId)) {
    const input = reopened.getAgentTurnInput(delivery.inputId);
    const message = reopened.getAgentMessageByInput(input.inputId);
    assert(message);
    assert.equal(message.actor, input.targetActor);
    assert.equal(message.sessionId, input.targetActor === AgentActor.CODEX_AGENT
      ? "session-codex"
      : "session-web");
    assert.equal(message.turnId, delivery.providerReceipt.externalTurnId);
  }

  const submitCount = context.runtime.submissions.length;
  await resumedDispatcher.runUntilSettled({ runId: run.runId, maxDispatches: 10 });
  assert.equal(context.runtime.submissions.length, submitCount, "COMPLETE must not submit turn six");
  assert.deepEqual(reopened.verifyEventChains(run.runId).valid, true);
  assert.equal(reopened.rebuildRunProjection(run.runId, { compare: true }).replaced, false);
  reopened.close();
});

test("a reopened SUBMITTED delivery is recovery work and is never automatically resubmitted", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-submitted",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Hold this provider turn across Controller restart."),
      manual: true,
    }],
  });
  const firstSessions = createFakeDiscussionSessions(context.runtime);
  const firstDispatcher = dispatcher(context, context.store, firstSessions);
  const inFlight = firstDispatcher.dispatchNext({ runId: "run-dispatcher-submitted" });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-dispatcher-submitted")
      .find((delivery) => delivery.state === DeliveryState.SUBMITTED),
    "dispatcher did not persist the submitted provider receipt",
  );
  assert.equal(context.runtime.submissions.length, 1);
  firstDispatcher.close();
  await assert.rejects(
    inFlight,
    (error) => error.code === "RUNTIME_EVENT_CONSUMER_CLOSED",
  );
  const beforeLateCompletion = {
    delivery: context.store.getDelivery(submitted.deliveryId),
    events: context.store.listDomainEvents("run-dispatcher-submitted"),
    messages: context.store.listAgentMessages("run-dispatcher-submitted"),
    run: context.store.getRun("run-dispatcher-submitted"),
  };
  firstSessions[AgentActor.CODEX_AGENT].completeActive();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({
    delivery: context.store.getDelivery(submitted.deliveryId),
    events: context.store.listDomainEvents("run-dispatcher-submitted"),
    messages: context.store.listAgentMessages("run-dispatcher-submitted"),
    run: context.store.getRun("run-dispatcher-submitted"),
  }, beforeLateCompletion);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const resumedSessions = createFakeDiscussionSessions(context.runtime);
  const resumedDispatcher = dispatcher(context, reopened, resumedSessions);
  assert.equal(
    await resumedDispatcher.dispatchNext({ runId: "run-dispatcher-submitted" }),
    null,
  );
  assert.equal(context.runtime.submissions.length, 1);
  assert.equal(reopened.getDelivery(submitted.deliveryId).state, DeliveryState.SUBMITTED);
  const recovery = scanStartupRecovery(reopened);
  assert.equal(recovery.length, 1);
  assert.deepEqual(
    recovery[0].reasons.map(({ type }) => type),
    ["TURN_RUNNING", "DELIVERY_UNCERTAIN"],
  );
  reopened.close();
});

test("completion emitted before submitTurn returns is buffered until submission is durable", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-synchronous-completion",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Buffer this completion until its submission receipt is durable."),
      manual: true,
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const codex = sessions[AgentActor.CODEX_AGENT];
  const originalSubmit = codex.submitTurn.bind(codex);
  codex.submitTurn = async (input) => {
    const handle = await originalSubmit(input);
    codex.completeActive();
    return handle;
  };
  const activeDispatcher = dispatcher(context, context.store, sessions);

  const result = await activeDispatcher.dispatchNext({
    runId: "run-dispatcher-synchronous-completion",
  });
  assert.equal(result.status, "RESPONSE_RECORDED");
  assert.equal(context.store.listAgentMessages("run-dispatcher-synchronous-completion").length, 1);
  const [firstDelivery, nextDelivery] = context.store.listDeliveries(
    "run-dispatcher-synchronous-completion",
  );
  assert.equal(firstDelivery.state, DeliveryState.RELAYED);
  assert.equal(nextDelivery.state, DeliveryState.PENDING);
  assert.equal(context.runtime.submissions.length, 1);
  context.store.close();
});

test("provider submission before receipt persistence reopens as uncertain and is not resent", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-pre-receipt-crash",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Do not resend an unrecorded provider submission after restart."),
      manual: true,
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const codex = sessions[AgentActor.CODEX_AGENT];
  const originalSubmit = codex.submitTurn.bind(codex);
  const handleCreated = deferred();
  const releaseHandle = deferred();
  codex.submitTurn = async (input) => {
    const handle = await originalSubmit(input);
    handleCreated.resolve();
    await releaseHandle.promise;
    return handle;
  };
  const firstDispatcher = dispatcher(context, context.store, sessions);
  const inFlight = firstDispatcher.dispatchNext({ runId: "run-dispatcher-pre-receipt-crash" });
  await handleCreated.promise;
  const [dispatching] = context.store.listDeliveries("run-dispatcher-pre-receipt-crash");
  assert.equal(dispatching.state, DeliveryState.DISPATCHING);
  assert.equal(context.runtime.submissions.length, 1);
  firstDispatcher.close();
  releaseHandle.resolve();
  await assert.rejects(inFlight);
  context.store.close();

  const reopened = new SqliteStore(context.filename);
  const resumedSessions = createFakeDiscussionSessions(context.runtime);
  const resumedDispatcher = dispatcher(context, reopened, resumedSessions);
  assert.equal(
    await resumedDispatcher.dispatchNext({ runId: "run-dispatcher-pre-receipt-crash" }),
    null,
  );
  assert.equal(context.runtime.submissions.length, 1);
  assert.equal(reopened.getDelivery(dispatching.deliveryId).state, DeliveryState.DISPATCHING);
  assert.deepEqual(
    scanStartupRecovery(reopened)[0].reasons.map(({ type }) => type),
    ["DELIVERY_UNCERTAIN"],
  );
  reopened.close();
});

test("terminal runtime events require exact attribution and are applied at most once", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-correlation",
    steps: [
      {
        actor: AgentActor.CODEX_AGENT,
        packet: proposal("Apply only the exact CODEX completion."),
        manual: true,
      },
      {
        actor: AgentActor.CHATGPT_WEB_AGENT,
        response: ({ input }) => ({
          packet: critique(referencedProposal(input.text)),
          manual: true,
        }),
      },
    ],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);
  const firstDispatch = activeDispatcher.dispatchNext({ runId: "run-dispatcher-correlation" });
  await waitFor(
    () => context.store.listDeliveries("run-dispatcher-correlation")
      .some(({ state }) => state === DeliveryState.SUBMITTED),
    "first fake turn was not submitted",
  );
  sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
    type: "TURN_COMPLETED",
    sourceMethod: "turn/completed",
    threadId: "thread-codex",
    turnId: "foreign-turn",
    itemId: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.store.listAgentMessages("run-dispatcher-correlation").length, 0);

  sessions[AgentActor.CODEX_AGENT].completeActive();
  await firstDispatch;
  assert.equal(context.store.listAgentMessages("run-dispatcher-correlation").length, 1);
  const codexTerminal = sessions[AgentActor.CODEX_AGENT].lastTerminalEvent;

  const secondDispatch = activeDispatcher.dispatchNext({ runId: "run-dispatcher-correlation" });
  await waitFor(
    () => context.store.getRun("run-dispatcher-correlation").phase === RunPhase.WEB_TURN_RUNNING,
    "second fake turn was not submitted",
  );
  const stableBeforeLateEvent = {
    messages: context.store.listAgentMessages("run-dispatcher-correlation").length,
    deliveries: context.store.listDeliveries("run-dispatcher-correlation").length,
    version: context.store.getRun("run-dispatcher-correlation").version,
  };
  sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent(codexTerminal);
  sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent(codexTerminal);
  sessions[AgentActor.CHATGPT_WEB_AGENT].emitRuntimeEvent({
    type: "TURN_COMPLETED",
    occurredAt: T0,
    sessionId: "session-web",
    turnId: "foreign-web-turn",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({
    messages: context.store.listAgentMessages("run-dispatcher-correlation").length,
    deliveries: context.store.listDeliveries("run-dispatcher-correlation").length,
    version: context.store.getRun("run-dispatcher-correlation").version,
  }, stableBeforeLateEvent);

  sessions[AgentActor.CHATGPT_WEB_AGENT].completeActive();
  await secondDispatch;
  const stableAfterCompletion = {
    messages: context.store.listAgentMessages("run-dispatcher-correlation").length,
    deliveries: context.store.listDeliveries("run-dispatcher-correlation").length,
    version: context.store.getRun("run-dispatcher-correlation").version,
  };
  sessions[AgentActor.CHATGPT_WEB_AGENT].emitRuntimeEvent(
    sessions[AgentActor.CHATGPT_WEB_AGENT].lastTerminalEvent,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({
    messages: context.store.listAgentMessages("run-dispatcher-correlation").length,
    deliveries: context.store.listDeliveries("run-dispatcher-correlation").length,
    version: context.store.getRun("run-dispatcher-correlation").version,
  }, stableAfterCompletion);
  assert.equal(context.runtime.submissions.length, 2);
  context.store.close();
});

test("dispatcher serializes claims and honors pause versions before submit and response storage", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-pause-races",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Preserve a response across both pause race windows."),
      manual: true,
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const codex = sessions[AgentActor.CODEX_AGENT];
  const originalSubmit = codex.submitTurn.bind(codex);
  const handleCreated = deferred();
  const releaseHandle = deferred();
  codex.submitTurn = async (input) => {
    const handle = await originalSubmit(input);
    handleCreated.resolve();
    await releaseHandle.promise;
    return handle;
  };
  const activeDispatcher = dispatcher(context, context.store, sessions);
  const dispatch = activeDispatcher.dispatchNext({ runId: "run-dispatcher-pause-races" });
  await handleCreated.promise;

  await assert.rejects(
    activeDispatcher.dispatchNext({ runId: "run-dispatcher-pause-races" }),
    (error) => error.code === "DISCUSSION_DISPATCHER_BUSY",
  );
  const pausedBeforeSubmit = context.service.pause({
    runId: "run-dispatcher-pause-races",
    expectedVersion: context.store.getRun("run-dispatcher-pause-races").version,
  });
  assert.equal(pausedBeforeSubmit.paused, true);
  releaseHandle.resolve();

  const submitted = await waitFor(
    () => context.store.listDeliveries("run-dispatcher-pause-races")
      .find(({ state }) => state === DeliveryState.SUBMITTED),
    "paused provider turn was not durably submitted",
  );
  const [{ turnId }] = context.runtime.submissions;
  assert.equal(context.store.getRun("run-dispatcher-pause-races").paused, true);
  codex.emitRuntimeEvent({
    type: "TEXT_DELTA",
    sourceMethod: "item/agentMessage/delta",
    threadId: "thread-codex",
    turnId,
    itemId: null,
    delta: "first output",
  });
  await waitFor(
    () => context.store.getDelivery(submitted.deliveryId).state === DeliveryState.RESPONSE_STARTED,
    "TEXT_DELTA was not persisted as RESPONSE_STARTED",
  );

  codex.completeActive();
  const result = await dispatch;

  assert.equal(result.status, "RESPONSE_RECORDED");
  assert.equal(result.run.paused, true);
  assert.equal(result.run.phase, RunPhase.CODEX_TO_WEB_PENDING);
  assert.equal(context.runtime.submissions.length, 1);
  assert.equal(context.store.listDeliveries("run-dispatcher-pause-races").length, 2);
  assert.equal(
    context.store.listDispatchableDeliveries({ runId: "run-dispatcher-pause-races" }).length,
    1,
  );
  context.store.close();
});

test("runtime preflight failure leaves the delivery PENDING", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-preflight",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("This runtime binding must not pass preflight."),
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const bindings = sessionRegistry(sessions);
  const invalidBindings = Object.freeze({
    ...bindings,
    [AgentActor.CODEX_AGENT]: Object.freeze({
      ...bindings[AgentActor.CODEX_AGENT],
      sessionId: "wrong-session",
    }),
  });
  const activeDispatcher = new DiscussionOutboxDispatcher({
    store: context.store,
    controller: context.controller,
    sessions: invalidBindings,
  });

  await assert.rejects(
    activeDispatcher.dispatchNext({ runId: "run-dispatcher-preflight" }),
    (error) => error.code === "RUNTIME_SESSION_BINDING_MISMATCH",
  );
  const [delivery] = context.store.listDeliveries("run-dispatcher-preflight");
  assert.equal(delivery.state, DeliveryState.PENDING);
  assert.equal(context.runtime.submissions.length, 0);
  context.store.close();
});

test("completion attribution mismatch remains recovery work rather than an Agent rejection", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-dispatcher-attribution-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), { recursive: true, force: true }));
  const context = fixture(t, {
    runId: "run-dispatcher-attribution",
    artifactStore,
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("A foreign completion identity must never become my rejection."),
      completionOverrides: { turnId: "foreign-completion-turn" },
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);

  await assert.rejects(
    activeDispatcher.dispatchNext({ runId: "run-dispatcher-attribution" }),
    (error) => error.code === "RUNTIME_COMPLETION_TURN_MISMATCH",
  );
  const [delivery] = context.store.listDeliveries("run-dispatcher-attribution");
  assert.equal(delivery.state, DeliveryState.RESPONSE_STARTED);
  assert.equal(context.store.getAgentPacketRejectionByDelivery(delivery.deliveryId), null);
  assert.equal(context.store.listAgentMessages("run-dispatcher-attribution").length, 0);
  assert.equal(context.store.listAgentTurnInputs("run-dispatcher-attribution").length, 1);
  assert.equal(context.store.getRunOutcome("run-dispatcher-attribution"), null);
  assert.deepEqual(
    scanStartupRecovery(context.store)[0].reasons.map(({ type }) => type),
    ["TURN_RUNNING", "DELIVERY_UNCERTAIN"],
  );
  context.store.close();
});

test("a turn event without provider session identity fails closed", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-missing-event-identity",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Every authoritative turn event needs its thread identity."),
      manual: true,
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);
  const dispatch = activeDispatcher.dispatchNext({
    runId: "run-dispatcher-missing-event-identity",
  });
  await waitFor(
    () => context.store.listDeliveries("run-dispatcher-missing-event-identity")
      .some(({ state }) => state === DeliveryState.SUBMITTED),
    "identity test turn was not submitted",
  );
  const [{ turnId }] = context.runtime.submissions;
  sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
    type: "TEXT_DELTA",
    sourceMethod: "item/agentMessage/delta",
    turnId,
    itemId: null,
    delta: "unattributed output",
  });

  await assert.rejects(
    dispatch,
    (error) => error.code === "RUNTIME_EVENT_SESSION_IDENTITY_MISSING",
  );
  const [delivery] = context.store.listDeliveries("run-dispatcher-missing-event-identity");
  assert.equal(delivery.state, DeliveryState.SUBMITTED);
  assert.equal(context.store.getAgentPacketRejectionByDelivery(delivery.deliveryId), null);
  assert.equal(context.store.listAgentMessages("run-dispatcher-missing-event-identity").length, 0);
  context.store.close();
});

test("a context-invalid packet is durably rejected and repaired by the same actor", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-dispatcher-context-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), { recursive: true, force: true }));
  const context = fixture(t, {
    runId: "run-dispatcher-context-rejection",
    artifactStore,
    steps: [
      {
        actor: AgentActor.CODEX_AGENT,
        packet: proposal("Create the proposal whose reference is frozen by the Controller."),
      },
      {
        actor: AgentActor.CHATGPT_WEB_AGENT,
        packet: critique(`sha256:${"0".repeat(64)}`),
      },
    ],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);
  await activeDispatcher.dispatchNext({ runId: "run-dispatcher-context-rejection" });
  const rejected = await activeDispatcher.dispatchNext({
    runId: "run-dispatcher-context-rejection",
  });

  assert.equal(rejected.status, "RESPONSE_REJECTED");
  assert.equal(rejected.rejectionEvent.errorCode, "PROPOSAL_REFERENCE_MISMATCH");
  assert.equal(rejected.rejectionEvent.parserStage, "HASH_BINDING");
  assert.equal(rejected.nextDelivery.turnInput.kind, AgentTurnInputKind.PROTOCOL_REPAIR);
  assert.equal(rejected.nextDelivery.turnInput.targetActor, AgentActor.CHATGPT_WEB_AGENT);
  assert.deepEqual(
    rejected.nextDelivery.turnInput.payload.allowedPacketTypes,
    [AgentPacketType.CRITIQUE, AgentPacketType.ACCEPT, AgentPacketType.BLOCKED],
  );
  assert.equal(context.store.listAgentMessages("run-dispatcher-context-rejection").length, 1);
  context.store.close();
});

test("malformed Web output stores only a generic summary and allowlisted derived evidence", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-dispatcher-redaction-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), { recursive: true, force: true }));
  const context = fixture(t, {
    runId: "run-dispatcher-redaction",
    artifactStore,
    steps: [
      {
        actor: AgentActor.CODEX_AGENT,
        packet: proposal("Ask the Web reviewer without persisting its malformed secret."),
      },
      {
        actor: AgentActor.CHATGPT_WEB_AGENT,
        rawText: "review\n<controller_packet>\nsecret=abc123\n</controller_packet>",
      },
    ],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);
  await activeDispatcher.dispatchNext({ runId: "run-dispatcher-redaction" });
  const rejected = await activeDispatcher.dispatchNext({ runId: "run-dispatcher-redaction" });
  const persisted = context.store.getAgentPacketRejectionByDelivery(
    rejected.delivery.deliveryId,
  );
  const artifactText = artifactStore.read(persisted.rawResponseArtifactHash).toString("utf8");

  assert.equal(persisted.parserStage, "JSON_PARSE");
  assert.equal(persisted.errorSummary, "Agent response failed strict protocol validation.");
  assert.equal(JSON.stringify(context.store.listDomainEvents(context.store.getRun(
    "run-dispatcher-redaction",
  ).runId)).includes("abc123"), false);
  assert.equal(artifactText.includes("abc123"), false);
  assert.match(artifactText, /discussion-runtime-response-evidence-v1/u);
  assert.match(artifactText, /"observedCandidatePacketType":null/u);
  context.store.close();
});

test("a correlated runtime approval fails closed without inventing approval authority", async (t) => {
  const context = fixture(t, {
    runId: "run-dispatcher-runtime-approval",
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      packet: proposal("Wait for a trusted runtime approval evidence producer."),
      manual: true,
    }],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);
  const dispatch = activeDispatcher.dispatchNext({
    runId: "run-dispatcher-runtime-approval",
  });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-dispatcher-runtime-approval")
      .find(({ state }) => state === DeliveryState.SUBMITTED),
    "approval test turn was not durably submitted",
  );
  const [{ turnId }] = context.runtime.submissions;

  sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/commandExecution/requestApproval",
    requestId: "runtime-approval-request-1",
    threadId: "thread-codex",
    turnId,
    itemId: "runtime-item-1",
    availableDecisions: ["accept", "decline"],
    proposedExecpolicyAmendment: null,
  });
  await assert.rejects(
    dispatch,
    (error) => error.code === "RUNTIME_APPROVAL_EVIDENCE_UNSUPPORTED",
  );

  const run = context.store.getRun("run-dispatcher-runtime-approval");
  assert.equal(run.phase, RunPhase.CODEX_TURN_RUNNING);
  assert.equal(run.activeActor, AgentActor.CODEX_AGENT);
  assert.equal(run.blocker, null);
  assert.equal(context.store.getDelivery(submitted.deliveryId).state, DeliveryState.SUBMITTED);
  assert.equal(context.store.listAgentMessages(run.runId).length, 0);
  assert.equal(context.store.listApprovals({ runId: run.runId }).length, 0);
  assert.equal(context.store.listRecoveryOperations({ runId: run.runId }).length, 0);
  assert.equal(context.store.listAgentTurnInputs(run.runId).length, 1);
  assert.equal(context.store.listDeliveries(run.runId).length, 1);
  assert.equal(context.store.getRunOutcome(run.runId), null);
  assert.deepEqual(
    scanStartupRecovery(context.store)[0].reasons.map(({ type }) => type),
    ["TURN_RUNNING", "DELIVERY_UNCERTAIN"],
  );
  context.store.close();
});

test("a typed malformed response queues one same-actor protocol repair", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-dispatcher-artifacts-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), { recursive: true, force: true }));
  const malformedProposal = JSON.stringify({
    type: AgentPacketType.PROPOSAL,
    summary: "Missing the required body",
    assumptions: [],
    open_decisions: [],
  });
  const context = fixture(t, {
    runId: "run-dispatcher-repair",
    artifactStore,
    steps: [
      { actor: AgentActor.CODEX_AGENT, rawText: malformedProposal },
      {
        actor: AgentActor.CODEX_AGENT,
        packet: proposal("A strict repaired proposal may now be relayed."),
      },
    ],
  });
  const sessions = createFakeDiscussionSessions(context.runtime);
  const activeDispatcher = dispatcher(context, context.store, sessions);

  const rejected = await activeDispatcher.dispatchNext({ runId: "run-dispatcher-repair" });
  assert.deepEqual(
    context.runtime.submissions.map(({ actor }) => actor),
    [AgentActor.CODEX_AGENT],
  );
  assert.equal(context.store.listAgentMessages("run-dispatcher-repair").length, 0);
  const inputsAfterRejection = context.store.listAgentTurnInputs("run-dispatcher-repair");
  assert.equal(inputsAfterRejection.length, 2);
  assert.equal(inputsAfterRejection[1].kind, AgentTurnInputKind.PROTOCOL_REPAIR);
  assert.equal(inputsAfterRejection[1].targetActor, AgentActor.CODEX_AGENT);
  assert.deepEqual(
    inputsAfterRejection[1].payload.allowedPacketTypes,
    [AgentPacketType.PROPOSAL, AgentPacketType.BLOCKED],
  );
  assert.equal(context.store.getRunLimits("run-dispatcher-repair").protocolRepairsUsed, 1);
  const persistedRejection = context.store.getAgentPacketRejectionByDelivery(
    rejected.delivery.deliveryId,
  );
  assert.deepEqual(
    JSON.parse(artifactStore.read(
      persistedRejection.rawResponseArtifactHash,
    ).toString("utf8")),
    {
      actor: AgentActor.CODEX_AGENT,
      observedCandidatePacketType: AgentPacketType.PROPOSAL,
      parserStage: "SCHEMA_VALIDATION",
      schema: "discussion-runtime-response-evidence-v1",
    },
  );

  await activeDispatcher.dispatchNext({ runId: "run-dispatcher-repair" });
  assert.deepEqual(
    context.runtime.submissions.map(({ actor }) => actor),
    [AgentActor.CODEX_AGENT, AgentActor.CODEX_AGENT],
  );
  const [message] = context.store.listAgentMessages("run-dispatcher-repair");
  assert.equal(message.kind, AgentMessageKind.PROPOSAL);
  const [next] = context.store.listDispatchableDeliveries({ runId: "run-dispatcher-repair" });
  assert.equal(
    context.store.getAgentTurnInput(next.inputId).targetActor,
    AgentActor.CHATGPT_WEB_AGENT,
  );
  assert.equal(context.store.getRunLimits("run-dispatcher-repair").consecutiveActorFailures, 0);
  context.store.close();
});
