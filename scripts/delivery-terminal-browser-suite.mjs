import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionBrowser} from '../tests/helpers/extension-browser.mjs';
import {createDeliveryRecoveryActions} from '../src/orchestration/delivery-recovery-actions.js';

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
  await page.locator('#terminalLabel').waitFor({state:'visible'}).catch(async error=>{throw new Error(error.message+' STATUS '+await page.locator('#status').textContent());});
  assert.match(await page.locator('#status').textContent(),/접근 불가/u);
  await page.locator('#reason').fill('Reviewed terminal ownership');
  await page.locator('#unresolved').check();await page.locator('#noResend').check();await page.locator('#terminal').check();
  assert.equal(await page.locator('#discard').isDisabled(),true);
  await page.locator('#pageUnknown').check();await page.locator('#discard').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('양쪽 폐기 처리 완료'));
  assert.match(await page.locator('#status').textContent(),/실제 전송 결과 미확정/u);
  assert.equal(f.readStorage().currentDeliveryId,null);assert.equal(f.readStorage().lastDeliveryDiscard.deliveryId,owner.currentDeliveryId);
  assert.deepEqual(events,['STARTED','COMPLETED']);assert.equal(posts,1);
  assert.equal(f.commands.some(c=>['agent.submit','agent.ack','agent.cancel'].includes(c.type)),false);
  await f.connect();await page.locator('#inspect').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('폐기 확인 완료'));
  assert.match(await page.locator('#status').textContent(),/전송 결과: 미확정/u);
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
  await page.waitForFunction(()=>document.querySelector('#recoveryDetail').textContent.includes('해당 전송 기록 있음'));
  assert.equal(await page.locator('#orphanDiscardPanel').isHidden(),true);
  await page.evaluate(()=>{globalThis.serverStatus='MISSING';});await page.locator('#inspectDelivery').click();
  await page.locator('#orphanDiscardPanel').waitFor({state:'visible'});
  assert.equal(await page.locator('#discardOrphan').isDisabled(),true);
});
