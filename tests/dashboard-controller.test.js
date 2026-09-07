import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DashboardController } from "../src/orchestration/dashboard-controller.js";
import { LiveDiscussionComposition } from "../src/orchestration/live-discussion-composition.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { createBridgeServer } from "../src/server.js";
import { computeWebChallengeHmac } from "../src/runtime/web/auth.js";
import { FakeDiscussionSession, ScriptedDiscussionRuntime } from "./support/fake-discussion-sessions.js";

const proposal = { type: "PROPOSAL", summary: "Test", body: "Keep exact sessions.", assumptions: [], open_decisions: [] };
const token = "dashboard-integration-token-0123456789abcdef";
const secret = "extension-integration-secret-0123456789abcdef";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-controller-"));
  const store = new SqliteStore(join(directory, "controller.sqlite"));
  const artifacts = new ArtifactStore(join(directory, "artifacts"));
  const ledger = new ScriptedDiscussionRuntime([
    { actor: "CODEX_AGENT", packet: proposal },
    { actor: "CHATGPT_WEB_AGENT", response: () => ({ packet: {
      type: "CRITIQUE", target_proposal_sha256: store.listProposalArtifacts(store.listRuns()[0].runId)[0].proposalRefHash,
      blocking_findings: [], non_blocking_findings: [], requested_changes: [],
    } }) },
  ]);
  const sessions = {};
  const composition = new LiveDiscussionComposition({
    store, artifactStore: artifacts,
    createCodexSession: ({ sessionId, persistThreadBinding }) => {
      persistThreadBinding({ actor: "CODEX_AGENT", threadId: "thread-test" });
      return sessions.CODEX_AGENT = new FakeDiscussionSession({ actor: "CODEX_AGENT", sessionId, externalSessionId: "thread-test", runtime: ledger });
    },
    createWebSession: ({ sessionId }) => {
      const web = new FakeDiscussionSession({ actor: "CHATGPT_WEB_AGENT", sessionId, externalSessionId: "conversation-test", runtime: ledger });
      web.resume = async ({ binding }) => binding;
      return sessions.CHATGPT_WEB_AGENT = web;
    },
  });
  let closed = false;
  const live = { store, composition, artifactStore: artifacts, async close() { if (closed) return; closed = true; composition.close(); store.close(); } };
  t.after(async () => { await live.close(); rmSync(directory, { recursive: true, force: true }); });
  const dashboard = new DashboardController({ getRuntime: async () => live, preflight: () => ({ readyForProvisioning: true }), webSession: null, transport: null });
  t.after(() => dashboard.close());
  return { live, store, composition, dashboard, sessions, ledger };
}

