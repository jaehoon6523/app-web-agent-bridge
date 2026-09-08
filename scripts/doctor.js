import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const strict = args.has("--strict");
const cwd = process.cwd();
const baseUrl = (process.env.BRIDGE_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8787"}`)
  .replace(/\/+$/u, "");

function command(executable, commandArgs) {
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || null,
  };
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function versionAtLeast(actual, expected) {
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function entry(id, status, detail, required = true) {
  return Object.freeze({ id, status, detail, required });
}

function fileExists(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function directoryWritable(dirname) {
  try {
    fs.mkdirSync(dirname, { recursive: true });
    fs.accessSync(dirname, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(2_000),
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const checks = [];
const nodeVersion = parseVersion(process.versions.node);
checks.push(entry(
  "node.version",
  versionAtLeast(nodeVersion, [22, 5, 0]) ? "PASS" : "FAIL",
  `Node ${process.versions.node}; required >= 22.5.0`,
));

const gitVersion = command("git", ["--version"]);
checks.push(entry(
  "git.available",
  gitVersion.ok ? "PASS" : "FAIL",
  gitVersion.ok ? gitVersion.stdout : (gitVersion.error || gitVersion.stderr || "git unavailable"),
));

const gitRoot = command("git", ["rev-parse", "--show-toplevel"]);
checks.push(entry(
  "git.repository",
  gitRoot.ok ? "PASS" : "FAIL",
  gitRoot.ok ? path.resolve(gitRoot.stdout) : "Current directory is not a Git repository.",
));

const gitStatus = command("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
checks.push(entry(
  "git.clean",
  gitStatus.ok && gitStatus.stdout === "" ? "PASS" : "WARN",
  gitStatus.ok ? (gitStatus.stdout === "" ? "Target working tree is clean." : "Working tree has local changes.") : "Git status unavailable.",
  strict,
));

let codexResult;
if (process.env.CODEX_EXECUTABLE?.trim()) {
  const configured = path.resolve(cwd, process.env.CODEX_EXECUTABLE.trim());
  codexResult = fileExists(configured)
    ? { ok: true, detail: `Configured executable exists: ${configured}` }
    : { ok: false, detail: `Configured executable not found: ${configured}` };
} else {
  const detected = command(process.platform === "win32" ? "codex.cmd" : "codex", ["--version"]);
  codexResult = {
    ok: detected.ok,
    detail: detected.ok ? `Detected on PATH: ${detected.stdout}` : "CODEX_EXECUTABLE is unset and codex was not found on PATH.",
  };
}
checks.push(entry("codex.executable", codexResult.ok ? "PASS" : "FAIL", codexResult.detail));

const auditProject = process.env.AUDIT_PROJECT_FILE?.trim()
  ? path.resolve(cwd, process.env.AUDIT_PROJECT_FILE.trim())
  : null;
checks.push(entry(
  "audit.project",
  auditProject && fileExists(auditProject) ? "PASS" : "FAIL",
  auditProject ? `Audit project: ${auditProject}` : "AUDIT_PROJECT_FILE is not configured.",
));

for (const name of [
  "DASHBOARD_TOKEN",
  "WEB_EXTENSION_SHARED_SECRET",
  "WEB_EXTENSION_EXPECTED_IDENTITY",
]) {
  checks.push(entry(
    `config.${name.toLowerCase()}`,
    process.env[name]?.trim() ? "PASS" : "FAIL",
    process.env[name]?.trim() ? `${name} is configured.` : `${name} is not configured.`,
  ));
}

const dataDirectory = path.resolve(cwd, process.env.CONTROLLER_DATA_DIR || ".agent-controller");
checks.push(entry(
  "storage.controller",
  directoryWritable(dataDirectory) ? "PASS" : "FAIL",
  `Controller data directory: ${dataDirectory}`,
));

try {
  const health = await fetchJson(`${baseUrl}/api/health`);
  checks.push(entry(
    "server.health",
    health?.ok === true ? "PASS" : "FAIL",
    `Server reachable at ${baseUrl}; liveOrchestrationReady=${Boolean(health?.liveOrchestrationReady)}`,
    strict,
  ));
} catch (error) {
  checks.push(entry(
    "server.health",
    "WARN",
    `Server not reachable at ${baseUrl}: ${error.message}`,
    strict,
  ));
}

try {
  const preflight = await fetchJson(`${baseUrl}/api/preflight`);
  checks.push(entry(
    "server.preflight",
    preflight?.readyForProvisioning === true ? "PASS" : "WARN",
    preflight?.readyForProvisioning === true
      ? "Live provisioning preflight is ready."
      : `Live provisioning preflight incomplete: ${(preflight?.missing || []).join(", ") || "unknown"}`,
    strict,
  ));
} catch (error) {
  checks.push(entry(
    "server.preflight",
    "WARN",
    `Preflight unavailable: ${error.message}`,
    strict,
  ));
}

const blocking = checks.filter((check) =>
  check.status === "FAIL" || (strict && check.required && check.status === "WARN"));
const report = Object.freeze({
  ok: blocking.length === 0,
  strict,
  baseUrl,
  checkedAt: new Date().toISOString(),
  checks,
});

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const width = Math.max(...checks.map((check) => check.id.length));
  for (const check of checks) {
    process.stdout.write(`${check.status.padEnd(4)}  ${check.id.padEnd(width)}  ${check.detail}\n`);
  }
  process.stdout.write(`\nDoctor result: ${report.ok ? "PASS" : "FAIL"}${strict ? " (strict)" : ""}\n`);
}

process.exitCode = report.ok ? 0 : 1;
