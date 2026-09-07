import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCodeReview } from "../src/domain/code-review.js";

const policy = { threshold: 9, evidenceRefs: ["captured-diff"] };
const report = { score: 8, findings: ["Missing boundary handling"], evidenceRefs: ["captured-diff"], summary: "Needs revision" };

test("Controller threshold alone determines PASS or REWORK", () => {
  assert.equal(evaluateCodeReview(report, policy).decision, "REWORK");
  assert.equal(evaluateCodeReview({ ...report, score: 9 }, policy).decision, "PASS");
  assert.equal(evaluateCodeReview(report, { ...policy, threshold: 8 }).decision, "PASS");
});

test("Reviewer cannot inject authority or cite uncaptured evidence", () => {
  for (const field of ["approved", "nextAction", "threshold", "candidatePacketType"]) {
    assert.throws(() => evaluateCodeReview({ ...report, [field]: "PASS" }, policy), /only/);
  }
  assert.throws(() => evaluateCodeReview({ ...report, evidenceRefs: ["invented"] }, policy), /outside/);
  assert.throws(() => evaluateCodeReview({ ...report, evidenceRefs: [] }, policy), /outside/);
  assert.throws(() => evaluateCodeReview(report, { evidenceRefs: policy.evidenceRefs }), /finite/);
  assert.throws(() => evaluateCodeReview({ ...report, score: "9" }, policy), /finite/);
});

test("decision preserves an immutable copy of reviewed findings", () => {
  const input = structuredClone(report);
  const result = evaluateCodeReview(input, policy);
  input.findings.push("later change");
  assert.deepEqual(result.report.findings, report.findings);
  assert.equal(Object.isFrozen(result.report.findings), true);
});
