import process from "node:process";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const cwd = process.cwd();
const baseUrl = (process.env.BRIDGE_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8787"}`)
  .replace(/\/+$/u, "");
const runId = process.env.CERTIFY_RUN_ID?.trim();
const token = process.env.DASHBOARD_TOKEN?.trim();
const expectApplied = ["1", "true", "yes", "on"].includes(
  String(process.env.CERTIFY_EXPECT_APPLIED || "").toLowerCase(),
);

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
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

async function main() {
  process.stdout.write("Certification phase 1/3: static and automated checks\n");
  run(npm, ["run", "check"]);

  process.stdout.write("\nCertification phase 2/3: strict local capability checks\n");
  run(node, ["scripts/doctor.js", "--strict"]);

  process.stdout.write("\nCertification phase 3/3: persisted live audit evidence\n");
  requireCondition(
    runId,
    "CERTIFY_RUN_ID is required. Certification never invents or starts a live provider run.",
  );
  requireCondition(
    token,
    "DASHBOARD_TOKEN is required to inspect the persisted run.",
  );

  const health = await fetchJson("/api/health");
  requireCondition(health?.ok === true, "Bridge health endpoint is not healthy.");
  requireCondition(
    health?.codexRuntimeReady === true,
    "Codex runtime is not currently ready.",
  );
  requireCondition(
    health?.webRuntimeReady === true,
    "ChatGPT Web runtime is not currently ready.",
  );
  requireCondition(
    health?.liveSessionBindingReady === true,
    "ChatGPT Web session is not currently bound.",
  );

  const snapshot = await fetchJson(`/api/state?runId=${encodeURIComponent(runId)}`, true);
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

main().catch((error) => {
  process.stderr.write(`\nCertification result: FAIL\n${error.message}\n`);
  process.exitCode = 1;
});
