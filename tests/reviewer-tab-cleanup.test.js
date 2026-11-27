import assert from "node:assert/strict";
import test from "node:test";
import { closeSettledReviewerTabs } from "../src/orchestration/audit-round.js";

function fixture() {
  const roles = ["JUDGE", "CRITIC"], closed = [];
  const run = {
    stage:"AWAITING_APPLY", candidate:{candidateId:"c1"},
    reviews:[{ decision:"PASS", candidateId:"c1", reviewerRoles:roles }],
    conversationBindings:roles.map((role, index) => ({
      role, tabId:index + 1, sessionId:role, activeDeliveryId:null, conversationUrl:"https://chatgpt.com/c/" + role,
    })),
  };
  run.webDeliveryReceipts = run.conversationBindings.map(binding => ({
    ...binding, deliveryId:binding.role, state:"ACKNOWLEDGED", responseRef:{sha256:"stored"}, bridgeOwnedTab:true,
  }));
  const service = {
    get:() => run, update:(_id, patch) => Object.assign(run, patch),
    reviewerWeb:role => ({ async closePreparationTab(expected) {
      closed.push(role);
      assert.equal(expected.deliveryId,role);
      return {status:"CLOSED",tabId:expected.tabId};
    } }),
  };
  return { run, service, closed, finish:() => closeSettledReviewerTabs(service, "code_test") };
}

test("final audit closes both proven tabs exactly once and records independent receipts", async () => {
  const f = fixture();
  await f.finish();
  await f.finish();
  assert.deepEqual(f.closed, ["JUDGE","CRITIC"]);
  assert.equal(f.run.reviewerTabCleanup.JUDGE.status, "CLOSED");
  assert.equal(f.run.reviewerTabCleanup.CRITIC.status, "CLOSED");
});

for (const [name, change] of [
  ["hold", run => { run.stage = "HOLD"; }],
  ["rework that can continue", run => { run.stage = "REWORK"; }],
  ["recovery", run => { run.stage = "RECOVERY_REQUIRED"; }],
  ["unsettled acknowledgement", run => { run.webDeliveryReceipts[1].state = "ACK_PENDING"; }],
  ["active delivery", run => { run.conversationBindings[1].activeDeliveryId = "active"; }],
]) {
  test(`keeps both tabs open during ${name}`, async () => {
    const f = fixture();
    change(f.run);
    await f.finish();
    assert.deepEqual(f.closed, []);
  });
}

test("a manually opened tab stays open and a Chrome failure preserves the audit outcome", async () => {
  const f = fixture();
  f.run.webDeliveryReceipts[0].bridgeOwnedTab = false;
  f.service.reviewerWeb = role => ({ async closePreparationTab() {
    f.closed.push(role);
    throw new Error("Chrome unavailable");
  } });
  await f.finish();
  assert.deepEqual(f.closed, ["CRITIC"]);
  assert.equal(f.run.reviewerTabCleanup.CRITIC.status, "UNCONFIRMED");
  assert.equal(f.run.stage, "AWAITING_APPLY");
});
