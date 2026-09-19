import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CodexProcessManager,
  CodexApprovalBridge,
  CodexSessionAdapter,
  JsonlRpcPeer,
  assertStrictOutputSchema,
  buildCodexSandboxPolicy,
  compileOutputSchema,
  createCodexChildEnvironment,
  createCodexAgentSessionAdapter,
  resolvePinnedExecutable,
  verifyPinnedExecutable,
} from "../src/runtime/codex/index.js";
import { AGENT_SESSION_STATUSES } from "../src/domain/vocabulary.js";
import { CodexDiscussionPacketEnvelopeSchema } from "../src/domain/packet-json-schemas.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.dirname(TEST_DIR);
const FAKE_SERVER = path.join(TEST_DIR, "fixtures", "fake-codex-app-server.mjs");

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    ok: { type: "boolean" },
    prompt: { type: "string" },
    outputSchemaReceived: { type: "boolean" },
    sandboxType: { type: ["string", "null"] },
    approvalDecision: { type: ["string", "null"] },
  },
  required: ["ok", "prompt", "outputSchemaReceived", "sandboxType"],
  additionalProperties: false,
});

async function createManager(overrides = {}) {
  return CodexProcessManager.create({
    executablePath: process.execPath,
    workspaceRoot: REPOSITORY_ROOT,
    appServerArgs: [FAKE_SERVER],
    sourceEnv: { ...process.env, SHOULD_NOT_REACH_CHILD: "top-secret" },
    initializeTimeoutMs: 5_000,
    ...overrides,
  });
}

function createSession(manager, overrides = {}) {
  const persisted = [];
  const session = new CodexSessionAdapter({
    manager,
    workspaceRoot: REPOSITORY_ROOT,
    mode: "DISCUSSION",
    persistThreadId: async (binding) => persisted.push(binding),
    ...overrides,
  });
  return { session, persisted };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

test("one app-server process owns multiple independently persisted threads", async (t) => {
  let spawnCount = 0;
  let observedSpawnOptions = null;
  const manager = await createManager({
    spawn: (command, args, options) => {
      spawnCount += 1;
      observedSpawnOptions = options;
      return spawn(command, args, options);
    },
  });
  t.after(() => manager.close());
  const first = createSession(manager);
  const second = createSession(manager);
  t.after(() => first.session.close());
  t.after(() => second.session.close());

  const firstHandle = await first.session.start();
  const secondHandle = await second.session.start();

  assert.notEqual(firstHandle.threadId, secondHandle.threadId);
  assert.equal(first.persisted[0].threadId, firstHandle.threadId);
  assert.equal(second.persisted[0].threadId, secondHandle.threadId);
  assert.equal(first.session.externalSessionId, firstHandle.threadId);
  assert.equal(second.session.externalSessionId, secondHandle.threadId);
  assert.equal(spawnCount, 1);
  assert.equal(manager.processGeneration, 1);
  assert.equal(observedSpawnOptions.shell, false);
  assert.deepEqual(observedSpawnOptions.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(!Object.hasOwn(observedSpawnOptions.env, "SHOULD_NOT_REACH_CHILD"));
});

test("a failed start binding persist is retried by exact-thread resume without creating another thread", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const sent = [];
  manager.on("rpcSent", (message) => sent.push(message));
  const bindings = [];
  let persistenceAttempts = 0;
  const session = new CodexSessionAdapter({
    manager,
    workspaceRoot: REPOSITORY_ROOT,
    mode: "DISCUSSION",
    persistThreadId: async (binding) => {
      bindings.push(binding);
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error("synthetic persistence failure");
    },
  });
  t.after(() => session.close());
  const events = [];
  session.onEvent((event) => events.push(event));

  let persistenceError = null;
  try {
    await session.start();
  } catch (error) {
    persistenceError = error;
  }
  assert.equal(persistenceError?.code, "CODEX_THREAD_PERSISTENCE_FAILED");
  assert.equal(session.threadId, persistenceError.threadId);
  assert.equal(session.status, "FAILED");
  assert.equal(events.some((event) => event.type === "SESSION_READY"), false);

  const resumed = await session.resume({ threadId: persistenceError.threadId });
  assert.equal(resumed.threadId, persistenceError.threadId);
  assert.equal(session.status, "READY");
  assert.equal(persistenceAttempts, 2);
  assert.deepEqual(bindings[1], bindings[0]);
  assert.equal(sent.filter((message) => message.method === "thread/start").length, 1);
  assert.equal(sent.filter((message) => message.method === "thread/resume").length, 1);
  assert.equal(events.filter((event) => event.type === "SESSION_READY").length, 1);
});

test("concurrent turns on shared process remain isolated by required thread and turn ids", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const first = createSession(manager);
  const second = createSession(manager);
  t.after(() => first.session.close());
  t.after(() => second.session.close());
  const firstEvents = [];
  const secondEvents = [];
  first.session.onEvent((event) => firstEvents.push(event));
  second.session.onEvent((event) => secondEvents.push(event));
  await Promise.all([first.session.start(), second.session.start()]);

  const [firstTurn, secondTurn] = await Promise.all([
    first.session.submitTurn({ text: "first-thread", outputSchema: OUTPUT_SCHEMA }),
    second.session.submitTurn({ text: "second-thread", outputSchema: OUTPUT_SCHEMA }),
  ]);
  const [firstResult, secondResult] = await Promise.all([
    firstTurn.completion,
    secondTurn.completion,
  ]);
  assert.equal(firstResult.structuredOutput.prompt, "first-thread");
  assert.equal(secondResult.structuredOutput.prompt, "second-thread");
  assert.ok(firstEvents.filter((event) => event.turnId).every((event) => event.threadId === first.session.threadId));
  assert.ok(secondEvents.filter((event) => event.turnId).every((event) => event.threadId === second.session.threadId));
});

