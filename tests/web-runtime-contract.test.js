import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import {
  ChatGptWebSessionAdapter,
  WebExtensionAuthenticator,
  WebExtensionTransport,
  computeWebChallengeHmac,
  createWebSessionBinding,
} from "../src/runtime/web/index.js";

const SHARED_SECRET = "test-only-shared-secret-0123456789abcdef";
const EXTENSION_IDENTITY = "extension-test-01";

// 기존 web-runtime-core.new.test.js 와 동일한 형태의 최소 유효 packet fixture
const ACCEPT_PACKET = Object.freeze({
  type: "ACCEPT",
  accepted_proposal_sha256: `sha256:${"0".repeat(64)}`,
  blocking_findings: Object.freeze([]),
});

function controllerResponse(body = "ok", packet = ACCEPT_PACKET) {
  return [
    body,
    "",
    "<controller_packet>",
    JSON.stringify(packet),
    "</controller_packet>",
  ].join("\n");
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }

  send(raw) {
    this.sent.push(JSON.parse(String(raw)));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  receive(message) {
    this.emit("message", JSON.stringify(message));
  }
}

function binding(overrides = {}) {
  return createWebSessionBinding({
    sessionId: "session-1",
    runId: "run-1",
    tabId: 7,
    windowId: 3,
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    conversationId: "conversation-1",
    title: "Bound conversation",
    lastObservedUserMessageId: null,
    lastObservedAssistantMessageId: null,
    bindingStatus: "BOUND",
    ...overrides,
  });
}

function authenticatedTransport() {
  const transport = new WebExtensionTransport({
    sharedSecret: SHARED_SECRET,
    expectedExtensionIdentity: EXTENSION_IDENTITY,
  });
  const socket = new FakeSocket();
  transport.attach(socket);
  const challenge = socket.sent[0];
  socket.receive({
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: challenge.challengeId,
    extensionIdentity: EXTENSION_IDENTITY,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, SHARED_SECRET),
  });
  assert.equal(transport.authenticated, true);
  return { transport, socket };
}

async function startAdapter() {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const sessionBinding = binding();
  const starting = adapter.start({ binding: sessionBinding, focus: false });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.ready",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { session: sessionBinding },
  });
  await starting;
  return { adapter, transport, socket, sessionBinding };
}

function promptError(socket, requestId, code, message) {
  socket.receive({
    type: "web.prompt.error",
    protocolVersion: 2,
    requestId,
    payload: { code, message },
  });
}

// ---------------------------------------------------------------------------
// 1. 기본 초기화
// ---------------------------------------------------------------------------

test("1-1 Given 정상 환경변수, When loadConfig, Then Web 설정이 초기화된다", () => {
  const cwd = path.resolve("workspace", "project");
  const config = loadConfig({
    cwd,
    env: {
      HOST: "127.0.0.1",
      PORT: "8787",
      WORKSPACE: ".",
      CONTROLLER_DATA_DIR: ".agent-controller",
      WEB_EXTENSION_SHARED_SECRET: SHARED_SECRET,
      WEB_EXTENSION_EXPECTED_IDENTITY: EXTENSION_IDENTITY,
    },
  });

  assert.equal(config.baseUrl, "http://127.0.0.1:8787");
  assert.equal(config.webExtension.enabled, true);
  assert.equal(config.webExtension.sharedSecret, SHARED_SECRET);
  assert.equal(config.webExtension.expectedExtensionIdentity, EXTENSION_IDENTITY);
  assert.equal(
    config.persistence.databasePath,
    path.join(cwd, ".agent-controller", "controller.sqlite"),
  );
});

test("1-2 Given Extension 환경변수 없음, When loadConfig, Then 서버 설정은 생성되고 Web 연동만 비활성화된다", () => {
  const config = loadConfig({
    cwd: path.resolve("workspace", "project"),
    env: {},
  });

  assert.equal(config.webExtension.enabled, false);
  assert.equal(config.webExtension.sharedSecret, null);
  assert.equal(config.webExtension.expectedExtensionIdentity, null);
});

