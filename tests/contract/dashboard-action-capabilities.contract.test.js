import assert from "node:assert/strict";
import test from "node:test";
import { projectDashboardStartActions } from "../../public/dashboard-start-actions.js";
import {
  projectPreparationActions,
  projectReviewerActions,
  projectRunCommandActions,
  reviewerProviderMatches,
} from "../../public/dashboard-action-capabilities.js";

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

test("contract: local run actions do not depend on extension or reviewer availability", () => {
  assert.deepEqual(projectRunCommandActions({
    stateAvailable:true,
    runPresent:true,
    commandCapabilities:["run.stop","code.apply","evidence.export","evidence.get","run.note.add",
      "run.reconcile","run.abandon","run.retry","run.delete","run.archive","code.worker.intervene"],
    workerTurnAvailable:true,
  }), {
    stopRun:true, applyCode:true, exportEvidence:true, openEvidence:true,
    deleteRun:true, archiveRun:true, operatorNote:true, reconcileRun:true,
    abandonRun:true, retryWorker:true, interveneWorker:true,
  });
});

test("contract: worker intervention requires a current worker turn but no Web dependency", () => {
  assert.equal(projectRunCommandActions({
    stateAvailable:true, runPresent:true,
    commandCapabilities:["code.worker.intervene"], workerTurnAvailable:false,
  }).interveneWorker, false);
  assert.equal(projectRunCommandActions({
    stateAvailable:true, runPresent:true,
    commandCapabilities:["code.worker.intervene"], workerTurnAvailable:true,
  }).interveneWorker, true);
});

test("contract: reviewer actions are role-local while re-audit requires both reviewers", () => {
  const runtimes = { JUDGE:{availability:"UNAVAILABLE"}, CRITIC:{availability:"AVAILABLE"} };
  const caps = ["code.review.discuss","code.review.discuss.discard","code.review.rebind","code.review.retry","code.decision.reply"];
  const judge = projectReviewerActions({
    stateAvailable:true, runPresent:true, extensionAuthenticated:true,
    commandCapabilities:caps, reviewerRuntimes:runtimes, role:"JUDGE", exactBindingAvailable:true,
  });
  assert.equal(judge.discuss, false);
  assert.equal(judge.rebind, false);
  assert.equal(judge.retryReview, false);
  assert.equal(judge.decisionReply, false);

  const critic = projectReviewerActions({
    stateAvailable:true, runPresent:true, extensionAuthenticated:true,
    commandCapabilities:caps, reviewerRuntimes:runtimes, role:"CRITIC", exactBindingAvailable:true,
    exactDiscardDeliveryAvailable:true,
  });
  assert.equal(critic.discuss, true);
  assert.equal(critic.discardDiscussion, true);
  assert.equal(critic.retryReview, false);
  assert.equal(projectReviewerActions({
    stateAvailable:true, runPresent:true, extensionAuthenticated:true,
    commandCapabilities:caps, reviewerRuntimes:runtimes, role:"CRITIC",
    exactBindingAvailable:true, exactDiscardDeliveryAvailable:false,
  }).discardDiscussion, false);
});

test("contract: reviewer binding provider identity fails closed when missing or mismatched", () => {
  assert.equal(reviewerProviderMatches(undefined, "CLAUDE_WEB"), false);
  assert.equal(reviewerProviderMatches(null, "CLAUDE_WEB"), false);
  assert.equal(reviewerProviderMatches("", "CLAUDE_WEB"), false);
  assert.equal(reviewerProviderMatches("CHATGPT_WEB", "CLAUDE_WEB"), false);
  assert.equal(reviewerProviderMatches("CLAUDE_WEB", "CLAUDE_WEB"), true);
});

test("contract: extension disconnect disables only Web-dependent reviewer/preparation actions", () => {
  const reviewer = projectReviewerActions({
    stateAvailable:true, runPresent:true, extensionAuthenticated:false,
    commandCapabilities:["code.review.discuss","code.review.retry"],
    reviewerRuntimes:{JUDGE:{availability:"AVAILABLE"},CRITIC:{availability:"AVAILABLE"}},
    role:"JUDGE", exactBindingAvailable:true,
  });
  assert.equal(reviewer.discuss, false);
  assert.equal(reviewer.retryReview, false);
  assert.deepEqual(projectPreparationActions({
    serverReachable:true,
    dashboardAuthenticated:true,
    stateAvailable:true,
    extensionAuthenticated:false,
    commandCapabilities:["preparation.cancel","preparation.reply","preparation.approve","preparation.discard"],
  }), { chooseFolder:true, cancel:true, reply:false, approve:false, discard:false });
});

test("contract: failed state read disables every projected action family", () => {
  assert.equal(projectRunCommandActions({
    stateAvailable:false, runPresent:true, commandCapabilities:["code.apply"],
  }).applyCode, false);
  assert.equal(projectReviewerActions({
    stateAvailable:false, runPresent:true, extensionAuthenticated:true,
    commandCapabilities:["code.review.discuss"],
    reviewerRuntimes:{JUDGE:{availability:"AVAILABLE"}}, role:"JUDGE", exactBindingAvailable:true,
  }).discuss, false);
  const preparation = projectPreparationActions({
    serverReachable:true, dashboardAuthenticated:true,
    stateAvailable:false, extensionAuthenticated:true, commandCapabilities:["preparation.cancel"],
  });
  assert.equal(preparation.chooseFolder, true);
  assert.equal(preparation.cancel, false);
  assert.equal(projectPreparationActions({
    serverReachable:false, dashboardAuthenticated:true,
    stateAvailable:false, extensionAuthenticated:true,
  }).chooseFolder, false);
  assert.equal(projectPreparationActions({
    serverReachable:true, dashboardAuthenticated:false,
    stateAvailable:false, extensionAuthenticated:true,
  }).chooseFolder, false);
});
