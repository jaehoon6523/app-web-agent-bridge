import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertRelaySafeCompletion,
  assertTurnSessionBinding,
  assertTurnStateBinding,
  assertTurnTabBinding,
  captureTurnBinding,
  createActiveTurnGate,
} from "../extension/runtime/turn-guard.js";

function boundState(overrides = {}) {
  return {
    lastBoundSessionId: "session-1",
    lastBoundRunId: "run-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    conversationId: "conversation-1",
    tabId: 7,
    windowId: 3,
    documentId: "document-1",
    frameId: 0,
    currentDeliveryId: "delivery-1",
    bindingStatus: "BOUND",
    ...overrides,
  };
}

function frozenTurn() {
  return captureTurnBinding(boundState(), {
    requestId: "delivery-1",
    controllerMessageId: "message-1",
    runId: "run-1",
  });
}

test("active turn reservation is synchronous, exclusive, and released only by its token", () => {
  const gate = createActiveTurnGate();
  const reservation = gate.reserve("delivery-1");
  assert.equal(gate.active, true);
  assert.equal(gate.activeRequestId, "delivery-1");
  assert.throws(() => gate.reserve("delivery-2"), { code: "WEB_SESSION_BUSY" });
  assert.throws(() => gate.assertIdle("Session rebind"), { code: "WEB_SESSION_BUSY" });
  assert.equal(gate.release(Object.freeze({ requestId: "delivery-1" })), false);
  assert.equal(gate.active, true);
  assert.equal(gate.release(reservation), true);
  assert.equal(gate.active, false);
  assert.throws(() => gate.reserve(" "), { code: "INVALID_DELIVERY" });
});

test("a frozen turn rejects state, tab, or returned-session binding drift", () => {
  const expected = frozenTurn();
  assert.equal(assertTurnStateBinding(expected, boundState()).currentDeliveryId, "delivery-1");
  assert.equal(assertTurnTabBinding(
    expected,
    { id: 7, windowId: 3 },
    expected.conversationUrl,
    expected.conversationId,
  ).id, 7);
  const session = {
    sessionId: expected.sessionId,
    runId: expected.runId,
    conversationUrl: expected.conversationUrl,
    conversationId: expected.conversationId,
    tabId: expected.tabId,
    windowId: expected.windowId,
    documentId: expected.documentId,
    frameId: expected.frameId,
    bindingStatus: "BOUND",
  };
  assert.equal(assertTurnSessionBinding(expected, session), session);

  assert.throws(
    () => assertTurnStateBinding(expected, boundState({ currentDeliveryId: "delivery-2" })),
    { code: "TURN_BINDING_CHANGED" },
  );
  assert.throws(
    () => assertTurnTabBinding(expected, { id: 8, windowId: 3 }, expected.conversationUrl, expected.conversationId),
    { code: "TURN_BINDING_CHANGED" },
  );
  assert.throws(
    () => assertTurnSessionBinding(expected, { ...session, conversationId: "other" }),
    { code: "TURN_BINDING_CHANGED" },
  );
});

test("only exact relay-safe completion confidences with frozen conversation evidence pass", () => {
  const expected = frozenTurn();
  const completion = {
    text: "Reviewed",
    confidence: "CONFIRMED_BY_UI_STATE",
    evidence: {
      conversationUrl: expected.conversationUrl,
      conversationId: expected.conversationId,
      documentId: expected.documentId,
      frameId: expected.frameId,
    },
  };
  assert.equal(assertRelaySafeCompletion(completion, expected), completion);
  assert.equal(
    assertRelaySafeCompletion({ ...completion, confidence: "HEURISTIC" }, expected).confidence,
    "HEURISTIC",
  );
  for (const confidence of [undefined, null, "AMBIGUOUS", "TOTALLY_DONE"]) {
    assert.throws(
      () => assertRelaySafeCompletion({ ...completion, confidence }, expected),
      { code: "AMBIGUOUS_COMPLETION" },
    );
  }
  assert.throws(
    () => assertRelaySafeCompletion({
      ...completion,
      evidence: { ...completion.evidence, conversationId: "other" },
    }, expected),
    { code: "TURN_BINDING_CHANGED" },
  );
});

test("background integration reserves a prompt before its first await and guards binding mutations", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const promptStart = source.indexOf("async function handlePrompt(message)");
  const promptEnd = source.indexOf("async function cancelPrompt", promptStart);
  const promptBody = source.slice(promptStart, promptEnd);
  assert.ok(promptBody.indexOf("turnGate.reserve(message.requestId)") >= 0);
  assert.ok(promptBody.indexOf("turnGate.reserve(message.requestId)") < promptBody.indexOf("await "));
  assert.match(source, /turnGate\.assertIdle\(explicitRebind \? "Session rebind" : "Session preparation"\)/u);
  assert.match(source, /turnGate\.assertIdle\("Delivery acknowledgement"\)/u);
  assert.match(source, /turnGate\.assertIdle\("Session focus"\)/u);
});
