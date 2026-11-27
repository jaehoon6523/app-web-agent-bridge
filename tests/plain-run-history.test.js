import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPlainRuns, plainRunDirectory, readPlainRun, savePlainRun } from "../src/plain-run-history.js";
import { runPlainRoleLoop } from "../src/orchestration/plain-role-loop.js";

test("stored transcripts and receipts remain bound to each Run ID after a fresh read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plain-history-"));
  try {
    const first = `plain_${randomUUID()}`, second = `plain_${randomUUID()}`;
    for (const [runId, startedAt] of [[first, "2026-01-01"], [second, "2026-01-02"]]) {
      await savePlainRun(root, { runId, startedAt, status: "COMPLETED" });
      await writeFile(path.join(plainRunDirectory(root, runId), "transcript.jsonl"),
        JSON.stringify({ runId, role: "JUDGE", receipt: "RESPONSE_SAVED", diffSha256: runId }) + "\n"
        + JSON.stringify({ runId, role: "JUDGE", receipt: "ACK_CONFIRMED" }) + "\n");
    }
    const reopened = await listPlainRuns(root);
    assert.deepEqual(reopened.map(run => run.runId), [second, first]);
    assert.deepEqual(reopened.map(run => run.turns[0].diffSha256), [second, first]);
    assert.equal((await readPlainRun(root, first)).turns[1].receipt, "ACK_CONFIRMED");
    assert.equal(await readPlainRun(root, `plain_${randomUUID()}`), null);
    assert.throws(() => plainRunDirectory(root, "../other"), TypeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transcript-only Runs use the recorded ID and keep their original turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plain-legacy-"));
  try {
    const locations = ["plain-worker-old", "plain-worker-dashboard-live/plain-worker-old", "plain-role-loop-live"];
    const legacy = [];
    for (const location of locations) {
      const runId = `plain_${randomUUID()}`;
      const turn = { runId, role: "WORKER", turnId: randomUUID(), received: "저장된 응답" };
      legacy.push({ runId, status: "LEGACY", startedAt: null, turns: [turn] });
      const directory = path.join(root, location);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "transcript.jsonl"), JSON.stringify(turn) + "\r\n");
    }
    const runId = `plain_${randomUUID()}`;
    await savePlainRun(root, { runId, status: "COMPLETED", startedAt: "2026-01-03" });
    const listed = await listPlainRuns(root);
    assert.equal(listed[0].runId, runId);
    assert.equal(listed.length, 4);
    for (const run of legacy) assert.deepEqual(await readPlainRun(root, run.runId), run);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewer receipts show saved Diff before exact ACK and Worker session stays stable", async () => {
  const turns = [];
  const responses = ["동의\n의견", "자료를 요청합니다.\n비판 의견"];
  const receipts = [];
  let binding;
  const web = {
    async resume({ binding: target }) {
      binding = { ...target, conversationId: target.sessionId, conversationUrl: `https://example.test/${target.sessionId}` };
      return binding;
    },
    async submitTurn({ turnId }) {
      const rawText = responses.shift();
      const decisionEvidence = { status: "PERSISTED", phase: "COMPLETED", deliveryId: turnId,
        captureId: randomUUID(), persistedAt: Date.now(), manifestSha256: "a".repeat(64),
        response: { utf8Bytes: Buffer.byteLength(rawText), sha256: createHash("sha256").update(rawText).digest("hex") } };
      receipts.push(decisionEvidence);
      return { completion: Promise.resolve({ turnId, binding, rawText, confidence: "CONFIRMED_BY_UI_STATE",
        evidence: { responseAssociation: "DIRECT_DOM_ORDER", conversationId: binding.conversationId, decisionEvidence } }) };
    },
    async acknowledgeDelivery({ turnId }) {
      assert.equal(turns.at(-1).turnId, turnId);
      assert.deepEqual(turns.at(-1).browserReceipt, receipts.at(-1));
      return { ...binding, currentDeliveryId: null };
    },
  };
  const runId = `plain_${randomUUID()}`;
  await runPlainRoleLoop(web, "task", turn => turns.push(turn), async ({ initial }) => {
    turns.push({ runId, role: "WORKER", threadId: "same-thread", receipt: "RESPONSE_SAVED" });
    return { received: "done", diff: initial ? "diff --git a/a b/a\n" : "", diffSha256: "sha256:diff" };
  }, runId);
  assert.deepEqual(turns.filter(turn => turn.role === "JUDGE" || turn.role === "CRITIC")
    .map(turn => turn.receipt), ["RESPONSE_SAVED", "ACK_CONFIRMED", "RESPONSE_SAVED", "ACK_CONFIRMED"]);
  assert.ok(turns.filter(turn => ["JUDGE", "CRITIC"].includes(turn.role) && turn.receipt === "RESPONSE_SAVED")
    .every(turn => turn.diffSha256 === "sha256:diff" && turn.runId === runId
      && turn.conversationId === turn.sessionId && turn.browserReceipt.deliveryId === turn.turnId));
  assert.equal(turns.filter(turn => turn.role === "WORKER")[0].threadId,
    turns.filter(turn => turn.role === "WORKER").at(-1).threadId);
});

test("uncertain reviewer ACK leaves a saved response without another send", async () => {
  const turns = [];
  let submits = 0, binding;
  const web = {
    async resume({ binding: target }) {
      binding = { ...target, conversationId: "judge", conversationUrl: "https://example.test/judge" };
      return binding;
    },
    async submitTurn({ turnId }) {
      submits++;
      return { completion: Promise.resolve({ turnId, binding, rawText: "동의\n의견",
        confidence: "CONFIRMED_BY_UI_STATE", evidence: { responseAssociation: "DIRECT_DOM_ORDER",
          conversationId: binding.conversationId, decisionEvidence: { status: "PERSISTED", phase: "COMPLETED",
            deliveryId: "another-turn" } } }) };
    },
    async acknowledgeDelivery() { throw new Error("ACK uncertain"); },
  };
  await assert.rejects(runPlainRoleLoop(web, "task", turn => turns.push(turn), async () =>
    ({ received: "done", diff: "diff --git a/a b/a\n", diffSha256: "sha256:diff" })), /ACK uncertain/u);
  assert.equal(submits, 1);
  assert.equal(turns.filter(turn => turn.role === "JUDGE" && turn.receipt === "RESPONSE_SAVED").length, 1);
  assert.equal(turns[0].browserReceipt, null);
  assert.equal(turns.filter(turn => turn.receipt === "ACK_CONFIRMED").length, 0);
});
