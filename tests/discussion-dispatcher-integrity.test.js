import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionRecord } from "../src/domain/contracts.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  SessionProvider,
} from "../src/domain/vocabulary.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { DiscussionController } from "../src/orchestration/discussion-controller.js";
import { DiscussionOutboxDispatcher } from "../src/orchestration/discussion-dispatcher.js";
import { RunService } from "../src/orchestration/run-service.js";
import { DeliveryState, SqliteStore } from "../src/persistence/sqlite-store.js";
import {
  ScriptedDiscussionRuntime,
  controllerEnvelopeFromPrompt,
  createFakeDiscussionSessions,
} from "./support/fake-discussion-sessions.js";

const T0 = "2026-09-04T09:00:00.000Z";

function proposal(body = "Keep exact runtime attribution.") {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Integrity probe",
    body,
    assumptions: [],
    open_decisions: [],
  };
}

function critique(proposalRefHash) {
  return {
    type: AgentPacketType.CRITIQUE,
    target_proposal_sha256: proposalRefHash,
    blocking_findings: ["Keep the runtime binding stable."],
    non_blocking_findings: [],
    requested_changes: ["Reject a response from a replaced session."],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFixture(t, { runId, steps, artifactStore = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "discussion-dispatcher-integrity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(join(directory, "controller.sqlite"));
  let id = 0;
  let tick = 0;
  const idFactory = () => `integrity-${++id}`;
  const clock = () => new Date(Date.parse(T0) + tick++).toISOString();
  const runService = new RunService({ store, idFactory, clock });
  const run = runService.createRun({
    runId,
    objective: "Reject stale runtime attribution and unsafe evidence",
    policy: createDiscussionRunPolicy({ maxTurns: 8 }),
  });
  for (const actor of Object.values(AgentActor)) {
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
  controller.start({ runId, expectedVersion: run.version });
  const runtime = new ScriptedDiscussionRuntime(steps);
  const sessions = createFakeDiscussionSessions(runtime);
  return { artifactStore, clock, controller, directory, idFactory, runtime, sessions, store };
}

function bindings(sessions, afterDurableResponse = undefined) {
  return Object.freeze({
    [AgentActor.CODEX_AGENT]: Object.freeze({
      sessionId: "session-codex",
      session: sessions[AgentActor.CODEX_AGENT],
      ...(afterDurableResponse === undefined ? {} : { afterDurableResponse }),
    }),
    [AgentActor.CHATGPT_WEB_AGENT]: Object.freeze({
      sessionId: "session-web",
      session: sessions[AgentActor.CHATGPT_WEB_AGENT],
    }),
  });
}

function createDispatcher(context, options = {}) {
  return new DiscussionOutboxDispatcher({
    store: context.store,
    controller: context.controller,
    sessions: bindings(context.sessions, options.afterDurableResponse),
    artifactStore: context.artifactStore,
    ...options,
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

function mutatePersistedSession(store, sessionId, changes) {
  const session = store.getAgentSession(sessionId);
  return store.updateAgentSession({
    session: {
      ...session,
      ...changes,
      version: session.version + 1,
    },
    expectedVersion: session.version,
    updatedAt: T0,
  });
}

function rebindPersistedSession(store, externalSessionId) {
  return mutatePersistedSession(store, "session-codex", { externalSessionId });
}

test("a session rebind before receipt persistence cannot own the submitted turn", async (t) => {
  const context = createFixture(t, {
    runId: "run-rebind-before-submit",
    steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal(), manual: true }],
  });
  const originalSubmit = context.sessions[AgentActor.CODEX_AGENT].submitTurn.bind(
    context.sessions[AgentActor.CODEX_AGENT],
  );
  context.sessions[AgentActor.CODEX_AGENT].submitTurn = async (input) => {
    const handle = await originalSubmit(input);
    rebindPersistedSession(context.store, "thread-rebound");
    return handle;
  };
  const dispatcher = createDispatcher(context);
  const dispatch = dispatcher.dispatchNext({ runId: "run-rebind-before-submit" });
  const early = await Promise.race([
    dispatch.then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 50)),
  ]);
  if (early.status === "pending") {
    context.sessions[AgentActor.CODEX_AGENT].completeActive();
    await dispatch;
    assert.fail("a stale pre-submit session binding was accepted");
  }
  assert.equal(early.status, "rejected");
  assert.equal(early.error.code, "AGENT_SESSION_BINDING_CHANGED");
  const [delivery] = context.store.listDeliveries("run-rebind-before-submit");
  assert.equal(delivery.state, DeliveryState.DISPATCHING);
  assert.equal(context.store.listAgentMessages("run-rebind-before-submit").length, 0);
  context.store.close();
});

test("a session rebind after submission is rejected before response persistence", async (t) => {
  const context = createFixture(t, {
    runId: "run-rebind-after-submit",
    steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal(), manual: true }],
  });
  const dispatcher = createDispatcher(context);
  const dispatch = dispatcher.dispatchNext({ runId: "run-rebind-after-submit" });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-rebind-after-submit")
      .find(({ state }) => state === DeliveryState.SUBMITTED),
    "turn was not submitted",
  );
  rebindPersistedSession(context.store, "thread-rebound");
  context.sessions[AgentActor.CODEX_AGENT].completeActive();

  await assert.rejects(
    dispatch,
    (error) => error.code === "AGENT_SESSION_BINDING_CHANGED",
  );
  assert.equal(context.store.getDelivery(submitted.deliveryId).state, DeliveryState.SUBMITTED);
  assert.equal(context.store.listAgentMessages("run-rebind-after-submit").length, 0);
  context.store.close();
});

