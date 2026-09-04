import assert from "node:assert/strict";
import test from "node:test";
import { AgentActor, RunMode } from "../src/domain/vocabulary.js";
import {
  AGENT_CAPABILITY_FIELDS,
  AgentSession,
  AgentSessionContractError,
  DISCUSSION_CAPABILITY_PROFILES,
  ExplicitCapabilityPolicyRequiredError,
  RuntimeCapabilityError,
  createAgentCapabilities,
  getDiscussionCapabilities,
  invokeWithAgentCapabilities,
  resolveAgentCapabilities,
  validateAgentCapabilities,
} from "../src/runtime/agent-session.js";
import {
  RUNTIME_EVENT_TYPES,
  RuntimeEventContractError,
  RuntimeEventType,
  validateRuntimeEventType,
} from "../src/runtime/runtime-events.js";

function capabilities(overrides = {}) {
  return {
    persistentSession: true,
    structuredOutput: true,
    interruption: true,
    steering: true,
    localRead: true,
    localWrite: false,
    shellExecution: false,
    ...overrides,
  };
}

function recordingAdapter() {
  const calls = [];
  const adapter = {};
  for (const method of [
    "start",
    "resume",
    "inspect",
    "submitTurn",
    "interrupt",
    "steer",
    "close",
    "onEvent",
  ]) {
    adapter[method] = (...args) => {
      calls.push({ method, args });
      return `${method}-result`;
    };
  }
  return { adapter, calls };
}

test("AgentCapabilities is a closed seven-boolean contract", () => {
  assert.deepEqual(AGENT_CAPABILITY_FIELDS, [
    "persistentSession",
    "structuredOutput",
    "interruption",
    "steering",
    "localRead",
    "localWrite",
    "shellExecution",
  ]);
  const valid = capabilities();
  assert.equal(validateAgentCapabilities(valid), valid);
  assert.throws(
    () => validateAgentCapabilities({ ...valid, networkAccess: false }),
    /unsupported property/,
  );
  assert.throws(
    () => validateAgentCapabilities({ ...valid, localRead: undefined }),
    /must be a boolean/,
  );
  const { shellExecution: _omitted, ...missing } = valid;
  assert.throws(() => validateAgentCapabilities(missing), /missing required property/);
});

test("discussion profiles are frozen and do not grant write or shell access", () => {
  const codex = getDiscussionCapabilities(AgentActor.CODEX_AGENT);
  const web = getDiscussionCapabilities(AgentActor.CHATGPT_WEB_AGENT);

  assert.ok(Object.isFrozen(DISCUSSION_CAPABILITY_PROFILES));
  assert.ok(Object.isFrozen(codex));
  assert.ok(Object.isFrozen(web));
  assert.equal(codex.localRead, true);
  assert.equal(codex.localWrite, false);
  assert.equal(codex.shellExecution, false);
  assert.equal(web.localRead, false);
  assert.equal(web.localWrite, false);
  assert.equal(web.shellExecution, false);
  assert.equal(web.structuredOutput, false);
  assert.equal(web.steering, false);

  assert.equal(
    resolveAgentCapabilities({
      actor: AgentActor.CODEX_AGENT,
      mode: RunMode.DISCUSSION,
    }),
    codex,
  );
  assert.throws(
    () => resolveAgentCapabilities({
      actor: AgentActor.CODEX_AGENT,
      mode: RunMode.DISCUSSION,
      capabilities: capabilities({ localWrite: true }),
    }),
    RuntimeCapabilityError,
  );
});

test("CODE_CHANGE has no implicit capability profile", () => {
  assert.throws(
    () => resolveAgentCapabilities({
      actor: AgentActor.CODEX_AGENT,
      mode: RunMode.CODE_CHANGE,
    }),
    (error) => error instanceof ExplicitCapabilityPolicyRequiredError
      && error.code === "EXPLICIT_CAPABILITY_POLICY_REQUIRED",
  );

  const explicit = resolveAgentCapabilities({
    actor: AgentActor.CODEX_AGENT,
    mode: RunMode.CODE_CHANGE,
    capabilities: capabilities({ localWrite: true }),
  });
  assert.equal(explicit.localWrite, true);
  assert.ok(Object.isFrozen(explicit));

  assert.throws(
    () => resolveAgentCapabilities({
      actor: AgentActor.CHATGPT_WEB_AGENT,
      mode: RunMode.CODE_CHANGE,
      capabilities: capabilities({
        structuredOutput: false,
        steering: false,
        localRead: false,
        localWrite: true,
      }),
    }),
    RuntimeCapabilityError,
  );
});

