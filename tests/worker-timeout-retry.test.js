import test from "node:test";
import assert from "node:assert/strict";
import { setupAudit } from "./helpers/audit-fixtures.js";

test("settled pre-candidate Worker timeout can be manually retried without changing timeout policy", async (t) => {
  const f = setupAudit(t,{reviewVerdicts:["UNSATISFIED","SATISFIED"]});
  const completed = await f.run();
  const timeoutError = "External turn timed out; execution state requires recovery.";
  const recovery = f.service.update(completed.runId, {
    stage: "RECOVERY_REQUIRED",
    iteration: 1,
    candidate: null,
    capture: null,
    candidates: [],
    evidence: [],
    findings: [],
    reviews: [],
    application: null,
    workerTurns: [{
      turnId: "timeout-turn",
      status: "failed",
      metadata: { error: timeoutError },
    }],
    error: timeoutError,
    terminationReason: "EXECUTION_UNCERTAIN",
  });
  const beforeTimeout = recovery.policy.turnTimeoutMs;
  await f.reopen();
  const restarted = f.service.get(completed.runId);
  assert.equal(restarted.error, "Server restarted during execution. No automatic resubmission or patch application.");
  assert.ok(f.service.snapshot(completed.runId, {}).commandCapabilities.includes("run.retry"));
  if (restarted.workspaceRoot) {
    const fs = await import("node:fs");
    fs.rmSync(restarted.workspaceRoot, { recursive: true, force: true });
  }
  const result = await f.service.command("run.retry", { runId: completed.runId, expectedVersion: restarted.version });
  assert.equal(result.status, "RETRY_ACCEPTED");
  await f.service.jobs.get(completed.runId);
  const retried = f.service.get(completed.runId);
  assert.equal(retried.policy.turnTimeoutMs, beforeTimeout);
  assert.equal(retried.recoveryAttempts.at(-1).previousTurnId, "timeout-turn");
});