test("resume uses the recorded id, reads persisted turns, and never falls back to thread/start", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const original = createSession(manager);
  await original.session.start();
  const turn = await original.session.submitTurn({ text: "first", outputSchema: OUTPUT_SCHEMA });
  const completed = await turn.completion;
  assert.equal(completed.structuredOutput.prompt, "first");
  const threadId = original.session.threadId;
  await original.session.close();

  const resumed = createSession(manager);
  t.after(() => resumed.session.close());
  const resumedDiagnostics = [];
  resumed.session.onDiagnostic((entry) => resumedDiagnostics.push(entry));
  const handle = await resumed.session.resume({ threadId });
  assert.equal(handle.threadId, threadId);
  assert.equal(handle.inspection.lastCompletedTurnId, turn.turnId);
  await manager.request("test/late-turn-event", { threadId, turnId: turn.turnId });
  await waitFor(() => resumedDiagnostics.some((entry) => entry.type === "staleRuntimeEvent"));

  const sent = [];
  manager.on("rpcSent", (message) => sent.push(message));
  const missing = createSession(manager);
  t.after(() => missing.session.close());
  await assert.rejects(
    missing.session.resume({ threadId: "thr_missing" }),
    (error) => error.code === "CODEX_RPC_FAILED",
  );
  assert.equal(sent.filter((message) => message.method === "thread/start").length, 0);
});