test("capability guard rejects before invoking an adapter operation", () => {
  const session = {
    actor: AgentActor.CODEX_AGENT,
    capabilities: createAgentCapabilities(capabilities({ localWrite: false })),
  };
  let calls = 0;
  assert.throws(
    () => invokeWithAgentCapabilities(
      session,
      ["localWrite"],
      "write workspace",
      () => { calls += 1; },
    ),
    (error) => error instanceof RuntimeCapabilityError
      && error.capability === "localWrite",
  );
  assert.equal(calls, 0);

  assert.equal(
    invokeWithAgentCapabilities(session, ["localRead"], "read workspace", () => {
      calls += 1;
      return "read";
    }),
    "read",
  );
  assert.equal(calls, 1);
});

test("AgentSession exposes provider-neutral operations and readonly identity", () => {
  const { adapter, calls } = recordingAdapter();
  const session = new AgentSession({
    actor: AgentActor.CODEX_AGENT,
    capabilities: capabilities(),
    adapter,
  });

  assert.ok(Object.isFrozen(session));
  assert.ok(Object.isFrozen(session.capabilities));
  assert.throws(() => { session.actor = AgentActor.CHATGPT_WEB_AGENT; }, TypeError);
  assert.equal(session.start({}), "start-result");
  assert.equal(session.resume({}), "resume-result");
  assert.equal(session.inspect({}), "inspect-result");
  assert.equal(session.submitTurn({}), "submitTurn-result");
  assert.equal(session.interrupt({}), "interrupt-result");
  assert.equal(session.steer({}), "steer-result");
  assert.equal(session.close({}), "close-result");
  assert.equal(session.onEvent(() => {}), "onEvent-result");
  assert.deepEqual(calls.map(({ method }) => method), [
    "start",
    "resume",
    "inspect",
    "submitTurn",
    "interrupt",
    "steer",
    "close",
    "onEvent",
  ]);
});

test("AgentSession accepts a class-based provider adapter", () => {
  class ClassAdapter {
    start() {}
    resume() {}
    inspect() {}
    submitTurn() {}
    interrupt() {}
    steer() {}
    close() {}
    onEvent() {}
  }

  const session = new AgentSession({
    actor: AgentActor.CODEX_AGENT,
    capabilities: capabilities(),
    adapter: new ClassAdapter(),
  });
  assert.equal(session.actor, AgentActor.CODEX_AGENT);
});

test("unsupported session operations do not reach the adapter", () => {
  const { adapter, calls } = recordingAdapter();
  const session = new AgentSession({
    actor: AgentActor.CHATGPT_WEB_AGENT,
    capabilities: getDiscussionCapabilities(AgentActor.CHATGPT_WEB_AGENT),
    adapter,
  });

  assert.equal(session.steer, undefined);
  assert.throws(
    () => invokeWithAgentCapabilities(
      session,
      ["steering"],
      "steer",
      () => adapter.steer({}),
    ),
    RuntimeCapabilityError,
  );
  assert.equal(calls.length, 0);

  const nonInterrupting = new AgentSession({
    actor: AgentActor.CODEX_AGENT,
    capabilities: capabilities({ interruption: false }),
    adapter,
  });
  assert.throws(() => nonInterrupting.interrupt({}), RuntimeCapabilityError);
  assert.equal(calls.length, 0);
});

test("canonical runtime event vocabulary is exact and rejects provider event names", () => {
  assert.deepEqual(RUNTIME_EVENT_TYPES, [
    "SESSION_READY",
    "TURN_STARTED",
    "TEXT_DELTA",
    "TOOL_STARTED",
    "TOOL_COMPLETED",
    "APPROVAL_REQUESTED",
    "TURN_COMPLETED",
    "TURN_INTERRUPTED",
    "TURN_FAILED",
    "SESSION_DISCONNECTED",
  ]);
  for (const value of RUNTIME_EVENT_TYPES) {
    assert.equal(validateRuntimeEventType(value), value);
  }
  assert.equal(RuntimeEventType.TURN_COMPLETED, "TURN_COMPLETED");
  assert.throws(
    () => validateRuntimeEventType("turn/completed"),
    (error) => error instanceof RuntimeEventContractError
      && error.code === "INVALID_RUNTIME_EVENT_TYPE",
  );
  assert.throws(() => validateRuntimeEventType(undefined), RuntimeEventContractError);
});

test("invalid capability objects fail before adapter construction", () => {
  const { adapter, calls } = recordingAdapter();
  assert.throws(
    () => new AgentSession({
      actor: AgentActor.CODEX_AGENT,
      capabilities: { ...capabilities(), browserAutomation: true },
      adapter,
    }),
    AgentSessionContractError,
  );
  assert.equal(calls.length, 0);
});
