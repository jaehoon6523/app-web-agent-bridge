import assert from "node:assert/strict";
import {evidenceTestFile,evidenceFetch} from "../helpers/failure-evidence.mjs";
const test = evidenceTestFile(import.meta.url);
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { watchServerProcess } from "../../scripts/server-watchdog.mjs";
import { removeOwnedFixture } from "../../scripts/e2e/helpers/owned-fixture.mjs";

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
    let previous=performance.now();setInterval(()=>{const now=performance.now();send({type:'heartbeat',at:new Date().toISOString(),monotonicMs:performance.timeOrigin+now,loopDelayMs:Math.max(0,now-previous-100)});previous=now},100).unref();
    const fault=${JSON.stringify(fault)};
    if(fault==='diagnostic-write') {
      const {default:io}=await import('node:fs/promises');const open=io.open.bind(io);
      io.open=async(filename,...args)=>{
        const handle=await open(filename,...args);
        if(String(filename).endsWith('.tmp'))handle.sync=async()=>{
          send({type:'test.diagnostic-held'});await new Promise(()=>{});
        };
        return handle;
      };
    }
    const bridge=createBridgeServer({runtimeConfig:${JSON.stringify(config)},onDiagnostic:send,
      createLiveRuntime:()=>{
        if(fault==='diagnostic-write')return Promise.resolve({store:{listRuns:()=>[]},composition:{},codeChanges:{list:()=>[]},close:async()=>{}});
        if(fault==='throw')throw new Error('injected initialization failure');
        if(fault==='reject')return Promise.reject(new Error('injected asynchronous failure'));
        if(fault==='cpu'){const started=performance.now();while(performance.now()-started<2500){};return Promise.reject(new Error('CPU stall completed'));}
        return new Promise(()=>{});
      }});
    await bridge.listen();
  `],{cwd:root,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:["ignore","pipe","pipe","ipc"]});
  const events=[];
  const observe=event=>{events.push({...event,observedAt:new Date().toISOString()});t.evidence.event(event);};
  child.on("message",event=>{if(event?.type==="heartbeat")observe(event);});
  const stop=watchServerProcess(child,observe,{intervalMs:100,staleMs:500});
  let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk});
  const exited=new Promise(resolve=>child.once("close",resolve));
  t.after(async()=>{
    t.diagnostic(JSON.stringify({fault,watchdog:events.filter(event=>/^(?:watchdog\.|event-loop\.delay)/u.test(event.type))
      .map(({type,observedAt,silenceMs,loopDelayMs,lastStage,route})=>({type,observedAt,silenceMs,loopDelayMs,lastStage,route})),
      lastStages:events.filter(event=>/^(?:preparation|runtime)\.initialization\.|^state\./u.test(event.type))
        .slice(-16).map(({type,observedAt,elapsedMs,code})=>({type,observedAt,elapsedMs,code}))}));
    stop();if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await exited;locker?.close();t.evidence.preserve(root);
    fs.writeFileSync(path.join(t.evidence.directory,"server-stderr.log"),stderr);
    await removeOwnedFixture(root);
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
  config.evidence=t.evidence;
  return {config,events,wait,child};
}
async function read(config,route,{authenticated=false,deadline=1000,session=false}={}) {
  const headers=authenticated?{authorization:`Bearer ${token}`}:{ };
  if(session)Object.assign(headers,{origin:config.baseUrl,"sec-fetch-site":"same-origin"});
  const response=await evidenceFetch(config.evidence,config.baseUrl+route,{method:session?"POST":"GET",headers,signal:AbortSignal.timeout(deadline)});
  return {status:response.status,body:await response.json()};
}
test('responsive contract: held diagnostic fsync cannot delay a successful state response',{timeout:10000},async t=>{
  const {config,wait}=await start(t,'diagnostic-write');
  await wait('test.diagnostic-held');
  const response=await read(config,'/api/state',{authenticated:true,deadline:1000});
  assert.equal(response.status,200);
  assert.equal(response.body.runtimeAvailability.ready,true);
  const repeated=await Promise.all(Array.from({length:8},()=>read(config,'/api/state',{authenticated:true,deadline:1000})));
  assert.ok(repeated.every(result=>result.status===200 && result.body.runtimeAvailability.ready===true));
  for(const route of ['/api/preflight','/api/health'])assert.equal((await read(config,route)).status,200);
});
for(const fault of ["pending","reject","throw","corrupt-preparation","sqlite-lock"]) {
  test(`responsive contract: runtime ${fault} preserves preflight, health and local session responses`,{timeout:12000},async t=>{
    const {config,events,wait}=await start(t,fault);
    const incidentStart = events.length;
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
    // Independent endpoint deadlines establish the response contract above. A
    // missing heartbeat alone cannot distinguish an event-loop stall from an
    // IPC pause; the dedicated CPU incident test checks watchdog detection.
    await wait('heartbeat',2000,event => events.indexOf(event) >= incidentStart);
    const heartbeats = events.slice(incidentStart).filter(event => event.type === 'heartbeat');
    assert.ok(heartbeats.length > 0, 'responsiveness needs an actual event-loop observation');
    assert.ok(heartbeats.every(event => event.loopDelayMs < 1000),
      'a measured event-loop delay must remain inside the independent endpoint budget');
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
    await wait("watchdog.resumed",8000,event=>event.loopDelayMs>=faultDuration(fault)
      &&runtimeStallEpisode(events.slice(incidentStart),faultDuration(fault))?.resumed===event);
    const incidentEvents=events.slice(incidentStart);
    const episode=runtimeStallEpisode(incidentEvents,faultDuration(fault));
    const warning=episode?.warning;
    assert.ok(warning, "watchdog must observe the injected runtime stall");
    assert.equal(episode.runtimeStart.type,"runtime.initialization.started");
    assert.ok(episode.runtimeEnd.elapsedMs>=faultDuration(fault),"the injected runtime interval must actually be observed");
    const resumed=episode?.resumed;
    assert.ok(resumed.loopDelayMs>=faultDuration(fault));
    assert.equal((await read(config,"/api/preflight")).status,200);
  });
}
function faultDuration(fault){return fault==="cpu"?2000:4000;}

function runtimeStallEpisode(events,duration) {
  const start=events.findIndex(event=>event.type==='runtime.initialization.started');
  const end=events.findIndex((event,index)=>index>start&&event.type==='state.snapshot.runtime.failed'&&event.elapsedMs>=duration);
  if(start<0||end<0)return null;
  for(let index=end+1;index<events.length;index++) {
    const resumed=events[index];
    if(resumed.type!=='watchdog.resumed'||resumed.loopDelayMs<duration)continue;
    const warning=events.findLastIndex((event,position)=>position<index&&event.type==='watchdog.unresponsive');
    if(warning<0||warning>=end||events.slice(warning+1,end+1).some(event=>event.type==='heartbeat'))continue;
    return {warning:events[warning],resumed,runtimeStart:events[start],runtimeEnd:events[end]};
  }
  return null;
}

test('watchdog attribution includes a runtime stall within one continuous preparation and runtime episode',()=>{
  const warning={type:'watchdog.unresponsive',lastStage:'preparation.initialization.started'};
  const resumed={type:'watchdog.resumed',loopDelayMs:3700};
  const events=[{type:'heartbeat'},{type:'preparation.initialization.started'},warning,
    {type:'preparation.initialization.completed',elapsedMs:1200},{type:'runtime.initialization.started'},
    {type:'runtime.initialization.failed'},{type:'state.snapshot.runtime.failed',elapsedMs:2500},
    {type:'heartbeat',loopDelayMs:3700},resumed];
  const episode=runtimeStallEpisode(events,2000);
  assert.ok(episode,'a continuous unresponsive episode must retain the actual runtime interval');
  assert.equal(episode.warning,warning);assert.equal(episode.resumed,resumed);
});

test('watchdog attribution rejects a stage label without an observed runtime stall interval',()=>{
  const events=[{type:'watchdog.unresponsive',lastStage:'runtime.initialization.started'},
    {type:'heartbeat',loopDelayMs:3000},{type:'watchdog.resumed',loopDelayMs:3000}];
  assert.equal(runtimeStallEpisode(events,2000),null,'a label and unrelated delay cannot prove runtime execution');
});
