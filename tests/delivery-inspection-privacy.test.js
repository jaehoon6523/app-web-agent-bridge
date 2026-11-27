import test from "node:test";
import assert from "node:assert/strict";
import { inspectDeliveryRequest } from "../src/runtime/web/delivery-inspection.js";

test("recovery mismatch reports check names without writing private response or binding data", async t => {
  const consoleError = t.mock.method(console, "error", () => {});
  const binding = {
    sessionId:"private-session",runId:"private-run",tabId:7,documentId:"private-document",frameId:0,
    conversationUrl:"https://chatgpt.com/c/private-conversation",conversationId:"private-conversation",
  };
  const response = {
    turnId:"wrong-turn",binding,confidence:"CONFIRMED_BY_UI_STATE",rawText:"private response contents",
    evidence:{...binding,userMessageId:"private-user",assistantMessageId:"private-assistant",responseAssociation:"DIRECT_DOM_ORDER"},
  };
  const state = {
    binding:null,activeTurnId:null,sessionOperation:null,pendingCount:0,ambiguousTurnId:null,
    request:async request => {
      assert.equal(request.type,"web.delivery.inspect-pinned-root");
      return {type:"web.delivery.inspected",payload:{
      ...binding,observedDocumentId:binding.documentId,observedConversationUrl:binding.conversationUrl,
      currentDeliveryId:response.turnId,pageReachable:true,generating:false,pageBusy:false,extensionBusy:false,
      completedDelivery:response,
      }};
    },
  };
  const expected = {...binding,currentDeliveryId:"expected-turn",userMessageId:"private-user",assistantMessageId:"different"};
  await assert.rejects(inspectDeliveryRequest(state,{recoverSubmitted:expected},"request"), error => {
    assert.equal(error.code,"DELIVERY_RECOVERY_MISMATCH");
    assert.equal(error.receiptDiagnostics.failureBoundary,"INSPECTION_VALIDATION");
    assert.deepEqual(error.receiptDiagnostics.failedChecks,["turnId","pinnedIdentity"]);
    assert.doesNotMatch(JSON.stringify(error.receiptDiagnostics), /private-|private response/);
    return true;
  });
  assert.equal(consoleError.mock.callCount(),0);
});