test("turn outputSchema and supported read-only sandbox are sent; deltas are UI-only", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  assert.throws(
    () => createSession(manager, { approvalPolicy: "unlessTrusted" }),
    (error) => error.code === "CODEX_APPROVAL_POLICY_UNSUPPORTED",
  );
  assert.throws(
    () => createSession(manager, { approvalPolicy: { granular: {} } }),
    (error) => error.code === "CODEX_APPROVAL_POLICY_INVALID",
  );
  const granular = createSession(manager, {
    approvalPolicy: {
      granular: {
        mcp_elicitations: true,
        rules: true,
        sandbox_approval: true,
      },
    },
  });
  await granular.session.close();
  const { session } = createSession(manager);
  t.after(() => session.close());
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();

  const turn = await session.submitTurn({ text: "hello", outputSchema: OUTPUT_SCHEMA });
  const result = await turn.completion;
  assert.equal(result.structuredOutput.prompt, "hello");
  assert.equal(result.structuredOutput.outputSchemaReceived, true);
  assert.equal(result.structuredOutput.sandboxType, "readOnly");
  assert.notEqual(result.text, "ui-only-delta");
  assert.ok(events.some((event) => event.type === "TEXT_DELTA" && event.delta === "ui-only-delta"));
  assert.ok(events.some((event) => event.type === "TURN_COMPLETED"));

  const deltaOnly = await session.submitTurn({ text: "__delta_only__", outputSchema: OUTPUT_SCHEMA });
  await assert.rejects(
    deltaOnly.completion,
    (error) => error.code === "CODEX_AUTHORITATIVE_OUTPUT_MISSING",
  );
  assert.equal(
    events.some((event) => event.type === "TURN_COMPLETED" && event.turnId === deltaOnly.turnId),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "TURN_FAILED" && event.turnId === deltaOnly.turnId),
    true,
  );
});

test("authoritative output is locally validated before TURN_COMPLETED is emitted", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();

  const turn = await session.submitTurn({ text: "__wrong_schema_value__", outputSchema: OUTPUT_SCHEMA });
  await assert.rejects(
    turn.completion,
    (error) => error.code === "CODEX_AUTHORITATIVE_OUTPUT_INVALID"
      && error.reason === "SCHEMA_VALIDATION_FAILED"
      && error.validationErrors.some((entry) => entry.instancePath === "/ok"),
  );
  const terminalEvents = events.filter((event) => event.turnId === turn.turnId
    && ["TURN_COMPLETED", "TURN_FAILED"].includes(event.type));
  assert.deepEqual(terminalEvents.map((event) => event.type), ["TURN_FAILED"]);
  assert.equal(session.snapshot.lastCompletedTurnId, null);
});

test("missing or unknown Codex terminal status cannot become completion", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();

  for (const text of ["__missing_terminal_status__", "__unknown_terminal_status__"]) {
    const turn = await session.submitTurn({ text, outputSchema: OUTPUT_SCHEMA });
    await assert.rejects(turn.completion, { code: "CODEX_TURN_STATUS_INVALID" });
    const terminal = events.filter((event) => event.turnId === turn.turnId
      && ["TURN_COMPLETED", "TURN_FAILED"].includes(event.type));
    assert.deepEqual(terminal.map((event) => event.type), ["TURN_FAILED"]);
  }
  assert.equal(session.snapshot.lastCompletedTurnId, null);
});

test("a completion discovered by recovered inspection is schema-validated before its event", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const original = createSession(manager);
  await original.session.start();
  const turn = await original.session.submitTurn({
    text: "__complete_on_second_read_wrong_schema__",
    outputSchema: OUTPUT_SCHEMA,
  });
  const threadId = original.session.threadId;
  await original.session.close();

  const resumed = createSession(manager);
  t.after(() => resumed.session.close());
  const events = [];
  resumed.session.onEvent((event) => events.push(event));
  const handle = await resumed.session.resume({ threadId });
  assert.equal(handle.inspection.activeTurnId, turn.turnId);
  assert.equal(resumed.session.activeTurnId, turn.turnId);

  const inspection = await resumed.session.inspect();
  assert.equal(inspection.lastCompletedTurnId, turn.turnId);
  assert.deepEqual(
    events
      .filter((event) => event.turnId === turn.turnId
        && ["TURN_COMPLETED", "TURN_FAILED"].includes(event.type))
      .map((event) => event.type),
    ["TURN_FAILED"],
  );
  assert.equal(resumed.session.snapshot.lastCompletedTurnId, null);
  assert.equal(resumed.session.status, "READY");
});

