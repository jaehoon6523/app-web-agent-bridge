import test from "node:test";
import assert from "node:assert/strict";
import { fixture, settled } from "./helpers/preparation-service-fixture.js";
import {
  isPlainTextDiscussionCandidate, preservesPlainTextDiscussion, plainTextDiscussionAgreement,
} from "../src/orchestration/preparation-plain-text.js";

const context = { acceptPlainTextDiscussion: true, lifecycle: "ACTIVE", agreement: { status: "DISCUSSING" } };
const response = {
  rawText: "  어떤 기능이 필요한가요?\n",
  confidence: "CONFIRMED_BY_UI_STATE",
  evidence: { responseAssociation: "DIRECT_DOM_ORDER" },
};
const missing = { code: "CONTROLLER_PACKET_MISSING" };
const candidate = (options = {}) => isPlainTextDiscussionCandidate({
  context, response, packetParseError: missing, validationStatus: "CONFIRMED", ...options,
});

test("only verified plain text for an active opt-in preparation is a candidate", () => {
  assert.equal(candidate(), true);
  for (const changedContext of [
    { ...context, acceptPlainTextDiscussion: false },
    { ...context, acceptPlainTextDiscussion: undefined },
    { ...context, lifecycle: "ABANDONED" },
    { ...context, agreement: { status: "APPROVED" } },
  ]) assert.equal(candidate({ context: changedContext }), false);
  assert.equal(candidate({ validationStatus: "FAILED" }), false);
  assert.equal(candidate({ packetParseError: { code: "INVALID_PACKET_JSON" } }), false);
});

test("empty text, packet markers and uncertain association are rejected", () => {
  for (const rawText of ["", "  \n", "<controller_packet>", "</CONTROLLER_PACKET>",
    "CONTROLLER_PACKET_BEGIN", "controller_packet_end", "답변시작", "답변끝", "질문\n</controller_packet>\n후기"]) {
    assert.equal(candidate({ response: { ...response, rawText } }), false, rawText);
  }
  assert.equal(candidate({ response: { ...response, confidence: "HEURISTIC" } }), false);
  assert.equal(candidate({ response: { ...response, evidence: { responseAssociation: "EXPLICIT_MANUAL_FOLLOWUP" } } }), false);
});

test("snapshots preserve only confirmed plain text pending or past ACK", () => {
  const pending = { state: "RESPONSE_COMPLETED", processingState: "ACK_PENDING",
    validation: { status: "CONFIRMED", format: "PLAIN_TEXT_DISCUSSION" } };
  const complete = { ...pending, state: "ACKNOWLEDGED", processingState: "COMPLETE" };
  assert.equal(preservesPlainTextDiscussion(context, pending), true);
  assert.equal(preservesPlainTextDiscussion(context, complete), true);
  assert.equal(preservesPlainTextDiscussion(context, { ...complete, processingState: undefined }), false);
  assert.equal(preservesPlainTextDiscussion(context, { ...pending, state: "ACKNOWLEDGED" }), false);
  assert.equal(preservesPlainTextDiscussion(context, { ...pending, validation: { ...pending.validation, status: "FAILED" } }), false);
  assert.equal(preservesPlainTextDiscussion({ ...context, acceptPlainTextDiscussion: undefined }, pending), false);
});

test("plain text moves an existing agreement to discussion without mutating it", () => {
  const agreement = Object.freeze({ status: "READY", summary: "이전 제안", unresolvedQuestions: [],
    requirements: [{ statement: "이전 제안", acceptanceCriteria: "이전 기준" }] });
  const updated = plainTextDiscussionAgreement(agreement);
  assert.equal(updated.status, "DISCUSSING");
  assert.match(updated.summary, /평문 응답/);
  assert.deepEqual(updated.requirements, agreement.requirements);
  assert.equal(agreement.status, "READY");
  assert.equal(agreement.summary, "이전 제안");
});

const plainReply = "  방법 안내인가요, 기능 구현인가요?\n";
test("new advisory sends its role and goal once and resends only the format instructions", async t => {
  const f = fixture(t);
  const submit = f.web.submitTurn.bind(f.web);
  const inputs = [];
  t.mock.method(f.web, "submitTurn", async input => {
    inputs.push(input);
    const { completion } = await submit(input);
    const response = await completion;
    return { completion:Promise.resolve({ ...response,
      rawText:inputs.length === 3 ? "먼저 사용자가 개입하는 지점을 보세요." : response.rawText,
      evidence:{ responseAssociation:"DIRECT_DOM_ORDER" },
    }) };
  });
  await f.start({ objective:"Studio를 더 개선할지 판단해 주세요.", conversationUrl:"https://chatgpt.com/",
    plainTextAdvisory:true, autoApproveOnReady:true });
  await settled(f.service);
  const first = f.service.snapshot();
  assert.equal(first.webSession.conversationId, "new-conversation");
  assert.equal(first.discussion.at(-1).content, first.deliveries[1].response.rawText);
  assert.equal(first.deliveries[0].response.packet, null);
  assert.equal(first.agreement.status, "DISCUSSING");
  assert.equal(first.autoApproveOnReady, false);
  await f.command("preparation.reply", { content:"그럼 Studio 실제로 써볼 때 뭐부터 봐야 돼?" });
  await settled(f.service);
  assert.match(inputs[0].text, /독립 기술 자문.*확인된 사실.*대안/u);
  assert.match(inputs[0].text, /첫 목표: Studio를 더 개선할지 판단해 주세요\.\n\n\[2\] 응답 형식/u);
  for (const heading of ["동의", "일부 반박할게 있습니다.", "질문이 있습니다.", "합의합니다.", "자료를 요청합니다."]) {
    assert.ok(inputs[0].text.includes(heading));
  }
  const formatInstructions = inputs[0].text.slice(inputs[0].text.indexOf("[2] 응답 형식"));
  assert.deepEqual(inputs.slice(1).map(({text}) => text), [formatInstructions, "그럼 Studio 실제로 써볼 때 뭐부터 봐야 돼?"]);
  assert.equal(f.service.snapshot().discussion.at(-1).content, "먼저 사용자가 개입하는 지점을 보세요.");
  assert.ok(inputs.every(({plainText}) => plainText));
  assert.equal(f.service.snapshot().webSession.conversationId, first.webSession.conversationId);
  assert.ok(!f.service.capabilities().includes("preparation.approve"));
  assert.equal(f.runs.size, 0);
});
function returnPlainReply(t, f, evidence = {}) {
  const submit = f.web.submitTurn.bind(f.web);
  t.mock.method(f.web, "submitTurn", async (input) => {
    const { completion } = await submit(input);
    const response = await completion;
    return { completion: Promise.resolve({ ...response, rawText: plainReply,
      packet: { type: "PLANNING_RESPONSE" },
      evidence: { responseAssociation: "DIRECT_DOM_ORDER", ...evidence },
    }) };
  });
}