test("1-2b Given Extension 환경변수 일부만 존재, When loadConfig, Then 설정 오류가 발생한다", () => {
  assert.throws(
    () => loadConfig({
      cwd: path.resolve("workspace", "project"),
      env: { WEB_EXTENSION_SHARED_SECRET: SHARED_SECRET },
    }),
    /WEB_EXTENSION_SHARED_SECRET and WEB_EXTENSION_EXPECTED_IDENTITY must be configured together/,
  );
  assert.throws(
    () => loadConfig({
      cwd: path.resolve("workspace", "project"),
      env: { WEB_EXTENSION_EXPECTED_IDENTITY: EXTENSION_IDENTITY },
    }),
    /WEB_EXTENSION_SHARED_SECRET and WEB_EXTENSION_EXPECTED_IDENTITY must be configured together/,
  );
});

test("1-3 Given 32바이트 미만 sharedSecret, When 인증기 생성, Then INVALID_AUTH_CONFIGURATION", () => {
  assert.throws(
    () => new WebExtensionAuthenticator({
      sharedSecret: "too-short",
      expectedExtensionIdentity: EXTENSION_IDENTITY,
    }),
    { code: "INVALID_AUTH_CONFIGURATION" },
  );
});

test("1-4 Given 정상 바인딩, When start, Then sessionReady와 SESSION_READY가 노출된다", async () => {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const sessionBinding = binding();
  const starting = adapter.start({ binding: sessionBinding, focus: false });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.ready",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { session: sessionBinding },
  });
  await starting;

  assert.equal((await adapter.inspect()).sessionReady, true);
  assert.equal(events.at(-1).type, "SESSION_READY");
  await adapter.close();
});

// ---------------------------------------------------------------------------
// 2. 대화 생성 – 정상 경로
// ---------------------------------------------------------------------------

test("2-1 Given 인증 완료, When start({ binding, focus }), Then 정확한 세션 바인딩을 반환한다", async () => {
  const { adapter, sessionBinding } = await startAdapter();
  assert.deepEqual((await adapter.inspect()).binding, sessionBinding);
  assert.equal(adapter.externalSessionId, "conversation-1");
  await adapter.close();
});

test("2-2 Given start 성공, When 런타임 이벤트 확인, Then SESSION_READY에 sessionId와 conversationId가 있다", async () => {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const sessionBinding = binding();
  const starting = adapter.start({ binding: sessionBinding });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.ready",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { session: sessionBinding },
  });
  await starting;

  assert.equal(events[0].sessionId, "session-1");
  assert.equal(events[0].payload.binding.conversationId, "conversation-1");
  await adapter.close();
});

test("2-3 Given start 성공, When inspect, Then 준비 상태이며 활성 작업이 없다", async () => {
  const { adapter } = await startAdapter();
  const state = await adapter.inspect();
  assert.equal(state.sessionReady, true);
  assert.equal(adapter.activeTurnId, null);
  await adapter.close();
});

// ---------------------------------------------------------------------------
// 3. 대화 생성 – 에러 케이스
// ---------------------------------------------------------------------------

test("3-1 Given 잘못된 HMAC·재사용·만료 challenge, When verifyResponse, Then 실제 AUTH 코드로 거부한다", () => {
  let now = 1_000;
  let fill = 0;
  const authenticator = new WebExtensionAuthenticator({
    sharedSecret: SHARED_SECRET,
    expectedExtensionIdentity: EXTENSION_IDENTITY,
    challengeTtlMs: 10,
    clock: () => now,
    randomBytesFn: (size) => Buffer.alloc(size, ++fill),
  });
  const invalidChallenge = authenticator.issueChallenge();
  const invalidResponse = {
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: invalidChallenge.challengeId,
    extensionIdentity: EXTENSION_IDENTITY,
    hmacSha256: "0".repeat(64),
  };
  assert.throws(() => authenticator.verifyResponse(invalidResponse), { code: "AUTH_HMAC_INVALID" });
  assert.throws(() => authenticator.verifyResponse(invalidResponse), { code: "AUTH_REPLAY_REJECTED" });

  const expiredChallenge = authenticator.issueChallenge();
  now += 11;
  assert.throws(() => authenticator.verifyResponse({
    ...invalidResponse,
    challengeId: expiredChallenge.challengeId,
    hmacSha256: computeWebChallengeHmac(expiredChallenge.nonce, SHARED_SECRET),
  }), { code: "AUTH_CHALLENGE_EXPIRED" });
});

