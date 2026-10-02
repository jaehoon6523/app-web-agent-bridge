import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { runDiagnosticServer } from "../scripts/diagnose-server.mjs";
import { createBridgeServer } from "../src/server.js";
import { PreparationService } from "../src/orchestration/preparation-service.js";
import { loadConfig } from "../src/config.js";

test("diagnostic supervisor boots the configured server and records completed real HTTP probes without credentials",{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-diagnostic-supervisor-"));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,"127.0.0.1",r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const secret="supervisor-dashboard-token-0123456789";
  const config=loadConfig({env:{PORT:String(port),CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:secret}});
  const events=[];const outputFile=path.join(root,"events.jsonl");
  const child=runDiagnosticServer({runtimeConfig:config,outputFile,onEvent:event=>events.push(event)});
  const closed=new Promise(resolve=>child.once("close",resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;fs.rmSync(root,{recursive:true,force:true})});
  const started=Date.now();
  while(events.filter(e=>e.type==="probe.completed").length<2){
    if(Date.now()-started>7000)throw Error("real probes did not complete");await new Promise(r=>setTimeout(r,20));
  }
  const response=await fetch(config.baseUrl+"/api/state?diagnostic-secret="+secret,{signal:AbortSignal.timeout(1000)});await response.text();
  assert.equal(response.status,401);
  await new Promise(r=>setTimeout(r,50));
  const text=fs.readFileSync(outputFile,"utf8");assert.equal(text.includes(secret),false);
  assert.ok(events.some(e=>e.type==="connection.accepted"));
  const completed=events.find(e=>e.type==="request.completed"&&e.route==="/api/state");
  assert.ok(completed);assert.equal(completed.status,401);assert.ok(completed.elapsedMs>=0);
  assert.ok(events.some(e=>e.type==="request.express"&&e.requestId===completed.requestId));
  assert.ok(events.some(e=>e.type==="request.received"&&e.requestId===completed.requestId));
  assert.equal(events.some(e=>e.type==="runtime.initialization.started"),false);
});

test("a failing diagnostic sink cannot change authentication or HTTP results",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-diagnostic-sink-"));
  const config={...loadConfig({env:{CONTROLLER_DATA_DIR:root}}),port:0};
  const bridge=createBridgeServer({runtimeConfig:config,onDiagnostic:()=>{throw Error("sink failed")}});
  await bridge.listen();
  t.after(async()=>{await bridge.close();fs.rmSync(root,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const preflight=await fetch(base+"/api/preflight",{signal:AbortSignal.timeout(1000)});assert.equal(preflight.status,200);await preflight.text();
  const unauthorized=await fetch(base+"/api/state",{signal:AbortSignal.timeout(1000)});assert.equal(unauthorized.status,401);await unauthorized.text();
});


test("successful preparation initialization keeps native SQLite calls fail-fast",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-preparation-lock-policy-"));
  const service=new PreparationService({filename:path.join(root,"preparation.sqlite"),web:null,available:()=>false,assertStart:async()=>{},approve:async()=>{},findRun:async()=>null});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})});
  assert.equal(service.db.prepare("PRAGMA busy_timeout").get().timeout,0);
});