test("binding drift after RESPONSE_STARTED cannot own a valid response", async (t) => {
  const context = createFixture(t, {
    runId: "run-rebind-after-response-start",
    steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal(), manual: true }],
  });
  const dispatcher = createDispatcher(context);
  const dispatch = dispatcher.dispatchNext({ runId: "run-rebind-after-response-start" });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-rebind-after-response-start")
      .find(({ state }) => state === DeliveryState.SUBMITTED),
    "turn was not submitted",
  );
  const [{ turnId }] = context.runtime.submissions;
  context.sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
    type: "TEXT_DELTA",
    sourceMethod: "item/agentMessage/delta",
    threadId: "thread-codex",
    turnId,
    itemId: null,
    delta: "started",
  });
  await waitFor(
    () => context.store.getDelivery(submitted.deliveryId).state === DeliveryState.RESPONSE_STARTED,
    "response start was not persisted",
  );
  mutatePersistedSession(context.store, "session-codex", {
    externalLocator: "codex-thread://rebound",
  });
  context.sessions[AgentActor.CODEX_AGENT].completeActive();

  await assert.rejects(
    dispatch,
    (error) => error.code === "AGENT_SESSION_BINDING_CHANGED",
  );
  assert.equal(
    context.store.getDelivery(submitted.deliveryId).state,
    DeliveryState.RESPONSE_STARTED,
  );
  assert.equal(context.store.listAgentMessages("run-rebind-after-response-start").length, 0);
  context.store.close();
});

test("version-only drift cannot turn malformed output into a rejection or repair", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-invalid-binding-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), {
    recursive: true,
    force: true,
  }));
  const context = createFixture(t, {
    runId: "run-invalid-response-rebind",
    artifactStore,
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      rawText: JSON.stringify({ type: AgentPacketType.PROPOSAL }),
      manual: true,
    }],
  });
  const dispatcher = createDispatcher(context);
  const dispatch = dispatcher.dispatchNext({ runId: "run-invalid-response-rebind" });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-invalid-response-rebind")
      .find(({ state }) => state === DeliveryState.SUBMITTED),
    "turn was not submitted",
  );
  const [{ turnId }] = context.runtime.submissions;
  context.sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
    type: "TEXT_DELTA",
    sourceMethod: "item/agentMessage/delta",
    threadId: "thread-codex",
    turnId,
    itemId: null,
    delta: "started",
  });
  await waitFor(
    () => context.store.getDelivery(submitted.deliveryId).state === DeliveryState.RESPONSE_STARTED,
    "response start was not persisted",
  );
  mutatePersistedSession(context.store, "session-codex", {});
  context.sessions[AgentActor.CODEX_AGENT].completeActive();

  await assert.rejects(
    dispatch,
    (error) => error.code === "AGENT_SESSION_BINDING_CHANGED",
  );
  assert.equal(context.store.getAgentPacketRejectionByDelivery(submitted.deliveryId), null);
  assert.equal(context.store.listAgentTurnInputs("run-invalid-response-rebind").length, 1);
  assert.equal(context.store.listAgentMessages("run-invalid-response-rebind").length, 0);
  context.store.close();
});

