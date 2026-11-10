import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import test from "node:test";
import vm from "node:vm";
import {EventEmitter} from "node:events";
import {Element, fixtureMessage} from "./helpers/aud14-dom.js";
const root=process.env.AUD14_SOURCE_ROOT || path.resolve(import.meta.dirname,"..");
const {inspectMessageDom}=await import(pathToFileURL(path.join(root,"extension/runtime/message-dom-inspection.js")));
const {collectMessageDomInspection}=await import(pathToFileURL(path.join(root,"src/orchestration/message-dom-inspection.js")));
const request={tabId:7,conversationUrl:"https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",controllerMessageId:"delivery_22222222-2222-2222-2222-222222222222",runId:"prep_33333333-3333-3333-3333-333333333333"};
const text=`[controller_message_id:${request.controllerMessageId}]\n[run_id:${request.runId}]`;
function observe(...messages) {const doc=new Element().append(...messages.map(m=>m.parent));return JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectMessageDom.toString()})(request)`,{request,location:{href:request.conversationUrl},document:doc})));}
async function project(observed) {const t=new EventEmitter();t.authenticated=true;t.send=m=>t.emit("message",{type:"extension.message-dom.inspected",requestId:m.requestId,payload:{...observed,tabId:7,frameId:0}});return collectMessageDomInspection(t,request);}
function provider(messages) {const doc=new Element().append(...messages.map(m=>m.parent));const groups=Object.fromEntries(["composer","sendButton","stopButton","message","messageContainer","messageContent"].map(k=>[k,k==="message"?["[data-message-author-role]"]:["[data-message-content]"]]));const c={URL,document:doc,ChatGptBridgeSelectors:{version:"test",groups,resolveSendButtonState(){}},ChatGptBridgeResponseText:{elementText:n=>n.textContent}};c.globalThis=c;for(const file of ["extension/selectors/message-selectors.js","extension/runtime/page-provider-registry.js","extension/runtime/providers/chatgpt-page.js"])vm.runInNewContext(fs.readFileSync(path.join(root,file),"utf8"),c);return c.WebBridgePageProviders.provider("CHATGPT_WEB");}
test("R-01 unknown search suffix alone cannot establish FOUND or Provider binding",async()=>{const m=fixtureMessage("user",text,{heading:false,search:true,explicit:false});assert.equal(observe(m).result,"NOT_CONFIRMED");assert.throws(()=>provider([m]).readMessages(),{code:"UI_CONTRACT_CHANGED"});});
test("R-02 explicit role attribute without independent heading is unconfirmed",()=>{assert.equal(observe(fixtureMessage("user",text,{heading:false})).result,"NOT_CONFIRMED");});
test("R-03 another message heading cannot prove marked message",()=>{const a=fixtureMessage("user","unrelated"), b=fixtureMessage("user",text,{heading:false});assert.equal(observe(a,b).result,"NOT_CONFIRMED");});
test("R-04 direct sibling heading preserves FOUND through server projection",async()=>{const m=fixtureMessage("user",text,{explicit:false,search:true});const o=observe(m);assert.equal(o.result,"FOUND");assert.equal((await project(o)).result,"FOUND");assert.equal(provider([m]).readMessages()[0].role,"user");});
test("R-05 normal verified user with both markers remains FOUND; assistant is not user",async()=>{const u=fixtureMessage("user",text),a=fixtureMessage("assistant","answer",{id:"a1"});const o=observe(u,a);assert.equal(o.result,"FOUND");assert.equal((await project(o)).result,"FOUND");assert.deepEqual(Array.from(provider([u,a]).readMessages(),m=>m.role),["user","assistant"]);assert.equal(observe(fixtureMessage("assistant",text)).result,"NOT_CONFIRMED");});
test("R-06 server cannot reconstruct omitted role proof",async()=>{const o=observe(fixtureMessage("user",text));delete o.matches[0].roleProof;assert.equal((await project(o)).result,"NOT_CONFIRMED");});
test("R-07 server rejects legacy untrusted role proof despite claimed FOUND",async()=>{for(const proof of [{attribute:"data-chatgpt-search-unit-key",value:"fallback:user"},{attribute:"data-message-author-role",value:"user"}]){const o=observe(fixtureMessage("user",text));Object.assign(o.matches[0],{role:"user",roleConfirmed:true,roleProof:proof});o.result="FOUND";assert.equal((await project(o)).result,"NOT_CONFIRMED");}});
test("R-08 conflicting user/assistant evidence fails closed",()=>{const m=fixtureMessage("user",text,{search:true});m.node.attrs["data-chatgpt-search-unit-key"]="turn:assistant";assert.equal(observe(m).result,"NOT_CONFIRMED");assert.throws(()=>provider([m]).readMessages(),{code:"UI_CONTRACT_CHANGED"});});
test("duplicate matching messages and split markers cannot establish unique target",async()=>{const a=fixtureMessage("user",text),b=fixtureMessage("user",text,{id:"m2"});const o=observe(a,b);assert.equal(o.result,"NOT_CONFIRMED");assert.equal((await project(o)).result,"NOT_CONFIRMED");const lines=text.split("\n");assert.equal(observe(fixtureMessage("user",lines[0]),fixtureMessage("user",lines[1],{id:"m2"})).result,"NOT_CONFIRMED");});
test("heading inside message content cannot authorize quoted role",()=>{const m=fixtureMessage("user",text);const outer=new Element("DIV",{class:"markdown"}).append(m.parent);m.parent=outer;assert.equal(observe(m).result,"NOT_CONFIRMED");});
test("server rejects malformed heading proof and truncated scope",async()=>{for(const change of [{headingCount:2},{messageBranchCount:2},{relation:"OTHER_MESSAGE"},{label:"ChatGPT said:"}]){const o=observe(fixtureMessage("user",text));Object.assign(o.matches[0].roleProof,change);assert.equal((await project(o)).result,"NOT_CONFIRMED");}const o=observe(fixtureMessage("user",text));o.scope.matchesTruncated=true;assert.equal((await project(o)).result,"NOT_CONFIRMED");});

test("R-03 one heading cannot authorize two independent body siblings",()=>{
  const m=fixtureMessage("user",text);
  m.node.append(new Element("DIV",{"data-message-content":""},"another message"));
  assert.equal(observe(m).result,"NOT_CONFIRMED");
  assert.throws(()=>provider([m]).readMessages(),{code:"UI_CONTRACT_CHANGED"});
});
test("mixed selector families cannot hide duplicate marked messages",async()=>{
  const a=fixtureMessage("user",text), b=fixtureMessage("user",text,{search:true,explicit:false,id:"m2"});
  const result=observe(a,b);
  assert.equal(result.result,"NOT_CONFIRMED");
  assert.equal((await project(result)).result,"NOT_CONFIRMED");
});
test("Provider includes mixed layouts in DOM order and rejects unknown intervening role",()=>{
  const a=fixtureMessage("user",text,{search:true,explicit:false}), b=fixtureMessage("assistant","answer",{id:"a2"});
  assert.deepEqual(Array.from(provider([a,b]).readMessages(),m=>m.role),["user","assistant"]);
  const middle=fixtureMessage("user","intervening",{heading:false,id:"m3"});
  assert.throws(()=>provider([a,middle,b]).readMessages(),{code:"UI_CONTRACT_CHANGED"});
});
test("R-03 server rejects heading proof moved to another message index",async()=>{
  const o=observe(fixtureMessage("user",text));o.matches[0].index++;
  assert.equal((await project(o)).result,"NOT_CONFIRMED");
});
test("Korean accessible heading preserves verified normal FOUND",async()=>{
  const m=fixtureMessage("user",text);m.title.text="내가 한 말:";
  assert.equal((await project(observe(m))).result,"FOUND");
});
test("Provider cannot extract text outside its proven content branch",()=>{
  const m=fixtureMessage("user",text);const outer=new Element("ARTICLE",{"data-testid":"conversation-turn-1"},"unrelated prefix").append(m.parent);
  m.parent=outer;
  assert.equal(provider([m]).readMessages()[0].text,text);
});
test("conflicting outer alias cannot be hidden by inner content deduplication",async()=>{
  const m=fixtureMessage("user",text);
  m.parent=new Element("DIV",{"data-chatgpt-search-unit-key":"outer:assistant","data-chatgpt-search-message-ids":"outer"}).append(m.parent);
  const o=observe(m);
  assert.equal(o.result,"NOT_CONFIRMED");
  assert.equal((await project(o)).result,"NOT_CONFIRMED");
  assert.throws(()=>provider([m]).readMessages(),{code:"UI_CONTRACT_CHANGED"});
});
