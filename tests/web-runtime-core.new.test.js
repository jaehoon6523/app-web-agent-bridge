import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ChatGptWebSessionAdapter,
  WebExtensionAuthenticator,
  WebExtensionTransport,
  assessWebCompletion,
  associatePromptResponse,
  canonicalConversationUrl,
  computeWebChallengeHmac,
  createMarkedPrompt,
  createWebSessionBinding,
  detectWebPageState,
  extractConversationId,
  selectExactConversationTab,
} from "../src/runtime/web/index.js";
import { RUNTIME_EVENT_TYPES } from "../src/runtime/runtime-events.js";
import { parseCodeReviewResponse } from "../src/domain/code-review.js";
import { reviewContext, reportFor } from "./helpers/audit-fixtures.js";

const SECRET = "test-only-shared-secret-0123456789abcdef";
const IDENTITY = "extension-test-01";
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "chatgpt-dom");
const ACCEPT_PACKET = Object.freeze({
  type: "ACCEPT",
  accepted_proposal_sha256: `sha256:${"0".repeat(64)}`,
  blocking_findings: [],
});

function controllerResponse(body = "Reviewed", packet = ACCEPT_PACKET) {
  return `${body}\n<controller_packet>\n${JSON.stringify(packet)}\n</controller_packet>`;
}

function boundSession(overrides = {}) {
  return createWebSessionBinding({
    sessionId: "session-1",
    runId: "run-1",
    tabId: 7,
    windowId: 3,
    documentId: "document-1",
    frameId: 0,
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    conversationId: "conversation-1",
    title: "Bound conversation",
    lastObservedUserMessageId: null,
    lastObservedAssistantMessageId: null,
    bindingStatus: "BOUND",
    ...overrides,
  });
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.failOnType = null;
  }

  send(raw) {
    const message = JSON.parse(String(raw));
    if (message.type === this.failOnType) throw new Error(`send failed for ${message.type}`);
    this.sent.push(message);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  receive(message) {
    // Simulate the extension's success envelope; explicit trace values are never replaced.
    if (message.type === "web.prompt.result" && message.payload?.trace === undefined) {
      const session = message.payload.session;
      message = { ...message, payload: { ...message.payload,
        trace: { requestId: message.requestId, actionId: message.requestId, result: "success",
          tabId: session?.tabId, bindingId: `${session?.sessionId}:${session?.runId}`,
          documentId: session?.documentId, frameId: session?.frameId },
        evidence: { documentId: session?.documentId, frameId: session?.frameId, ...message.payload.evidence },
      } };
    }
    this.emit("message", JSON.stringify(message));
  }
}

function authenticate(transport, socket) {
  const challenge = socket.sent[0];
  socket.receive({
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: challenge.challengeId,
    extensionIdentity: IDENTITY,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, SECRET),
  });
  assert.equal(transport.authenticated, true);
}

async function readyAdapter(transport, socket, binding = boundSession(), options = {}) {
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 500, ...options });
  assert.equal(adapter.actor, "CHATGPT_WEB_AGENT");
  assert.equal(adapter.externalSessionId, null);
  const starting = adapter.start({ binding });
  const request = socket.sent.at(-1);
  assert.equal(request.type, "web.session.rebind");
  socket.receive({
    type: "web.session.ready",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { session: binding },
  });
  await starting;
  return adapter;
}

test("Controller-configured review parser accepts evaluation data through the existing Web adapter", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket, boundSession(), {
    parseResponse: (raw) => parseCodeReviewResponse(raw, reviewContext()),
  });
  const report = reportFor(reviewContext(), "UNSATISFIED");
  try {
    const handle = await adapter.submitTurn({ turnId: "review-1", controllerMessageId: "review-input", runId: "run-1", text: "Review captured diff" });
    socket.receive({ type: "web.prompt.result", protocolVersion: 2, requestId: "review-1", payload: {
      text: controllerResponse("Review", report), confidence: "CONFIRMED_BY_UI_STATE",
      evidence: { assistantMessageId: "review-message" }, session: boundSession(),
    } });
    assert.deepEqual((await handle.completion).packet, report);
  } finally { await adapter.close(); }
});

