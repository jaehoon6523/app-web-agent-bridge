import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTORS,
  buildCommandEnvelope,
  classifyMessageOrigin,
  deliveryState,
  normalizeDashboardState,
  selectMessagesForActor,
  sessionFieldRows,
} from "../../public/dashboard-model.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../../public");

test("dashboard uses only canonical actor names and removes legacy completion controls", async () => {
  const sources = await Promise.all([
    "index.html",
    "app.js",
    "styles.css",
    "dashboard-model.js",
  ].map((name) => readFile(path.join(publicDir, name), "utf8")));
  const combined = sources.join("\n");

  assert.match(combined, /CODEX_AGENT/);
  assert.match(combined, /CHATGPT_WEB_AGENT/);
  assert.doesNotMatch(combined, /APP_AGENT/);
  assert.doesNotMatch(combined, /(?<!CHATGPT_)WEB_AGENT/);
  assert.doesNotMatch(combined, /\[\[DONE\]\]/);
  assert.doesNotMatch(combined, /stopOnDone/);
  assert.doesNotMatch(combined, /firstActor/);
  assert.deepEqual(ACTORS, ["CODEX_AGENT", "CHATGPT_WEB_AGENT"]);
});

test("every run-bound dashboard command is tied to runId and expectedVersion", () => {
  const envelope = buildCommandEnvelope({
    type: "run.pause",
    requestId: "ui_1",
    run: { runId: "run_1", version: 7 },
    payload: { reason: "operator" },
  });

  assert.deepEqual(envelope, {
    type: "run.pause",
    requestId: "ui_1",
    payload: {
      reason: "operator",
      runId: "run_1",
      expectedVersion: 7,
    },
  });
  assert.throws(
    () => buildCommandEnvelope({ type: "run.pause", requestId: "ui_2", run: null }),
    /requires a canonical run/,
  );
});

test("run creation and state read use an explicit zero expectedVersion", () => {
  const envelope = buildCommandEnvelope({
    type: "run.start",
    requestId: "ui_start",
    run: null,
    payload: { mode: "DISCUSSION", objective: "review" },
    allowWithoutRun: true,
  });
  assert.equal(envelope.payload.expectedVersion, 0);
  assert.equal(envelope.payload.mode, "DISCUSSION");
});

test("dashboard state rejects missing version and duplicate actor sessions", () => {
  assert.throws(
    () => normalizeDashboardState({ run: { runId: "run_1" } }),
    /run.version/,
  );
  assert.throws(
    () => normalizeDashboardState({
      run: null,
      sessions: [
        { actor: "CODEX_AGENT", sessionId: "session_1" },
        { actor: "CODEX_AGENT", sessionId: "session_2" },
      ],
    }),
    /Duplicate session/,
  );
});

test("human input, controller relay, and agent output remain visually distinguishable", () => {
  assert.equal(classifyMessageOrigin({ source: "HUMAN" }).label, "HUMAN INPUT");
  assert.equal(classifyMessageOrigin({ source: "CONTROLLER_RELAY" }).label, "CONTROLLER RELAY");
  assert.equal(classifyMessageOrigin({ fromActor: "CODEX_AGENT" }).label, "AGENT OUTPUT");
  assert.equal(classifyMessageOrigin({ source: "mystery" }).label, "UNCLASSIFIED");
});

test("transcripts include outgoing agent messages and incoming controller relays for one actor", () => {
  const selected = selectMessagesForActor([
    { messageId: "m3", runId: "run_1", sequence: 3, fromActor: "CHATGPT_WEB_AGENT", toActor: "CODEX_AGENT" },
    { messageId: "m1", runId: "run_1", sequence: 1, actor: "CODEX_AGENT" },
    { messageId: "m2", runId: "run_other", sequence: 2, actor: "CODEX_AGENT" },
  ], "CODEX_AGENT", "run_1");
  assert.deepEqual(selected.map((message) => message.messageId), ["m1", "m3"]);
});