test("opt-in plain completion stays visible across snapshots and ACK retries without resubmission", async t => {
  const f = fixture(t);
  returnPlainReply(t, f);
  const acknowledge = f.web.acknowledgeDelivery.bind(f.web);
  let attempts = 0;
  t.mock.method(f.web, "acknowledgeDelivery", async args => {
    const pending = f.service.snapshot().deliveries[0];
    assert.equal(pending.validation.format, "PLAIN_TEXT_DISCUSSION");
    assert.equal(pending.processingState, "ACK_PENDING");
    await acknowledge(args);
    if (++attempts < 3) throw Object.assign(new Error("ACK reply lost"), {
      code: "WEB_RESPONSE_TIMEOUT", receiptDiagnostics: { extensionRequestId: "ack-request" },
    });
  });
  await f.start({ acceptPlainTextDiscussion: true, autoApproveOnReady: true });
  await settled(f.service);
  assert.match(f.prompts[0], /태그가 전혀 없는 평문/);
  const before = f.service.snapshot();
  const { sessionId, conversationId, conversationUrl, activeDeliveryId: deliveryId } = before.webSession;
  const identity = { sessionId, conversationId, conversationUrl, deliveryId };
  assert.equal(before.discussion.length, 1);
  assert.equal(before.error.details.completion.stage, "ACK");
  assert.equal(before.error.details.completion.rawTextLength, plainReply.length);
  assert.equal(JSON.stringify(before.error.details.completion).includes(plainReply.trim()), false);
  await assert.rejects(f.command("web.reconcile", { ...identity, requestId: "ack-retry" }), { code: "WEB_RESPONSE_TIMEOUT" });
  f.restart();
  assert.equal(f.service.snapshot().deliveries[0].validation.format, "PLAIN_TEXT_DISCUSSION");
  const diagnostics = f.service.data.receipts["ack-retry"].error.diagnostics;
  assert.equal(diagnostics.extensionRequestId, "ack-request");
  assert.equal(diagnostics.completion.stage, "ACK");
  assert.equal(diagnostics.completion.originalCode, "WEB_RESPONSE_TIMEOUT");
  await f.command("web.reconcile", identity);
  f.restart();
  const completed = f.service.snapshot();
  assert.equal(completed.webSession.activeDeliveryId, null);
  assert.equal(completed.deliveries[0].state, "ACKNOWLEDGED");
  assert.equal(completed.deliveries[0].processingState, "COMPLETE");
  assert.equal(completed.deliveries[0].validation.format, "PLAIN_TEXT_DISCUSSION");
  assert.equal(completed.deliveries[0].validation.formatError, undefined);
  assert.equal(completed.deliveries[0].response.packet, null);
  assert.deepEqual(completed.discussion.filter(turn => turn.deliveryId === deliveryId).map(turn => turn.content), [plainReply]);
  assert.equal(completed.state, "DISCUSSING");
  assert.equal(completed.agreement.status, "DISCUSSING");
  assert.deepEqual(completed.agreement.requirements, []);
  assert.equal(completed.error, null);
  assert.equal(completed.autoApproveOnReady, true);
  assert.ok(!f.service.capabilities().includes("preparation.approve"));
  assert.equal(f.runs.size, 0);
  assert.equal(f.prompts.length, 1);
});

test("default-off and non-direct plain responses remain invalid without acknowledgement", async t => {
  for (const [optIn, evidence] of [[undefined, {}], [true, { responseAssociation: "EXPLICIT_MANUAL_FOLLOWUP" }]]) {
    const f = fixture(t);
    returnPlainReply(t, f, evidence);
    const ack = t.mock.method(f.web, "acknowledgeDelivery");
    await f.start(optIn === undefined ? {} : { acceptPlainTextDiscussion: optIn });
    await settled(f.service);
    const current = f.service.snapshot();
    assert.equal(current.acceptPlainTextDiscussion, optIn === true);
    assert.equal(f.prompts[0].includes("태그가 전혀 없는 평문"), optIn === true);
    assert.equal(current.error.code, "INVALID_AGREEMENT");
    assert.equal(current.error.details.completion.originalCode, "CONTROLLER_PACKET_MISSING");
    assert.equal(current.deliveries[0].validation.format, "INVALID");
    assert.equal(ack.mock.callCount(), 0);
  }
});

test("start rejects a non-boolean plain-text option before dispatch", async t => {
  const f = fixture(t);
  await assert.rejects(f.start({ acceptPlainTextDiscussion: "true" }), { code: "INVALID_INPUT" });
  assert.deepEqual(f.prompts, []);
});