test("explicit Web rebind carries the user-selected tab and establishes that exact binding", async () => {
  const transport = new WebExtensionTransport({ sharedSecret:SECRET, expectedExtensionIdentity:IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket); authenticate(transport, socket);
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs:500 });
  const requested = createWebSessionBinding({
    sessionId:"session-rebind", runId:"run-rebind",
    tabId:null, windowId:null, documentId:null, frameId:null,
    conversationUrl:"https://chatgpt.com/c/rebind", conversationId:"rebind",
    title:null, lastObservedUserMessageId:null, lastObservedAssistantMessageId:null,
    bindingStatus:"NEEDS_REBIND",
  });
  const pending = adapter.rebind({ binding:requested, tabId:12, focus:true });
  const request = socket.sent.at(-1);
  assert.equal(request.type, "web.session.rebind");
  assert.equal(request.payload.tabId, 12);
  assert.equal(request.payload.focus, true);
  const rebound = createWebSessionBinding({
    ...requested, tabId:12, windowId:2, documentId:"document-12", frameId:0,
    title:"Chosen", bindingStatus:"BOUND",
  });
  socket.receive({
    type:"web.session.ready", protocolVersion:2, requestId:request.requestId,
    payload:{ session:rebound },
  });
  const result = await pending;
  assert.equal(result.tabId, 12);
  assert.equal(result.conversationId, "rebind");
  assert.equal((await adapter.inspect()).sessionReady, true);
  await adapter.close();
});

test("one-time HMAC challenges reject invalid values and replay", () => {
  let now = 1_000;
  let counter = 0;
  const authenticator = new WebExtensionAuthenticator({
    sharedSecret: SECRET,
    expectedExtensionIdentity: IDENTITY,
    clock: () => now,
    randomBytesFn: (size) => Buffer.alloc(size, ++counter),
  });
  const challenge = authenticator.issueChallenge();
  const validResponse = {
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: challenge.challengeId,
    extensionIdentity: IDENTITY,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, SECRET),
  };
  assert.equal(authenticator.verifyResponse(validResponse).extensionIdentity, IDENTITY);
  assert.throws(() => authenticator.verifyResponse(validResponse), { code: "AUTH_REPLAY_REJECTED" });

  const invalidChallenge = authenticator.issueChallenge();
  const invalid = {
    ...validResponse,
    challengeId: invalidChallenge.challengeId,
    hmacSha256: "0".repeat(64),
  };
  assert.throws(() => authenticator.verifyResponse(invalid), { code: "AUTH_HMAC_INVALID" });
  assert.throws(() => authenticator.verifyResponse({
    ...invalid,
    hmacSha256: computeWebChallengeHmac(invalidChallenge.nonce, SECRET),
  }), { code: "AUTH_REPLAY_REJECTED" });

  now += 60_000;
  const expired = authenticator.issueChallenge();
  now += 60_000;
  assert.throws(() => authenticator.verifyResponse({
    ...validResponse,
    challengeId: expired.challengeId,
    hmacSha256: computeWebChallengeHmac(expired.nonce, SECRET),
  }), { code: "AUTH_CHALLENGE_EXPIRED" });
});

test("Web extension authentication rejects weak shared secrets", () => {
  assert.throws(() => new WebExtensionAuthenticator({
    sharedSecret: "too-short",
    expectedExtensionIdentity: IDENTITY,
  }), { code: "INVALID_AUTH_CONFIGURATION" });
});

test("transport ignores unauthenticated events and keeps diagnostics off canonical channel", () => {
  const transport = new WebExtensionTransport({
    sharedSecret: SECRET,
    expectedExtensionIdentity: IDENTITY,
  });
  const socket = new FakeSocket();
  const diagnostics = [];
  const runtimeEvents = [];
  const messages = [];
  transport.on("diagnostic", (event) => diagnostics.push(event));
  transport.onEvent((event) => runtimeEvents.push(event));
  transport.on("message", (message) => messages.push(message));
  transport.attach(socket);

  socket.receive({ type: "extension.hello", protocolVersion: 2, payload: { secret: "must-not-pass" } });
  assert.equal(messages.length, 0);
  assert.equal(diagnostics.at(-1).type, "UNAUTHENTICATED_MESSAGE_IGNORED");
  authenticate(transport, socket);
  socket.receive({ type: "extension.state", protocolVersion: 2, payload: {} });
  socket.receive({
    type: "extension.auth.response",
    protocolVersion: 2,
    challengeId: socket.sent[0].challengeId,
    extensionIdentity: IDENTITY,
    hmacSha256: "0".repeat(64),
  });
  assert.equal(messages.length, 1);
  assert.equal(diagnostics.at(-1).type, "AUTH_REPLAY_IGNORED");
  assert.deepEqual(runtimeEvents, []);
  transport.close();
  assert.ok(runtimeEvents.every((event) => RUNTIME_EVENT_TYPES.includes(event.type)));
});