test("a Web locator-only rebind is rejected for its in-flight response", async (t) => {
  const context = createFixture(t, {
    runId: "run-web-locator-rebind",
    steps: [
      { actor: AgentActor.CODEX_AGENT, packet: proposal() },
      {
        actor: AgentActor.CHATGPT_WEB_AGENT,
        response: ({ input }) => ({
          packet: critique(
            controllerEnvelopeFromPrompt(input.text).peer_message.proposal_ref_sha256,
          ),
          manual: true,
        }),
      },
    ],
  });
  const dispatcher = createDispatcher(context);
  await dispatcher.dispatchNext({ runId: "run-web-locator-rebind" });
  const dispatch = dispatcher.dispatchNext({ runId: "run-web-locator-rebind" });
  const submitted = await waitFor(
    () => context.store.listDeliveries("run-web-locator-rebind")
      .find(({ state, inputId }) => (
        state === DeliveryState.SUBMITTED
        && context.store.getAgentTurnInput(inputId).targetActor === AgentActor.CHATGPT_WEB_AGENT
      )),
    "Web turn was not submitted",
  );
  mutatePersistedSession(context.store, "session-web", {
    externalLocator: "https://chatgpt.com/c/rebound-conversation",
  });
  context.sessions[AgentActor.CHATGPT_WEB_AGENT].completeActive();

  await assert.rejects(
    dispatch,
    (error) => error.code === "AGENT_SESSION_BINDING_CHANGED",
  );
  assert.equal(context.store.getDelivery(submitted.deliveryId).state, DeliveryState.SUBMITTED);
  assert.equal(context.store.listAgentMessages("run-web-locator-rebind").length, 1);
  context.store.close();
});

test("a completed turn keeps its frozen receipt valid across a later session rebind", async (t) => {
  const context = createFixture(t, {
    runId: "run-post-completion-rebind",
    steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal() }],
  });
  await createDispatcher(context).dispatchNext({ runId: "run-post-completion-rebind" });
  const [completed] = context.store.listDeliveries("run-post-completion-rebind");
  assert.deepEqual(completed.providerReceipt.sessionBinding, {
    sessionId: "session-codex",
    version: 1,
    externalSessionId: "thread-codex",
    externalLocator: null,
  });
  assert.equal(context.store.getAgentSession("session-codex").version, 3);
  rebindPersistedSession(context.store, "thread-after-completion");
  context.store.close();

  const reopened = new SqliteStore(join(context.directory, "controller.sqlite"));
  assert.deepEqual(reopened.verifyTurnQueueLinks(), {
    valid: true,
    queuedTurns: 2,
    submittedTurns: 1,
  });
  assert.equal(
    reopened.getDelivery(completed.deliveryId).providerReceipt.sessionBinding.externalSessionId,
    "thread-codex",
  );
  reopened.close();
});

test("malformed response evidence never retains arbitrary secret-bearing fields", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-safe-evidence-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), {
    recursive: true,
    force: true,
  }));
  const rawText = JSON.stringify({
    type: AgentPacketType.PROPOSAL,
    password: "abc123",
    api_key: "provider-key",
    cookie: "sessionid=private-cookie",
    Authorization: "Bearer private-token",
  });
  const context = createFixture(t, {
    runId: "run-safe-runtime-evidence",
    artifactStore,
    steps: [{ actor: AgentActor.CODEX_AGENT, rawText }],
  });
  const result = await createDispatcher(context).dispatchNext({
    runId: "run-safe-runtime-evidence",
  });
  const rejection = context.store.getAgentPacketRejectionByDelivery(
    result.delivery.deliveryId,
  );
  const evidence = artifactStore.read(rejection.rawResponseArtifactHash).toString("utf8");

  assert.equal(result.status, "RESPONSE_REJECTED");
  assert.doesNotMatch(evidence, /abc123|provider-key|private-cookie|private-token/u);
  assert.doesNotMatch(evidence, /password|api_key|cookie|Authorization/u);
  assert.match(evidence, /discussion-runtime-response-evidence-v1/u);
  context.store.close();
});

