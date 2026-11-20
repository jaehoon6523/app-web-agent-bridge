import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createAutomaticAgentReport, summarizeTabs, summarizeDelivery, safeFailure, writeAgentReport } from "../src/diagnostics/agent-report.js";
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from "../src/orchestration/selector-diagnostics.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-agent-report-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}
test("automatic repository observation bypasses fsmonitor hooks while preserving HEAD and dirty evidence", async t => {
  const root = fixture(t), marker = path.join(root, "fsmonitor-invoked");
  const hook = path.join(root, "fsmonitor.mjs");
  fs.writeFileSync(hook, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'invoked'); process.stdout.write('token\\0/');`);
  const git = args => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", root, ...args], {encoding:"utf8",windowsHide:true});
  git(["init", "--quiet"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "before\n");
  git(["add", "tracked.txt"]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  // Git invokes this command through its shell, including Git for Windows.
  const quote = value => '"' + value.replaceAll('\\','/').replaceAll('"','\\"') + '"';
  git(["config", "core.fsmonitor", [process.execPath, hook].map(quote).join(" ")]);
  execFileSync("git", ["--no-optional-locks", "-C", root, "status", "--porcelain", "--untracked-files=normal"], {windowsHide:true});
  assert.equal(fs.readFileSync(marker,"utf8"), "invoked", "the real Git control must invoke the configured hook");
  fs.unlinkSync(marker);
  fs.writeFileSync(path.join(root, "tracked.txt"), "after\n");
  const report = createAutomaticAgentReport({root,directory:path.join(root,"diagnostics")});
  try { await report.ready; } finally { await report.close(); }
  assert.equal(fs.existsSync(marker), false, "read-only diagnostics must not invoke a hook that can start unowned processes");
  const saved = JSON.parse(fs.readFileSync(path.join(root,"diagnostics/runtime-latest.json"),"utf8"));
  assert.deepEqual(saved.server.repository, {commit,dirty:true});
});
test("latest report excludes content, labels and errors; unknown delivery is not missing", async t => {
  const root = fixture(t);
  const secret = "PRIVATE_SECRET_RESPONSE";
  const tabs = summarizeTabs({tabs:[{tabId:7,pageStatus:"READY",composerPresent:true,
    responseBody:secret,diagnostics:{editableCandidates:[{visible:2,matched:2,samples:[{controlLabel:secret}]}]}}]});
  assert.equal(tabs[0].decision, "REPAIR_NOT_NEEDED");
  const error = Object.assign(new Error(secret), {cause:{message:secret,code:"ECONNREFUSED"}});
  await writeAgentReport(root, "server", {tabs,delivery:summarizeDelivery(null)});
  const result = await writeAgentReport(root, "repair", {failure:safeFailure(error,"REPAIR_HTTP_FAILED")});
  const text = fs.readFileSync(result.logFile,"utf8"), value = JSON.parse(text);
  assert.doesNotMatch(text, /PRIVATE_SECRET_RESPONSE/u);
  assert.equal(value.server.delivery.serverExtensionMatch,"UNKNOWN");
  assert.equal(value.server.delivery.currentDeliveryId,null);
  assert.equal(value.server.delivery.recordObserved,false);
  assert.equal(value.repair.failure.causeCode,"ECONNREFUSED");
  await writeAgentReport(root,"repair",{code:"REPAIR_NOT_NEEDED"});
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
  await report.ready;
  const pending=report.refresh(); await Promise.resolve();
  assert.ok(transport.listenerCount("message")>1);
  const before=fs.readFileSync(path.join(root,"runtime-latest.json"),"utf8");
  await report.close(); await pending;
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


test("closing immediately after scheduling a refresh cannot create a late inspection timer or listener",async t=>{
  const root=fixture(t),transport=new EventEmitter();transport.authenticated=true;transport.send=()=>{};
  const report=createAutomaticAgentReport({root,directory:root,transport});
  const pending=report.refresh();
  await report.close();await pending;
  assert.equal(transport.listenerCount('message'),0);
  assert.equal(transport.listenerCount('state'),0);
});

test('an authenticated export cannot reuse an unauthenticated collection still waiting for persistence',async t=>{
  const root=fixture(t),transport=new EventEmitter();
  Object.assign(transport,{authenticated:false,responsive:false,snapshot:{connected:false}});
  let releaseRepository, markRepository, reads=0;
  const repositoryEntered=new Promise(resolve=>{markRepository=resolve;});
  const repositoryGate=new Promise(resolve=>{releaseRepository=resolve;});
  const report=createAutomaticAgentReport({root,directory:root,transport,
    observeRepository:async()=>{markRepository();await repositoryGate;return {commit:null,dirty:null};},
    collect:async()=>{
      reads++;
      if(!transport.authenticated)throw Object.assign(new Error('Not authenticated.'),{code:'EXTENSION_NOT_AUTHENTICATED'});
      return {inspectedAt:new Date().toISOString(),tabs:[{tabId:7,pageStatus:'READY',composerPresent:true}]};
    }});
  t.after(async()=>{releaseRepository();await report.close();});
  await repositoryEntered;
  const beforeAuthentication=report.refresh('SERVER_CREATED');
  await Promise.resolve();
  assert.equal(reads,1);
  Object.assign(transport,{authenticated:true,responsive:true,snapshot:{connected:true}});
  transport.emit('state');
  const exports=Array.from({length:3},()=>report.refresh('EXPORT'));
  releaseRepository();
  const [, ...snapshots]=await Promise.all([beforeAuthentication,...exports]);
  assert.equal(reads,2,'all current exports must share one new authenticated collection');
  assert.ok(snapshots.every(snapshot=>snapshot?.tabs[0].tabId===7));
  const result=await report.export();
  assert.equal(result.server.collection.status,'OBSERVED');
  assert.equal(result.server.tabs[0].decision,'REPAIR_NOT_NEEDED');
});

test('a connection change during collection remains unavailable instead of certifying an old snapshot',async t=>{
  const root=fixture(t),transport=new EventEmitter();
  Object.assign(transport,{authenticated:true,responsive:true,snapshot:{connected:true}});
  let releaseCollection;
  const collected=new Promise(resolve=>{releaseCollection=resolve;});
  const report=createAutomaticAgentReport({root,directory:root,transport,
    observeRepository:async()=>({commit:null,dirty:null}),collect:()=>collected});
  t.after(()=>report.close());
  const refreshed=report.refresh('EXPORT');
  await Promise.resolve();
  Object.assign(transport,{authenticated:false,responsive:false,snapshot:{connected:false}});
  transport.emit('state');
  releaseCollection({inspectedAt:new Date().toISOString(),tabs:[{tabId:7,pageStatus:'READY',composerPresent:true}]});
  assert.equal(await refreshed,null);
  const result=await report.export();
  assert.equal(result.server.tabs,null);
  assert.equal(result.server.collection.code,'DIAGNOSTIC_CONNECTION_CHANGED');
});
