import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createAutomaticAgentReport, summarizeTabs, summarizeDelivery, safeFailure, writeAgentReport } from "../src/diagnostics/agent-report.js";
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from "../src/orchestration/selector-diagnostics.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-agent-report-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}
test("latest report excludes content, labels and errors; unknown delivery is not missing", t => {
  const root = fixture(t);
  const secret = "PRIVATE_SECRET_RESPONSE";
  const tabs = summarizeTabs({tabs:[{tabId:7,pageStatus:"READY",composerPresent:true,
    responseBody:secret,diagnostics:{editableCandidates:[{visible:2,matched:2,samples:[{controlLabel:secret}]}]}}]});
  assert.equal(tabs[0].decision, "REPAIR_NOT_NEEDED");
  const error = Object.assign(new Error(secret), {cause:{message:secret,code:"ECONNREFUSED"}});
  writeAgentReport(root, "server", {tabs,delivery:summarizeDelivery(null)});
  const result = writeAgentReport(root, "repair", {failure:safeFailure(error,"REPAIR_HTTP_FAILED")});
  const text = fs.readFileSync(result.logFile,"utf8"), value = JSON.parse(text);
  assert.doesNotMatch(text, /PRIVATE_SECRET_RESPONSE/u);
  assert.equal(value.server.delivery.serverExtensionMatch,"UNKNOWN");
  assert.equal(value.server.delivery.currentDeliveryId,null);
  assert.equal(value.server.delivery.recordObserved,false);
  assert.equal(value.repair.failure.causeCode,"ECONNREFUSED");
  writeAgentReport(root,"repair",{code:"REPAIR_NOT_NEEDED"});
  assert.equal(fs.readdirSync(root).length,1);
  assert.equal(JSON.parse(fs.readFileSync(result.logFile)).repair.code,"REPAIR_NOT_NEEDED");
});
test("automatic observation coalesces storms and does not queue retries", async t => {
  const root = fixture(t), transport = new EventEmitter();
  Object.assign(transport,{authenticated:true,responsive:true,snapshot:{connected:true}});
  let reads = 0, resolve;
  const report = createAutomaticAgentReport({transport,directory:root,root,collect:() => {
    reads++; return new Promise(done => {resolve=done;});
  }});
  t.after(() => report.close());
  const pending = report.refresh();
  await Promise.resolve();
  for(let i=0;i<100;i++) {transport.emit("state");transport.emit("message",{type:"extension.heartbeat"});}
  assert.equal(reads,1);
  resolve({tabs:[{tabId:7,composerPresent:false,pageStatus:"UI_CONTRACT_CHANGED"}]});
  await pending;
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"runtime-latest.json"))).server.tabs[0].decision,"INSPECT_SELECTOR_MISMATCH");
  transport.emit("message",{type:"extension.heartbeat"});
  await new Promise(done => setTimeout(done,150));
  assert.equal(reads,1);
  report.close();
  assert.equal(transport.listenerCount("state"),0);
});
test("closing an automatic pending inspection releases its timer and listener", async t => {
  const root=fixture(t), transport=new EventEmitter();
  transport.authenticated=true; transport.send=()=>{};
  const report=createAutomaticAgentReport({transport,directory:root,root});
  const pending=report.refresh(); await Promise.resolve();
  assert.ok(transport.listenerCount("message")>1);
  const before=fs.readFileSync(path.join(root,"runtime-latest.json"),"utf8");
  report.close(); await pending;
  assert.equal(transport.listenerCount("message"),0);
  assert.equal(fs.readFileSync(path.join(root,"runtime-latest.json"),"utf8"),before);
});
test("delivery diagnostic projection excludes bodies and preserves ownership without mutation", async () => {
  const transport=new EventEmitter(); transport.authenticated=true;
  transport.send=m=>queueMicrotask(()=>transport.emit("message",{type:"extension.diagnostics.inspected",requestId:m.requestId,
    payload:{tabs:[],delivery:{currentDeliveryId:"delivery_618fcd37-ec59-4d1b-9151-eb437b6468e2",tabId:7,
      bindingStatus:"AMBIGUOUS",responseObserved:true,responseBody:"PRIVATE_BODY",sharedSecret:"PRIVATE_KEY"}}}));
  const result=await collectSelectorDiagnostics(transport);
  assert.equal(result.delivery.bindingStatus,"AMBIGUOUS");
  assert.equal(result.delivery.responseObserved,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY|PRIVATE_KEY/u);
  cancelSelectorDiagnostics(transport);
});
