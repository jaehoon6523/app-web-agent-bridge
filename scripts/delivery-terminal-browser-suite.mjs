import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extensionBrowser} from '../tests/helpers/extension-browser.mjs';
import {createDeliveryRecoveryActions} from '../src/orchestration/delivery-recovery-actions.js';

test('delivery review returns only the exact stored response fingerprint, even after the original tab is gone', {timeout:30000}, async t => {
  const f=await extensionBrowser(t);
  const owner={currentDeliveryId:'delivery-fingerprint',sessionId:'session-fingerprint',runId:'prep-fingerprint',
    conversationUrl:'https://chatgpt.com/c/6af91c9b-1ce8-83ee-bcc0-729b6ffbdbdc'};
  const rawText='비공개 응답\n🙂';
  const binding={sessionId:owner.sessionId,runId:owner.runId,conversationUrl:owner.conversationUrl};
  await f.background.waitForFunction(()=>globalThis.fixturePopupState?.connected === true);
  await f.background.evaluate(({owner,binding,rawText})=>chrome.storage.local.set({
    currentDeliveryId:owner.currentDeliveryId,lastBoundSessionId:owner.sessionId,lastBoundRunId:owner.runId,
    conversationUrl:owner.conversationUrl,tabId:null,documentId:null,frameId:null,
    completedDelivery:{turnId:owner.currentDeliveryId,binding,rawText},
  }),{owner,binding,rawText});
  const context={preparationId:owner.runId,webSession:{...binding,activeDeliveryId:owner.currentDeliveryId},
    deliveries:[{deliveryId:owner.currentDeliveryId,state:'RESPONSE_COMPLETED',response:{text:rawText}}]};
  const actions=createDeliveryRecoveryActions({web:f.adapter,getSources:async()=>({contexts:[context],runs:[]})});
  const before=structuredClone(f.readStorage());
  const result=await actions.inspect(owner);
  assert.deepEqual(result.extension.responseFingerprint,{bytes:Buffer.byteLength(rawText),
    sha256:createHash('sha256').update(rawText).digest('hex')});
  assert.equal(JSON.stringify(result).includes('비공개 응답'),false);
  assert.deepEqual(f.readStorage(),before);
  assert.equal((await actions.inspect({...owner,runId:'different-preparation'})).extension.responseFingerprint,null);
  await f.background.evaluate(({owner,rawText,binding})=>chrome.storage.local.set({
    completedDelivery:{turnId:owner.currentDeliveryId,binding:{...binding,sessionId:'foreign-session'},rawText},
  }),{owner,rawText,binding});
  assert.equal((await actions.inspect(owner)).extension.responseFingerprint,null);
  assert.equal(f.commands.some(c=>['agent.submit','agent.ack','agent.cancel'].includes(c.type)),false);
});

