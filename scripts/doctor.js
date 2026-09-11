import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { loadConfig } from "../src/config.js";

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

let runtimeConfig = null;
try {
  runtimeConfig = loadConfig({ env: process.env, cwd });
  checks.push(entry(
    "config.runtime",
    "PASS",
    "Server environment configuration is valid. Optional integrations may still be disabled.",
  ));
} catch (error) {
  checks.push(entry(
    "config.runtime",
    "FAIL",
    `Invalid server environment configuration: ${error.message}`,
  ));
}

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
    ? { status: "PASS", detail: `Configured executable exists: ${configured}` }
    : { status: "FAIL", detail: `Configured CODEX_EXECUTABLE does not exist: ${configured}` };
} else {
  codexResult = {
    status: "WARN",
    detail: "CODEX_EXECUTABLE is unset; the server can boot, but live Codex composition is unavailable.",
  };
}
checks.push(entry("codex.executable", codexResult.status, codexResult.detail, true));
checks.push(entry(
  "provider.codex.authentication",
  "NOT_RUN",
  "Authentication was not probed by doctor; executable availability is not authentication proof.",
  false,
));
checks.push(entry(
  "provider.codex.turn",
  "NOT_RUN",
  "No Codex turn was started by doctor; a real turn requires an explicit live certification run.",
  false,
));
checks.push(entry(
  "provider.codex.process",
  "NOT_RUN",
  "Codex process readiness is not probed by standalone doctor; use a running server health check.",
  false,
));

const managedProject = path.resolve(cwd, process.env.WORKSPACE || ".", process.env.CONTROLLER_DATA_DIR || ".agent-controller", "audit-project.json");
const configuredAuditProject = process.env.AUDIT_PROJECT_FILE?.trim()
  ? path.resolve(cwd, process.env.AUDIT_PROJECT_FILE.trim())
  : null;
const auditProject = fileExists(managedProject) ? managedProject : configuredAuditProject;
checks.push(entry(
  "audit.project",
  auditProject && fileExists(auditProject)
    ? "PASS"
    : (configuredAuditProject ? "FAIL" : "WARN"),
  auditProject
    ? (fileExists(auditProject)
      ? `Audit project: ${auditProject}`
      : `Configured AUDIT_PROJECT_FILE does not exist: ${auditProject}`)
    : "No audit project is configured yet; the server can boot and the project can be created from the dashboard.",
  true,
));

const dashboardTokenConfigured = Boolean(process.env.DASHBOARD_TOKEN?.trim());
checks.push(entry(
  "config.dashboard_token",
  "PASS",
  dashboardTokenConfigured
    ? "DASHBOARD_TOKEN is configured for explicit local API/automation clients."
    : "DASHBOARD_TOKEN is optional; the same-origin dashboard uses a process-lifetime browser-session token.",
  false,
));

const extensionSecretConfigured = Boolean(process.env.WEB_EXTENSION_SHARED_SECRET?.trim());
const extensionIdentityConfigured = Boolean(process.env.WEB_EXTENSION_EXPECTED_IDENTITY?.trim());
if (extensionSecretConfigured !== extensionIdentityConfigured) {
  checks.push(entry(
    "config.web_extension",
    "FAIL",
    "WEB_EXTENSION_SHARED_SECRET and WEB_EXTENSION_EXPECTED_IDENTITY must be configured together.",
  ));
} else {
  checks.push(entry(
    "config.web_extension",
    extensionSecretConfigured ? "PASS" : "WARN",
    extensionSecretConfigured
      ? "Web Extension HMAC configuration is present."
      : "Web Extension configuration is absent; the server can boot, but live Web runs are unavailable.",
    true,
  ));
}

const workerProvider = runtimeConfig?.codeWorker?.provider || process.env.CODE_WORKER_PROVIDER || "codex";
const workerExecutable = runtimeConfig?.codeWorker?.executablePath || null;
checks.push(entry(
  "code-worker.configuration",
  workerProvider === "codex" || workerExecutable ? "PASS" : "WARN",
  workerProvider === "codex"
    ? "CODE_WORKER_PROVIDER=codex; the Codex executable readiness is reported separately."
    : (workerExecutable
      ? `${workerProvider} worker executable: ${workerExecutable}`
      : `${workerProvider} requires CODE_WORKER_EXECUTABLE before code-change runs can start.`),
  true,
));

const dataDirectory = path.resolve(cwd, process.env.CONTROLLER_DATA_DIR || ".agent-controller");
checks.push(entry(
  "storage.controller",
  directoryWritable(dataDirectory) ? "PASS" : "FAIL",
  `Controller data directory: ${dataDirectory}`,
));

let health = null;
try {
  health = await fetchJson(`${baseUrl}/api/health`);
  checks.push(entry(
    "server.health",
    health?.ok === true ? "PASS" : "FAIL",
    `Server reachable at ${baseUrl}; liveOrchestrationReady=${Boolean(health?.liveOrchestrationReady)}`,
    strict,
  ));
  checks.push(entry(
    "provider.codex.process",
    health?.codexRuntimeReady === true ? "PASS" : "WARN",
    health?.codexRuntimeReady === true
      ? "Running server reports the Codex runtime as ready."
      : "Running server does not report the Codex runtime as ready.",
    true,
  ));
  checks.push(entry(
    "provider.web.connection",
    health?.webRuntimeReady === true ? "PASS" : "WARN",
    health?.webRuntimeReady === true
      ? "Running server reports the Web runtime as ready."
      : "Running server does not report the Web runtime as ready.",
    true,
  ));
  checks.push(entry(
    "provider.web.binding",
    health?.liveSessionBindingReady === true ? "PASS" : "WARN",
    health?.liveSessionBindingReady === true
      ? "Running server reports an exact live session binding."
      : "Running server does not report an exact live session binding.",
    true,
  ));
} catch (error) {
  checks.push(entry(
    "server.health",
    "WARN",
    `Server not reachable at ${baseUrl}: ${error.message}`,
    strict,
  ));
  checks.push(entry(
    "provider.web.connection",
    "NOT_RUN",
    "Web connection could not be probed because the server is unreachable.",
    false,
  ));
  checks.push(entry(
    "provider.codex.process",
    "NOT_RUN",
    "Codex process readiness could not be probed because the server is unreachable.",
    false,
  ));
  checks.push(entry(
    "provider.web.binding",
    "NOT_RUN",
    "Web session binding could not be probed because the server is unreachable.",
    false,
  ));
}
checks.push(entry(
  "provider.web.authentication",
  health?.webConnected === true ? "PASS" : (health === null ? "NOT_RUN" : "WARN"),
  health?.webConnected === true
    ? "Server health reports the extension as authenticated."
    : "Authentication is not established according to server health.",
  true,
));
checks.push(entry(
  "provider.web.turn",
  "NOT_RUN",
  "No Web turn was started by doctor; a real turn requires an explicit live certification run.",
  false,
));

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
