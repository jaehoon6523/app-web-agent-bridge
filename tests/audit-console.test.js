import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// This exercises the shipped UI script with a DOM/network double, not a browser.
class Element {
  constructor(){this.children=[];this.events={};this.value="";this.disabled=false;this.hidden=false;this.open=false;this.own="";}
  set textContent(value){this.own=String(value);this.children=[];}
  get textContent(){return this.own+this.children.map((c)=>c.textContent).join("");}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.own="";this.children=nodes;}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(key,value){this[key]=value;}
  showModal(){this.open=true;} close(){this.open=false;} click(){this.events.click?.();}
}
function state(id="a", phase="HOLD") {
  const at="2026-09-07T01:02:03.000Z";
  return { run:{runId:id,version:3,phase,objective:`Objective ${id}`,iteration:1,createdAt:at,updatedAt:at,requirements:{items:[]},findings:[],candidate:{candidateId:`candidate-${id}`}},
    runs:[{runId:"a",phase:"HOLD",objective:"Objective a"},{runId:"b",phase:"HOLD",objective:"Objective b"}],
    preflight:{checks:{},readyForProvisioning:false,missing:["auditProjectConfigured"]},commandCapabilities:["run.stop","evidence.export","evidence.get"],
    messages:[],events:[{type:"STAGE_CHANGED",createdAt:at,payload:{stage:phase}}],assessments:[],findings:[],evidence:[] };
}
async function harness(options={}) {
  const elements=new Map(),timers=[],requests=[];let getState=async()=>state();
  const document={events:{},addEventListener(type,fn){this.events[type]=fn;},getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();}};
  const fetch=async(url,options)=>{
    requests.push({url,options});
    if (override) { const response=await override(url,options); if(response) return response; }
    if(url.includes("/session"))return{ok:true,json:async()=>({token:"fixture-token"})};
    if(url.includes("/commands"))return{ok:true,json:async()=>({payload:{runId:JSON.parse(options.body).payload.runId}})};
    const body=await getState(url);return{ok:true,json:async()=>body};
  };
  let override=options.response, requestNumber=0;
  const context=vm.createContext({document,fetch,crypto:{randomUUID:()=>`request-${++requestNumber}`},Date,Map,Set,JSON,Blob,URL,AbortSignal:options.AbortSignal ?? AbortSignal,setTimeout:(fn)=>{timers.push(fn);},console});
  vm.runInContext(fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8"),context);
  const settle=()=>new Promise((r)=>setImmediate(r));await settle();
  return {elements,requests,timers,settle,document,eval(code){return vm.runInContext(code,context);},respond(fn){override=fn;},setState(fn){getState=fn;},get(id){return document.getElementById(id);}};
}
test("VAL-17: a late snapshot for a previous run cannot replace the selected run or command target",async()=>{
  const h=await harness();let releaseA;
  h.setState(async(url)=>url.includes("runId=a")?new Promise((r)=>{releaseA=r;}):state("b"));
  // Display order is newest first: b, a.
  const buttons=[...h.get("runList").children];buttons[1].click();buttons[0].click();await h.settle();
  assert.equal(h.get("runObjective").textContent,"Objective b");
  releaseA(state("a"));await h.settle();assert.equal(h.get("runObjective").textContent,"Objective b");
  h.get("stopRun").click();await h.settle();
  const posted=JSON.parse(h.requests.find((r)=>r.url==="/api/commands").options.body);
  assert.equal(posted.payload.runId,"b");assert.equal(posted.payload.expectedVersion,3);
});
test("VAL-18: rerenders preserve actual event times and disconnected UI retains last known state with commands disabled",async()=>{
  const h=await harness();h.get("runList").children[1].click();await h.settle();
  const log=h.get("eventLog").textContent;h.get("objective").events.input();assert.equal(h.get("eventLog").textContent,log);
  h.setState(async()=>{throw new Error("offline");});h.timers.shift()();await h.settle();
  assert.equal(h.get("runStatus").textContent,"판단 보류");assert.equal(h.get("stopRun").disabled,true);
  assert.match(h.get("connectionNotice").textContent,/마지막 확인/);assert.equal(h.get("eventLog").textContent,log);
});
test("recovery UI requires confirmation and sends the selected run and operator reason",async()=>{
  const h=await harness();h.setState(async()=>({...state("a","RECOVERY_REQUIRED"),commandCapabilities:["run.abandon"]}));
  h.get("runList").children[1].click();await h.settle();
  assert.equal(h.get("abandonRun").disabled,true);
  h.get("recoveryExternal").checked=true;h.get("recoveryTarget").checked=true;h.get("recoveryReason").value="Stopped CLI and web; inspected target";
  h.get("recoveryReason").events.input();assert.equal(h.get("abandonRun").disabled,false);
  h.get("abandonRun").click();await h.settle();
  const posted=JSON.parse(h.requests.find(r=>r.url==="/api/commands").options.body);
  assert.equal(posted.type,"run.abandon");assert.equal(posted.payload.runId,"a");assert.equal(posted.payload.expectedVersion,3);
  assert.equal(posted.payload.externalTerminationConfirmed,true);assert.equal(posted.payload.targetInspected,true);assert.match(posted.payload.reason,/Stopped CLI/);
});