test("unauthenticated candidate socket cannot evict an authenticated active transport", async () => {
  const transport = new WebExtensionTransport({
    sharedSecret: SECRET,
    expectedExtensionIdentity: IDENTITY,
  });
  const authenticatedSocket = new FakeSocket();
  transport.attach(authenticatedSocket);
  authenticate(transport, authenticatedSocket);
  const adapter = await readyAdapter(transport, authenticatedSocket);
  const turn = await adapter.submitTurn({
    turnId: "turn-kept",
    controllerMessageId: "msg-kept",
    runId: "run-1",
    text: "Keep this pending turn",
    timeoutMs: 500,
  });

  const candidateSocket = new FakeSocket();
  transport.attach(candidateSocket);
  assert.deepEqual(candidateSocket.closed, {
    code: 4409,
    reason: "Authenticated extension already connected",
  });
  assert.equal(candidateSocket.sent.length, 0);
  assert.equal(authenticatedSocket.closed, null);
  assert.equal(transport.authenticated, true);

  authenticatedSocket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-kept",
    payload: {
      text: controllerResponse("Still bound"),
      confidence: "CONFIRMED_BY_UI_STATE",
      session: boundSession({ lastObservedAssistantMessageId: "assistant-kept" }),
    },
  });
  assert.equal((await turn.completion).text, "Still bound");
  await adapter.close();
});

test("a heartbeat keeps the authenticated extension; an expired connection can be replaced", () => {
  let time = 0;
  const transport = new WebExtensionTransport({
    sharedSecret: SECRET,
    expectedExtensionIdentity: IDENTITY,
  }, { now: () => time, staleAfterMs: 65_000 });
  const oldSocket = new FakeSocket();
  transport.attach(oldSocket);
  authenticate(transport, oldSocket);

  time = 60_000;
  oldSocket.receive({ type: "extension.heartbeat", protocolVersion: 2, payload: { at: time } });
  time = 70_000;
  const premature = new FakeSocket();
  transport.attach(premature);
  assert.equal(premature.closed?.code, 4409);
  assert.equal(oldSocket.closed, null);

  time = 126_000;
  const replacement = new FakeSocket();
  transport.attach(replacement);
  assert.equal(oldSocket.closed?.code, 4001);
  authenticate(transport, replacement);
  oldSocket.emit("close");
  assert.equal(transport.authenticated, true);
  assert.equal(transport.snapshot.connected, true);
  transport.close();
});

test("expired extension heartbeat disconnects without confirming or replaying an active delivery", async () => {
  let time = 0;
  const transport = new WebExtensionTransport({
    sharedSecret: SECRET,
    expectedExtensionIdentity: IDENTITY,
  }, { now: () => time, staleAfterMs: 65_000 });
  const socket = new FakeSocket();
  const events = [];
  transport.onEvent((event) => events.push(event));
  transport.attach(socket);
  authenticate(transport, socket);
  assert.equal(transport.snapshot.responsive, true);

  time = 65_001;
  assert.equal(transport.snapshot.responsive, false);
  assert.equal(transport.expireStaleConnection(), true);
  assert.equal(transport.snapshot.connected, false);
  assert.equal(socket.closed?.code, 4001);
  assert.equal(events.filter((event) => event.type === "SESSION_DISCONNECTED").length, 1);
  assert.equal(transport.expireStaleConnection(), false);

  const nextSocket = new FakeSocket();
  transport.attach(nextSocket);
  authenticate(transport, nextSocket);
  socket.emit("close");
  assert.equal(transport.snapshot.responsive, true);
  transport.close();
});