test("3-2 Given Extension 미인증, When start({ binding }), Then EXTENSION_NOT_AUTHENTICATED", async () => {
  const transport = new WebExtensionTransport({
    sharedSecret: SHARED_SECRET,
    expectedExtensionIdentity: EXTENSION_IDENTITY,
  });
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  await assert.rejects(adapter.start({ binding: binding() }), { code: "EXTENSION_NOT_AUTHENTICATED" });
  await adapter.close();
});

test("3-3 Given 로그인 필요 응답, When start, Then SESSION_AUTH_REQUIRED이고 준비되지 않는다", async () => {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const starting = adapter.start({ binding: binding() });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.error",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { code: "SESSION_AUTH_REQUIRED", message: "Login required" },
  });

  await assert.rejects(starting, { code: "SESSION_AUTH_REQUIRED" });
  assert.equal((await adapter.inspect()).sessionReady, false);
  await adapter.close();
});

test("3-4 Given CAPTCHA 상태 응답, When start, Then CAPTCHA_REQUIRED로 실패한다", async () => {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const starting = adapter.start({ binding: binding() });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.error",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { code: "CAPTCHA_REQUIRED", message: "Verify you are human" },
  });

  await assert.rejects(starting, { code: "CAPTCHA_REQUIRED" });
  assert.equal((await adapter.inspect()).sessionReady, false);
  await adapter.close();
});

test("3-5 Given RATE_LIMITED 응답, When start, Then RATE_LIMITED로 실패한다", async () => {
  const { transport, socket } = authenticatedTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 100 });
  const starting = adapter.start({ binding: binding() });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.error",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { code: "RATE_LIMITED", message: "Too many requests" },
  });

  await assert.rejects(starting, { code: "RATE_LIMITED" });
  assert.equal((await adapter.inspect()).sessionReady, false);
  await adapter.close();
});

test("3-6 Given URL과 다른 conversationId, When createWebSessionBinding, Then INVALID_WEB_SESSION_BINDING", () => {
  assert.throws(() => binding({ conversationId: "different-id" }), {
    code: "INVALID_WEB_SESSION_BINDING",
  });
});

test("3-7 Given 활성 turn, When 두 번째 submitTurn, Then WEB_SESSION_BUSY", async () => {
  const { adapter, socket } = await startAdapter();
  const first = await adapter.submitTurn({
    turnId: "turn-1",
    controllerMessageId: "message-1",
    runId: "run-1",
    text: "first",
    timeoutMs: 20,
  });
  await assert.rejects(adapter.submitTurn({
    turnId: "turn-2",
    controllerMessageId: "message-2",
    runId: "run-1",
    text: "second",
  }), { code: "WEB_SESSION_BUSY" });
  promptError(socket, "turn-1", "RATE_LIMITED", "Too many requests");
  await assert.rejects(first.completion, { code: "RATE_LIMITED" });
  await adapter.close();
});

test("3-8 Given 응답 없음, When submitTurn 제한시간 경과, Then WEB_TURN_AMBIGUOUS와 상태 정리", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { adapter } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.submitTurn({
    turnId: "turn-timeout",
    controllerMessageId: "message-timeout",
    runId: "run-1",
    text: "wait",
    timeoutMs: 5,
  });
  t.mock.timers.tick(15_005);
  await assert.rejects(turn.completion, { code: "WEB_TURN_AMBIGUOUS" });
  assert.equal(adapter.activeTurnId, null);
  assert.equal((await adapter.inspect()).ambiguousTurnId, "turn-timeout");
  assert.deepEqual(events.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
  await adapter.close();
});

