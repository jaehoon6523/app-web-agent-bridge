import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { replyToConnectedTabFocus, replyToTabFocus } from '../extension/runtime/tab-diagnostics.js';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';

const target={tabId:7,url:'https://chatgpt.com/'};
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
function receiver(chrome) {
  const replies=[],turnGate=createActiveTurnGate();
  const context=vm.createContext({chrome,turnGate,replyToConnectedTabFocus,authenticated:true,socket:{readyState:1},
    PROTOCOL_VERSION:2,agentDiagnostics:{accept:()=>false},serverDeliveryInspector:{accept:()=>false},send:m=>replies.push(m)});
  vm.runInContext(source.slice(source.indexOf('async function handleControllerMessage('),source.indexOf('async function handlePrepare(')),context);
  return {context,turnGate,replies,receive:(requestId,payload=target)=>context.handleControllerMessage(JSON.stringify({protocolVersion:2,type:'web.tab.focus',requestId,payload}))};
}
function chromeFixture() {
  const calls=[];
  return {calls,tabs:{get:async id=>({id,url:target.url,windowId:9,active:true}),update:async id=>{calls.push(['tab',id]);}},
    windows:{update:async()=>{calls.push(['window']);return {focused:true};}}};
}
test('production receiver respects an existing Web reservation and releases only its own focus after failure',async()=>{
  const chrome=chromeFixture(),f=receiver(chrome),held=f.turnGate.reserve('web-turn');
  await f.receive('blocked');assert.equal(f.replies.at(-1).payload.code,'WEB_SESSION_BUSY');
  assert.equal(f.turnGate.activeRequestId,'web-turn');assert.deepEqual(chrome.calls,[]);
  f.turnGate.release(held);
  const update=chrome.tabs.update;chrome.tabs.update=async()=>{throw new Error('Chrome update failed');};
  await f.receive('failed');assert.equal(f.replies.at(-1).payload.code,'TAB_FOCUS_UNCONFIRMED');
  assert.equal(f.turnGate.active,false);
  chrome.tabs.update=update;await f.receive('recovered');assert.equal(f.replies.at(-1).type,'web.tab.focused');
  assert.equal(f.turnGate.active,false);
});
test('expiry during activation keeps occupancy across connection replacement until Chrome settles',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const chrome=chromeFixture();let release;
  chrome.tabs.update=async id=>{chrome.calls.push(['tab',id]);await new Promise(resolve=>{release=resolve;});};
  const f=receiver(chrome),first=f.receive('first',{...target,expiresAt:2000});
  await new Promise(setImmediate);assert.equal(f.turnGate.activeRequestId,'first');
  t.mock.timers.tick(1001);f.context.socket={readyState:1};
  await f.receive('second',{...target,tabId:8,expiresAt:3000});
  assert.equal(f.replies.at(-1).payload.code,'WEB_SESSION_BUSY');
  assert.equal(f.turnGate.activeRequestId,'first');assert.deepEqual(chrome.calls,[['tab',7]]);
  release();await first;
  assert.equal(f.replies.some(x=>x.requestId==='first'),false,'never reply to replacement peer');
  assert.deepEqual(chrome.calls,[['tab',7]],'no window mutation after expiry');assert.equal(f.turnGate.active,false);
  chrome.tabs.update=async id=>{chrome.calls.push(['tab',id]);};
  await f.receive('third',{...target,expiresAt:4000});assert.equal(f.replies.at(-1).type,'web.tab.focused');
});
test('expiry after activation is UNKNOWN; expiry on receipt is NOT_EXECUTED',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const chrome=chromeFixture(),replies=[];
  chrome.tabs.update=async()=>{chrome.calls.push(['tab']);t.mock.timers.tick(1001);};
  await replyToTabFocus(chrome,m=>replies.push(m),{requestId:'partial',payload:{...target,expiresAt:2000}});
  assert.equal(replies.at(-1).payload.details.executionOutcome,'UNKNOWN');assert.deepEqual(chrome.calls,[['tab']]);
  await replyToTabFocus(chrome,m=>replies.push(m),{requestId:'expired',payload:{...target,expiresAt:2000}});
  assert.equal(replies.at(-1).payload.code,'TAB_FOCUS_EXPIRED');
  assert.equal(replies.at(-1).payload.details.executionOutcome,'NOT_EXECUTED');assert.deepEqual(chrome.calls,[['tab']]);
});