async function settled(dashboard, runId) {
  for (let i = 0; i < 100; i++) {
    const state = await dashboard.snapshot(runId);
    if (state.error) throw new Error(state.error);
    if (["COMPLETE", "CANCELLED", "FAILED"].includes(state.run.phase)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not settle.");
}

test("dashboard runs both actors, exposes durable output, and acknowledges stored Web responses", async (t) => {
  const { dashboard, store, sessions } = fixture(t);
  const { runId } = await dashboard.execute({ type: "run.start", payload: { expectedVersion: 0, mode: "DISCUSSION", objective: "Test relay", maxTurns: 2, conversationUrl: "https://chatgpt.com/c/conversation-test" } });
  const state = await settled(dashboard, runId);
  assert.equal(state.run.currentTurn, 2);
  assert.equal(state.outcome.outcome.type, "INCONCLUSIVE");
  assert.equal(state.messages.filter((m) => m.actor).length, 2);
  assert.equal(sessions.CHATGPT_WEB_AGENT.acknowledgements.length, 1);
  store.verifyEventChains();
  store.verifyRunOutcomes();
  const evidence = await dashboard.execute({ type: "evidence.export", payload: { runId, expectedVersion: state.run.version } });
  assert.equal(evidence.proposals.length, 1);
  const deleted = await dashboard.execute({ type: "run.delete", payload: { runId, expectedVersion: state.run.version } });
  assert.deepEqual(deleted, { runId, deleted: true });
  assert.equal(store.getRun(runId), null);
  assert.equal(store.listRuns().length, 0);
  store.verifyEventChains();
});

test("pause, stale-version rejection and stop preserve a verifiable cancellation outcome", async (t) => {
  const { dashboard, composition, store } = fixture(t);
  const { run } = await composition.provisionRun({ objective: "Pause before sending", policy: createDiscussionRunPolicy({ maxTurns: 2 }), webConversationUrl: "https://chatgpt.com/c/conversation-test" });
  const paused = await dashboard.execute({ type: "run.pause", payload: { runId: run.runId, expectedVersion: run.version } });
  assert.equal(paused.paused, true);
  await assert.rejects(dashboard.execute({ type: "run.stop", payload: { runId: run.runId, expectedVersion: run.version } }), { code: "RUN_VERSION_CONFLICT" });
  const stopped = await dashboard.execute({ type: "run.stop", payload: { runId: run.runId, expectedVersion: paused.version } });
  assert.equal(stopped.phase, "CANCELLED");
  assert.equal(store.getRunOutcome(run.runId).outcome.type, "CANCELLED");
  store.verifyEventChains();
  store.verifyRunOutcomes();
  store.verifyControlSideRecordLinks();
});

test("an unfinished run blocks another start and invalid URL has no persisted effect", async (t) => {
  const { dashboard, store, composition } = fixture(t);
  const payload = { expectedVersion: 0, mode: "DISCUSSION", objective: "Test", maxTurns: 2, conversationUrl: "https://example.com" };
  await assert.rejects(dashboard.execute({ type: "run.start", payload }));
  assert.equal(store.listRuns().length, 0);
  await composition.provisionRun({ objective: "Existing", policy: createDiscussionRunPolicy(), webConversationUrl: "https://chatgpt.com/c/conversation-test" });
  await assert.rejects(dashboard.execute({ type: "run.start", payload: { ...payload, conversationUrl: "https://chatgpt.com/c/conversation-test" } }), { code: "RUN_BUSY" });
  assert.equal(store.listRuns().length, 1);
});

test("HTTP dashboard requires bearer authentication and same-origin mutation, then runs asynchronously", async (t) => {
  const { live, store } = fixture(t);
  const bridge = createBridgeServer({ runtimeConfig: {
    host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0", demoMode: false,
    codex: { executablePath: process.execPath }, dashboard: { token },
    webExtension: { sharedSecret: secret, expectedExtensionIdentity: "test-extension" }, relay: { webResponseTimeoutMs: 1000 },
  }, createLiveRuntime: async () => live });
  await bridge.listen();
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const headers = { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:0", "content-type": "application/json" };
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/commands`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: '{}' })).status, 403);
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws/extension`);
  const [raw] = await once(ws, "message");
  const challenge = JSON.parse(String(raw));
  ws.send(JSON.stringify({ type: "extension.auth.response", protocolVersion: challenge.protocolVersion, challengeId: challenge.challengeId, extensionIdentity: "test-extension", hmacSha256: computeWebChallengeHmac(challenge.nonce, secret) }));
  await once(ws, "message");
  const response = await fetch(`${base}/api/commands`, { method: "POST", headers, body: JSON.stringify({ type: "run.start", requestId: "start-1", payload: { expectedVersion: 0, mode: "DISCUSSION", objective: "HTTP test", maxTurns: 2, conversationUrl: "https://chatgpt.com/c/conversation-test" } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.type, "command.result");
  for (let i = 0; i < 100 && store.getRun(result.payload.runId).phase !== "COMPLETE"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshot = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(snapshot.run.phase, "COMPLETE");
  const replay = await fetch(`${base}/api/commands`, { method: "POST", headers, body: JSON.stringify({ type: "run.start", requestId: "start-1", payload: { expectedVersion: 0, mode: "DISCUSSION", objective: "HTTP test", maxTurns: 2, conversationUrl: "https://chatgpt.com/c/conversation-test" } }) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), result);
  assert.equal(store.listRuns().length, 1);
  const conflict = await fetch(`${base}/api/commands`, { method: "POST", headers, body: JSON.stringify({ type: "run.pause", requestId: "start-1", payload: {} }) });
  assert.equal(conflict.status, 409);
  ws.terminate();
});

test("explicit resume restores only unsent pending work into exact persisted sessions", async (t) => {
  const { dashboard, composition, store } = fixture(t);
  const { run } = await composition.provisionRun({ objective: "Restore pending", policy: createDiscussionRunPolicy({ maxTurns: 2 }), webConversationUrl: "https://chatgpt.com/c/conversation-test" });
  const originalIds = store.listAgentSessions(run.runId).map((s) => s.sessionId);
  composition.close();
  await dashboard.execute({ type: "run.resume", payload: { runId: run.runId, expectedVersion: run.version } });
  const snapshot = await settled(dashboard, run.runId);
  assert.equal(snapshot.run.phase, "COMPLETE");
  assert.deepEqual(store.listAgentSessions(run.runId).map((s) => s.sessionId), originalIds);
  store.verifyEventChains();
  store.verifyAgentCommunicationLinks();
});

test("restore refuses a claimed delivery before contacting providers", async (t) => {
  const { composition, store } = fixture(t);
  const { run } = await composition.provisionRun({ objective: "Do not resend", policy: createDiscussionRunPolicy({ maxTurns: 2 }), webConversationUrl: "https://chatgpt.com/c/conversation-test" });
  composition.controller.claimNext({ runId: run.runId, expectedRunVersion: run.version });
  composition.close();
  await assert.rejects(composition.restorePendingRun(run.runId), { code: "RECOVERY_REQUIRED" });
  assert.equal(store.listDeliveries(run.runId)[0].state, "DISPATCHING");
});