test("3-9 Given 생성 중 수동 개입, When web.manual-intervention, Then 복구 필요 실패 이벤트", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.submitTurn({
    turnId: "turn-manual",
    controllerMessageId: "message-manual",
    runId: "run-1",
    text: "controlled prompt",
    timeoutMs: 100,
  });
  socket.receive({
    type: "web.manual-intervention",
    protocolVersion: 2,
    requestId: "turn-manual",
    payload: { observedMessageId: "manual-message" },
  });

  await assert.rejects(turn.completion, { code: "MANUAL_INTERVENTION_DETECTED" });

  const failed = events.at(-1);
  assert.equal(failed.type, "TURN_FAILED");
  assert.equal(failed.payload.code, "MANUAL_INTERVENTION_DETECTED");
  assert.equal(typeof failed.payload.message, "string");
  assert.ok(failed.payload.message.length > 0);
  assert.equal(failed.payload.ambiguous, true);
  assert.equal(failed.payload.recoveryRequired, true);
  await adapter.close();
});

// ---------------------------------------------------------------------------
// 4. 프론트 전달 계약
// ---------------------------------------------------------------------------

test("4-1 Given 프론트 전달 오류, When TURN_FAILED, Then code·message·recoveryRequired가 존재한다", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-frontend-error",
    controllerMessageId: "message-frontend-error",
    runId: "run-1",
    text: "fail",
    timeoutMs: 100,
  });

  promptError(socket, "turn-frontend-error", "RATE_LIMITED", "Too many requests");
  await assert.rejects(turn.completion, { code: "RATE_LIMITED" });

  const failed = events.find((event) => event.type === "TURN_FAILED");
  assert.ok(failed);
  assert.equal(typeof failed.payload.code, "string");
  assert.equal(typeof failed.payload.message, "string");
  assert.equal(typeof failed.payload.recoveryRequired, "boolean");

  await adapter.close();
});
test("4-2 Given 인증 오류, When 거부 응답 생성, Then secret·stack·내부 경로를 노출하지 않는다", () => {
  const transport = new WebExtensionTransport({
    sharedSecret: SHARED_SECRET,
    expectedExtensionIdentity: EXTENSION_IDENTITY,
  });
  const socket = new FakeSocket();
  transport.attach(socket);
  const challenge = socket.sent[0];
  socket.receive({
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: challenge.challengeId,
    extensionIdentity: EXTENSION_IDENTITY,
    hmacSha256: "0".repeat(64),
  });
  const serialized = JSON.stringify(socket.sent.at(-1));
  assert.equal(socket.sent.at(-1).code, "AUTH_HMAC_INVALID");
  assert.equal(serialized.includes(SHARED_SECRET), false);
  assert.equal(serialized.includes("stack"), false);
  assert.equal(serialized.includes(path.sep + "workspace" + path.sep), false);
});

test("4-3 Given turn 실패, When completion 종료, Then activeTurnId가 남지 않는다", async () => {
  const { adapter, socket } = await startAdapter();
  const turn = await adapter.submitTurn({
    turnId: "turn-cleanup",
    controllerMessageId: "message-cleanup",
    runId: "run-1",
    text: "fail",
    timeoutMs: 100,
  });
  promptError(socket, "turn-cleanup", "RATE_LIMITED", "Too many requests");
  await assert.rejects(turn.completion, { code: "RATE_LIMITED" });
  assert.equal(adapter.activeTurnId, null);
  await adapter.close();
});

test("4-4a Given MANUAL_INTERVENTION, When TURN_FAILED, Then recoveryRequired === true", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-recovery-required",
    controllerMessageId: "message-recovery-required",
    runId: "run-1",
    text: "manual intervention",
    timeoutMs: 100,
  });

  socket.receive({
    type: "web.manual-intervention",
    protocolVersion: 2,
    requestId: "turn-recovery-required",
    payload: {},
  });

  await assert.rejects(turn.completion, { code: "MANUAL_INTERVENTION_DETECTED" });

  const failed = events.find((e) => e.type === "TURN_FAILED");
  assert.ok(failed);
  assert.equal(failed.payload.recoveryRequired, true);

  await adapter.close();
});