for (const terminalType of ["TURN_FAILED", "TURN_INTERRUPTED"]) {
  test(`${terminalType} ends immediately even when completion never settles`, async (t) => {
    const context = createFixture(t, {
      runId: `run-${terminalType.toLowerCase()}`,
      steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal(), manual: true }],
    });
    const dispatcher = createDispatcher(context, { completionEventTimeoutMs: 1_000 });
    const dispatch = dispatcher.dispatchNext({ runId: `run-${terminalType.toLowerCase()}` });
    const submitted = await waitFor(
      () => context.store.listDeliveries(`run-${terminalType.toLowerCase()}`)
        .find(({ state }) => state === DeliveryState.SUBMITTED),
      "turn was not submitted",
    );
    const [{ turnId }] = context.runtime.submissions;
    const before = Date.now();
    context.sessions[AgentActor.CODEX_AGENT].emitRuntimeEvent({
      type: terminalType,
      sourceMethod: terminalType === "TURN_FAILED" ? "turn/failed" : "turn/interrupted",
      threadId: "thread-codex",
      turnId,
      itemId: null,
    });

    await assert.rejects(
      dispatch,
      (error) => error.code === "RUNTIME_TURN_NOT_COMPLETED",
    );
    assert(Date.now() - before < 500, "terminal failure must not wait for completion timeout");
    assert.equal(context.store.getDelivery(submitted.deliveryId).state, DeliveryState.SUBMITTED);
    context.store.close();
  });
}

test("a post-commit callback failure reports the already committed response boundary", async (t) => {
  const context = createFixture(t, {
    runId: "run-post-commit-effect",
    steps: [{ actor: AgentActor.CODEX_AGENT, packet: proposal() }],
  });
  const dispatcher = createDispatcher(context, {
    afterDurableResponse: async () => {
      const error = new Error("provider acknowledgement failed");
      error.code = "ACK_FAILED";
      throw error;
    },
  });

  await assert.rejects(
    dispatcher.dispatchNext({ runId: "run-post-commit-effect" }),
    (error) => {
      assert.equal(error.code, "POST_COMMIT_EFFECT_FAILED");
      assert.equal(error.details.responseStatus, "RESPONSE_RECORDED");
      assert.equal(error.details.responseRecorded, true);
      assert.equal(error.details.deliveryState, DeliveryState.RELAYED);
      assert.equal(typeof error.details.nextDeliveryId, "string");
      assert.equal(JSON.stringify(error.details).includes("provider acknowledgement failed"), false);
      return true;
    },
  );
  assert.equal(context.store.listAgentMessages("run-post-commit-effect").length, 1);
  assert.deepEqual(
    context.store.listDeliveries("run-post-commit-effect").map(({ state }) => state),
    [DeliveryState.RELAYED, DeliveryState.PENDING],
  );
  assert.equal(context.runtime.submissions.length, 1);
  context.store.close();
});

test("an invalid response keeps its rejection durable when the post-commit callback fails", async (t) => {
  const artifactStore = new ArtifactStore(join(
    mkdtempSync(join(tmpdir(), "discussion-invalid-post-commit-")),
    "artifacts",
  ));
  t.after(() => rmSync(join(artifactStore.rootDirectory, ".."), {
    recursive: true,
    force: true,
  }));
  const context = createFixture(t, {
    runId: "run-invalid-post-commit-effect",
    artifactStore,
    steps: [{
      actor: AgentActor.CODEX_AGENT,
      rawText: JSON.stringify({ type: AgentPacketType.PROPOSAL }),
    }],
  });
  const dispatcher = createDispatcher(context, {
    afterDurableResponse: async () => {
      throw new Error("do not expose this provider acknowledgement detail");
    },
  });

  await assert.rejects(
    dispatcher.runUntilSettled({ runId: "run-invalid-post-commit-effect" }),
    (error) => {
      assert.equal(error.code, "POST_COMMIT_EFFECT_FAILED");
      assert.equal(error.details.responseStatus, "RESPONSE_REJECTED");
      assert.equal(error.details.responseRecorded, true);
      assert.equal(error.details.deliveryState, DeliveryState.RESPONSE_COMPLETED);
      assert.equal(JSON.stringify(error.details).includes("acknowledgement detail"), false);
      return true;
    },
  );
  const deliveries = context.store.listDeliveries("run-invalid-post-commit-effect");
  assert.deepEqual(
    deliveries.map(({ state }) => state),
    [DeliveryState.RESPONSE_COMPLETED, DeliveryState.PENDING],
  );
  assert(context.store.getAgentPacketRejectionByDelivery(deliveries[0].deliveryId));
  assert.equal(context.runtime.submissions.length, 1);
  context.store.close();
});
