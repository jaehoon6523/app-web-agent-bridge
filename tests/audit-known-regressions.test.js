import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertionsFor, reportFor, reviewContext, setupAudit } from "./helpers/audit-fixtures.js";
import { validateAuditResponse } from "../src/domain/code-review.js";
import { requirementsRef } from "../src/domain/audit-contract.js";

test("regression: generated CODE_SNAPSHOT is bound to the captured candidate blob", async (t) => {
  let observedSnapshot = null;
  const f = setupAudit(t, {
    configure(project) {
      project.requirements.items[0].verificationMethod = {
        kinds:["CODE_SNAPSHOT"],
        description:"Inspect captured source",
      };
    },
    worker({ workspace }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), "revision 2\n");
    },
    review(data) {
      observedSnapshot = data.context.evidence.find((evidence) =>
        evidence.kind === "CODE_SNAPSHOT" && evidence.result?.path === "file.txt");
      assert.ok(observedSnapshot, "Controller must provide the captured changed source before review.");
      assert.equal(observedSnapshot.producer, "CONTROLLER");
      assert.equal(observedSnapshot.candidateId, data.context.candidateId);
      assert.equal(observedSnapshot.result.candidateTree, data.candidate.candidateTree);
      return assertionsFor(data.context, "SATISFIED", {strict:true});
    },
  });
  const run = await f.run();
  const capturedFile = run.capture.files.find((file) => file.path === "file.txt");
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(run.auditResult, "PASS");
  assert.equal(run.application, null);
  assert.ok(capturedFile);
  assert.ok(observedSnapshot);
  assert.equal(observedSnapshot.result.sourceContentHash, capturedFile.contentRef.sha256);
  assert.equal(f.options.artifactStore.verify(observedSnapshot.contentRef.sha256), true);
  assert.equal(f.options.artifactStore.read(observedSnapshot.contentRef.sha256).toString("utf8"), "revision 2\n");
});

test("regression: SATISFIED cannot cite PATCH in place of required CODE_SNAPSHOT", () => {
  const context = reviewContext();
  context.requirements.items[0].verificationMethod = {
    kinds:["CODE_SNAPSHOT"],
    description:"Inspect captured source",
  };
  context.requirementsRef = requirementsRef(context.requirements);
  const report = reportFor(context, "SATISFIED");
  report.requirementsRef = context.requirementsRef;
  assert.throws(() => validateAuditResponse(report, context), /required verification evidence kinds/u);
});

test("regression: foreign candidate PATCH cannot prove the current candidate", () => {
  const context = reviewContext();
  const report = reportFor(context, "SATISFIED");
  const attacked = structuredClone(context);
  attacked.evidence[0].candidateId = "foreign-candidate";
  assert.throws(() => validateAuditResponse(report, attacked));
});

test("regression: AGENT-produced required PATCH cannot prove the current candidate", () => {
  const context = reviewContext();
  const report = reportFor(context, "SATISFIED");
  const attacked = structuredClone(context);
  attacked.evidence[0].producer = "AGENT";
  assert.throws(() => validateAuditResponse(report, attacked));
});