test("exact conversation binding never falls back to active or latest tabs", () => {
  assert.equal(canonicalConversationUrl("https://chatgpt.com/c/abc?x=1#y"), "https://chatgpt.com/c/abc");
  assert.equal(extractConversationId("https://chatgpt.com/c/abc"), "abc");
  assert.equal(canonicalConversationUrl("https://chatgpt.com/uc/guest-abc?x=1#y"), "https://chatgpt.com/uc/guest-abc");
  assert.equal(extractConversationId("https://chatgpt.com/uc/guest-abc"), "guest-abc");
  assert.equal(extractConversationId("https://chatgpt.com/c/WEB:temporary"), null);
  assert.equal(extractConversationId("https://chatgpt.com/c/WEB%3Atemporary"), null);
  assert.equal(canonicalConversationUrl("https://chat.openai.com/c/abc"), null);
  const binding = boundSession();
  const result = selectExactConversationTab([
    { id: 99, windowId: 1, active: true, url: "https://chatgpt.com/c/wrong", title: "Wrong" },
    { id: 7, windowId: 3, active: false, url: binding.conversationUrl, title: "Right" },
  ], binding);
  assert.equal(result.status, "BOUND");
  assert.equal(result.tab.id, 7);

  assert.equal(selectExactConversationTab([], binding).status, "NEEDS_REBIND");
  assert.equal(selectExactConversationTab([
    { id: 7, windowId: 3, url: binding.conversationUrl },
    { id: 8, windowId: 4, url: binding.conversationUrl },
  ], binding).status, "AMBIGUOUS");
  assert.throws(() => createWebSessionBinding({ ...binding, active: true }), {
    code: "INVALID_WEB_SESSION_BINDING",
  });
});

test("prompt markers bind only the matching user turn and following assistant", () => {
  const content = createMarkedPrompt({
    controllerMessageId: "msg-1",
    runId: "run-1",
    content: "Review this proposal.",
  });
  const association = associatePromptResponse({
    controllerMessageId: "msg-1",
    runId: "run-1",
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/conversation-1",
    messages: [
      { id: "u1", role: "user", text: content, index: 10 },
      { id: "a1", role: "assistant", text: "Review", index: 11 },
    ],
  });
  assert.deepEqual(association, {
    status: "MATCHED",
    reason: null,
    userMessageId: "u1",
    assistantMessageId: "a1",
  });

  const duplicateMarker = associatePromptResponse({
    controllerMessageId: "msg-1",
    runId: "run-1",
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/conversation-1",
    messages: [{ id: "u1", role: "user", text: `${content}\n[run_id:run-1]`, index: 10 }],
  });
  assert.equal(duplicateMarker.status, "MARKER_NOT_FOUND");

  const manual = associatePromptResponse({
    controllerMessageId: "msg-1",
    runId: "run-1",
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/conversation-1",
    messages: [
      { id: "u1", role: "user", text: content, index: 10 },
      { id: "manual", role: "user", text: "Human message", index: 11 },
      { id: "a1", role: "assistant", text: "Wrongly associated", index: 12 },
    ],
  });
  assert.equal(manual.status, "MANUAL_INTERVENTION_DETECTED");
  assert.equal(manual.observedMessageId, "manual");

  const changed = associatePromptResponse({
    controllerMessageId: "msg-1",
    runId: "run-1",
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/other",
    messages: [],
  });
  assert.equal(changed.status, "MANUAL_INTERVENTION_DETECTED");
  assert.equal(changed.reason, "CONVERSATION_CHANGED");
});

test("DOM snapshot fixtures preserve normal, manual, and wrong-conversation outcomes", async () => {
  for (const name of [
    "normal-conversation.json",
    "manual-user-insertion.json",
    "wrong-conversation.json",
  ]) {
    const fixture = JSON.parse(await readFile(path.join(FIXTURE_ROOT, name), "utf8"));
    const expectedStatus = fixture.expectedStatus;
    delete fixture.expectedStatus;
    assert.equal(associatePromptResponse(fixture).status, expectedStatus, name);
  }
});

