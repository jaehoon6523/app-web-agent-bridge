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
    if (!this.targetRoot && !fs.existsSync(this.root)) return;
    try {
      if (this.targetRoot) git(this.targetRoot, ["worktree", "remove", "--force", this.root]);
      else fs.rmSync(this.root, { recursive: true, force: true });
    } catch {
      fs.rmSync(this.root, { recursive: true, force: true });
      if (this.targetRoot) {
        try { git(this.targetRoot, ["worktree", "prune"]); } catch { /* best effort */ }
      }
    }
  }

  capture() {
    if (head(this.root) !== this.baseCommit) throw new Error("Worker changed the base commit.");
    if (git(this.root, ["ls-files", "--stage"]).toString("utf8").split("\n")
      .some((entry) => entry.startsWith("160000 "))) {
      throw new Error("Submodule changes require a separate capture contract.");
    }
    const candidateTree = tree(this.root, this.baseCommit);
    const patch = git(this.root, ["diff", "--binary", "--full-index", "--no-ext-diff",
      "--no-textconv", "--no-renames", this.baseCommit, candidateTree, "--"]);
    if (!patch.length) throw new Error("Worker produced no Git changes.");
    if (head(this.root) !== this.baseCommit || tree(this.root, this.baseCommit) !== candidateTree) {
      throw new Error("Workspace changed during capture.");
    }
    const artifact = this.artifactStore.put(patch);
    return Object.freeze({ baseCommit: this.baseCommit, candidateTree, artifact });
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
