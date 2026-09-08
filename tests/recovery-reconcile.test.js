import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { CodeChangeService } from "../src/orchestration/code-change-service.js";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-reconcile-target-"));
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "base"], { stdio: "ignore" });
  return root;
}

function service(stateRoot) {
  return new CodeChangeService({
    filename: path.join(stateRoot, "runs.sqlite"),
    artifactStore: new ArtifactStore(path.join(stateRoot, "artifacts")),
    webSession: { activeTurnId: null },
    codex: {},
    project: null,
    createWorker: () => { throw new Error("not used"); },
  });
}

test("reconcile is read-only for recovery-required run", () => {
  const root = repository();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-reconcile-state-"));
  const svc = service(stateRoot);
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    svc.store.save({
      schemaVersion: 3, runId: "code_reconcile", stage: "RECOVERY_REQUIRED",
      targetRoot: root, baseCommit: head, workspaceRoot: null, capture: null,
      candidate: null, reviews: [], evidence: [], events: [], error: "restart",
    });
    const before = svc.get("code_reconcile");
    const report = svc.reconcile(before);
    const after = svc.get("code_reconcile");
    assert.equal(report.classification, "RECOVERY_REQUIRED");
    assert.equal(report.readOnly, true);
    assert.deepEqual(after, before);
    assert.ok(report.allowedActions.includes("run.abandon"));
  } finally {
    void svc.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("missing worktree is orphaned", () => {
  const root = repository();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-reconcile-state-"));
  const svc = service(stateRoot);
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const report = svc.reconcile({
      runId: "code_orphan", stage: "HOLD", targetRoot: root, baseCommit: head,
      workspaceRoot: path.join(stateRoot, "missing-worktree"), capture: null,
    });
    assert.equal(report.classification, "ORPHANED");
  } finally {
    void svc.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
