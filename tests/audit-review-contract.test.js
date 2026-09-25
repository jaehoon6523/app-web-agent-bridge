import test from "node:test";
import assert from "node:assert/strict";
import { setupAudit, assertionsFor } from "./helpers/audit-fixtures.js";

test("Web review receives the complete current candidate diff and a matching hash on every rework iteration", async (t) => {
  const f = setupAudit(t,{reviewVerdicts:["UNSATISFIED","SATISFIED"]});
  const run = await f.run();

  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(f.starts(), 2);
  assert.equal(f.prompts.length, 2);

  assert.match(f.prompts[0].candidateDiff, /revision 1/);
  assert.match(f.prompts[1].candidateDiff, /revision 2/);
  assert.notEqual(f.prompts[0].candidateDiff, f.prompts[1].candidateDiff);

  for (const prompt of f.prompts) {
    assert.equal(prompt.candidateDiffHash, prompt.candidate.patchHash);
    assert.equal(typeof prompt.candidateDiff, "string");
    assert.ok(prompt.candidateDiff.length > 0);
  }
});

test("REPORT_REPAIR keeps the exact candidate and diff while supplying the previous invalid response", async (t) => {
  const f = setupAudit(t, {
    review(data, number) {
      if (number === 1) return { ...assertionsFor(data.context), assessments: [] };
      return assertionsFor(data.context);
    },
  });

  const run = await f.run();

  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(f.starts(), 1);
  assert.equal(f.prompts.length, 2);

  const first = f.prompts[0];
  const repair = f.prompts[1];

  assert.equal(repair.feedback.kind, "REPORT_REPAIR");
  assert.equal(repair.candidate.candidateId, first.candidate.candidateId);
  assert.equal(repair.candidateDiffHash, first.candidateDiffHash);
  assert.equal(repair.candidateDiff, first.candidateDiff);
  assert.equal(repair.feedback.candidateId, first.candidate.candidateId);
  assert.equal(repair.feedback.candidateDiffHash, first.candidateDiffHash);
  assert.equal(typeof repair.feedback.previousResponse, "string");
  assert.ok(repair.feedback.previousResponse.length > 0);
});

test("maxIterations still bounds the real Worker/review loop", async (t) => {
  const f = setupAudit(t, {
    reviewVerdicts: ["UNSATISFIED"],
    configure(project) {
      project.policy.maxIterations = 1;
    },
  });

  const run = await f.run();

  assert.equal(f.starts(), 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(run.stage, "INCONCLUSIVE");
  assert.equal(run.terminationReason, "ITERATION_LIMIT");
});
