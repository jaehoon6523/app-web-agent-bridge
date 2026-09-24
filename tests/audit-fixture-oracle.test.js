import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertionsFor, reportFor, strictReportFor, setupAudit } from "./helpers/audit-fixtures.js";

test("fixture reviewer is an explicit external script and does not derive verdicts from candidateDiff", async (t) => {
  const f = setupAudit(t, {
    reviewVerdicts:["UNSATISFIED", "SATISFIED"],
    worker({ workspace }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), "revision 2\n");
    },
  });
  const run = await f.run();
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(run.auditResult, "PASS");
  assert.equal(run.application, null);
  assert.equal(f.starts(), 2);
  assert.equal(f.reviews(), 2);
  assert.deepEqual(run.reviews.map((review) => review.decision), ["REWORK", "PASS"]);
  assert.ok(f.prompts.every((prompt) => prompt.candidateDiff.split(/\r?\n/u).includes("+revision 2")),
    "The same candidate semantics must not force the fixture reviewer to change its scripted verdict.");
});

test("fixture rejects implicit review verdicts", (t) => {
  assert.throws(() => setupAudit(t), /Set explicit reviewVerdicts or a review provider/u);
});

test("legacy REVIEW_REPORT remains invalid at the provider boundary", async (t) => {
  const f = setupAudit(t, {
    configure(project) { project.policy.maxFormatRepairs = 0; },
    review(data) { return reportFor(data.context); },
  });
  const run = await f.run();
  assert.notEqual(run.auditResult, "PASS");
  assert.notEqual(run.stage, "AWAITING_APPLY");
  assert.equal(run.application, null);
});

test("fixture reviewer fails closed when its explicit external script is exhausted", async (t) => {
  const f = setupAudit(t, {
    reviewVerdicts:["UNSATISFIED"],
    worker({ workspace, number }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), `candidate-${number}\n`);
    },
  });
  const run = await f.run();
  assert.equal(run.stage, "RECOVERY_REQUIRED");
  assert.equal(run.application, null);
  assert.match(run.error, /AUDIT_FIXTURE_REVIEW_SCRIPT_EXHAUSTED:2/u);
  assert.equal(f.starts(), 2);
  assert.equal(f.reviews(), 2);
});

test("persistently rejected candidates never become PASS because review count advances", async (t) => {
  const f = setupAudit(t, {
    reviewVerdicts:["UNSATISFIED", "UNSATISFIED", "UNSATISFIED"],
    worker({ workspace, number }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), `candidate-${number}\n`);
    },
  });
  const run = await f.run();
  assert.equal(run.stage, "INCONCLUSIVE", run.error);
  assert.equal(run.auditResult, "REWORK");
  assert.equal(run.application, null);
  assert.equal(run.terminationReason, "ITERATION_LIMIT");
  assert.equal(f.starts(), 3);
  assert.equal(f.reviews(), 3);
  assert.ok(run.reviews.every((review) => review.decision === "REWORK"));
  assert.equal(run.findings[0].status, "OPEN");
  assert.equal(run.findings[0].verifiedCandidateId, null);
});

test("REPORT_REPAIR preserves candidate identity and never reruns Worker", async (t) => {
  const f = setupAudit(t, {
    worker({ workspace }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), "revision 2\n");
    },
    review(data, number) {
      return number === 1
        ? { ...assertionsFor(data.context, "SATISFIED"), assessments:[] }
        : assertionsFor(data.context, "SATISFIED");
    },
  });
  const run = await f.run();
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(run.auditResult, "PASS");
  assert.equal(run.application, null);
  assert.equal(f.starts(), 1, "report repair must not rerun Worker");
  assert.equal(f.prompts.length, 2);
  assert.equal(run.candidates.length, 1);
  assert.equal(f.prompts[0].candidate.candidateId, f.prompts[1].candidate.candidateId);
  assert.equal(f.prompts[0].candidate.patchHash, f.prompts[1].candidate.patchHash);
  assert.equal(f.prompts[0].candidate.candidateTree, f.prompts[1].candidate.candidateTree);
  assert.equal(f.prompts[1].feedback.kind, "REPORT_REPAIR");
});

test("reportFor stays permissive while strictReportFor requires candidate-bound required evidence", () => {
  const context = {
    runId:"run-1", requestId:"request-1", candidateId:"candidate-1",
    requirementsRef:{ requirementsId:"fixture", revision:"1", hash:"fixture-hash" },
    requirements:{ items:[{ requirementId:"R1", statement:"Inspect source", acceptanceCriteria:"source is correct", required:true,
      verificationMethod:{ kinds:["CODE_SNAPSHOT"], description:"Inspect captured source" } }] },
    findings:[],
    evidence:[{ evidenceId:"patch-1", candidateId:"candidate-1", kind:"PATCH", producer:"CONTROLLER", valid:true }],
  };
  assert.equal(reportFor(context, "SATISFIED").assessments[0].verdict, "SATISFIED");
  assert.throws(() => strictReportFor(context, "SATISFIED"), /STRICT_REPORT_EVIDENCE_MISSING:R1:CODE_SNAPSHOT/u);
});
