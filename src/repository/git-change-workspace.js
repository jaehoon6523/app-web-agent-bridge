import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Private Git boundary. The Controller owns review decisions and authorizes
// calling apply(); this module does not infer approval from an agent response.
function git(root, args, { env = {}, input = undefined } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    env: { ...inherited, ...env, GIT_TERMINAL_PROMPT: "0" },
    input, maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString("utf8")}`);
  }
  return result.stdout;
}

function repositoryRoot(directory) {
  if (!path.isAbsolute(directory)) throw new TypeError("An absolute repository root is required.");
  const root = fs.realpathSync(directory);
  const actual = fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
  if (root !== actual) throw new Error("The supplied directory must be the Git repository root.");
  return root;
}

function head(root) {
  return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
}

function requireClean(root) {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length) {
    throw new Error("Target repository has existing changes; application is refused.");
  }
}

function tree(root, baseCommit) {
  // An alternate index includes new files without touching the user's index.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-git-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
    git(root, ["read-tree", baseCommit], { env });
    git(root, ["add", "--all", "--", "."], { env });
    return git(root, ["write-tree"], { env }).toString("utf8").trim();
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
}

export class GitChangeWorkspace {
  static preflight(targetRoot) {
    const root = repositoryRoot(targetRoot);
    requireClean(root);
    return { targetRoot: root, baseCommit: head(root) };
  }
  static targetApplicationState({ capture, targetRoot, artifactStore }) {
    const root = repositoryRoot(targetRoot);
    artifactStore.verify(capture.artifact.sha256);
    if (head(root) !== capture.baseCommit) return "AMBIGUOUS";
    const indexTree = git(root, ["write-tree"]).toString("utf8").trim();
    const workingTree = tree(root, capture.baseCommit);
    if (indexTree === capture.candidateTree && workingTree === capture.candidateTree) return "APPLIED";
    return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0 ? "NOT_APPLIED" : "AMBIGUOUS";
  }

  static create({ targetRoot, workspaceRoot, artifactStore }) {
    const target = repositoryRoot(targetRoot);
    requireClean(target);
    if (!path.isAbsolute(workspaceRoot) || fs.existsSync(workspaceRoot)) {
      throw new Error("A new absolute worktree path is required.");
    }
    const relative = path.relative(target, path.resolve(workspaceRoot));
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error("Worker worktree must be outside the target repository.");
    }
    const baseCommit = head(target);
    git(target, ["worktree", "add", "--detach", "--", workspaceRoot, baseCommit]);
    return new GitChangeWorkspace({ workspaceRoot, baseCommit, artifactStore, targetRoot: target });
  }

  constructor({ workspaceRoot, baseCommit, artifactStore, targetRoot = null }) {
    this.root = repositoryRoot(workspaceRoot);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit)) {
      throw new TypeError("An exact base commit object ID is required.");
    }
    if (head(this.root) !== baseCommit) throw new Error("Workspace HEAD differs from its base commit.");
    this.baseCommit = baseCommit;
    this.artifactStore = artifactStore;
    this.targetRoot = targetRoot ? repositoryRoot(targetRoot) : null;
  }

  cleanup() {
    if (!fs.existsSync(this.root)) return;
    if (!this.targetRoot || this.root === this.targetRoot) throw new Error("Cleanup requires a separate registered worktree.");
    const relative = path.relative(this.targetRoot, this.root);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("Cleanup target is inside the target repository.");
    const registered = git(this.targetRoot, ["worktree", "list", "--porcelain"]).toString("utf8");
    if (!registered.split("\n").some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)) === this.root)) throw new Error("Unregistered cleanup target.");
    git(this.targetRoot, ["worktree", "remove", "--force", this.root]);
  }

  capture({ allowUnchanged = false } = {}) {
    if (head(this.root) !== this.baseCommit) throw new Error("Worker changed the base commit.");
    if (git(this.root, ["ls-files", "--stage"]).toString("utf8").split("\n")
      .some((entry) => entry.startsWith("160000 "))) {
      throw new Error("Submodule changes require a separate capture contract.");
    }
    const candidateTree = tree(this.root, this.baseCommit);
    const patch = git(this.root, ["diff", "--binary", "--full-index", "--no-ext-diff",
      "--no-textconv", "--no-renames", this.baseCommit, candidateTree, "--"]);
    if (!patch.length && !allowUnchanged) throw new Error("Worker produced no Git changes.");
    if (head(this.root) !== this.baseCommit || tree(this.root, this.baseCommit) !== candidateTree) {
      throw new Error("Workspace changed during capture.");
    }
    const artifact = this.artifactStore.put(patch);
    const changedFiles = git(this.root, ["diff", "--name-only", "-z", this.baseCommit, candidateTree, "--"]).toString("utf8").split("\0").filter(Boolean);
    const files = this.snapshotFiles(candidateTree);
    return Object.freeze({ baseCommit: this.baseCommit, candidateTree, artifact, changedFiles, files, unchanged: !patch.length });
  }

  snapshotFiles(candidateTree) {
    const entries = git(this.root, ["ls-tree", "-r", "-z", candidateTree]).toString("utf8").split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t"), [mode, type, oid] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), mode, type, oid };
    }).filter((entry) => entry.type === "blob");
    const data = git(this.root, ["cat-file", "--batch"], { input: entries.map((e) => e.oid).join("\n") + "\n" });
    let offset = 0;
    return entries.map((entry) => {
      const newline = data.indexOf(10, offset), header = data.subarray(offset, newline).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error("Candidate blob snapshot failed.");
      const content = data.subarray(newline + 1, newline + 1 + size);
      if (content.length !== size) throw new Error("Candidate blob snapshot was truncated.");
      offset = newline + 1 + size + 1;
      return { path: entry.path, mode: entry.mode, contentRef: this.artifactStore.put(content) };
    });
  }

  assertCandidate(capture) {
    if (head(this.root) !== capture.baseCommit || tree(this.root, capture.baseCommit) !== capture.candidateTree) throw new Error("Candidate changed during verification.");
    this.artifactStore.verify(capture.artifact.sha256);
  }

  readCode(capture, filename) {
    if (typeof filename !== "string" || !filename || filename.includes("\\") || filename.includes("\0")
      || filename.startsWith("/") || filename.includes(":") || filename.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("Code path must stay inside the candidate repository.");
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(capture.candidateTree)) throw new Error("Invalid candidate tree.");
    if (capture.files) {
      const file = capture.files.find((entry) => entry.path === filename && ["100644", "100755"].includes(entry.mode));
      if (!file) throw new Error("Only regular captured files can be queried; missing, symlink and submodule paths are unavailable.");
      const content = this.artifactStore.read(file.contentRef.sha256);
      if (content.includes(0)) throw new Error("Binary code is unavailable as text.");
      return content.toString("utf8");
    }
    const entry = git(this.root, ["ls-tree", "-z", capture.candidateTree, "--", filename]).toString("utf8");
    if (!/^100(?:644|755) blob /u.test(entry) || entry.split("\0").filter(Boolean).length !== 1) throw new Error("Only regular captured files can be queried; missing, symlink and submodule paths are unavailable.");
    const content = git(this.root, ["show", `${capture.candidateTree}:${filename}`]);
    if (content.includes(0)) throw new Error("Binary code is unavailable as text.");
    return content.toString("utf8");
  }

  // Call only after the Controller has bound human approval to this capture.
  // Applies the stored bytes, never the potentially changed worker directory.
  apply({ capture, targetRoot }) {
    const root = repositoryRoot(targetRoot);
    if (capture.baseCommit !== this.baseCommit || head(root) !== capture.baseCommit) {
      throw new Error("Target HEAD differs from the reviewed base commit.");
    }
    requireClean(root);
    const patch = this.artifactStore.read(capture.artifact.sha256);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(capture.candidateTree)) {
      throw new Error("Invalid candidate tree.");
    }
    const expected = git(root, ["diff", "--binary", "--full-index", "--no-ext-diff",
      "--no-textconv", "--no-renames", capture.baseCommit, capture.candidateTree, "--"]);
    if (!patch.equals(expected)) throw new Error("Artifact differs from the captured Git tree.");
    if (!patch.length && capture.unchanged && capture.candidateTree === git(root, ["rev-parse", `${capture.baseCommit}^{tree}`]).toString("utf8").trim()) {
      return Object.freeze({ baseCommit: capture.baseCommit, tree: capture.candidateTree, artifactHash: capture.artifact.sha256, unchanged: true });
    }
    git(root, ["apply", "--check", "--index", "--binary", "-"], { input: patch });
    if (head(root) !== capture.baseCommit) throw new Error("Target HEAD changed before application.");
    requireClean(root);
    git(root, ["apply", "--index", "--binary", "-"], { input: patch });
    const appliedTree = git(root, ["write-tree"]).toString("utf8").trim();
    if (appliedTree !== capture.candidateTree) {
      throw new Error("Applied tree differs from review; inspect the target before continuing.");
    }
    return Object.freeze({ baseCommit: capture.baseCommit, tree: appliedTree, artifactHash: capture.artifact.sha256 });
  }

  applicationState({ capture, targetRoot }) {
    return GitChangeWorkspace.targetApplicationState({ capture, targetRoot, artifactStore: this.artifactStore });
  }
}
