// B-APPLY-GIT 2차 discovery — API shape 캡처
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function makeTargetRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b-apply-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# target\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return { dir, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim() };
}

async function loadModule() {
  try {
    return await import("file:///" + process.cwd().replace(/\\/g, "/") + "/src/repository/git-change-workspace.js");
  } catch (err) {
    return { __loadError: err.message };
  }
}

async function inspect() {
  const mod = await loadModule();
  if (mod.__loadError) {
    return { threw: false, discovery: "MODULE_LOAD_FAILED", loadError: mod.__loadError };
  }
  const GCW = mod.GitChangeWorkspace;
  if (!GCW) {
    return { threw: false, discovery: "CLASS_NOT_EXPORTED", moduleExports: Object.keys(mod) };
  }
  const staticMethods = Object.getOwnPropertyNames(GCW)
    .filter(n => typeof GCW[n] === "function" && !["length","name","prototype"].includes(n));
  const instanceMethods = Object.getOwnPropertyNames(GCW.prototype)
    .filter(n => typeof GCW.prototype[n] === "function" && n !== "constructor");
  return {
    threw: false,
    discovery: "API_SHAPE_CAPTURED",
    staticMethods,
    instanceMethods,
    staticSignatures: staticMethods.map(n => ({ name: n, args: GCW[n].length })),
    instanceSignatures: instanceMethods.map(n => ({ name: n, args: GCW.prototype[n].length })),
  };
}

export const setups = {
  "GIT-APPLY-NORMAL": async () => ({ observed: await inspect() }),
  "GIT-APPLY-BASE-DRIFT": async () => ({ observed: await inspect() }),
  "GIT-APPLY-DIRTY-TARGET": async () => ({ observed: await inspect() }),
  "GIT-STATE-APPLIED": async () => ({ observed: await inspect() }),
  "GIT-STATE-NOT-APPLIED": async () => ({ observed: await inspect() }),
  "GIT-STATE-AMBIGUOUS": async () => ({ observed: await inspect() }),
};