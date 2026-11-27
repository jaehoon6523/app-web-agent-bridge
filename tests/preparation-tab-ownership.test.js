import assert from "node:assert/strict";
import test from "node:test";
import { closeFinishedPreparationTab, handoffOwnedPreparationTab, recordOwnedTabAcknowledgement, rememberPreparationTab } from "../extension/runtime/preparation-tab-ownership.js";

function fixture() {
  const expected = { tabId:8, windowId:1, sessionId:"web_prep_test", runId:"prep_test", deliveryId:"delivery_1",
    conversationUrl:"https://chatgpt.com/c/test", conversationId:"test", documentId:"doc-test" };
  const state = { ...expected, lastBoundSessionId:expected.sessionId, lastBoundRunId:expected.runId,
    currentDeliveryId:null, bindingStatus:"BOUND", lastAcknowledgedDelivery:expected, deliveryScopes:{} };
  const page = { ...expected, url:expected.conversationUrl, frameId:0, ok:true, busy:false, generating:false };
  const tab = { id:expected.tabId, windowId:expected.windowId, url:expected.conversationUrl };
  const records = {}, removed = [];
  const chrome = { storage:{ session:{
    get:async (key) => ({ [key]:records[key] }),
    set:async (patch) => { Object.assign(records, patch); },
    remove:async (key) => { delete records[key]; },
  } }, tabs:{ get:async () => tab, sendMessage:async () => page,
    remove:async (id) => { removed.push(id); } } };
  return { chrome, expected, state, page, tab, removed, async remember() {
    await rememberPreparationTab(chrome, tab, expected.sessionId);
    await recordOwnedTabAcknowledgement(chrome, state);
  },
    close:() => closeFinishedPreparationTab(chrome, { read:async () => state }, expected) };
}

test("an acknowledged Bridge-owned preparation tab closes once", async () => {
  const f = fixture();
  await f.remember();
  assert.deepEqual(await f.close(), { status:"CLOSED", tabId:8 });
  assert.equal((await f.close()).reason, "TAB_NOT_BRIDGE_OWNED");
  assert.deepEqual(f.removed, [8]);
});

for (const [name, change, reason] of [
  ["user-opened tab", null, "TAB_NOT_BRIDGE_OWNED"],
  ["active delivery", f => { f.state.currentDeliveryId = "different"; }, "ACK_OR_BINDING_UNCONFIRMED"],
  ["parked delivery", f => { f.state.deliveryScopes.other = { tabId:8 }; }, "ACK_OR_BINDING_UNCONFIRMED"],
  ["different ACK", f => { f.expected.deliveryId = "different"; }, "ACK_OR_BINDING_UNCONFIRMED"],
  ["changed document", f => { f.page.documentId = "different"; }, "DOCUMENT_OR_ACTIVITY_UNCONFIRMED"],
  ["generating page", f => { f.page.generating = true; }, "DOCUMENT_OR_ACTIVITY_UNCONFIRMED"],
  ["pinned tab", f => { f.tab.pinned = true; }, "TAB_CHANGED"],
]) {
  test(`tab cleanup preserves a ${name}`, async () => {
    const f = fixture();
    if (change) { await f.remember(); change(f); }
    assert.deepEqual(await f.close(), { status:"SKIPPED", reason });
    assert.deepEqual(f.removed, []);
  });
}

test("Judge takes ownership from a proven preparation and keeps its own ACK after Critic binds", async () => {
  const f = fixture(), source = f.expected.sessionId;
  await f.remember();
  Object.assign(f.expected, { sessionId:"web_code_test", runId:"code_test", deliveryId:"review-judge" });
  await handoffOwnedPreparationTab(f.chrome, f.tab, f.expected, f.expected.documentId, source);
  Object.assign(f.state, { lastBoundSessionId:f.expected.sessionId, lastBoundRunId:f.expected.runId,
    lastAcknowledgedDelivery:{ ...f.expected } });
  assert.equal(await recordOwnedTabAcknowledgement(f.chrome, f.state), true);
  Object.assign(f.state, { lastBoundSessionId:"web_code_test_critic", tabId:9, conversationUrl:"https://chatgpt.com/c/critic",
    lastAcknowledgedDelivery:{ deliveryId:"review-critic" } });
  assert.deepEqual(await f.close(), { status:"CLOSED", tabId:8 });
});