test("unfinished shortcut opens the blocking run from a cancelled history record before stopping", async () => {
  const h = await harness();
  h.setState(async (url) => {
    const active = url.includes("runId=b");
    return { ...state(active ? "b" : "a", active ? "CREATED" : "CANCELLED"),
      runs: [{ runId: "a", phase: "CANCELLED", objective: "Old task" },
        { runId: "b", phase: "CREATED", objective: "Blocking task" }],
      commandCapabilities: active ? ["run.stop"] : [],
    };
  });
  h.get("runList").children[1].click(); await h.settle();
  assert.equal(h.get("stopRun").disabled, true);
  assert.equal(h.get("newRun").disabled, true);
  assert.match(h.get("newRunReason").textContent, /Blocking task/u);
  assert.equal(h.get("showUnfinishedRun").hidden, false);
  h.get("showUnfinishedRun").click(); await h.settle();
  assert.equal(h.get("runObjective").textContent, "Objective b");
  assert.equal(h.get("stopRun").disabled, false);
  h.get("stopRun").click(); await h.settle();
  const posted = JSON.parse(h.requests.find((r) => r.url === "/api/commands").options.body);
  assert.equal(posted.type, "run.stop");
  assert.equal(posted.payload.runId, "b");
  assert.equal(posted.payload.expectedVersion, 3);
  h.setState(async () => ({ ...state("b", "CANCELLED"),
    runs: [{ runId: "b", phase: "CANCELLED", objective: "Blocking task" }], commandCapabilities: [],
  }));
  h.timers.shift()(); await h.settle();
  assert.equal(h.get("newRun").disabled, false);
  assert.equal(h.get("showUnfinishedRun").hidden, true);
});

const response = (body, status=200) => ({ok:status>=200 && status<300,status,json:async()=>body});
const brokenJson = (status=500) => ({ok:status===200,status,json:async()=>{throw new SyntaxError("bad json");}});
const qa = (id, name, fn) => test(`QA-${id}: ${name}`,fn);
async function display(h, value=state()) {
  h.setState(async()=>value); h.get("runList").children[1].click(); await h.settle();
}
async function update(h, value) { h.setState(async()=>value); await h.eval("refresh()"); }

