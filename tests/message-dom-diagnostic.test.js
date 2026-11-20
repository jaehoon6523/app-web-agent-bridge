import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Console } from "node:console";
import { Writable, Duplex } from "node:stream";
import vm from "node:vm";
import {fixtureMessage} from "./helpers/aud14-dom.js";
import { randomUUID } from "node:crypto";
import { replyToMessageDomInspection } from "../extension/runtime/message-dom-inspection.js";
import { handleMessageDomInspection } from "../src/orchestration/message-dom-inspection.js";

const q = { tabId:7, conversationUrl:"https://chatgpt.com/c/" + randomUUID(),
  controllerMessageId:"delivery_" + randomUUID(), runId:"prep_" + randomUUID() };
const secret = "PRIVATE_MESSAGE_TOKEN_STACK";
function output(t) {
  let bytes = "";
  const sink = new Console(new Writable({ write(chunk, enc, cb) { bytes += chunk.toString(); cb(); } }));
  t.mock.method(console, "warn", sink.warn.bind(sink));
  return () => {
    for (const value of [secret, q.conversationUrl, q.controllerMessageId, q.runId, "Authorization", "Bearer"])
      assert.ok(!bytes.includes(value), "sensitive output");
    return bytes.trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
  };
}
function chrome(mode, calls) {
  let reads = 0;
  return { tabs:{ async get(id) {
    calls.push(++reads === 1 ? "tab_query" : "tab_requery");
    if ((reads === 1 && mode === "tab_query") || (reads === 2 && ["tab_requery","double"].includes(mode))) throw Error(secret);
    return { url:mode === "tab_url" || (mode === "changed_after" && reads === 2) ? "https://chatgpt.com/" : q.conversationUrl, windowId:9 };
  } }, scripting:{ async executeScript(input) {
    calls.push("injection");
    if (mode === "injection") throw Error(secret);
    const verified = fixtureMessage("user", "[controller_message_id:"+q.controllerMessageId+"]\n[run_id:"+q.runId+"]");
    const ctx = {location:{href:mode === "page_url" ? "https://chatgpt.com/" : q.conversationUrl}, console,
      args:input.args, document:{ querySelectorAll() {
        if (["content_dom","double","page_reject"].includes(mode)) throw Error(secret);
        if (mode === "found") return [verified.node];
        if (mode === "content_read") {
          const node={getAttribute:n=>n==="data-message-author-role"?"user":null,querySelector:()=>null,closest:()=>null,
            tagName:"DIV",get innerText(){if (mode==="content_read") throw Error(secret);
              return "[controller_message_id:"+q.controllerMessageId+"]\n[run_id:"+q.runId+"]";}};
          return [node];
        }
        return [];
      } }};
    if (mode === "returned_error") return [{frameId:0,result:{errorCode:"MESSAGE_DOM_INSPECTION_FAILED"}}];
    try { return [{frameId:0, result:vm.runInNewContext("(" + input.func.toString() + ")(...args)",ctx)}]; }
    catch (e) {
      if (mode === "page_reject") throw e;
      // Model Chrome resolving without a usable result separately from rejection.
      return [{frameId:0}];
    }
  } }};
}
const cases = [
  ["found","FOUND",3,[]], ["empty","NOT_CONFIRMED",3,[]],
  ["content_read","TAB_CHANGED",3,["content_dom","tab_requery"]], ["returned_error","TAB_CHANGED",3,["tab_requery"]], ["tab_query","MESSAGE_DOM_INSPECTION_FAILED",1,["tab_query"]],
  ["tab_url","TAB_CHANGED",1,["tab_url"]], ["injection","MESSAGE_DOM_INSPECTION_FAILED",2,["injection"]],
  ["page_url","TAB_CHANGED",3,["page_url","page_url"]], ["content_dom","TAB_CHANGED",3,["content_dom","tab_requery"]],
  ["page_reject","MESSAGE_DOM_INSPECTION_FAILED",2,["content_dom","injection"]],
  ["tab_requery","MESSAGE_DOM_INSPECTION_FAILED",3,["tab_requery"]],
  ["double","MESSAGE_DOM_INSPECTION_FAILED",3,["content_dom","tab_requery"]],
  ["changed_after","TAB_CHANGED",3,["tab_requery"]]
];
for (const [mode, expected, n, stages] of cases) test("inspection order and final reply: " + mode, async t => {
  const logs=output(t), calls=[], replies=[], id=randomUUID();
  await replyToMessageDomInspection(chrome(mode,calls), m=>replies.push(m), {payload:q,requestId:id});
  assert.deepEqual(calls,["tab_query","injection","tab_requery"].slice(0,n));
  assert.equal(replies.length,1);
  assert.equal(replies[0].payload.errorCode ?? replies[0].payload.result,expected);
  const rows=logs();
  assert.deepEqual(rows.map(r=>r.stage),stages);
  if (mode==="content_read") assert.equal(rows[0].cause,"DOM_READ_EXCEPTION");
  if (mode==="content_dom" || mode==="double") assert.equal(rows[0].cause,"SELECTOR_QUERY_EXCEPTION");
  for(const row of rows) { assert.equal(row.requestId,id); assert.equal(row.tabId,7); assert.ok(Date.parse(row.at)); }
});