test('browser fixture: explicit terminal recovery reaches WS discard, persisted receipt, reinspection and separate outcome UI', {timeout:30000}, async t => {
  const f=await extensionBrowser(t);
  const owner={currentDeliveryId:'delivery-fixture',sessionId:'session-fixture',runId:'prep-fixture',conversationUrl:'https://chatgpt.com/'};
  await f.background.waitForFunction(()=>globalThis.fixturePopupState?.connected === true);
  await f.background.evaluate(owner=>chrome.storage.local.set({currentDeliveryId:owner.currentDeliveryId,
    lastBoundSessionId:owner.sessionId,lastBoundRunId:owner.runId,conversationUrl:owner.conversationUrl,
    tabId:999,documentId:'unreachable-original-document',frameId:0,bindingStatus:'AMBIGUOUS'}),owner);
  const context={preparationId:owner.runId,webSession:{sessionId:owner.sessionId,conversationUrl:owner.conversationUrl,activeDeliveryId:null},
    deliveries:[{deliveryId:owner.currentDeliveryId,state:'RECOVERY_DISCARDED'}]};
  const events=[],actions=createDeliveryRecoveryActions({web:f.adapter,getSources:async()=>({contexts:[context],runs:[]}),
    getServices:async()=>({preparationService:{jobs:new Map()},codeChanges:{jobs:new Map(),workers:new Map(),reviewerWebBusy:()=>false}}),
    audit:async e=>events.push(e.phase)});
  let posts=0;
  await f.page.context().route('**/api/delivery-review**',async route=>{
    try {
      if(route.request().method()==='POST') {posts++;return route.fulfill({json:await actions.discard(route.request().postDataJSON())});}
      return route.fulfill({json:await actions.inspect(owner)});
    } catch(error) {return route.fulfill({status:409,json:{error:error.message,code:error.code}});}
  });
  const page=await f.page.context().newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(5000);
  await page.goto('https://dashboard.fixture/delivery-recovery.html?'+new URLSearchParams(owner));
  await page.locator('#discardPanel').waitFor({state:'visible'}).catch(async error=>{throw new Error(error.message+' STATUS '+await page.locator('#status').textContent());});
  assert.match(await page.locator('#chatgptState').textContent(),/미확정/u);
  await page.locator('#reason').fill('Reviewed terminal ownership');
  await page.locator('#ownership').check();
  assert.equal(await page.locator('#discard').isDisabled(),true);
  await page.locator('#pageUnknown').check();await page.locator('#discard').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('브리지 소유권 기록 정리 완료'));
  assert.match(await page.locator('#status').textContent(),/ChatGPT 처리 결과는 미확정/u);
  assert.equal(f.readStorage().currentDeliveryId,null);assert.equal(f.readStorage().lastDeliveryDiscard.deliveryId,owner.currentDeliveryId);
  assert.deepEqual(events,['STARTED','COMPLETED']);assert.equal(posts,1);
  assert.equal(f.commands.some(c=>['agent.submit','agent.ack','agent.cancel'].includes(c.type)),false);
  await f.connect();await page.locator('#inspect').click();
  await page.waitForFunction(()=>document.querySelector('#recordStatus').textContent.includes('일치'));
  assert.match(await page.locator('#chatgptState').textContent(),/미확정/u);
  assert.match(await page.locator('#extensionState').textContent(),/영수증/u);
  await actions.discard({...owner,reason:'Reviewed terminal ownership',unresolvedResultConfirmed:true,noAutomaticResendConfirmed:true,
    terminalDiscardConfirmed:true,pageStateUnconfirmedConfirmed:true});
  assert.deepEqual(f.errors,[]);
});

test('browser fixture: popup orphan controls appear only after an actual MISSING server observation',{timeout:15000},async t=>{
  const f=await extensionBrowser(t),page=await f.page.context().newPage();
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../extension/popup.html',import.meta.url),'utf8');
  const source=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
  await page.setContent(html.replace(/<script[^>]*src="popup.js"[^>]*><\/script>/u,''));
  await page.evaluate(()=>{
    globalThis.serverStatus='MATCHED';
    globalThis.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async message=>message.type==='bridge.inspectDelivery'
      ? {ok:true,result:{owner:{currentDeliveryId:'d'},phase:'UNRESOLVED',server:{status:globalThis.serverStatus,records:[{state:'RECOVERY_DISCARDED'}]},page:{reachable:false}}}
      : {ok:true,state:{currentDeliveryId:'d',connected:true,bindingStatus:'AMBIGUOUS'}}}};
  });
  await page.addScriptTag({content:source});
  assert.equal(await page.locator('#orphanDiscardPanel').isHidden(),true);
  await page.locator('#inspectDelivery').click();
  await page.waitForFunction(()=>document.querySelector('#recoveryDetail').textContent.includes('기록 불일치'));
  assert.equal(await page.locator('#orphanDiscardPanel').isHidden(),true);
  assert.equal(await page.locator('#openRecovery').isVisible(),true);
  await page.evaluate(()=>{globalThis.serverStatus='MISSING';});await page.locator('#inspectDelivery').click();
  await page.locator('#orphanDiscardPanel').waitFor({state:'visible'});
  assert.equal(await page.locator('#discardOrphan').isDisabled(),true);
});