qa(101,"401 with non-JSON body still clears authentication",async()=>{
  const h=await harness();h.respond(url=>url.includes("/state")?brokenJson(401):null);
  await h.eval("refresh()");assert.equal(h.eval("token"),"");assert.equal(h.eval("connected"),false);
});
qa(102,"HTML server failure includes HTTP status",async()=>{
  const h=await harness();h.respond(()=>brokenJson(502));await h.eval("refresh()");
  assert.match(h.get("connectionNotice").textContent,/502/);
});
for(const [id,name,value]of [[103,"null state",null],[104,"missing run list",{...state(),runs:undefined}],
  [105,"missing capabilities",{...state(),commandCapabilities:undefined}],[106,"missing preflight",{...state(),preflight:null}]]) {
  qa(id,`${name} cannot turn API green`,async()=>{const h=await harness();await update(h,value);assert.equal(h.eval("connected"),false);});
}
for(const [id,name,value]of [[107,"missing",{}],[108,"empty",{token:""}],[109,"whitespace",{token:"  "}],
  [110,"numeric",{token:42}],[111,"null response",null]]) {
  qa(id,`${name} session token is rejected`,async()=>{
    const h=await harness({response:url=>url.includes("/session")?response(value):null});
    assert.equal(h.eval("connected"),false);assert.equal(h.requests.some(r=>r.url.includes("/state")),false);
  });
}
for(const [id,key,value,el]of [[112,"extensionAuthenticated","false","channelHealth"],[113,"extensionAuthenticated",1,"channelHealth"],
  [114,"codexExecutableConfigured","true","engineHealth"],[115,"codexExecutableConfigured",0,"engineHealth"]]) {
  qa(id,`${key} rejects non-boolean ${JSON.stringify(value)}`,async()=>{
    const h=await harness();await update(h,{...state(),preflight:{...state().preflight,checks:{[key]:value}}});
    assert.equal(h.get(el).className,"health unknown");
  });
}
for(const [id,url,ms]of [[116,"/api/state",10000],[117,"/api/dashboard/session",10000],[118,"/api/commands",30000],[119,"/api/project",30000]]) {
  qa(id,`${url} has bounded waiting`,async()=>{
    const deadlines=[];const h=await harness({AbortSignal:{timeout(ms){deadlines.push(ms);return AbortSignal.timeout(ms);}}});
    h.respond(()=>response({}));
    await h.eval(`request(${JSON.stringify(url)})`);assert.equal(deadlines.at(-1),ms);
  });
}
qa(120,"abort becomes an actionable timeout message",async()=>{
  const h=await harness();h.respond(()=>{throw Object.assign(new Error("aborted"),{name:"AbortError"});});
  await h.eval("refresh()");assert.match(h.get("connectionNotice").textContent,/시간이 초과/);
});
qa(121,"malformed successful JSON is not considered a successful state",async()=>{
  const h=await harness();h.respond(()=>brokenJson(200));await h.eval("refresh()");assert.equal(h.eval("connected"),false);
});
qa(122,"null error body preserves HTTP failure",async()=>{
  const h=await harness();h.respond(()=>response(null,503));await h.eval("refresh()");assert.match(h.get("connectionNotice").textContent,/503/);
});
qa(123,"structured command rejection explains its reason",async()=>{
  const h=await harness();h.respond(()=>response({payload:{message:"version conflict"}},409));
  await assert.rejects(h.eval('request("/api/commands")'),/version conflict/);
});
qa(124,"authentication stays in the header, not the URL",async()=>{
  const h=await harness();const r=h.requests.find(r=>r.url.includes("/state"));
  assert.equal(r.options.headers.Authorization,"Bearer fixture-token");assert.equal(r.url.includes("fixture-token"),false);
});
qa(125,"state fetch bypasses browser cache",async()=>{
  const h=await harness();assert.equal(h.requests.find(r=>r.url.includes("/state")).options.cache,"no-store");
});
qa(126,"removed events disappear without changing run version",async()=>{
  const h=await harness();await display(h);assert.match(h.get("eventLog").textContent,/STAGE_CHANGED/);
  await update(h,{...state(),events:[]});assert.doesNotMatch(h.get("eventLog").textContent,/STAGE_CHANGED/);
});
qa(127,"edited message content updates without changing run version",async()=>{
  const h=await harness();const s={...state(),messages:[{content:"before",createdAt:"2026-09-09"}]};await display(h,s);
  await update(h,{...s,messages:[{content:"after",createdAt:"2026-09-09"}]});assert.match(h.get("eventLog").textContent,/after/);assert.doesNotMatch(h.get("eventLog").textContent,/before/);
});
qa(128,"assessment edits update without changing run version",async()=>{
  const h=await harness();const s=state();s.run.requirements.items=[{requirementId:"R",statement:"requirement",acceptanceCriteria:"criterion"}];
  await display(h,s);await update(h,{...s,assessments:[{requirementId:"R",reason:"new assessment",verdict:"PASS"}]});assert.match(h.get("assessments").textContent,/new assessment/);
});
qa(129,"evidence result edits update without changing run version",async()=>{
  const h=await harness();const s={...state(),evidence:[{evidenceId:"e",kind:"PATCH",result:{text:"before"}}]};await display(h,s);
  await update(h,{...s,evidence:[{evidenceId:"e",kind:"PATCH",result:{text:"after"}}]});assert.match(h.get("evidenceList").textContent,/after/);
});
qa(130,"finding history updates without changing run version",async()=>{
  const h=await harness();const f={findingId:"f",status:"OPEN",problem:"issue",history:[]};const s={...state(),findings:[f]};await display(h,s);
  await update(h,{...s,findings:[{...f,history:[{reason:"new history"}]}]});assert.match(h.get("findings").textContent,/new history/);
});
qa(131,"candidate metadata updates without changing run version",async()=>{
  const h=await harness();await display(h);const s=state();s.run.candidate={candidateId:"new-candidate"};await update(h,s);assert.match(h.get("candidateDetails").textContent,/new-candidate/);
});
qa(132,"unrecognized run phases are not green",async()=>{const h=await harness();assert.equal(h.eval('runAppearance("FUTURE_PHASE")'),"unknown");});
qa(133,"legacy complete is static green",async()=>{const h=await harness();assert.equal(h.eval('runAppearance("COMPLETE")'),"ok");});
qa(134,"offline active run stops advertising live activity",async()=>{const h=await harness();assert.equal(h.eval('connected=false;runAppearance("WORKER_RUNNING")'),"unknown");});
qa(135,"read failures preserve last confirmed snapshot",async()=>{
  const h=await harness();const before=h.eval("JSON.stringify(snapshot)");h.respond(()=>response({},500));await h.eval("refresh()");assert.equal(h.eval("JSON.stringify(snapshot)"),before);
});
qa(136,"objective HTML is inserted as text",async()=>{
  const h=await harness();const s=state();s.run.objective='<img src=x onerror="alert(1)">';await display(h,s);assert.equal(h.get("runObjective").textContent,s.run.objective);assert.equal(h.get("runObjective").children.length,0);
});
qa(137,"message HTML is inserted as text",async()=>{
  const h=await harness();await display(h,{...state(),messages:[{content:"<script>alert(1)</script>"}]});
  assert.ok(h.get("eventLog").children.some(row=>row.children.some(c=>c.textContent==="<script>alert(1)</script>" && c.children.length===0)));
});
qa(138,"server error HTML is inserted as text",async()=>{
  const h=await harness();h.respond(()=>response({error:"<img src=x>"},500));await h.eval("refresh()");assert.match(h.get("connectionNotice").textContent,/<img src=x>/);assert.equal(h.get("connectionNotice").children.length,0);
});
qa(139,"each explicit command gets a fresh request ID",async()=>{
  const h=await harness();await display(h);await h.eval('command("run.stop")');await h.eval('command("run.stop")');
  const ids=h.requests.filter(r=>r.url.includes("/commands")).map(r=>JSON.parse(r.options.body).requestId);assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
});
qa(140,"objective and conversation URL are trimmed before submission",async()=>{
  const h=await harness();h.get("objective").value="  goal  ";h.get("conversationUrl").value=" https://chatgpt.com/c/test ";h.get("startRun").disabled=false;
  h.get("startForm").events.submit({preventDefault(){}});await h.settle();const p=JSON.parse(h.requests.find(r=>r.url.includes("/commands")).options.body).payload;
  assert.equal(p.objective,"goal");assert.equal(p.conversationUrl,"https://chatgpt.com/c/test");
});
qa(141,"selected run ID is URL encoded",async()=>{
  const h=await harness();await h.eval('selected="a&b?c";refresh()');assert.ok(h.requests.some(r=>r.url==="/api/state?runId=a%26b%3Fc"));
});
qa(142,"pending command blocks a second submission",async()=>{
  const h=await harness();await display(h);let release;h.respond(url=>url.includes("/commands")?new Promise(r=>{release=r;}):null);
  const first=h.eval('command("run.stop")');await h.settle();await h.eval('command("run.stop")');assert.equal(h.requests.filter(r=>r.url.includes("/commands")).length,1);
  release(response({payload:{runId:"a"}}));await first;
});
qa(143,"command timeout does not automatically resend",async()=>{
  const h=await harness();await display(h);h.respond(url=>{if(url.includes("/commands"))throw Object.assign(new Error("timeout"),{name:"TimeoutError"});});
  await h.eval('command("run.stop")');assert.equal(h.requests.filter(r=>r.url.includes("/commands")).length,1);assert.equal(h.eval("pending"),false);assert.match(h.get("commandResult").textContent,/시간이 초과/);
});
qa(144,"new findings retain separate evidence buttons",async()=>{
  const h=await harness();await display(h,{...state(),findings:[{findingId:"f",history:[],evidenceRefs:["e1","e2"]}]});
  const links=h.get("findings").children[0].children.find(c=>c.className==="links");assert.equal(links.children.length,2);
});
qa(145,"a failed state poll can recover on the next scheduled poll",async()=>{
  const h=await harness();h.respond(()=>{throw Object.assign(new Error("timeout"),{name:"TimeoutError"});});h.timers.shift()();await h.settle();assert.equal(h.eval("connected"),false);
  h.respond(null);h.timers.shift()();await h.settle();assert.equal(h.eval("connected"),true);
});

test("regression: start guidance clears stale errors and lists all missing prerequisites once",async()=>{
  const h=await harness();h.eval('lastCommandError="old error"');h.get("objective").events.input();assert.doesNotMatch(h.get("startReason").textContent,/old error/);
  h.eval('lastCommandError="old URL error"');h.get("conversationUrl").events.input();assert.doesNotMatch(h.get("startReason").textContent,/old URL error/);
  h.eval('lastCommandError="old readiness error"');const s=state();s.preflight.missing=["auditProjectConfigured","extensionAuthenticated"];s.preflight.projectError="Configure project now";await update(h,s);
  assert.doesNotMatch(h.get("startReason").textContent,/old readiness error/);assert.match(h.get("startReason").textContent,/브라우저 확장 연결/);
  assert.match(h.get("startReason").textContent,/프로젝트 설정/);assert.match(h.get("startReason").textContent,/Configure project now/);assert.doesNotMatch(h.get("projectSummary").textContent,/Configure project now/);
});