test("completion is confirmed only from associated and stable UI evidence", () => {
  const association = { status: "MATCHED", assistantMessageId: "a1" };
  const confirmed = assessWebCompletion({
    association,
    assistantMessageId: "a1",
    stopButtonVisible: false,
    sendButtonEnabled: true,
    stableForMs: 4_000,
    requiredStableMs: 3_500,
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/conversation-1",
  });
  assert.equal(confirmed.confidence, "CONFIRMED_BY_UI_STATE");
  assert.equal(confirmed.automaticRelayAllowed, true);

  const heuristic = assessWebCompletion({
    ...confirmed.signals,
    association,
    assistantMessageId: "a1",
    stopButtonVisible: false,
    sendButtonEnabled: null,
    stableForMs: 4_000,
    requiredStableMs: 3_500,
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/conversation-1",
  });
  assert.equal(heuristic.confidence, "HEURISTIC");

  const ambiguous = assessWebCompletion({
    association,
    assistantMessageId: "a1",
    stopButtonVisible: true,
    sendButtonEnabled: false,
    stableForMs: 100,
    requiredStableMs: 3_500,
    expectedConversationUrl: "https://chatgpt.com/c/conversation-1",
    observedConversationUrl: "https://chatgpt.com/c/other",
  });
  assert.equal(ambiguous.confidence, "AMBIGUOUS");
  assert.equal(ambiguous.automaticRelayAllowed, false);
});

test("page-state detection distinguishes authentication and UI failures", () => {
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/auth/login",
    title: "Log in to ChatGPT",
  }), "SESSION_AUTH_REQUIRED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    title: "Verify you are human",
    pageText: "CAPTCHA",
  }), "CAPTCHA_REQUIRED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    title: "Checking your browser",
    pageText: "Cloudflare security check",
  }), "SECURITY_CHECK_REQUIRED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    title: "ChatGPT",
    pageText: "Too many requests",
  }), "RATE_LIMITED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    title: "ChatGPT",
    pageText: "Something went wrong",
  }), "CHATGPT_ERROR_PAGE");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    composerPresent: true,
    sendFailure: true,
  }), "MESSAGE_SEND_FAILED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    title: "ChatGPT",
    composerPresent: false,
  }), "UI_CONTRACT_CHANGED");
  assert.equal(detectWebPageState({
    url: "https://chatgpt.com/c/x",
    composerPresent: true,
  }), "READY");
});

test("failed Web session start never leaves a turn-submittable binding", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 500 });
  const starting = adapter.start({ binding: boundSession() });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.error",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { code: "SESSION_AUTH_REQUIRED", message: "Login required" },
  });
  await assert.rejects(starting, { code: "SESSION_AUTH_REQUIRED" });
  const inspection = await adapter.inspect();
  assert.equal(inspection.sessionReady, false);
  assert.equal(inspection.binding, null);
  await assert.rejects(adapter.submitTurn({
    turnId: "turn-after-failed-start",
    controllerMessageId: "msg-after-failed-start",
    runId: "run-1",
    text: "Must not send",
  }), { code: "WEB_SESSION_NOT_READY" });
  await adapter.close();
});

test("submitTurn returns a TurnHandle before Web response and emits only canonical runtime events", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  for (const method of ["start", "resume", "inspect", "submitTurn", "interrupt", "close", "onEvent", "acknowledgeDelivery"]) {
    assert.equal(typeof adapter[method], "function");
  }
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turnHandle = await adapter.submitTurn({
    turnId: "turn-1",
    controllerMessageId: "msg-1",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  });
  let completionSettled = false;
  void turnHandle.completion.then(
    () => { completionSettled = true; },
    () => { completionSettled = true; },
  );
  await Promise.resolve();
  assert.equal(completionSettled, false);
  assert.equal(turnHandle.turnId, "turn-1");
  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-1",
    payload: {
      text: controllerResponse(),
      confidence: "CONFIRMED_BY_UI_STATE",
      evidence: { assistantMessageId: "a1" },
      session: boundSession({ lastObservedAssistantMessageId: "a1" }),
    },
  });
  const completed = await turnHandle.completion;
  assert.equal(completed.text, "Reviewed");
  assert.deepEqual(completed.packet, ACCEPT_PACKET);
  assert.equal(completed.rawText, controllerResponse());
  assert.ok(runtimeEvents.every((event) => RUNTIME_EVENT_TYPES.includes(event.type)));
  assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_COMPLETED"]);
  await adapter.close();
});