test("late events for a terminal turn are diagnosed and never re-applied", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  const events = [];
  const diagnostics = [];
  session.onEvent((event) => events.push(event));
  session.onDiagnostic((event) => diagnostics.push(event));
  await session.start();
  const turn = await session.submitTurn({ text: "terminal-turn", outputSchema: OUTPUT_SCHEMA });
  await turn.completion;
  const eventCount = events.length;
  await manager.request("test/late-turn-event", {
    threadId: session.threadId,
    turnId: turn.turnId,
  });
  await waitFor(() => diagnostics.some((entry) => entry.type === "staleRuntimeEvent"));
  assert.equal(events.length, eventCount);
  assert.equal(session.status, "READY");
  assert.equal(session.snapshot.lastCompletedTurnId, turn.turnId);
});

test("installed-schema sandbox payload omits unsupported restricted-read fields and discloses the gap", async (t) => {
  assert.deepEqual(buildCodexSandboxPolicy({
    mode: "DISCUSSION",
    workspaceRoot: REPOSITORY_ROOT,
  }), {
    type: "readOnly",
    networkAccess: false,
  });
  assert.throws(
    () => buildCodexSandboxPolicy({
      mode: "DISCUSSION",
      workspaceRoot: REPOSITORY_ROOT,
      readableRoots: [TEST_DIR],
    }),
    (error) => error.code === "CODEX_RESTRICTED_READ_SCOPE_UNSUPPORTED",
  );
  assert.deepEqual(buildCodexSandboxPolicy({
    mode: "CODE_CHANGE",
    workspaceRoot: REPOSITORY_ROOT,
  }), {
    type: "workspaceWrite",
    writableRoots: [REPOSITORY_ROOT],
    networkAccess: false,
  });

  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  assert.equal(session.snapshot.readScopeEnforced, false);
  assert.equal(
    session.snapshot.readScopeLimitation,
    "INSTALLED_APP_SERVER_SCHEMA_HAS_NO_RESTRICTED_READ_ROOTS",
  );
});

test("caller must provide a strict output schema", () => {
  assert.throws(
    () => assertStrictOutputSchema(undefined),
    (error) => error.code === "CODEX_OUTPUT_SCHEMA_REQUIRED",
  );
  assert.throws(
    () => assertStrictOutputSchema({ type: "object" }),
    (error) => error.code === "CODEX_OUTPUT_SCHEMA_NOT_STRICT",
  );
  assert.deepEqual(assertStrictOutputSchema(OUTPUT_SCHEMA), OUTPUT_SCHEMA);
});

test("Codex discussion output schema accepts content-only proposals and rejects blank decisions", () => {
  const schema = assertStrictOutputSchema(CodexDiscussionPacketEnvelopeSchema);
  const validate = compileOutputSchema(schema);
  const proposal = {
    type: "PROPOSAL",
    summary: "Bounded proposal",
    body: "Implement the approved contract.",
    assumptions: [],
    open_decisions: [],
    target_proposal_sha256: "",
    blocking_findings: [],
    non_blocking_findings: [],
    requested_changes: [],
    accepted_proposal_sha256: "",
    reason_code: "",
    description: "",
    required_decisions: [],
  };

  assert.equal(validate(proposal), true);
  assert.equal(validate({
    ...proposal,
    proposal_id: "provider-owned-id",
    proposal_sha256: `sha256:${"0".repeat(64)}`,
  }), false);
  assert.equal(validate({ ...proposal, open_decisions: ["   "] }), true);
});

test("approval bridge requires exact request/thread/turn correlation and never auto-accepts", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();

  const turn = await session.submitTurn({ text: "__approval__", outputSchema: OUTPUT_SCHEMA });
  const approval = await waitFor(() => session.pendingApprovals[0]);
  assert.equal(approval.status, "PENDING");
  assert.ok(events.some((event) => event.type === "APPROVAL_REQUESTED"));
  assert.throws(
    () => session.respondToApproval({
      requestId: approval.requestId,
      turnId: "wrong-turn",
      decision: "accept",
    }),
    (error) => error.code === "CODEX_APPROVAL_CORRELATION_MISMATCH",
  );
  session.respondToApproval({
    requestId: approval.requestId,
    turnId: approval.turnId,
    decision: "decline",
  });
  const completed = await turn.completion;
  assert.equal(completed.structuredOutput.approvalDecision, "decline");
  await waitFor(() => session.pendingApprovals.length === 0);
});


