import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cwd = process.cwd();
const baseUrl = (process.env.BRIDGE_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8787"}`)
  .replace(/\/+$/u, "");
const runId = process.env.CERTIFY_RUN_ID?.trim();
const token = process.env.DASHBOARD_TOKEN?.trim();
const expectApplied = ["1", "true", "yes", "on"].includes(
  String(process.env.CERTIFY_EXPECT_APPLIED || "").toLowerCase(),
);

export function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && executable === "npm.cmd",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

async function fetchJson(pathname, authenticated = false) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(5_000),
    headers: {
      accept: "application/json",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({ check = () => run(npm, ["run", "check"]), request = fetchJson,
  certificationRunId = runId, dashboardToken = token, requireApplied = expectApplied } = {}) {
  const runId = certificationRunId, token = dashboardToken, expectApplied = requireApplied;
  process.stdout.write("Certification phase 1/2: static and automated checks\n");
  await check();

  process.stdout.write("\nCertification phase 2/2: persisted live audit evidence\n");
  requireCondition(
    runId,
    "CERTIFY_RUN_ID is required. Certification never invents or starts a live provider run.",
  );
  requireCondition(
    token,
    "DASHBOARD_TOKEN is required to inspect the persisted run.",
  );

  const health = await request("/api/health");
  requireCondition(health?.ok === true, "Bridge health endpoint is not healthy.");

  const snapshot = await request(`/api/state?runId=${encodeURIComponent(runId)}`, true);
  requireCondition(snapshot?.run?.runId === runId, "Requested live run was not returned.");
  requireCondition(
    snapshot?.run?.schemaVersion === 3,
    `Run ${runId} does not use audit contract schemaVersion 3.`,
  );
  requireCondition(
    snapshot?.run?.auditResult === "PASS",
    `Run ${runId} did not finish with auditResult PASS.`,
  );

  const stage = snapshot?.run?.stage || snapshot?.run?.phase;
  requireCondition(
    expectApplied ? stage === "APPLIED" : ["AWAITING_APPLY", "APPLIED"].includes(stage),
    expectApplied
      ? `Run ${runId} must be APPLIED for this certification. Current stage: ${stage}`
      : `Run ${runId} is not in an accepted post-audit stage. Current stage: ${stage}`,
  );
  requireCondition(
    Array.isArray(snapshot?.assessments) && snapshot.assessments.length > 0,
    "The run has no persisted requirement assessments.",
  );
  requireCondition(
    Array.isArray(snapshot?.evidence) && snapshot.evidence.length > 0,
    "The run has no persisted evidence.",
  );
  requireCondition(
    !Array.isArray(snapshot?.findings)
      || snapshot.findings.every((finding) => finding.required !== true
        || ["RESOLVED", "WITHDRAWN"].includes(finding.status)),
    "Required unresolved findings remain.",
  );

  process.stdout.write(`\nCertification result: PASS\n`);
  process.stdout.write(`Run: ${runId}\n`);
  process.stdout.write(`Stage: ${stage}\n`);
  process.stdout.write(`Assessments: ${snapshot.assessments.length}\n`);
  process.stdout.write(`Evidence records: ${snapshot.evidence.length}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`\nCertification result: FAIL\n${error.message}\n`);
  process.exitCode = 1;
});
