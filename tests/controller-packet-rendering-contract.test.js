import test from "node:test";
import assert from "node:assert/strict";
import { parseFinalControllerPacketJsonEnvelope } from "../src/domain/controller-packet-envelope.js";

const packet = {
  type: "REVIEW_REPORT",
  runId: "run-1",
  requestId: "audit-1",
  candidateId: "candidate-1",
  requirementsRef: { requirementsId: "r", revision: "1", hash: "h" },
  assessments: [],
  findingDecisions: [],
  newFindings: [],
  summary: "ok",
};

test("DOM-safe controller packet sentinels survive plain-text Web extraction", () => {
  const raw = [
    "CONTROLLER_PACKET_BEGIN",
    JSON.stringify(packet),
    "CONTROLLER_PACKET_END",
  ].join("\n");

  const parsed = parseFinalControllerPacketJsonEnvelope(raw);

  assert.deepEqual(parsed.parsed, packet);
  assert.equal(parsed.body, "");
  assert.equal(parsed.packetText, JSON.stringify(packet));
});

test("legacy angle-bracket controller packet framing remains accepted", () => {
  const raw = [
    "<controller_packet>",
    JSON.stringify(packet),
    "</controller_packet>",
  ].join("\n");

  assert.deepEqual(parseFinalControllerPacketJsonEnvelope(raw).parsed, packet);
});

test("escaped DOM-safe closing marker from a review is accepted only at the end", () => {
  const raw = ["판정 근거", "CONTROLLER_PACKET_BEGIN", JSON.stringify(packet), " CONTROLLER_PACKET_END\\"].join("\n");
  assert.deepEqual(parseFinalControllerPacketJsonEnvelope(raw).parsed, packet);
  assert.throws(() => parseFinalControllerPacketJsonEnvelope(raw + "\nother text"),
    { code: "CONTROLLER_PACKET_MISSING" });
});

test("DOM-safe closing marker must still be the final standalone unquoted line", () => {
  const trailingProse = [
    "CONTROLLER_PACKET_BEGIN",
    JSON.stringify(packet),
    "CONTROLLER_PACKET_END",
    "trailing prose",
  ].join("\n");

  assert.throws(
    () => parseFinalControllerPacketJsonEnvelope(trailingProse),
    { code: "CONTROLLER_PACKET_MISSING" },
  );

  const fenced = [
    "```",
    "CONTROLLER_PACKET_BEGIN",
    JSON.stringify(packet),
    "CONTROLLER_PACKET_END",
    "```",
  ].join("\n");

  assert.throws(
    () => parseFinalControllerPacketJsonEnvelope(fenced),
    { code: "CONTROLLER_PACKET_MISSING" },
  );
});

test("Korean sentinels use the same final standalone envelope rules", () => {
  const json = JSON.stringify(packet);
  assert.deepEqual(parseFinalControllerPacketJsonEnvelope(`답변시작\r\n${json}\r\n답변끝`).parsed, packet);
  assert.throws(() => parseFinalControllerPacketJsonEnvelope("답변시작"), { code: "CONTROLLER_PACKET_MISSING" });
  assert.throws(() => parseFinalControllerPacketJsonEnvelope(`답변시작\n${json}\nCONTROLLER_PACKET_END`),
    { code: "CONTROLLER_PACKET_AMBIGUOUS" });
  assert.throws(() => parseFinalControllerPacketJsonEnvelope(`답변시작\n${json}\n> 답변끝`),
    { code: "CONTROLLER_PACKET_AMBIGUOUS" });
});
