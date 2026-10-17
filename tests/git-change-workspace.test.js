import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";

function repositoryFixture(t) {
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
  return { directory, target, store, git };
}

function fixture(t) {
  const { directory, target, store, git } = repositoryFixture(t);
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

test("filesystem aliases of the selected Git root preserve its identity", (t) => {
  const { directory, target, git } = repositoryFixture(t);
  const alias = path.join(directory, "project alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const nativeRoot = fs.realpathSync.native(target);
  const aliases = [...new Set([target, nativeRoot, alias])];
  if (process.platform === "win32") {
    aliases.push(target.replace(/^([A-Za-z]):/u, (_, drive) =>
      `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`));
  }
  const gitRoot = git("rev-parse", "--show-toplevel").toString("utf8").trim();
  const observed = aliases.map(selected => {
    const selectedStat = fs.statSync(selected, { bigint: true });
    const gitStat = fs.statSync(gitRoot, { bigint: true });
    return { selected, legacySelected: fs.realpathSync(selected), legacyGitRoot: fs.realpathSync(gitRoot),
      nativeSelected: fs.realpathSync.native(selected), nativeGitRoot: fs.realpathSync.native(gitRoot),
      sameDirectoryId: selectedStat.dev === gitStat.dev && selectedStat.ino === gitStat.ino };
  });
  t.diagnostic(JSON.stringify({ node: process.version, platform: process.platform, rootIdentity: observed }));
  const expectedHead = git("rev-parse", "HEAD").toString("utf8").trim();
  for (const selected of aliases) {
    const result = GitChangeWorkspace.preflight(selected);
    assert.equal(result.baseCommit, expectedHead);
    assert.equal(result.targetRoot, nativeRoot);
    const prepared = GitChangeWorkspace.prepareTarget(selected);
    assert.equal(prepared.targetRoot, nativeRoot);
    assert.equal(prepared.createdInitialCommit, false);
  }
});

test("preflight accepts an existing root when the legacy resolver retains its alias", (t) => {
  const { directory, target, git } = repositoryFixture(t);
  const alias = path.join(directory, "retained root alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const legacyRealpath = fs.realpathSync;
  // Windows' legacy resolver can retain an 8.3 spelling. Model that behavior
  // around a real filesystem alias; Git and the native resolver remain real.
  const retained = t.mock.method(fs, "realpathSync", (selected, options) =>
    selected === alias ? alias : legacyRealpath(selected, options));
  retained.native = legacyRealpath.native;
  const gitRoot = git("rev-parse", "--show-toplevel").toString("utf8").trim();
  assert.notEqual(fs.realpathSync(alias), fs.realpathSync(gitRoot));
  assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(gitRoot));
  t.diagnostic(JSON.stringify({ retainedAliasModel: true, selected: alias, gitRoot,
    legacySelected: fs.realpathSync(alias), legacyGitRoot: fs.realpathSync(gitRoot),
    nativeSelected: fs.realpathSync.native(alias), nativeGitRoot: fs.realpathSync.native(gitRoot) }));
  const result = GitChangeWorkspace.preflight(alias);
  assert.equal(result.targetRoot, fs.realpathSync.native(target));
  assert.equal(result.baseCommit, git("rev-parse", "HEAD").toString("utf8").trim());
});

test("a subdirectory reached through a root alias is still refused", (t) => {
  const { directory, target, git } = repositoryFixture(t);
  const nested = path.join(target, "nested");
  fs.mkdirSync(nested);
  const alias = path.join(directory, "nested alias");
  fs.symlinkSync(nested, alias, process.platform === "win32" ? "junction" : "dir");
  const before = git("status", "--porcelain=v1").toString("utf8");
  for (const selected of [nested, alias]) {
    assert.throws(() => GitChangeWorkspace.preflight(selected), /repository root/u);
  }
  assert.equal(git("status", "--porcelain=v1").toString("utf8"), before);
  assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf8"), "before\n");
});

test("an aliased target can capture, apply and remove only its registered worktree", (t) => {
  const { directory, target, store, git } = repositoryFixture(t);
  const alias = path.join(directory, "target alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const workspaceRoot = path.join(directory, "worker project");
  const worker = GitChangeWorkspace.create({ targetRoot: alias, workspaceRoot, artifactStore: store });
  fs.writeFileSync(path.join(worker.root, "existing.txt"), "reviewed\n");
  const capture = worker.capture();
  worker.apply({ capture, targetRoot: alias });
  assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf8"), "reviewed\n");
  worker.cleanup();
  assert.equal(fs.existsSync(workspaceRoot), false);
  assert.equal(git("worktree", "list", "--porcelain").toString("utf8").split("\n")
    .filter(line => line.startsWith("worktree ")).length, 1);
  assert.equal(fs.existsSync(target), true);
});

test("a separate repository with the same HEAD is never a registered cleanup target", (t) => {
  const { directory, target, store, git } = repositoryFixture(t);
  const unrelated = path.join(directory, "unrelated project");
  execFileSync("git", ["clone", "--quiet", "--local", "--", target, unrelated], { windowsHide: true });
  const baseCommit = git("rev-parse", "HEAD").toString("utf8").trim();
  const workspace = new GitChangeWorkspace({ workspaceRoot: unrelated, baseCommit, artifactStore: store, targetRoot: target });
  assert.throws(() => workspace.cleanup(), /Unregistered cleanup target/u);
  assert.equal(fs.readFileSync(path.join(unrelated, "existing.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(unrelated, ".git")), true);
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
