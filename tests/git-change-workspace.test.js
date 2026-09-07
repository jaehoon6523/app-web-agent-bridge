import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-git-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target");
  fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C", target, ...args], { windowsHide: true });
  git("init", "--quiet");
  fs.writeFileSync(path.join(target, "existing.txt"), "before\n");
  fs.writeFileSync(path.join(target, "deleted.txt"), "remove me\n");
  git("add", ".");
  git("-c", "user.name=Bridge Test", "-c", "user.email=bridge@example.invalid",
    "-c", "core.hooksPath=", "commit", "--quiet", "-m", "fixture");
  const store = new ArtifactStore(path.join(directory, "artifacts"));
  const worker = GitChangeWorkspace.create({
    targetRoot: target, workspaceRoot: path.join(directory, "worker"), artifactStore: store,
  });
  return { directory, target, worker, store, git };
}

test("captures new, changed, deleted and binary files without changing the worker index; applies stored bytes", (t) => {
  const { target, worker, git } = fixture(t);
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "after\n");
  fs.unlinkSync(path.join(worker.root, "deleted.txt"));
  fs.writeFileSync(path.join(worker.root, "new file.txt"), "new\n");
  const binary = Buffer.from([0, 255, 0, 128, 13, 10]);
  fs.writeFileSync(path.join(worker.root, "binary.bin"), binary);
  const capture = worker.capture();
  assert.equal(execFileSync("git", ["-C", worker.root, "diff", "--cached"]).length, 0);
  // Later worker edits must never sneak into an approved patch.
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "unreviewed\n");
  const result = worker.apply({ capture, targetRoot: target });
  assert.equal(result.tree, capture.candidateTree);
  assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf8").trim(), "after");
  assert.equal(fs.existsSync(path.join(target, "deleted.txt")), false);
  assert.equal(fs.readFileSync(path.join(target, "new file.txt"), "utf8").trim(), "new");
  assert.deepEqual(fs.readFileSync(path.join(target, "binary.bin")), binary);
  assert.equal(git("write-tree").toString().trim(), capture.candidateTree);
});

test("rejects a dirty target without overwriting user changes", (t) => {
  const { target, worker } = fixture(t);
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "worker\n");
  const capture = worker.capture();
  fs.writeFileSync(path.join(target, "existing.txt"), "user\n");
  assert.throws(() => worker.apply({ capture, targetRoot: target }), /existing changes/);
  assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf8"), "user\n");
});

test("rejects corrupted artifact bytes and unrelated artifact substitution", (t) => {
  const { target, worker, store, directory } = fixture(t);
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "worker\n");
  const capture = worker.capture();
  const forged = { ...capture, artifact: store.put("not the reviewed patch") };
  assert.throws(() => worker.apply({ capture: forged, targetRoot: target }), /differs from/);
  fs.writeFileSync(path.join(directory, "artifacts", capture.artifact.sha256.slice(7)), "corrupt");
  assert.throws(() => worker.apply({ capture, targetRoot: target }), /verification/);
  assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf8"), "before\n");
});

test("rejects no-op capture, changed target HEAD and a repository subdirectory", (t) => {
  const { target, worker, git, store } = fixture(t);
  assert.throws(() => worker.capture(), /no Git changes/);
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "worker\n");
  const capture = worker.capture();
  git("-c", "user.name=Bridge Test", "-c", "user.email=bridge@example.invalid",
    "-c", "core.hooksPath=", "commit", "--allow-empty", "--quiet", "-m", "moved");
  assert.throws(() => worker.apply({ capture, targetRoot: target }), /HEAD differs/);
  const nested = path.join(target, "nested");
  fs.mkdirSync(nested);
  assert.throws(() => new GitChangeWorkspace({
    workspaceRoot: nested, baseCommit: capture.baseCommit, artifactStore: store,
  }), /repository root/);
});