test("public Codex agent-session adapter exposes approval responses", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const session = createCodexAgentSessionAdapter({
    manager,
    workspaceRoot: REPOSITORY_ROOT,
    mode: "DISCUSSION",
    persistThreadId: async () => {},
  });
  t.after(() => session.close());
  await session.start();

  const events = [];
  session.onEvent((event) => events.push(event));
  const turn = await session.submitTurn({ text: "__approval__", outputSchema: OUTPUT_SCHEMA });
  const approval = await waitFor(() => events.find((event) => event.type === "APPROVAL_REQUESTED"));

  assert.equal(typeof session.respondToApproval, "function");
  session.respondToApproval({
    requestId: approval.requestId,
    turnId: approval.turnId,
    decision: "decline",
  });
  const completed = await turn.completion;
  assert.equal(completed.structuredOutput.approvalDecision, "decline");
});

test("unsupported reverse requests receive a fail-closed JSON-RPC error response", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const observed = [];
  manager.on("serverRequest", (request) => observed.push(request));
  await manager.start();

  const result = await manager.request("test/unsupported-reverse-request");
  assert.deepEqual(result, {
    reverseError: { code: -32601, message: "Method not found" },
    reverseResult: null,
  });
  assert.deepEqual(observed, [{
    id: "reverse_1",
    method: "test/unsupported-server-request",
    paramsPresent: true,
  }]);
});

test("approval bridge preserves empty offers and requires the exact proposed execpolicy amendment", () => {
  const responses = [];
  const bridge = new CodexApprovalBridge({
    peer: {
      respond: (id, result) => responses.push({ id, result }),
    },
  });

  for (const [requestId, availableDecisions] of [
    ["missing", undefined],
    ["empty", []],
    ["unknown", ["approveEverything"]],
  ]) {
    bridge.capture({
      id: requestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-security",
        turnId: `turn-${requestId}`,
        ...(availableDecisions === undefined ? {} : { availableDecisions }),
      },
    });
    const pending = bridge.pendingApprovals.find((entry) => entry.requestId === requestId);
    assert.deepEqual(pending.availableDecisions, []);
    assert.throws(() => bridge.respond({
      requestId,
      threadId: "thread-security",
      turnId: `turn-${requestId}`,
      decision: "accept",
    }), { code: "CODEX_APPROVAL_DECISION_NOT_OFFERED" });
  }
  assert.throws(() => bridge.respond({
    requestId: "missing",
    threadId: "thread-security",
    turnId: "turn-missing",
    decision: {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
    },
  }), { code: "CODEX_APPROVAL_DECISION_NOT_OFFERED" });

  bridge.capture({
    id: "amendment",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-security",
      turnId: "turn-amendment",
      availableDecisions: [],
      proposedExecpolicyAmendment: ["git", "status"],
    },
  });
  assert.deepEqual(
    bridge.pendingApprovals.find((entry) => entry.requestId === "amendment").proposedExecpolicyAmendment,
    ["git", "status"],
  );
  assert.throws(() => bridge.respond({
    requestId: "amendment",
    threadId: "thread-security",
    turnId: "turn-amendment",
    decision: {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] },
    },
  }), { code: "CODEX_APPROVAL_DECISION_NOT_OFFERED" });
  bridge.respond({
    requestId: "amendment",
    threadId: "thread-security",
    turnId: "turn-amendment",
    decision: {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
    },
  });
  assert.deepEqual(responses, [{
    id: "amendment",
    result: {
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
      },
    },
  }]);
});

