import test from "node:test";
import assert from "node:assert/strict";
import { retryableAuditReview } from "../src/orchestration/code-change-runtime-policy.js";

const run = () => ({
  schemaVersion:3,
  runId:"run-1",
  stage:"HOLD",
  terminationReason:"WEB_DELIVERY_DISCARDED",
  auditResult:null,
  reviews:[{decision:"REWORK",report:{assessments:[{requirementId:"R1",verdict:"UNDETERMINED"}]}}],
  requirements:{items:[{requirementId:"R1",required:true}]},
  conversationBindings:[{sessionId:"session-1",activeDeliveryId:null}],
  webDeliveryDiscardIntent:{confirmed:true,runId:"run-1",sessionId:"session-1",currentDeliveryId:"delivery-1"},
  candidate:{candidateId:"candidate-1",patchHash:"hash",candidateTree:"tree",baseCommit:"base"},
  capture:{artifact:{sha256:"hash"},candidateTree:"tree",baseCommit:"base"},
  baseCommit:"base",
  application:null,
  stopRequested:false,
});

test("confirmed unresolved reviewer delivery can resume the same candidate review", () => {
  assert.equal(retryableAuditReview(run()), true);
});

test("review retry after delivery discard still requires exact confirmed cleanup and no active binding", () => {
  for (const patch of [
    {webDeliveryDiscardIntent:{confirmed:false,runId:"run-1",sessionId:"session-1",currentDeliveryId:"delivery-1"}},
    {conversationBindings:[{sessionId:"session-1",activeDeliveryId:"delivery-1"}]},
    {terminationReason:"TOTAL_TIME_LIMIT"},
  ]) assert.equal(retryableAuditReview({...run(),...patch}), false);
});

test("initial audit may resume a frozen candidate only before any reviewer binding or delivery", () => {
  const intent = {
    ...run(), stage:"RECOVERY_REQUIRED", terminationReason:"EXECUTION_UNCERTAIN", reviews:[],
    workerTurns:[{status:"completed"}], reviewTurnId:"judge-intent",
    coordination:{phase:"ROUND0", activeRole:"JUDGE", auditManifestHash:"manifest"},
    requests:[{requestId:"judge-intent", role:"JUDGE", status:"INTENT",
      auditManifestHash:"manifest", candidateId:"candidate-1"}],
    conversationBindings:["JUDGE","CRITIC"].map(role => ({role, bindingStatus:"NEEDS_REBIND"})),
  };
  assert.equal(retryableAuditReview(intent), true);
  assert.equal(retryableAuditReview({...intent, webDeliveryReceipts:[{state:"ACK_PENDING"}]}), false);
  assert.equal(retryableAuditReview({...intent, conversationBindings:[
    {...intent.conversationBindings[0], tabId:42}, intent.conversationBindings[1],
  ]}), false);
  assert.equal(retryableAuditReview({...intent, reviewTurnId:"different-intent"}), false);
});
