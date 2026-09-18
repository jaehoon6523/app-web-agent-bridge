import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ControllerPacketEnvelopeError,
  parseFinalControllerPacketJsonEnvelope,
} from "../src/domain/controller-packet-envelope.js";

const raw = fs.readFileSync(new URL(
  "./fixtures/incidents/preparation-packet-20260915/raw-response.txt",
  import.meta.url,
), "utf8").trimEnd();

const REQUIRED_INCIDENTS = Object.freeze([
  "valid-long-korean-packet",
  "invalid-windows-backslash",
  "missing-controller-packet",
  "ambiguous-controller-packet",
]);

const incidents = new Map([
  ["valid-long-korean-packet", { rawText: raw, expectedCode: null }],
  ["invalid-windows-backslash", {
    rawText: raw.replaceAll("C:/Users/User/Desktop/pj", "C:\\Users\\User\\Desktop\\pj"),
    expectedCode: null,
  }],
  ["missing-controller-packet", {
    rawText: "요구사항은 준비됐지만 packet은 없습니다.",
    expectedCode: "CONTROLLER_PACKET_MISSING",
  }],
  ["ambiguous-controller-packet", {
    rawText: raw.replace("\n</controller_packet>", "</controller_packet>"),
    expectedCode: "CONTROLLER_PACKET_AMBIGUOUS",
  }],
]);

test("the required preparation incident registry is closed and every incident executes", () => {
  assert.deepEqual([...incidents.keys()], REQUIRED_INCIDENTS);
  const executed = [];
  for (const [name, incident] of incidents) {
    executed.push(name);
    if (incident.expectedCode === null) {
      const parsed = parseFinalControllerPacketJsonEnvelope(incident.rawText).parsed;
      assert.equal(parsed.type, "REQUIREMENTS_PROPOSAL");
      assert.equal(parsed.items.length, 10);
      continue;
    }
    assert.throws(
      () => parseFinalControllerPacketJsonEnvelope(incident.rawText),
      (error) => error instanceof ControllerPacketEnvelopeError
        && error.code === incident.expectedCode,
      name,
    );
  }
  assert.deepEqual(executed, REQUIRED_INCIDENTS);
});
