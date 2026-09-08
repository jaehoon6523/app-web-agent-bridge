import assert from "node:assert/strict";
import test from "node:test";
import { main, run } from "../scripts/certify.js";

function certification(snapshot) {
  const paths = [];
  return {
    paths,
    options: {
      certificationRunId: "code_saved", dashboardToken: "test-token", requireApplied: false,
      check() {},
      async request(path, authenticated) {
        paths.push(path);
        if (path === "/api/health") return {
          ok: true, codexRuntimeReady: false, webRuntimeReady: false, liveSessionBindingReady: false,
        };
        assert.equal(path, "/api/state?runId=code_saved");
        assert.equal(authenticated, true);
        return snapshot;
      },
    },
  };
}
const saved = () => ({
  run: { runId: "code_saved", schemaVersion: 3, auditResult: "PASS", stage: "AWAITING_APPLY" },
  assessments: [{}], evidence: [{}], findings: [],
});

test("persisted certification succeeds with disconnected providers and no provisioning checks", async () => {
  const { options, paths } = certification(saved());
  await main(options);
  assert.deepEqual(paths, ["/api/health", "/api/state?runId=code_saved"]);
});

test("persisted certification still rejects failed audits, missing evidence and unapplied runs", async () => {
  const failed = saved(); failed.run.auditResult = "HOLD";
  await assert.rejects(main(certification(failed).options), /auditResult PASS/u);
  const missing = saved(); missing.evidence = [];
  await assert.rejects(main(certification(missing).options), /no persisted evidence/u);
  await assert.rejects(main({ ...certification(saved()).options, requireApplied: true }), /must be APPLIED/u);
  const unresolved = saved(); unresolved.findings = [{ required: true, status: "OPEN" }];
  await assert.rejects(main(certification(unresolved).options), /unresolved findings/u);
});

test("certification command runner launches npm on Windows", { skip: process.platform !== "win32" }, () => {
  run("npm.cmd", ["--version"]);
});
