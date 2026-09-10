import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-preparation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git: (...args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8" }) };
}

test("preparing a plain project makes its initial snapshot, excludes local secrets, and is repeatable", (t) => {
  const { root, git } = fixture(t);
  fs.writeFileSync(path.join(root, "app.js"), "console.log('hello');\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=local\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "package.js"), "dependency");
  const prepared = GitChangeWorkspace.prepareTarget(root);
  assert.equal(prepared.createdInitialCommit, true);
  assert.equal(git("show", "HEAD:app.js"), "console.log('hello');\n");
  assert.deepEqual(git("ls-files").trim().split("\n"), [".env.example", "app.js"]);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "SECRET=local\n");
  assert.equal(GitChangeWorkspace.preflight(root).baseCommit, prepared.baseCommit);
  assert.equal(GitChangeWorkspace.prepareTarget(root).createdInitialCommit, false);
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "1");
});

test("empty and unborn repositories can be prepared without configured author identity", (t) => {
  const { root, git } = fixture(t);
  git("init", "--quiet");
  assert.equal(GitChangeWorkspace.prepareTarget(root).createdInitialCommit, true);
  assert.equal(GitChangeWorkspace.inspectTarget(root).status, "");
});

test("existing dirty repositories and nested project selections preserve user files and history", (t) => {
  const { root, git } = fixture(t);
  fs.writeFileSync(path.join(root, "app.js"), "before");
  const child = path.join(root, "child"); fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "source.js"), "source");
  const { baseCommit } = GitChangeWorkspace.prepareTarget(root);
  fs.writeFileSync(path.join(root, "app.js"), "user changes");
  assert.throws(() => GitChangeWorkspace.prepareTarget(root), /변경/);
  assert.equal(git("rev-parse", "HEAD").trim(), baseCommit);
  assert.equal(fs.readFileSync(path.join(root, "app.js"), "utf8"), "user changes");
  assert.throws(() => GitChangeWorkspace.prepareTarget(child), /상위 Git/);
  assert.equal(fs.existsSync(path.join(child, ".git")), false);
});
