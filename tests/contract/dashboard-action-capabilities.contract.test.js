import assert from "node:assert/strict";
import test from "node:test";
import { projectDashboardStartActions } from "../../public/dashboard-start-actions.js";

const EMPTY = Object.freeze({ status:"AVAILABLE_EMPTY", count:0, runs:Object.freeze([]) });
const NONEMPTY = Object.freeze({ status:"AVAILABLE_NONEMPTY", count:1, runs:Object.freeze([{ runId:"run-1" }]) });
const UNKNOWN = Object.freeze({ status:"UNAVAILABLE", count:null, runs:null });

function project(overrides = {}) {
  return projectDashboardStartActions({
    stateAvailable:true,
    runListKnowledge:EMPTY,
    runtimeAvailable:true,
    extensionAuthenticated:true,
    preparationStartCapability:true,
    hasUnfinishedRun:false,
    workflowStage:"START",
    preparationActive:false,
    ...overrides,
  });
}

test("contract: verified empty state with extension and capability permits both start actions", () => {
  assert.deepEqual(project(), {
    canOpenNewRun:true,
    canStartPreparation:true,
  });
});

test("contract: missing binding is intentionally not a prerequisite for preparation bootstrap", () => {
  assert.deepEqual(project(), {
    canOpenNewRun:true,
    canStartPreparation:true,
  });
});

test("contract: extension disconnect keeps local new-work entry but blocks Web preparation start", () => {
  assert.deepEqual(project({ extensionAuthenticated:false }), {
    canOpenNewRun:true,
    canStartPreparation:false,
  });
});

test("contract: unfinished run blocks both actions even when the run list is known", () => {
  assert.deepEqual(project({
    runListKnowledge:NONEMPTY,
    hasUnfinishedRun:true,
  }), {
    canOpenNewRun:false,
    canStartPreparation:false,
  });
});

test("contract: unknown run list blocks both actions", () => {
  assert.deepEqual(project({
    runListKnowledge:UNKNOWN,
    runtimeAvailable:false,
  }), {
    canOpenNewRun:false,
    canStartPreparation:false,
  });
});

test("contract: missing preparation.start capability does not block local new-work entry", () => {
  assert.deepEqual(project({ preparationStartCapability:false }), {
    canOpenNewRun:true,
    canStartPreparation:false,
  });
});

test("contract: failed state read blocks both actions", () => {
  assert.deepEqual(project({ stateAvailable:false }), {
    canOpenNewRun:false,
    canStartPreparation:false,
  });
});
