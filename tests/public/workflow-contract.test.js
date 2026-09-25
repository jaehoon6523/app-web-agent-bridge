import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../../public");
const source = async (name) => readFile(path.join(publicDir, name), "utf8");

// Contract proof suite for Start → Prepare → Work → Result.
// These tests are architectural gates. They should be RED on the legacy
// implementation and GREEN only after the canonical workflow contract exists.

const allowed = new Map([
  ["START", new Set(["START_IDLE", "VALIDATING", "CONNECTING_WEB", "WAITING_WEB_RESPONSE", "RECOVERY_REQUIRED", "WEB_BLOCKED", "FAILED"])],
  ["PREPARE", new Set(["INITIALIZING", "WAITING_WEB_RESPONSE", "DISCUSSING", "AGREEMENT_READY", "APPROVING", "WEB_BLOCKED", "RECOVERY_REQUIRED", "FAILED"])],
  ["WORK", new Set(["RUN_CREATED", "PROVISIONING", "WORKER_RUNNING", "VERIFYING", "REVIEW_RUNNING", "REWORK", "APPLYING", "STOPPING", "HOLD", "RECOVERY_REQUIRED"])],
  ["RESULT", new Set(["AWAITING_APPLY", "APPLIED", "COMPLETE", "CANCELLED", "INCONCLUSIVE", "FAILED"])],
]);

function assertValidWorkflow(workflow) {
  assert.ok(workflow && typeof workflow === "object", "workflow is required");
  assert.ok(allowed.has(workflow.stage), `unknown stage ${workflow.stage}`);
  assert.ok(allowed.get(workflow.stage).has(workflow.state), `${workflow.stage}/${workflow.state} is forbidden`);
  if (workflow.stage === "PREPARE") {
    assert.equal(typeof workflow.preparationId, "string");
    assert.ok(Number.isSafeInteger(workflow.preparationVersion) && workflow.preparationVersion >= 1);
  }
  if (["WORK", "RESULT"].includes(workflow.stage)) {
    assert.equal(typeof workflow.runId, "string");
    assert.ok(Number.isSafeInteger(workflow.runVersion) && workflow.runVersion >= 1);
  }
}

function assertStrictDiscussionSequence(turns, preparationId) {
  let previous = 0;
  const ids = new Set();
  for (const turn of turns) {
    assert.equal(turn.preparationId, preparationId);
    assert.ok(Number.isSafeInteger(turn.sequence) && turn.sequence > previous, "sequence must strictly increase");
    assert.equal(ids.has(turn.turnId), false, `duplicate turnId ${turn.turnId}`);
    if (turn.actor === "WEB_DESIGNER") assert.equal(typeof turn.deliveryId, "string");
    ids.add(turn.turnId);
    previous = turn.sequence;
  }
}

function assertAtMostOneActiveDelivery(session, deliveries) {
  const active = deliveries.filter((d) => d.deliveryId === session.activeDeliveryId);
  if (session.activeDeliveryId == null) assert.equal(active.length, 0);
  else assert.equal(active.length, 1);
}

test("CONTRACT-01: stage/state is a discriminated union", () => {
  for (const [stage, states] of allowed) {
    for (const state of states) {
      const workflow = {
        stage,
        state,
        preparationId: stage === "PREPARE" ? "prep_1" : null,
        preparationVersion: stage === "PREPARE" ? 1 : null,
        runId: ["WORK", "RESULT"].includes(stage) ? "run_1" : null,
        runVersion: ["WORK", "RESULT"].includes(stage) ? 1 : null,
      };
      assert.doesNotThrow(() => assertValidWorkflow(workflow));
    }
  }
  assert.throws(() => assertValidWorkflow({ stage: "START", state: "AGREEMENT_READY" }));
  assert.throws(() => assertValidWorkflow({ stage: "RESULT", state: "HOLD", runId: "run_1", runVersion: 1 }));
  assert.throws(() => assertValidWorkflow({ stage: "WORK", state: "AGREEMENT_READY", runId: "run_1", runVersion: 1 }));
});