test("file-change approval defaults decisions only when the server omits the offer list", () => {
  const responses = [];
  const bridge = new CodexApprovalBridge({
    peer: { respond: (id, result) => responses.push({ id, result }) },
  });

  bridge.capture({
    id: "file-defaults",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-file",
      turnId: "turn-file",
      itemId: "item-file",
    },
  });
  const pending = bridge.pendingApprovals.find((entry) => entry.requestId === "file-defaults");
  assert.deepEqual(pending.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  bridge.respond({
    requestId: "file-defaults",
    threadId: "thread-file",
    turnId: "turn-file",
    decision: "accept",
  });
  assert.deepEqual(responses, [{ id: "file-defaults", result: { decision: "accept" } }]);

  bridge.capture({
    id: "file-explicit-empty",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-file",
      turnId: "turn-file-empty",
      itemId: "item-file-empty",
      availableDecisions: [],
    },
  });
  assert.throws(() => bridge.respond({
    requestId: "file-explicit-empty",
    threadId: "thread-file",
    turnId: "turn-file-empty",
    decision: "accept",
  }), { code: "CODEX_APPROVAL_DECISION_NOT_OFFERED" });
});

test("interrupt RPC is not completion; turn/interrupted confirms the operation", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();

  const turn = await session.submitTurn({ text: "__interrupt__", outputSchema: OUTPUT_SCHEMA });
  const interrupt = await session.interrupt({ operationId: "interrupt-op-1", turnId: turn.turnId });
  const confirmation = await interrupt.confirmation;
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.operationId, "interrupt-op-1");
  await assert.rejects(turn.completion, (error) => error.code === "CODEX_TURN_INTERRUPTED");
  assert.equal(session.snapshot.lastCompletedTurnId, null);
});

test("rejected interrupt clears its pending handle and preserves the running turn for inspection", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();
  const turn = await session.submitTurn({ text: "__interrupt_reject_once__", outputSchema: OUTPUT_SCHEMA });

  await assert.rejects(
    session.interrupt({ operationId: "rejected-op", turnId: turn.turnId }),
    (error) => error.code === "CODEX_RPC_FAILED",
  );
  assert.equal(session.status, "RUNNING");
  assert.equal((await session.inspect()).activeTurnId, turn.turnId);
  const retry = await session.interrupt({ operationId: "retry-op", turnId: turn.turnId });
  assert.equal(retry.operationId, "retry-op");
  assert.equal((await retry.confirmation).confirmed, true);
  await assert.rejects(turn.completion, (error) => error.code === "CODEX_TURN_INTERRUPTED");
});

test("thread/read can confirm an interrupt when its notification was not observed", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();

  const turn = await session.submitTurn({ text: "__interrupt_inspect__", outputSchema: OUTPUT_SCHEMA });
  const interrupt = await session.interrupt({ operationId: "interrupt-op-inspect", turnId: turn.turnId });
  let confirmed = false;
  interrupt.confirmation.then(() => { confirmed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
  const inspection = await session.inspect();
  assert.equal(inspection.lastTerminalStatus, "interrupted");
  assert.equal((await interrupt.confirmation).confirmed, true);
  await assert.rejects(turn.completion, (error) => error.code === "CODEX_TURN_INTERRUPTED");
});

test("resume inspects and preserves an already-active turn instead of starting another", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const original = createSession(manager);
  await original.session.start();
  const originalTurn = await original.session.submitTurn({ text: "__interrupt__", outputSchema: OUTPUT_SCHEMA });
  const threadId = original.session.threadId;
  await original.session.close();

  const resumed = createSession(manager);
  t.after(() => resumed.session.close());
  const handle = await resumed.session.resume({ threadId });
  assert.equal(handle.inspection.activeTurnId, originalTurn.turnId);
  assert.equal(resumed.session.activeTurnId, originalTurn.turnId);
  await assert.rejects(
    resumed.session.submitTurn({ text: "must-not-overlap", outputSchema: OUTPUT_SCHEMA }),
    (error) => error.code === "CODEX_SESSION_NOT_READY" || error.code === "CODEX_TURN_ALREADY_ACTIVE",
  );
  const interrupt = await resumed.session.interrupt({
    operationId: "cleanup-recovered-turn",
    turnId: originalTurn.turnId,
  });
  assert.equal((await interrupt.confirmation).confirmed, true);
});

