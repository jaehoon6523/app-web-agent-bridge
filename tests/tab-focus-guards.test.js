import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../',import.meta.url));
const load = relative => import(pathToFileURL(path.resolve(root, relative)).href);
const web = await load('src/runtime/web/index.js');
const { replyToTabFocus } = await load('extension/runtime/tab-diagnostics.js');
const target = {tabId:7,url:'https://chatgpt.com/'};
const secret = 'handoff-synthetic-focus-secret-0123456789';
class Socket extends EventEmitter {
  readyState=1; sent=[];
  send(raw) {this.sent.push(JSON.parse(raw));}
  close() {this.readyState=3;this.emit('close');}
  receive(message) {this.emit('message',JSON.stringify({protocolVersion:2,...message}));}
}

test('handoff: expired tab lookup must not begin browser changes', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const transport = new web.WebExtensionTransport({sharedSecret:secret,expectedExtensionIdentity:'handoff'});
  const socket = new Socket();
  transport.attach(socket);
  const challenge = socket.sent[0];
  socket.receive({type:'extension.auth.response',challengeId:challenge.challengeId,extensionIdentity:'handoff',
    hmacSha256:web.computeWebChallengeHmac(challenge.nonce,secret)});
  socket.receive({type:'extension.hello',payload:{capabilities:['tab-focus-v1']}});
  const adapter = new web.ChatGptWebSessionAdapter({transport});
  t.after(async () => {await adapter.close();transport.close();});
  const pending = adapter.focusCandidateTab(target), request = socket.sent.at(-1);
  const timeout = assert.rejects(pending,{code:'WEB_RESPONSE_TIMEOUT'});
  let release, gets=0;
  const mutations=[], tab={id:7,windowId:9,url:target.url,active:false};
  const chrome={tabs:{get:async()=>++gets===1 ? new Promise(resolve=>{release=resolve;}) : {...tab},
    update:async()=>{mutations.push('tab');tab.active=true;return {...tab};}},
    windows:{update:async()=>{mutations.push('window');return {id:9,focused:true};},get:async()=>({id:9,focused:true})}};
  const handling=replyToTabFocus(chrome,message=>socket.receive(message),request);
  t.mock.timers.tick(10001);
  await timeout;
  release({...tab});await handling;
  console.log('HANDOFF_EVIDENCE',JSON.stringify({case:'expiry',requestHasExpiry:Number.isFinite(request.payload.expiresAt),mutations}));
  assert.deepEqual(mutations,[],'no new tab/window changes may begin after server expiry');
});

test('handoff: overlapping activation must be rejected until the first settles', {timeout:5000}, async () => {
  let release;
  const starts=[], replies=[];
  const chrome={tabs:{get:async id=>({id,windowId:9,url:target.url,active:true}),update:async id=>{
    starts.push(id);if(starts.length===1)await new Promise(resolve=>{release=resolve;});return {id,active:true};
  }},windows:{update:async()=>({id:9,focused:true}),get:async()=>({id:9,focused:true})}};
  const first=replyToTabFocus(chrome,message=>replies.push(message),{type:'web.tab.focus',requestId:'first',payload:target});
  await new Promise(setImmediate);
  try {
    await replyToTabFocus(chrome,message=>replies.push(message),{type:'web.tab.focus',requestId:'second',payload:{...target,tabId:8}});
    const second=replies.find(message=>message.requestId==='second');
    console.log('HANDOFF_EVIDENCE',JSON.stringify({case:'overlap',starts:[...starts],second}));
    assert.deepEqual(starts,[7],'the second activation must not start');
    assert.equal(second?.payload?.code,'WEB_SESSION_BUSY');
  } finally {release?.();await first;}
});