test("delivery acknowledgement resolves only after exact extension confirmation", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const pending = adapter.acknowledgeDelivery({ turnId:"turn-ack" });
  const request = socket.sent.at(-1);
  assert.equal(request.type, "web.delivery.ack");
  assert.equal(request.requestId, "turn-ack");
  socket.receive({
    type:"web.delivery.acknowledged",
    protocolVersion:2,
    requestId:"turn-ack",
    payload:{
      currentDeliveryId:null,
      sessionId:"session-1",
      runId:"run-1",
      conversationUrl:"https://chatgpt.com/c/conversation-1",
    },
  });
  const result = await pending;
  assert.equal(result.currentDeliveryId, null);
  assert.equal(result.sessionId, "session-1");
  await adapter.close();
});

test("ambiguous extension output becomes TURN_FAILED rather than canonical completion", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turnHandle = await adapter.submitTurn({
    turnId: "turn-ambiguous",
    controllerMessageId: "msg-ambiguous",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  });
  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-ambiguous",
    payload: { text: "Uncertain", confidence: "AMBIGUOUS", evidence: {} },
  });
  await assert.rejects(turnHandle.completion, { code: "AMBIGUOUS_COMPLETION" });
  assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
  await adapter.close();
});

test("missing or unknown Web completion confidence can never become canonical completion", async () => {
  for (const [suffix, confidence] of [["missing", undefined], ["unknown", "TOTALLY_DONE"]]) {
    const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
    const socket = new FakeSocket();
    transport.attach(socket);
    authenticate(transport, socket);
    const adapter = await readyAdapter(transport, socket);
    const runtimeEvents = [];
    adapter.onEvent((event) => runtimeEvents.push(event));
    const turnId = `turn-confidence-${suffix}`;
    const turnHandle = await adapter.submitTurn({
      turnId,
      controllerMessageId: `msg-confidence-${suffix}`,
      runId: "run-1",
      text: "Review",
      timeoutMs: 500,
    });
    socket.receive({
      type: "web.prompt.result",
      protocolVersion: 2,
      requestId: turnId,
      payload: { text: "Unverified", ...(confidence === undefined ? {} : { confidence }) },
    });
    await assert.rejects(turnHandle.completion, { code: "AMBIGUOUS_COMPLETION" });
    assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
    await adapter.close();
  }
});

test("relay-safe UI completion without a strict final controller packet fails", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turnHandle = await adapter.submitTurn({
    turnId: "turn-missing-packet",
    controllerMessageId: "msg-missing-packet",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  });
  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-missing-packet",
    payload: {
      text: "Looks good, but has no machine packet.",
      confidence: "CONFIRMED_BY_UI_STATE",
      session: boundSession(),
    },
  });
  await assert.rejects(turnHandle.completion, { code: "CONTROLLER_PACKET_MISSING" });
  assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
  await adapter.close();
});

test("a valid-looking response cannot replace the exact active Web binding", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turnHandle = await adapter.submitTurn({
    turnId: "turn-binding-drift",
    controllerMessageId: "msg-binding-drift",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  });
  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-binding-drift",
    payload: {
      text: controllerResponse(),
      confidence: "CONFIRMED_BY_UI_STATE",
      session: boundSession({ sessionId: "session-other" }),
    },
  });
  await assert.rejects(turnHandle.completion, { code: "WEB_SESSION_BINDING_MISMATCH" });
  assert.equal(transport.snapshot.binding.sessionId, "session-1");
  assert.equal((await adapter.inspect()).sessionReady, false);
  await assert.rejects(adapter.submitTurn({
    turnId: "turn-after-binding-drift",
    controllerMessageId: "msg-after-binding-drift",
    runId: "run-1",
    text: "Must rebind first",
  }), { code: "WEB_SESSION_NOT_READY" });
  assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
  await adapter.close();
});

