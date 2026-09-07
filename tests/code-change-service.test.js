import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CodeChangeService } from "../src/orchestration/code-change-service.js";
import { DashboardController } from "../src/orchestration/dashboard-controller.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-code-service-"));
  const target = path.join(directory, "target"); fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C", target, ...args], { windowsHide: true });
  git("init", "--quiet"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(target, "file.txt"), "base\n"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=", "commit", "--quiet", "-m", "base");
  let starts = 0, reviews = 0;
  const acknowledgements = [];
  const options = { filename: path.join(directory, "controller.sqlite"), artifactStore: new ArtifactStore(path.join(directory, "artifacts")), codex: {},
    createWorker: async ({ workspace, persistThreadId, persistCapture }) => {
      const number = ++starts;
      return { async start() { await persistThreadId({ threadId: `worker-${number}` }); }, async close() {},
        async submitTurn() {
          fs.writeFileSync(path.join(workspace.root, "file.txt"), `revision ${number}\n`);
          const capture = workspace.capture();
          await persistCapture({ capture, turnId: `turn-${number}` });
          return { turnId: `turn-${number}`, completion: Promise.resolve({ text: "Implemented", capture }) };
        } };
    },
    webSession: { async resume() {}, async acknowledgeDelivery({ turnId }) { acknowledgements.push(turnId); },
      async submitTurn({ runId, turnId, text, parseResponse }) {
        const request = JSON.parse(text.slice(text.indexOf("\n") + 1));
        const report = { score: ++reviews === 1 ? 8 : 9, findings: reviews === 1 ? ["Revise"] : [], evidenceRefs: [request.artifactHash], summary: "Reviewed" };
        return { turnId, completion: Promise.resolve({ turnId, packet: parseResponse(`<controller_packet>\n${JSON.stringify(report)}\n</controller_packet>`).packet,
          binding: { runId, conversationId: "test" } }) };
      } },
  };
  let service = new CodeChangeService(options);
  const live = { codeChanges: service, store: { listRuns: () => [], getRun: () => null } };
  const dashboard = new DashboardController({ getRuntime: async () => live, preflight: () => ({ readyForProvisioning: true }), webSession: options.webSession, transport: null });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { target, options, dashboard, acknowledgements, starts: () => starts,
    get service() { return service; },
    async reopen() { await service.close(); service = new CodeChangeService(options); live.codeChanges = service; },
    async run() {
      const result = await dashboard.execute({ type: "run.start", payload: { mode: "CODE_CHANGE", expectedVersion: 0, objective: "Change file", targetRoot: target,
        reviewCriteria: "Rate 0 to 10; correct file", threshold: 9, maxIterations: 3, conversationUrl: "https://chatgpt.com/c/test" } });
      await service.jobs.get(result.runId);
      return service.get(result.runId);
    } };
}

test("dashboard performs two fresh workers, persists reviews, waits for exact approval and applies only once", async (t) => {
  const f = setup(t);
  const run = await f.run();
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.equal(f.starts(), 2);
  assert.equal(f.acknowledgements.length, 2);
  assert.equal(fs.readFileSync(path.join(f.target, "file.txt"), "utf8"), "base\n");
  await f.reopen();
  const snapshot = await f.dashboard.snapshot(run.runId);
  assert.ok(snapshot.commandCapabilities.includes("code.apply"));
  const payload = { runId: run.runId, expectedVersion: snapshot.run.version, artifactHash: run.captures.at(-1).capture.artifact.sha256, baseCommit: run.baseCommit };
  await assert.rejects(f.dashboard.execute({ type: "code.apply", payload: { ...payload, artifactHash: "wrong" } }), /candidate/);
  const applied = await f.dashboard.execute({ type: "code.apply", payload });
  assert.equal(applied.stage, "APPLIED");
  assert.equal(fs.readFileSync(path.join(f.target, "file.txt"), "utf8").trim(), "revision 2");
  await assert.rejects(f.dashboard.execute({ type: "code.apply", payload }), /changed/);
});

test("restart after patch write reconciles the approved tree without reapplying", async (t) => {
  const f = setup(t), run = await f.run();
  const applied = await f.dashboard.execute({ type: "code.apply", payload: { runId: run.runId, expectedVersion: run.version,
    artifactHash: run.captures.at(-1).capture.artifact.sha256, baseCommit: run.baseCommit } });
  f.service.update(run.runId, { stage: "APPLYING" });
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, "APPLIED");
  assert.equal(f.service.get(run.runId).approval.artifactHash, applied.approval.artifactHash);
  assert.equal(f.starts(), 2);
});

test("restart during a Worker submission never creates another Worker", async (t) => {
  const f = setup(t), run = await f.run();
  f.service.update(run.runId, { stage: "WORKER_RUNNING" });
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, "RECOVERY_REQUIRED");
  assert.equal(f.starts(), 2);
});
