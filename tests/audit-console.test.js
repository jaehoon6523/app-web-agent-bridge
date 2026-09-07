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
async function harness() {
  const elements=new Map(),timers=[],requests=[];let getState=async()=>state();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();}};
  const fetch=async(url,options)=>{
    requests.push({url,options});
    if(url.includes("/session"))return{ok:true,json:async()=>({token:"fixture-token"})};
    if(url.includes("/commands"))return{ok:true,json:async()=>({payload:{runId:JSON.parse(options.body).payload.runId}})};
    const body=await getState(url);return{ok:true,json:async()=>body};
  };
  vm.runInNewContext(fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8"),{document,fetch,crypto:{randomUUID:()=>"request-1"},Date,Map,Set,JSON,Blob,URL,setTimeout:(fn)=>{timers.push(fn);},console});
  const settle=()=>new Promise((r)=>setImmediate(r));await settle();
  return {elements,requests,timers,settle,setState(fn){getState=fn;},get(id){return document.getElementById(id);}};
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
