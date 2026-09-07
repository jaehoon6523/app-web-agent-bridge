import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CodeChangeService } from "../src/orchestration/code-change-service.js";
import { DashboardController } from "../src/orchestration/dashboard-controller.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";

function setupE2E(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-"));
  const target = path.join(directory, "target"); fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C", target, ...args], { windowsHide: true });
  git("init", "--quiet"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(target, "index.js"), "console.log('v1');\n");
  git("add", ".");
  git("-c", "user.name=E2E", "-c", "user.email=e2e@test.invalid", "-c", "core.hooksPath=", "commit", "--quiet", "-m", "init");

  let workerStarts = 0, reviewTurns = 0;
  const acknowledgements = [];
  const options = {
    filename: path.join(directory, "controller.sqlite"), artifactStore: new ArtifactStore(path.join(directory, "artifacts")), codex: {},
    createWorker: async ({ workspace, persistThreadId, persistCapture }) => {
      const turnNum = ++workerStarts;
      return { async start() { await persistThreadId({ threadId: `thread_${turnNum}` }); }, async close() {},
        async submitTurn() {
          fs.writeFileSync(path.join(workspace.root, "index.js"), turnNum === 1 ? "console.log('v2-rework');\n" : "console.log('v2-pass');\n");
          const capture = workspace.capture(); await persistCapture({ capture, turnId: `turn_${turnNum}` });
          return { turnId: `turn_${turnNum}`, completion: Promise.resolve({ text: `Turn ${turnNum} executed`, capture }) };
        } };
    },
    webSession: { async resume() {}, async acknowledgeDelivery({ turnId }) { acknowledgements.push(turnId); }, async interrupt() {},
      async submitTurn({ runId, turnId, text, parseResponse }) {
        const payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
        const report = ++reviewTurns === 1
          ? { score: 7, findings: ["Need pass version"], evidenceRefs: [payload.artifactHash], summary: "Rework required" }
          : { score: 10, findings: [], evidenceRefs: [payload.artifactHash], summary: "Pass" };
        return { turnId, completion: Promise.resolve({ turnId, packet: parseResponse(`<controller_packet>\n${JSON.stringify(report)}\n</controller_packet>`).packet, binding: { runId, conversationId: "conv_e2e" } }) };
      } },
  };
  let service = new CodeChangeService(options);
  const live = { codeChanges: service, store: { listRuns: () => [], getRun: () => null, listArtifactHashes: () => new Set() } };
  const dashboard = new DashboardController({ getRuntime: async () => live, preflight: () => ({ readyForProvisioning: true }), webSession: options.webSession, transport: null });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { target, dashboard, acknowledgements, getWorkerStarts: () => workerStarts, getReviewTurns: () => reviewTurns, getService: () => service,
    async reopen() { await service.close(); service = new CodeChangeService(options); live.codeChanges = service; } };
}

function startPayload(target, objective, maxIterations = 3) {
  return { mode: "CODE_CHANGE", expectedVersion: 0, objective, targetRoot: target, reviewCriteria: "Must score 9+", threshold: 9,
    maxIterations, conversationUrl: "https://chatgpt.com/c/conv_e2e" };
}

test("P1/H: REWORK -> 반복 -> PASS -> 승인 반영 및 Worktree 정리", async (t) => {
  const e2e = setupE2E(t);
  const start = await e2e.dashboard.execute({ type: "run.start", payload: startPayload(e2e.target, "Update to v2") });
  await e2e.getService().jobs.get(start.runId);
  const run = e2e.getService().get(start.runId);
  assert.equal(run.stage, "AWAITING_APPLY");
  assert.equal(e2e.getWorkerStarts(), 2); assert.equal(e2e.getReviewTurns(), 2); assert.equal(e2e.acknowledgements.length, 2);
  assert.equal(fs.readFileSync(path.join(e2e.target, "index.js"), "utf8"), "console.log('v1');\n");
  const capture = run.captures.at(-1).capture; const snapshot = await e2e.dashboard.snapshot(run.runId);
  const applied = await e2e.dashboard.execute({ type: "code.apply", payload: { runId: run.runId, expectedVersion: snapshot.run.version,
    artifactHash: capture.artifact.sha256, baseCommit: run.baseCommit } });
  assert.equal(applied.stage, "APPLIED");
  assert.equal(fs.readFileSync(path.join(e2e.target, "index.js"), "utf8"), "console.log('v2-pass');\n");
  const latestRun = e2e.getService().get(run.runId);
  await assert.rejects(e2e.dashboard.execute({ type: "code.apply", payload: { runId: run.runId, expectedVersion: latestRun.version,
    artifactHash: capture.artifact.sha256, baseCommit: run.baseCommit } }), /Command unavailable/);
});

test("P1/H: 실행 중 재시작은 RECOVERY_REQUIRED로 정지하고 자동 Worker를 만들지 않음", async (t) => {
  const e2e = setupE2E(t);
  const start = await e2e.dashboard.execute({ type: "run.start", payload: startPayload(e2e.target, "Crash test", 2) });
  e2e.getService().update(start.runId, { stage: "REVIEW_RUNNING" });
  await e2e.reopen();
  const recovered = e2e.getService().get(start.runId);
  assert.equal(recovered.stage, "RECOVERY_REQUIRED");
  assert.match(recovered.error, /Server restarted during execution/);
  assert.equal(e2e.getWorkerStarts(), 1);
});
