import assert from "node:assert/strict";
import test from "node:test";
import { DashboardController } from "../../src/orchestration/dashboard-controller.js";
import {
  RunListKnowledgeStatus,
  projectRunListKnowledge,
} from "../../public/dashboard-run-list-knowledge.js";

function preflight() {
  return { checks:{ extensionAuthenticated:true }, readyForProvisioning:true };
}

function runtimeWithRuns(runs) {
  return {
    store:{
      listRuns:() => structuredClone(runs),
      getRun:(runId) => structuredClone(runs.find((run) => run.runId === runId) ?? null),
      listAgentSessions:() => [],
      listAgentMessages:() => [],
      listAgentTurnInputs:() => [],
      listDeliveries:() => [],
      listApprovals:() => [],
      listDomainEvents:() => [],
      getRunOutcome:() => null,
    },
    codeChanges:{ list:() => [] },
    composition:{ getRuntimeSessions:() => null },
  };
}

function controller(getRuntime) {
  return new DashboardController({
    getRuntime,
    preflight,
    webSession:null,
    transport:null,
  });
}

test("contract: verified empty runs are AVAILABLE_EMPTY", async () => {
  const dashboard = controller(async () => runtimeWithRuns([]));
  const snapshot = await dashboard.snapshot();
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(snapshot.dataKnowledge.runs, { status:"AVAILABLE_EMPTY" });
  assert.equal(projectRunListKnowledge(snapshot).status, RunListKnowledgeStatus.AVAILABLE_EMPTY);
  dashboard.close();
});

test("contract: verified non-empty runs are AVAILABLE_NONEMPTY", async () => {
  const runs = [{
    runId:"run-known",
    objective:"Known run",
    phase:"COMPLETE",
    version:1,
    createdAt:"2026-09-29T00:00:00.000Z",
    updatedAt:"2026-09-29T00:01:00.000Z",
  }];
  const dashboard = controller(async () => runtimeWithRuns(runs));
  const snapshot = await dashboard.snapshot();
  assert.equal(snapshot.runs.length, 1);
  assert.deepEqual(snapshot.dataKnowledge.runs, { status:"AVAILABLE_NONEMPTY" });
  const knowledge = projectRunListKnowledge(snapshot);
  assert.equal(knowledge.status, RunListKnowledgeStatus.AVAILABLE_NONEMPTY);
  assert.equal(knowledge.count, 1);
  dashboard.close();
});

test("contract: runtime failure plus runs=[] is UNAVAILABLE, never AVAILABLE_EMPTY", async () => {
  const dashboard = controller(async () => {
    throw Object.assign(new Error("runtime unavailable"), { code:"RUNTIME_UNAVAILABLE" });
  });
  const snapshot = await dashboard.snapshot();
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(snapshot.dataKnowledge.runs, { status:"UNAVAILABLE" });
  const knowledge = projectRunListKnowledge(snapshot);
  assert.equal(knowledge.status, RunListKnowledgeStatus.UNAVAILABLE);
  assert.equal(knowledge.count, null);
  assert.equal(knowledge.runs, null);
  dashboard.close();
});

test("contract: missing run knowledge metadata is a projection error, not implicit UNAVAILABLE", () => {
  assert.throws(
    () => projectRunListKnowledge({ runs:[] }),
    (error) => error?.code === "DASHBOARD_STATE_INVALID"
      && error?.status === 200
      && error?.responseReceived === true,
  );
  assert.throws(
    () => projectRunListKnowledge(null),
    (error) => error?.code === "DASHBOARD_STATE_INVALID",
  );
});

test("contract: contradictory declared knowledge is rejected instead of silently reinterpreted", () => {
  assert.throws(
    () => projectRunListKnowledge({
      runs:[{ runId:"unexpected" }],
      dataKnowledge:{ runs:{ status:"AVAILABLE_EMPTY" } },
    }),
    (error) => error?.code === "DASHBOARD_STATE_INVALID",
  );
  assert.throws(
    () => projectRunListKnowledge({
      runs:[{ runId:"stale-without-freshness-semantics" }],
      dataKnowledge:{ runs:{ status:"UNAVAILABLE" } },
    }),
    (error) => error?.code === "DASHBOARD_STATE_INVALID",
  );
});
