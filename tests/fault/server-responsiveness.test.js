import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { watchServerProcess } from "../../scripts/server-watchdog.mjs";

const serverUrl = new URL("../../src/server.js", import.meta.url).href;
const token = "responsiveness-dashboard-token-0123456789";
async function start(t, fault) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-responsive-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0,"127.0.0.1",resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = {
    host:"127.0.0.1",port,baseUrl:`http://127.0.0.1:${port}`,demoMode:false,workspace:root,auditProjectFile:null,
    dashboard:{token},codex:{executablePath:process.execPath},
    persistence:{databasePath:path.join(root,"bridge.sqlite"),artifactDirectory:path.join(root,"artifacts")},
    webExtension:{enabled:true,sharedSecret:"responsiveness-extension-secret-0123456789",expectedExtensionIdentity:"responsive-extension"},
    relay:{webResponseTimeoutMs:500},
  };
  if (fault === "corrupt-preparation") fs.writeFileSync(path.join(root,"preparations.sqlite"),"not a SQLite database");
  let locker;
  if (fault === "sqlite-lock") {
    // This is a real second SQLite connection holding a lock, not a mocked promise.
    locker = new DatabaseSync(path.join(root,"preparations.sqlite"));
    locker.exec("CREATE TABLE preparation_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL) STRICT; BEGIN EXCLUSIVE");
  }
  const child = spawn(process.execPath,["--input-type=module","-e",`
    import {createBridgeServer} from ${JSON.stringify(serverUrl)};
    import {performance} from 'node:perf_hooks';
    const send=e=>{if(process.connected)process.send(e,()=>{})};
    let previous=performance.now();setInterval(()=>{const now=performance.now();send({type:'heartbeat',loopDelayMs:Math.max(0,now-previous-100)});previous=now},100).unref();
    const fault=${JSON.stringify(fault)};
    const bridge=createBridgeServer({runtimeConfig:${JSON.stringify(config)},onDiagnostic:send,
      createLiveRuntime:()=>{
        if(fault==='throw')throw new Error('injected initialization failure');
        if(fault==='reject')return Promise.reject(new Error('injected asynchronous failure'));
        if(fault==='cpu'){const started=performance.now();while(performance.now()-started<2500){};return Promise.reject(new Error('CPU stall completed'));}
        return new Promise(()=>{});
      }});
    await bridge.listen();
  `],{cwd:root,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:["ignore","pipe","pipe","ipc"]});
  const events=[];
  child.on("message",event=>{if(event?.type==="heartbeat")events.push(event);});
  const stop=watchServerProcess(child,event=>events.push(event),{intervalMs:100,staleMs:500});
  let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk});
  const exited=new Promise(resolve=>child.once("exit",resolve));
  t.after(async()=>{
    stop();if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await exited;locker?.close();fs.rmSync(root,{recursive:true,force:true});
  });
  async function wait(type,deadline=8000,predicate=()=>true) {
    const started=Date.now();
    while(!events.some(event=>event.type===type && predicate(event))) {
      if(Date.now()-started>deadline)throw new Error(`Missing ${type}; stderr=${stderr}`);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  await wait("server.listening");
  await wait("heartbeat");
  return {config,events,wait,child};
}
async function read(config,route,{authenticated=false,deadline=1000,session=false}={}) {
  const headers=authenticated?{authorization:`Bearer ${token}`}:{ };
  if(session)Object.assign(headers,{origin:config.baseUrl,"sec-fetch-site":"same-origin"});
  const response=await fetch(config.baseUrl+route,{method:session?"POST":"GET",headers,signal:AbortSignal.timeout(deadline)});
  return {status:response.status,body:await response.json()};
}
for(const fault of ["pending","reject","throw","corrupt-preparation","sqlite-lock"]) {
  test(`responsive contract: runtime ${fault} preserves preflight, health and local session responses`,{timeout:12000},async t=>{
    const {config,events}=await start(t,fault);
    const state=read(config,"/api/state",{authenticated:true,deadline:5000}).then(result=>({result}),error=>({error}));
    const [preflight,health,session,unauthenticated]=await Promise.all([
      read(config,"/api/preflight"),read(config,"/api/health"),read(config,"/api/dashboard/session",{session:true}),read(config,"/api/state"),
    ]);
    assert.equal(preflight.status,200);assert.equal(health.status,200);assert.equal(session.status,200);assert.equal(unauthenticated.status,401);
    assert.equal(typeof session.body.token,"string");
    const outcome=await state;
    assert.equal(outcome.error,undefined,"state must complete inside its HTTP deadline");
    const stateResponse=outcome.result;
    if(["corrupt-preparation","sqlite-lock"].includes(fault)) {
      assert.equal(stateResponse.status,503);
      assert.ok(events.some(event=>event.type==="preparation.initialization.failed"));
      assert.equal(events.some(event=>event.type==="runtime.initialization.started"),false);
      return;
    }
    assert.equal(stateResponse.body.runtimeAvailability.ready,false);
    assert.equal(stateResponse.body.dataKnowledge.runs.status,"UNAVAILABLE");
    assert.ok(events.some(event=>event.type==="runtime.initialization.started"));
    if(fault!=="pending")assert.ok(events.some(event=>event.type==="runtime.initialization.failed"));
    assert.equal(events.some(event=>event.type==="watchdog.unresponsive"&&event.lastStage!=="process.starting"),false);
    assert.equal(JSON.stringify(events).includes(token),false);
    assert.equal(JSON.stringify(events).includes(session.body.token),false);
  });
}
for(const fault of ["cpu"]) {
  test(`incident reproduction: ${fault} stalls independent endpoints and external watchdog records the boundary`,{timeout:15000},async t=>{
    const {config,events,wait}=await start(t,fault);
    // Startup can itself exceed staleMs on Windows. Observe only this incident.
    const incidentStart = events.length;
    const state=read(config,"/api/state",{authenticated:true,deadline:800}).then(()=>false,()=>true);
    await wait(fault==="cpu"?"runtime.initialization.started":"preparation.initialization.started");
    const attempts=await Promise.allSettled([
      read(config,"/api/preflight",{deadline:800}),read(config,"/api/health",{deadline:800}),read(config,"/api/dashboard/session",{deadline:800,session:true}),
    ]);
    assert.ok(attempts.every(item=>item.status==="rejected"),"same-thread stall must be observed by an independent client");
    assert.equal(await state,true);
    await wait("watchdog.resumed",8000,event=>event.loopDelayMs>=faultDuration(fault));
    const incidentEvents=events.slice(incidentStart);
    const warning=incidentEvents.find(event=>event.type==="watchdog.unresponsive" && event.lastStage==="runtime.initialization.started");
    assert.ok(warning, "watchdog must observe the injected runtime stall");
    assert.equal(warning.lastStage,fault==="cpu"?"runtime.initialization.started":"preparation.initialization.started");
    const resumed=incidentEvents.find(event=>event.type==="watchdog.resumed" && event.loopDelayMs>=faultDuration(fault));
    assert.ok(resumed.loopDelayMs>=faultDuration(fault));
    assert.equal((await read(config,"/api/preflight")).status,200);
  });
}
function faultDuration(fault){return fault==="cpu"?2000:4000;}