test("delivery states fail closed and both session headers expose required facts", () => {
  assert.equal(deliveryState({ state: "RESPONSE_COMPLETED" }), "RESPONSE_COMPLETED");
  assert.equal(deliveryState({ state: "invented" }), "UNKNOWN");

  const codexLabels = sessionFieldRows("CODEX_AGENT", null).map(([label]) => label);
  const webLabels = sessionFieldRows("CHATGPT_WEB_AGENT", null).map(([label]) => label);
  assert.deepEqual(codexLabels, ["thread ID", "active turn ID", "sandbox", "approval policy", "last resumed"]);
  assert.deepEqual(webLabels, [
    "conversation ID",
    "conversation URL",
    "tab / window",
    "login",
    "binding confidence",
    "last message ID",
  ]);
});

test("dashboard starts mutation controls disabled until a canonical state arrives", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  for (const id of [
    "startRun",
    "stopRun",
    "exportEvidence",
    "applyCode",
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`));
  }
  assert.match(html, /로컬 서버에 연결하고 있습니다/);
  assert.doesNotMatch(html, /id="(?:pauseRun|resumeRun|reviewThreshold|targetRoot)"/);
});

test("ambiguous delivery is never wired to the direct retry command", async () => {
  const source = await readFile(path.join(publicDir, "app.js"), "utf8");
  assert.match(source, /자동 재전송하지 않습니다/u);
  assert.doesNotMatch(source, /command\("(?:run|delivery)\.retry"/u);
  assert.doesNotMatch(source, /\["FAILED",\s*"AMBIGUOUS"\].*delivery\.retry/su);
});

test("contract: dashboard state preserves canonical workflow identity and versions", () => {
  const value = normalizeDashboardState({
    workflow: {
      stage: "PREPARE", state: "DISCUSSING", preparationId: "prep_1",
      preparationVersion: 4, runId: null, runVersion: null,
    },
    preparation: { preparationId: "prep_1", version: 4 },
    run: null, sessions: [], deliveries: [], approvals: [], events: [], messages: [],
    commandCapabilities: ["preparation.reply"],
  });
  assert.deepEqual(value.workflow, {
    stage: "PREPARE", state: "DISCUSSING", preparationId: "prep_1",
    preparationVersion: 4, runId: null, runVersion: null,
  });
});

test("contract: invalid workflow stage/state combinations fail closed", () => {
  assert.throws(() => normalizeDashboardState({
    workflow: {
      stage: "START", state: "DISCUSSING", preparationId: null,
      preparationVersion: null, runId: null, runVersion: null,
    },
    run: null, sessions: [], deliveries: [], approvals: [], events: [], messages: [],
    commandCapabilities: [],
  }), /workflow|stage|state|DISCUSSING/i);
});

test("contract: workflow version projection is mandatory for mutable PREPARE state", () => {
  assert.throws(() => normalizeDashboardState({
    workflow: {
      stage: "PREPARE", state: "DISCUSSING", preparationId: "prep_1",
      runId: null, runVersion: null,
    },
    run: null, sessions: [], deliveries: [], approvals: [], events: [], messages: [],
    commandCapabilities: [],
  }), /preparationVersion|version/i);
});

test("contract: acknowledged delivery is retained while IDLE is not a delivery record state", () => {
  assert.equal(deliveryState({ state: "ACKNOWLEDGED" }), "ACKNOWLEDGED");
  assert.equal(deliveryState({ state: "IDLE" }), "UNKNOWN");
});

test("contract: preparation capabilities remain separate from run capabilities", () => {
  const value = normalizeDashboardState({
    workflow: {
      stage: "PREPARE", state: "AGREEMENT_READY", preparationId: "prep_1",
      preparationVersion: 9, runId: null, runVersion: null,
    },
    preparation: { preparationId: "prep_1", version: 9 },
    run: null, sessions: [], deliveries: [], approvals: [], events: [], messages: [],
    commandCapabilities: ["preparation.approve", "web.inspect", "web.stop", "web.reconcile"],
  });
  assert.equal(value.commandCapabilities.has("preparation.approve"), true);
  assert.equal(value.commandCapabilities.has("web.inspect"), true);
  assert.equal(value.commandCapabilities.has("web.reconcile"), true);
  assert.equal(value.commandCapabilities.has("run.start"), false);
});
