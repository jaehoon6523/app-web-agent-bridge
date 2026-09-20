import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportFor, reviewContext, setupAudit } from "./helpers/audit-fixtures.js";
import { validateAuditResponse } from "../src/domain/code-review.js";

test("regression: missing CODE_SNAPSHOT cannot be converted into PASS by a SATISFIED reviewer claim", async (t) => {
  const f = setupAudit(t, {
    configure(project) {
      project.requirements.items[0].verificationMethod = {
        kinds:["CODE_SNAPSHOT"],
        description:"Inspect captured source",
      };
      project.policy.maxFormatRepairs = 0;
    },
    worker({ workspace }) {
      fs.writeFileSync(path.join(workspace.root, "file.txt"), "revision 2\n");
    },
    review(data) {
      return reportFor(data.context, "SATISFIED");
    },
  });
  const run = await f.run();
  const snapshot = f.service.snapshot(run.runId, {});
  assert.equal(run.stage, "HOLD");
  assert.equal(run.auditResult, "HOLD");
  assert.equal(run.application, null);
  assert.equal(run.reviews.length, 0);
  assert.equal(snapshot.run.phase, "HOLD");
  assert.equal(snapshot.outcome.auditResult, "HOLD");
  assert.equal(snapshot.commandCapabilities.includes("code.apply"), false);
  assert.equal(f.prompts[0].evidence.some((evidence) => evidence.kind === "CODE_SNAPSHOT"), false);
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