test("manual intervention invalidates readiness and requires explicit recovery", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turn = await adapter.submitTurn({
    turnId: "turn-manual-intervention",
    controllerMessageId: "msg-manual-intervention",
    runId: "run-1",
    text: "Do not mix manual input",
    timeoutMs: 500,
  });
  socket.receive({
    type: "web.manual-intervention",
    protocolVersion: 2,
    requestId: "turn-manual-intervention",
    payload: { observedMessageId: "manual-user-message" },
  });

  await assert.rejects(turn.completion, { code: "MANUAL_INTERVENTION_DETECTED" });
  const inspection = await adapter.inspect();
  assert.equal(inspection.sessionReady, false);
  assert.equal(inspection.ambiguousTurnId, "turn-manual-intervention");
  assert.deepEqual(runtimeEvents.at(-1).payload, {
    code: "MANUAL_INTERVENTION_DETECTED",
    message: "Manual intervention was detected in the bound conversation",
    ambiguous: true,
    recoveryRequired: true,
  });
  await assert.rejects(adapter.resume({ binding: boundSession() }), {
    code: "WEB_TURN_AMBIGUOUS_UNRESOLVED",
  });
  await adapter.close();
});

for (const mutation of ["missing", "request", "action", "document", "frame"]) {
  test(`success trace rejects ${mutation} and preserves the dispatched binding`, async () => {
    const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
    const socket = new FakeSocket(); transport.attach(socket); authenticate(transport, socket);
    const original = boundSession();
    const adapter = await readyAdapter(transport, socket, original);
    const turnId = `trace-${mutation}`;
    const turn = await adapter.submitTurn({ turnId, controllerMessageId: turnId, runId: "run-1", text: "Review", timeoutMs: 500 });
    let session = original;
    const trace = { requestId: turnId, actionId: turnId, result: "success", tabId: original.tabId,
      bindingId: `${original.sessionId}:${original.runId}`, documentId: original.documentId, frameId: original.frameId };
    const evidence = { documentId: original.documentId, frameId: original.frameId };
    if (mutation === "request") trace.requestId = "old";
    if (mutation === "action") trace.actionId = "old";
    if (mutation === "document") trace.documentId = "old";
    if (mutation === "frame") trace.frameId = 1;
    socket.receive({ type: "web.prompt.result", protocolVersion: 2, requestId: turnId,
      payload: { text: controllerResponse(), confidence: "CONFIRMED_BY_UI_STATE", session, evidence,
        trace: mutation === "missing" ? null : trace } });
    await assert.rejects(turn.completion, { code: "WEB_SUCCESS_TRACE_MISMATCH" });
    assert.equal((await adapter.inspect()).sessionReady, false);
    assert.deepEqual(transport.snapshot.binding, original);
    await adapter.close();
  });
}

test("an authenticated success trace may replace the locator with the current user target", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket(); transport.attach(socket); authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const turnId = "turn-current-target";
  const turn = await adapter.submitTurn({ turnId, controllerMessageId: turnId, runId: "run-1", text: "Review", timeoutMs: 500 });
  const session = boundSession({ tabId: 8, documentId: "document-b", conversationUrl: "https://chatgpt.com/c/b", conversationId: "b" });
  const trace = { requestId: turnId, actionId: turnId, result: "success", tabId: 8,
    bindingId: "session-1:run-1", documentId: "document-b", frameId: 0 };
  socket.receive({ type: "web.prompt.result", protocolVersion: 2, requestId: turnId,
    payload: { text: controllerResponse(), confidence: "CONFIRMED_BY_UI_STATE", session,
      evidence: { documentId: "document-b", frameId: 0 }, trace } });
  const response = await turn.completion;
  assert.equal(response.binding.tabId, 8);
  assert.equal(response.binding.documentId, "document-b");
  assert.equal(response.binding.conversationId, "b");
  await adapter.close();
});

test("a submitted Web prompt timeout remains ambiguous and blocks resend", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const runtimeEvents = [];
  adapter.onEvent((event) => runtimeEvents.push(event));
  const turn = await adapter.submitTurn({
    turnId: "turn-timeout-ambiguous",
    controllerMessageId: "msg-timeout-ambiguous",
    runId: "run-1",
    text: "May already be running",
    timeoutMs: 5,
  });
  await assert.rejects(turn.completion, { code: "WEB_TURN_AMBIGUOUS" });
  assert.deepEqual(runtimeEvents.map((event) => event.type), ["TURN_STARTED", "TURN_FAILED"]);
  assert.deepEqual(runtimeEvents.at(-1).payload, {
    code: "WEB_TURN_AMBIGUOUS",
    message: "Web prompt timed out after submission; its outcome is ambiguous",
    ambiguous: true,
    recoveryRequired: true,
  });
  assert.equal((await adapter.inspect()).ambiguousTurnId, "turn-timeout-ambiguous");
  await assert.rejects(adapter.submitTurn({
    turnId: "turn-duplicate",
    controllerMessageId: "msg-duplicate",
    runId: "run-1",
    text: "Do not resend",
  }), { code: "WEB_TURN_AMBIGUOUS_UNRESOLVED" });
  await adapter.close();
});