test("CONTRACT-02: UI source must not derive workflow stage from DOM/local legacy flags", async () => {
  const app = await source("app.js");
  assert.doesNotMatch(app, /editingProject\s*\?\s*["']stepPrepare["']/s);
  assert.doesNotMatch(app, /showStart\s*\?\s*["']stepStart["']/s);
  assert.doesNotMatch(app, /projectPanel[^\n]*hidden[^\n]*(?:stepPrepare|PREPARE)/s);
  assert.match(app, /workflow\.(?:stage|state)/);
});

test("CONTRACT-03: preparation approval is one external mutation, not prepare + project PUT + run.start", async () => {
  const app = await source("app.js");
  assert.match(app, /\/api\/preparations\/[^\n]*\/approve|preparation\.approve/);
  assert.doesNotMatch(app, /\/api\/project\/prepare[\s\S]{0,2500}\/api\/project[\s\S]{0,2500}run\.start/);
});

test("CONTRACT-04: entering PREPARE uses preparation.start and does not synchronously await a proposal response", async () => {
  const app = await source("app.js");
  assert.match(app, /preparation\.start|\/api\/preparations/);
  assert.doesNotMatch(app, /beginPreparation[\s\S]{0,1800}await\s+proposeRequirements\s*\(/);
});

test("CONTRACT-05: inspect, stop, and reconcile are distinct web commands", async () => {
  const app = await source("app.js");
  for (const command of ["web.inspect", "web.stop", "web.reconcile"]) assert.match(app, new RegExp(command.replace(".", "\\.")));
  assert.doesNotMatch(app, /proposalSessionAction\s*\(\s*["']recover["']|\/api\/project\/proposal\/session/);
});

test("CONTRACT-06: legacy proposalDraft cannot be the canonical workflow store", async () => {
  const app = await source("app.js");
  assert.doesNotMatch(app, /\blet\s+proposalDraft\b/);
  assert.doesNotMatch(app, /\blet\s+proposalPending\b/);
});

test("CONTRACT-07: dashboard projection exposes workflow identity and both optimistic versions", async () => {
  const model = await source("dashboard-model.js");
  for (const term of ["workflow", "preparationId", "preparationVersion", "runId", "runVersion"]) assert.match(model, new RegExp(term));
});

test("CONTRACT-08: ACKNOWLEDGED is retained and IDLE is not a persisted delivery state", async () => {
  const model = await source("dashboard-model.js");
  assert.match(model, /ACKNOWLEDGED/);
  const deliveryDeclaration = model.match(/DELIVERY_STATES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  assert.doesNotMatch(deliveryDeclaration, /["']IDLE["']/);
});

test("CONTRACT-09: DiscussionTurn identity is strict and WEB_DESIGNER turns carry deliveryId", () => {
  const turns = [
    { turnId: "t1", preparationId: "prep_1", sequence: 1, actor: "USER", content: "goal", deliveryId: null },
    { turnId: "t2", preparationId: "prep_1", sequence: 2, actor: "WEB_DESIGNER", content: "question", deliveryId: "d1" },
    { turnId: "t3", preparationId: "prep_1", sequence: 3, actor: "USER", content: "answer", deliveryId: null },
    { turnId: "t4", preparationId: "prep_1", sequence: 4, actor: "WEB_DESIGNER", content: "proposal", deliveryId: "d2" },
  ];
  assert.doesNotThrow(() => assertStrictDiscussionSequence(turns, "prep_1"));
  assert.throws(() => assertStrictDiscussionSequence([{ ...turns[0], sequence: 2 }, { ...turns[1], sequence: 2 }], "prep_1"));
  assert.throws(() => assertStrictDiscussionSequence([{ ...turns[1], deliveryId: null }], "prep_1"));
});

test("CONTRACT-10: one WebSession has at most one active delivery pointer", () => {
  const deliveries = [
    { deliveryId: "d1", state: "ACKNOWLEDGED" },
    { deliveryId: "d2", state: "RESPONSE_STARTED" },
  ];
  assert.doesNotThrow(() => assertAtMostOneActiveDelivery({ activeDeliveryId: "d2" }, deliveries));
  assert.throws(() => assertAtMostOneActiveDelivery({ activeDeliveryId: "missing" }, deliveries));
});

test("CONTRACT-11: acknowledged delivery records remain after active pointer is cleared", () => {
  const deliveries = [{ deliveryId: "d1", state: "ACKNOWLEDGED" }];
  const session = { activeDeliveryId: null };
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].state, "ACKNOWLEDGED");
  assert.equal(session.activeDeliveryId, null);
});

test("CONTRACT-12: source forbids silent automatic resend after timeout or ambiguous delivery", async () => {
  const app = await source("app.js");
  assert.match(app, /자동 재전송하지 않습니다|UNKNOWN_RESULT|requestId/);
  assert.doesNotMatch(app, /(?:AMBIGUOUS|TimeoutError)[\s\S]{0,500}(?:delivery\.retry|run\.retry|proposeRequirements\s*\()/);
});

test("CONTRACT-13: preparation mutations use preparationVersion instead of run.version", async () => {
  const app = await source("app.js");
  assert.match(app, /preparationVersion/);
  assert.match(app, /expectedVersion/);
});

test("CONTRACT-14: repository preparation is reachable only from approval path", async () => {
  const app = await source("app.js");
  const legacyPrepareCalls = [...app.matchAll(/\/api\/project\/prepare/g)];
  assert.equal(legacyPrepareCalls.length, 0, "legacy client-side repository prepare endpoint must be removed");
});

test("CONTRACT-15: workflow can be rendered from canonical server state without showStart", async () => {
  const app = await source("app.js");
  assert.doesNotMatch(app, /\blet[^\n]*\bshowStart\b/);
  assert.match(app, /workflow\.stage/);
});