test("process death makes an active turn ambiguous and blocks automatic resend", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();

  const turn = await session.submitTurn({ text: "__crash__", outputSchema: OUTPUT_SCHEMA });
  await assert.rejects(turn.completion, (error) => error.code === "CODEX_TURN_AMBIGUOUS");
  assert.equal(session.status, "DISCONNECTED");
  assert.equal(session.snapshot.ambiguousTurn.turnId, turn.turnId);
  await assert.rejects(
    session.submitTurn({ text: "must-not-resend", outputSchema: OUTPUT_SCHEMA }),
    (error) => error.code === "CODEX_SESSION_NOT_READY" || error.code === "CODEX_AMBIGUOUS_TURN_UNRESOLVED",
  );
});

test("process death before turn/start response preserves an unknown-id ambiguous submission", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();
  await assert.rejects(
    session.submitTurn({ text: "__crash_before_turn_response__", outputSchema: OUTPUT_SCHEMA }),
    (error) => error.code === "CODEX_TRANSPORT_CLOSED",
  );
  assert.equal(session.status, "DISCONNECTED");
  assert.equal(session.snapshot.ambiguousTurn.turnId, null);
  assert.equal(session.snapshot.ambiguousTurn.reason, "CODEX_TURN_AMBIGUOUS");
});

test("process restart is separate from thread lifecycle and requires explicit resume", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-codex-state-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const stateFile = path.join(tempRoot, "threads.json");
  const manager = await createManager({ appServerArgs: [FAKE_SERVER, "--state-file", stateFile] });
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  await session.start();
  const threadId = session.threadId;
  const turn = await session.submitTurn({ text: "__crash__", outputSchema: OUTPUT_SCHEMA });
  await assert.rejects(turn.completion, (error) => error.code === "CODEX_TURN_AMBIGUOUS");
  assert.equal(manager.status, "FAILED");
  assert.equal(session.threadId, threadId);

  const resumed = await session.resume({ threadId });
  assert.equal(manager.processGeneration, 2);
  assert.equal(resumed.threadId, threadId);
  assert.equal(resumed.inspection.activeTurnId, turn.turnId);
  assert.equal(session.snapshot.ambiguousTurn, null);
  const interrupt = await session.interrupt({ operationId: "post-restart-reconcile", turnId: turn.turnId });
  assert.equal((await interrupt.confirmation).confirmed, true);
});

test("public session status never escapes the AgentSessionRecord vocabulary", async (t) => {
  const allowed = new Set(AGENT_SESSION_STATUSES);
  const manager = await createManager();
  t.after(() => manager.close());
  const { session } = createSession(manager);
  t.after(() => session.close());
  assert.ok(allowed.has(session.status));
  await session.start();
  assert.ok(allowed.has(session.status));
  const turn = await session.submitTurn({ text: "__interrupt__", outputSchema: OUTPUT_SCHEMA });
  assert.ok(allowed.has(session.status));
  const interrupt = await session.interrupt({ operationId: "status-test", turnId: turn.turnId });
  await interrupt.confirmation;
  await assert.rejects(turn.completion);
  assert.ok(allowed.has(session.status));
  await session.close();
  assert.ok(allowed.has(session.status));
});

test("invalid JSON, orphan, late, and duplicate responses are surfaced as diagnostics", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  const diagnostics = [];
  for (const name of ["protocolError", "orphanResponse", "lateResponse", "duplicateResponse"]) {
    manager.on(name, (detail) => diagnostics.push({ name, detail }));
  }
  await manager.ensureReadyForNewOperation();
  await manager.request("test/invalid-json");
  await manager.request("test/orphan-response");
  await manager.request("test/duplicate-response");
  await assert.rejects(
    manager.request("test/late-response", {}, 10),
    (error) => error.code === "CODEX_RPC_TIMEOUT",
  );
  await waitFor(() => diagnostics.length >= 4);
  assert.ok(diagnostics.some((entry) => entry.name === "protocolError" && entry.detail.code === "CODEX_INVALID_JSON"));
  assert.ok(diagnostics.some((entry) => entry.name === "orphanResponse"));
  assert.ok(diagnostics.some((entry) => entry.name === "lateResponse"));
  assert.ok(diagnostics.some((entry) => entry.name === "duplicateResponse"));
});