test("session start and resume cannot overlap an active Web turn", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const binding = boundSession();
  const adapter = await readyAdapter(transport, socket, binding);
  const turn = await adapter.submitTurn({
    turnId: "turn-session-busy",
    controllerMessageId: "msg-session-busy",
    runId: "run-1",
    text: "Keep this operation active",
    timeoutMs: 500,
  });

  await assert.rejects(adapter.start({ binding }), { code: "WEB_SESSION_BUSY" });
  await assert.rejects(adapter.resume({ binding }), { code: "WEB_SESSION_BUSY" });

  socket.receive({
    type: "web.prompt.result",
    protocolVersion: 2,
    requestId: "turn-session-busy",
    payload: {
      text: controllerResponse(),
      confidence: "CONFIRMED_BY_UI_STATE",
      session: binding,
    },
  });
  await turn.completion;
  await adapter.close();
});

test("two Web session preparations cannot run concurrently", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const binding = boundSession();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 500 });
  const first = adapter.start({ binding });

  await assert.rejects(adapter.start({ binding }), { code: "WEB_SESSION_BUSY" });
  const request = socket.sent.at(-1);
  socket.receive({
    type: "web.session.ready",
    protocolVersion: 2,
    requestId: request.requestId,
    payload: { session: binding },
  });
  await first;
  await adapter.close();
});

test("disconnect after Web prompt submission is ambiguous rather than retry-safe failure", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const turn = await adapter.submitTurn({
    turnId: "turn-disconnect-ambiguous",
    controllerMessageId: "msg-disconnect-ambiguous",
    runId: "run-1",
    text: "May survive the socket",
    timeoutMs: 500,
  });
  socket.close(1006, "synthetic disconnect");
  await assert.rejects(turn.completion, { code: "WEB_TURN_AMBIGUOUS" });
  const inspection = await adapter.inspect();
  assert.equal(inspection.sessionReady, false);
  assert.equal(inspection.ambiguousTurnId, "turn-disconnect-ambiguous");
  await adapter.close();
});

test("interrupt resolves only after the content path confirms cancellation", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.submitTurn({
    turnId: "turn-cancel",
    controllerMessageId: "msg-cancel",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  });
  const interruption = adapter.interrupt({ turnId: "turn-cancel" });
  assert.equal(socket.sent.at(-1).type, "web.cancel");
  socket.receive({
    type: "web.prompt.cancelled",
    protocolVersion: 2,
    requestId: "turn-cancel",
    payload: {},
  });
  await interruption;
  await assert.rejects(turn.completion, { code: "TURN_INTERRUPTED" });
  assert.deepEqual(events.map((event) => event.type), ["TURN_STARTED", "TURN_INTERRUPTED"]);
  await adapter.close();
});

test("transport send failure returns no handle and emits no TURN_STARTED", async () => {
  const transport = new WebExtensionTransport({ sharedSecret: SECRET, expectedExtensionIdentity: IDENTITY });
  const socket = new FakeSocket();
  transport.attach(socket);
  authenticate(transport, socket);
  const adapter = await readyAdapter(transport, socket);
  const events = [];
  adapter.onEvent((event) => events.push(event));
  socket.failOnType = "web.prompt";
  await assert.rejects(adapter.submitTurn({
    turnId: "turn-send-failure",
    controllerMessageId: "msg-send-failure",
    runId: "run-1",
    text: "Review",
    timeoutMs: 500,
  }), /send failed for web\.prompt/);
  assert.deepEqual(events, []);
  assert.equal((await adapter.inspect()).authenticated, true);
  await adapter.close();
});