function fixture(tpt) {
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,"http://localhost");
    if(u.pathname!=="/api/message-dom-inspection") throw Error("wrong route");
    req.query=Object.fromEntries(u.searchParams); res.set=res.setHeader.bind(res);
    res.status=n=>{res.statusCode=n;return res;}; res.json=value=>res.end(JSON.stringify(value));
    return handleMessageDomInspection(tpt,req,res);
  });
  return server;
}
test("wire HTTP status, cache/header and correlated captured output for overlapping requests", async t=>{
  const logs=output(t), sent=[], tpt=Object.assign(new EventEmitter(),{authenticated:true});
  tpt.send=m=>{
    sent.push(m);
    const mode=({7:"double",8:"injection",9:"empty"})[m.payload.tabId];
    setImmediate(()=>replyToMessageDomInspection(chrome(mode,[]), r=>tpt.emit("message",r), m));
  };
  const server=fixture(tpt);
  // Feed the Node HTTP parser and capture actual wire bytes without opening a port.
  const request=id=>new Promise((resolve,reject)=>{
    let wire="";
    const socket=new Duplex({read(){},write(b,enc,done){wire+=b.toString();done();}});
    socket.on("error",reject);
    socket.on("finish",()=>{try {
      const [head,body]=wire.split("\r\n\r\n");
      assert.match(head,/cache-control: no-store/i);
      const uuid=head.match(/x-inspection-request-id: ([a-f0-9-]{36})/i)[1];
      resolve([Number(head.split(" ")[1]),uuid,JSON.parse(body)]);
    } catch(e){reject(e);}});
    server.emit("connection",socket);
    const path="/api/message-dom-inspection?"+new URLSearchParams({...q,tabId:String(id)});
    socket.push("GET "+path+" HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer "+secret+"\r\n\r\n");
  });
  const results=await Promise.all([7,8,9,-1].map(request));
  assert.deepEqual(results.map(r=>r[0]),[503,503,200,400]);
  assert.deepEqual(results.map(r=>r[2].code ?? r[2].result),["MESSAGE_DOM_INSPECTION_FAILED","MESSAGE_DOM_INSPECTION_FAILED","NOT_CONFIRMED","INVALID_DOM_INSPECTION_REQUEST"]);
  assert.equal(new Set(results.map(r=>r[1])).size,4);
  assert.equal(sent.length,3);
  const rows=logs();
  for(const [i,tabId] of [7,8].entries()) {
    const id=results[i][1], group=rows.filter(r=>r.requestId===id);
    assert.equal(sent.find(m=>m.payload.tabId===tabId).requestId,id);
    assert.deepEqual(group.map(r=>r.layer),tabId===7?["extension_page","extension","server"]:["extension","server"]);
    assert.ok(group.every(r=>r.tabId===tabId && r.cause && r.code && Date.parse(r.at)));
    assert.equal(group.at(-1).stage,tabId===7?"tab_requery":"injection");
    assert.equal(group[0].stage,tabId===7?"content_dom":"injection");
  }
  assert.equal(rows.filter(r=>r.requestId===results[2][1]).length,0);
  assert.equal(rows.filter(r=>r.requestId===results[3][1]).length,1);
});
test("default response_wait expires at 10000 ms, once, with no retransmit",async t=>{
  const logs=output(t), sends=[], tpt=Object.assign(new EventEmitter(),{authenticated:true,send:m=>sends.push(m)});
  t.mock.timers.enable({apis:["setTimeout"]});
  const res={headers:{},set(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(b){this.body=b;}};
  const done=handleMessageDomInspection(tpt,{query:q},res);
  t.mock.timers.tick(9999); await Promise.resolve(); assert.equal(res.body,undefined); assert.equal(tpt.listenerCount("message"),1);
  t.mock.timers.tick(1); await done; t.mock.timers.tick(10000);
  assert.equal(res.statusCode,503); assert.deepEqual(res.body,{code:"MESSAGE_DOM_INSPECTION_TIMEOUT"});
  assert.equal(sends.length,1); assert.equal(tpt.listenerCount("message"),0); assert.equal(tpt.listenerCount("state"),0);
  const [row]=logs(); assert.equal(row.stage,"response_wait");assert.equal(row.cause,"TIMEOUT");
  assert.equal(row.requestId,sends[0].requestId);assert.equal(row.requestId,res.headers["X-Inspection-Request-Id"]);
});
test("untrusted extension detail is never printed",async t=>{
  const logs=output(t), tpt=Object.assign(new EventEmitter(),{authenticated:true});
  tpt.send=m=>tpt.emit("message",{type:"extension.message-dom.inspected",requestId:m.requestId,
    payload:{errorCode:secret, diagnostic:{stage:"tab_requery",cause:secret}}});
  const res={set(){},status(n){this.n=n;return this;},json(b){this.body=b;}};
  await handleMessageDomInspection(tpt,{query:q},res);
  assert.deepEqual(res.body,{code:"MESSAGE_DOM_INSPECTION_FAILED"});assert.equal(logs()[0].stage,null);
});