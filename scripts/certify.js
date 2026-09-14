import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { canonicalJson } from "../src/domain/canonical-json.js";
import { requirementsRef } from "../src/domain/audit-contract.js";
import { evaluateCodeReview } from "../src/domain/code-review.js";

dotenv.config({ quiet: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cwd = process.cwd();
const baseUrl = (
  process.env.BRIDGE_BASE_URL
  || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8787"}`
).replace(/\/+$/u, "");

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

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit code ${result.status}.`,
    );
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
  if (!condition) {
    throw new Error(message);
  }
}

export async function main({
  check = () => run(npm, ["run", "check"]),
  request = fetchJson,
  certificationRunId = runId,
  dashboardToken = token,
  requireApplied = expectApplied,
} = {}) {
  const runId = certificationRunId;
  const token = dashboardToken;
  const expectApplied = requireApplied;

  process.stdout.write(
    "Certification phase 1/2: static and automated checks\n",
  );

  await check();

  process.stdout.write(
    "\nCertification phase 2/2: persisted audit consistency (provider provenance not certified)\n",
  );

  requireCondition(
    runId,
    "CERTIFY_RUN_ID is required. Certification never invents or starts a live provider run.",
  );

  requireCondition(
    token,
    "DASHBOARD_TOKEN is required by the headless certification CLI to inspect authenticated persisted state. It is not required for server startup or the same-origin browser dashboard.",
  );

  const health = await request("/api/health");

  requireCondition(
    health?.ok === true,
    "Bridge health endpoint is not healthy.",
  );

  const snapshot = await request(
    `/api/state?runId=${encodeURIComponent(runId)}`,
    true,
  );

  requireCondition(
    snapshot?.run?.runId === runId,
    "Requested live run was not returned.",
  );

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
    expectApplied
      ? stage === "APPLIED"
      : ["AWAITING_APPLY", "APPLIED"].includes(stage),
    expectApplied
      ? `Run ${runId} must be APPLIED for this certification. Current stage: ${stage}`
      : `Run ${runId} is not in an accepted post-audit stage. Current stage: ${stage}`,
  );

  requireCondition(
    Array.isArray(snapshot?.assessments)
      && snapshot.assessments.length > 0,
    "The run has no persisted requirement assessments.",
  );

  requireCondition(
    Array.isArray(snapshot?.evidence)
      && snapshot.evidence.length > 0,
    "The run has no persisted evidence.",
  );

  requireCondition(
    !Array.isArray(snapshot?.findings)
      || snapshot.findings.every(
        (finding) =>
          finding.required !== true
          || ["RESOLVED", "WITHDRAWN"].includes(finding.status),
      ),
    "Required unresolved findings remain.",
  );

  const record = snapshot.run;
  const review = record.reviews?.at(-1);
  requireCondition(review?.decision === "PASS" && review.report && record.candidate && record.capture,
    "The run has no complete candidate-bound review and capture.");
  requireCondition(
    review.candidateId === record.candidate.candidateId
      && record.candidate.runId === runId
      && record.capture.candidateTree === record.candidate.candidateTree
      && record.capture.artifact?.sha256 === record.candidate.patchHash
      && record.capture.baseCommit === record.baseCommit
      && record.candidate.baseCommit === record.baseCommit,
    "The persisted review and capture identify different candidates.",
  );
  requireCondition(
    canonicalJson(requirementsRef(record.requirements)) === canonicalJson(record.requirementsRef)
      && canonicalJson(review.requirementsRef) === canonicalJson(record.requirementsRef),
    "The reviewed requirements do not match the fixed requirements.",
  );
  requireCondition(Array.isArray(record.findings) && Array.isArray(record.evidence), "The run has no canonical findings/evidence arrays.");
  requireCondition(
    Array.isArray(snapshot.findings)
      && canonicalJson(snapshot.assessments) === canonicalJson(review.report.assessments)
      && canonicalJson(snapshot.evidence) === canonicalJson(record.evidence)
      && canonicalJson(snapshot.findings) === canonicalJson(record.findings),
    "The projected audit evidence differs from the canonical run.",
  );
  const evaluation = evaluateCodeReview(review.report, {
    runId, requestId: review.requestId, candidateId: record.candidate.candidateId,
    requirementsRef: record.requirementsRef, requirements: record.requirements,
    findings: record.findings, evidence: record.evidence,
  });
  requireCondition(evaluation.decision === "PASS", "Re-evaluating the persisted report did not produce PASS.");

  process.stdout.write("\nPersisted audit consistency: PASS (not live-provider certification)\n");
  process.stdout.write(`Run: ${runId}\n`);
  process.stdout.write(`Stage: ${stage}\n`);
  process.stdout.write(`Assessments: ${snapshot.assessments.length}\n`);
  process.stdout.write(`Evidence records: ${snapshot.evidence.length}\n`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `\nCertification result: FAIL\n${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