test("4-4b Given RATE_LIMITED, When TURN_FAILED, Then recoveryRequired === false", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-recovery-not-required",
    controllerMessageId: "message-recovery-not-required",
    runId: "run-1",
    text: "rate limited",
    timeoutMs: 100,
  });

  promptError(socket, "turn-recovery-not-required", "RATE_LIMITED", "Too many requests");
  await assert.rejects(turn.completion, { code: "RATE_LIMITED" });

  const failed = events.find((e) => e.type === "TURN_FAILED");
  assert.ok(failed);
  assert.equal(failed.payload.recoveryRequired, false);

  await adapter.close();
});

// ---------------------------------------------------------------------------
// 5. Session lifecycle contract
// ---------------------------------------------------------------------------

test("5-1 Given 활성 turn, When transport disconnect, Then pending turn이 정리되고 모호 실패한다", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-disconnect",
    controllerMessageId: "message-disconnect",
    runId: "run-1",
    text: "in flight",
    timeoutMs: 1000,
  });

  socket.close(1006, "abnormal closure");

  await assert.rejects(turn.completion, { code: "WEB_TURN_AMBIGUOUS" });
  assert.equal(adapter.activeTurnId, null);
  assert.equal((await adapter.inspect()).sessionReady, false);

  const failed = events.find((e) => e.type === "TURN_FAILED");
  assert.ok(failed);
  assert.equal(failed.payload.recoveryRequired, true);

  await adapter.close();
});

test("5-2 Given timeout 이후, When 늦은 result 도착, Then 무시되고 상태가 오염되지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-late",
    controllerMessageId: "message-late",
    runId: "run-1",
    text: "wait",
    timeoutMs: 5,
  });

  t.mock.timers.tick(15_005);
  await assert.rejects(turn.completion, { code: "WEB_TURN_AMBIGUOUS" });
  assert.equal(adapter.activeTurnId, null);

  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-late",
    payload: {
      text: controllerResponse("late result should be ignored"),
      confidence: "CONFIRMED_BY_UI_STATE",
      session: binding(),
    },
  });

  assert.equal(adapter.activeTurnId, null);
  assert.equal((await adapter.inspect()).ambiguousTurnId, "turn-late");
  assert.equal(events.filter((e) => e.type === "TURN_COMPLETED").length, 0);

  await adapter.close();
});

test("5-3 Given 동일 turn에 중복 result, When 두 번째 수신, Then 첫 결과만 유효하고 중복은 무시된다", async () => {
  const { adapter, socket } = await startAdapter();
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const turn = await adapter.submitTurn({
    turnId: "turn-duplicate",
    controllerMessageId: "message-duplicate",
    runId: "run-1",
    text: "once",
    timeoutMs: 100,
  });

  const firstResult = controllerResponse("first result");
  const duplicateResult = controllerResponse("duplicate result");

  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-duplicate",
    payload: {
      text: firstResult,
      confidence: "CONFIRMED_BY_UI_STATE",
      session: binding(),
    },
  });

  const completed = await turn.completion;
  assert.ok(completed);
  assert.equal(adapter.activeTurnId, null);

  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-duplicate",
    payload: {
      text: duplicateResult,
      confidence: "CONFIRMED_BY_UI_STATE",
      session: binding(),
    },
  });

  assert.equal(events.filter((e) => e.type === "TURN_COMPLETED").length, 1);
  assert.equal(adapter.activeTurnId, null);

  await adapter.close();
});

test("5-4 Given malformed protocol message, When 수신, Then 세션이 깨지지 않고 진단 가능한 실패로 처리된다", async () => {
  const { adapter, socket } = await startAdapter();

  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    payload: { text: "broken" },
  });

  const state = await adapter.inspect();
  assert.equal(state.sessionReady, true);
  assert.equal(adapter.activeTurnId, null);

  await adapter.close();
});

test("5-5 Given 활성 turn, When adapter.close, Then pending turn이 정리되고 activeTurnId가 남지 않는다", async () => {
  const { adapter } = await startAdapter();

  const turn = await adapter.submitTurn({
    turnId: "turn-close",
    controllerMessageId: "message-close",
    runId: "run-1",
    text: "closing",
    timeoutMs: 1000,
  });

  await adapter.close();

  await assert.rejects(turn.completion, (error) => (
    typeof error.code === "string" && error.code.length > 0
  ));
  assert.equal(adapter.activeTurnId, null);
});