test("late responses are distinguished from orphan and duplicate responses", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlRpcPeer({ input, output, defaultTimeoutMs: 15 });
  const late = [];
  peer.on("lateResponse", (message) => late.push(message));
  await assert.rejects(peer.request("slow", {}, 15), (error) => error.code === "CODEX_RPC_TIMEOUT");
  output.write(`${JSON.stringify({ id: 1, result: { tooLate: true } })}\n`);
  await waitFor(() => late.length === 1);
  peer.close();
});

test("executable pin rejects workspace binaries and detects byte changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outsideExecutable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex-bin");
  const insideExecutable = path.join(workspace, process.platform === "win32" ? "codex.exe" : "codex-bin");
  await mkdir(workspace);
  await writeFile(outsideExecutable, "first-version");
  await writeFile(insideExecutable, "inside-workspace");

  const pin = await resolvePinnedExecutable({
    executablePath: outsideExecutable,
    workspaceRoot: workspace,
  });
  assert.equal(await verifyPinnedExecutable(pin), true);
  await writeFile(outsideExecutable, "second-version");
  await assert.rejects(
    verifyPinnedExecutable(pin),
    (error) => error.code === "CODEX_EXECUTABLE_HASH_CHANGED",
  );
  await assert.rejects(
    resolvePinnedExecutable({ executablePath: insideExecutable, workspaceRoot: workspace }),
    (error) => error.code === "CODEX_EXECUTABLE_INSIDE_WORKSPACE",
  );
});

test("a changed executable is rejected before a new app-server process can spawn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-pin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const executable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex-bin");
  await mkdir(workspace);
  await writeFile(executable, "pinned-version");
  const pin = await resolvePinnedExecutable({ executablePath: executable, workspaceRoot: workspace });
  const environment = createCodexChildEnvironment({ sourceEnv: { TEMP: os.tmpdir() } });
  let spawnCount = 0;
  const manager = new CodexProcessManager({
    pin,
    environment,
    spawn: () => {
      spawnCount += 1;
      throw new Error("must not spawn");
    },
  });
  await writeFile(executable, "changed-version");
  await assert.rejects(
    manager.ensureReadyForNewOperation(),
    (error) => error.code === "CODEX_EXECUTABLE_HASH_CHANGED",
  );
  assert.equal(spawnCount, 0);
});

test("child environment is an explicit allowlist plus the fixed Codex auth-path key", async (t) => {
  const authRoot = await mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
  t.after(() => rm(authRoot, { recursive: true, force: true }));
  const sourceEnv = {
    PATH: "safe-path",
    TEMP: os.tmpdir(),
    CODEX_HOME: authRoot,
    OPENAI_API_KEY: "must-not-leak",
    DATABASE_URL: "must-not-leak",
  };
  const result = createCodexChildEnvironment({ sourceEnv, authPathKeys: ["CODEX_HOME"] });
  assert.deepEqual(Object.keys(result.env).sort(), ["CODEX_HOME", "PATH", "TEMP"]);
  assert.ok(!Object.hasOwn(result.env, "OPENAI_API_KEY"));
  assert.ok(!Object.hasOwn(result.env, "DATABASE_URL"));
  assert.match(result.snapshotSha256, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => createCodexChildEnvironment({
      sourceEnv: { LD_PRELOAD: path.join(authRoot, "evil.so") },
      authPathKeys: ["LD_PRELOAD"],
    }),
    (error) => error.code === "CODEX_AUTH_PATH_KEY_NOT_ALLOWED",
  );
});

test("the running fake app-server cannot observe non-allowlisted secrets", async (t) => {
  const manager = await createManager();
  t.after(() => manager.close());
  await manager.ensureReadyForNewOperation();
  const observed = await manager.request("test/environment");
  assert.ok(!observed.keys.includes("SHOULD_NOT_REACH_CHILD"));
  assert.ok(!observed.keys.includes("OPENAI_API_KEY"));
  assert.match(manager.environmentSnapshotSha256, /^sha256:[a-f0-9]{64}$/);
});
