import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { collectSelectorDiagnostics } from '../src/orchestration/selector-diagnostics.js';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import { nativeFixtureHtml } from './native-extension-contract.js';
import { createControlledPrompt } from '../extension/runtime/markers.js';

test('native fixture preserves rendered delivery markers and still rejects a manual user turn', {timeout:20000}, async t => {
  const text=createControlledPrompt({controllerMessageId:'native-delivery',runId:'native-run',text:'Controlled fixture lifecycle test'});
  for (const preserve of [false,true]) {
    const html=preserve ? nativeFixtureHtml : nativeFixtureHtml.replace("body.style.whiteSpace = 'pre-wrap';",'');
    const f=await extensionBrowser(t,{initialUrl:'https://chatgpt.com/c/native-fixture',providerHtml:html,autoConnect:false});
    const ping=await f.sendContent({type:'agent.ping'});
    const completion=f.sendContent({type:'agent.prompt',requestId:'native-delivery',payload:{
      text,controllerMessageId:'native-delivery',runId:'native-run',expectedDocumentId:ping.documentId,
      expectedFrameId:0,expectedConversationUrl:ping.url,expectedConversationId:ping.conversationId,
      timeoutMs:5000,stableMs:1000,
    }});
    await f.page.waitForFunction(() => window.fixtureClicks === 1);
    const rendered=await f.page.locator('[data-message-content]').innerText();
    if (!preserve) {
      assert.notEqual(rendered,text,'default CSS collapses the controlled marker lines');
      const rejected=await completion;
      assert.equal(rejected.code,'MANUAL_INTERVENTION_DETECTED');
    } else {
      assert.equal(rendered,text);
      assert.equal((await f.sendContent({type:'agent.ping'})).activeRequestId,'native-delivery');
      await f.page.evaluate(() => {
        const manual=document.createElement('article'); manual.id='manual-user';
        manual.setAttribute('data-message-author-role','user'); manual.textContent='Manual fixture message';
        document.querySelector('main').append(manual);
      });
      assert.equal((await completion).code,'MANUAL_INTERVENTION_DETECTED');
    }
    assert.equal(await f.page.evaluate(() => window.fixtureClicks),1);
    t.diagnostic(JSON.stringify({preserve,rendered}));
  }
});

async function reinject(page) {
  const manifest = JSON.parse(await fs.readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  for (const file of manifest.content_scripts[0].js) await page.addScriptTag({ content: await fs.readFile(new URL('../extension/' + file, import.meta.url), 'utf8') });
}

test('real DOM fixture: full manifest reinjection keeps one listener and the original document token', { timeout: 20_000 }, async t => {
  const f = await extensionBrowser(t, { initialUrl: 'https://chatgpt.com/c/lifecycle' });
  const before = await f.sendContent({ type: 'agent.ping' });
  await reinject(f.page); await reinject(f.page);
  assert.equal((await f.sendContent({ type: 'agent.ping' })).documentId, before.documentId);
  assert.equal(await f.page.evaluate(() => globalThis.fixtureContentRegistrations), 1);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), null);
  await f.page.reload();
  assert.notEqual((await f.sendContent({ type: 'agent.ping' })).documentId, before.documentId);
  assert.deepEqual(f.errors, []);
});

test('real DOM fixture: reinjection and background reconstruction preserve a pending job without resending', { timeout: 25_000 }, async t => {
  let resolveReply;
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const f = await extensionBrowser(t, { reply: () => reply });
  await f.prepare();
  const completion = f.submit('lifecycle-active').then(() => 'completed', error => error.code);
  await f.page.waitForFunction(() => sessionStorage.getItem('clicks') === '1');
  const before = await f.sendContent({ type: 'agent.ping' }); assert.equal(before.busy, true);
  await reinject(f.page);
  assert.equal((await f.sendContent({ type: 'agent.ping' })).activeRequestId, 'lifecycle-active');
  await f.connect();
  const after = await f.sendContent({ type: 'agent.ping' });
  assert.equal(after.documentId, before.documentId); assert.equal(after.activeRequestId, 'lifecycle-active');
  assert.equal(f.readStorage().currentDeliveryId, 'lifecycle-active');
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
  await f.sendContent({ type: 'agent.cancel', requestId: 'lifecycle-active' }); resolveReply('Controlled fixture reply');
  await completion;
  assert.equal(f.readStorage().currentDeliveryId, 'lifecycle-active'); assert.deepEqual(f.errors, []);
});

test('real DOM fixture: controller exposes only owner-matched ACK and explicit discard actions', { timeout: 20_000 }, async t => {
  const f = await extensionBrowser(t);
  const owner = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  let observation = { server: { status: 'MATCHED', records: [{ kind: 'REVIEW', active: true,
    state:'RESPONSE_COMPLETED', processingState:'ACK_PENDING', responseStored:true }] },
    extension: { exact: true, phase: 'ACK_PENDING', extensionBusy: false, pageReachable: true,
      pageIdentityConfirmed:true, pageBusy: false, generating: false, hasCompletedDelivery:false } };
  const actions = [];
  await f.page.context().route('**/api/delivery-review**', async route => {
    if (route.request().method() === 'POST') {
      actions.push(route.request().postDataJSON());
      observation = {server:{status:'MATCHED', records:[{kind:'REVIEW',active:false,state:'RECOVERY_DISCARDED',responseStored:false}]},
        extension:{...observation.extension, exact:false, discardConfirmed:true, terminalDiscardProtocol:1}};
      return route.fulfill({ json: { discarded: true } });
    }
    return route.fulfill({ json: observation });
  });
  const dashboard = await f.page.context().newPage();
  await dashboard.goto('https://dashboard.fixture/delivery-recovery.html?' + new URLSearchParams(owner));
  await dashboard.locator('#ack').waitFor({ state: 'visible' });
  assert.equal(await dashboard.locator('#discard').isDisabled(), true);
  assert.equal(await dashboard.locator('#discardPanel').isHidden(), true,
    'stored response evidence must block discard');
  observation = {...observation, server:{status:'MATCHED', records:[{kind:'REVIEW',active:true,state:'RECOVERY_REQUIRED',responseStored:false}]},
    extension:{...observation.extension,phase:'UNRESOLVED'}};
  await dashboard.locator('#inspect').click();
  await dashboard.locator('#discardPanel').waitFor({state:'visible'});
  await dashboard.locator('#reason').fill('Reviewed the conversation');
  await dashboard.locator('#ownership').check();
  assert.equal(await dashboard.locator('#discard').isDisabled(), false);
  await dashboard.locator('#discard').click();
  await dashboard.waitForFunction(() => document.querySelector('#status').textContent.includes('브리지 소유권 기록 정리 완료'));
  assert.equal(actions.length, 1); assert.equal(actions[0].currentDeliveryId, 'd');
  assert.equal(actions[0].unresolvedResultConfirmed, true); assert.equal(actions[0].noAutomaticResendConfirmed, true);
  observation = { ...observation, server: { status: 'MISMATCH', records: [] }, extension: { ...observation.extension, exact: false } };
  await dashboard.locator('#inspect').click();
  await dashboard.waitForFunction(() => document.querySelector('#serverState').textContent.includes('전송 식별자가 다른 기록'));
  assert.equal(await dashboard.locator('#discardPanel').isHidden(), true); assert.equal(await dashboard.locator('#ack').isHidden(), true);
  assert.deepEqual(f.errors, []);
});

test('real DOM fixture: observed Korean dictation identifies a composer but never a send control', { timeout:20_000 }, async t => {
  const labels = ['파일 등 추가', 'ChatGPT 모델 선택', '음성 입력', '음성 대화 시작', '프로젝트 선택', '파일', '플러그인'];
  const f = await extensionBrowser(t, { providerHtml:`<!doctype html><html><head><meta charset="utf-8"></head><body><main><form>
    <div role="presentation"><div contenteditable="true" role="textbox" style="min-height:40px"> </div></div>
    ${labels.map(label => `<button type="button" aria-label="${label}"></button>`).join('')}
    <button type="button"></button></form></main>
    <script>window.fixtureClicks=0; document.addEventListener('click', () => window.fixtureClicks++);</script>
    </body></html>` });
  const ping = await f.sendContent({ type:'agent.ping', includeDiagnostics:true });
  assert.equal(ping.composerPresent, true);
  const result = await f.page.evaluate(async () => {
    const p = globalThis.WebBridgePageProviders.provider('CHATGPT_WEB');
    const state = p.inspectPageState({ includeDiagnostics:true });
    const empty = p.findSendControl().state;
    document.querySelector('[contenteditable]').textContent = 'Fixture prompt';
    const nonempty = p.findSendControl().state;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    let failure;
    try { await p.submitPrompt('Fixture prompt', controller.signal); }
    catch (error) { failure = error.name; }
    finally { clearTimeout(timer); }
    return { state, empty, nonempty, failure, clicks:window.fixtureClicks };
  });
  assert.equal(result.state.status, 'READY');
  assert.equal(result.state.diagnostics.composerFallback.eligible, 1);
  assert.equal(result.empty, 'CONFIRMED_EMPTY_COMPOSER');
  assert.equal(result.nonempty, 'UNKNOWN');
  assert.equal(result.failure, 'AbortError');
  assert.equal(result.clicks, 0);
  assert.deepEqual(f.errors, []);
});


test('real DOM fixture: controller collects bounded repair metadata without changing a delivery owner', { timeout:20000 }, async t => {
  const f = await extensionBrowser(t, { providerHtml:`<!doctype html><html><head><meta charset="utf-8"></head><body><main><form>
    <div role="presentation"><div contenteditable="true" role="textbox" style="min-height:40px"></div></div>
    <button type="button" aria-label="새로운 음성 입력"></button></form></main></body></html>` });
  await f.background.evaluate(() => chrome.storage.local.set({currentDeliveryId:'preserved-owner'}));
  const before = f.readStorage();
  const snapshot = await collectSelectorDiagnostics(f.transport);
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0].composerPresent, false);
  assert.equal(snapshot.tabs[0].pageStatus, 'UI_CONTRACT_CHANGED');
  const samples = snapshot.tabs[0].diagnostics.editableCandidates.flatMap(item => item.samples ?? []);
  assert.ok(samples.some(sample => sample.controls?.some(control => control.controlLabel === '새로운 음성 입력')));
  assert.ok(samples.some(sample => sample.ancestors?.some(ancestor => ancestor.tagName === 'FORM')));
  assert.equal(f.readStorage().currentDeliveryId, before.currentDeliveryId);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), null);
  assert.deepEqual(f.errors, []);
});

for (const action of ['continueProject','newProjectTask']) {
  const scenarios=['newer-start','other-project','read-failure','changed-focus'];
  if (action==='newProjectTask') scenarios.push('other-project-failure','edited-read-failure','selection-read-failure','superseded-read-failure','new-run');
  else scenarios.push('other-run');
  for (const scenario of scenarios) {
    test(`project draft real DOM: ${action} ${scenario}`, {timeout:20000}, async t => {
      const f=await extensionBrowser(t,{autoConnect:false});
      const page=await f.page.context().newPage();
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(action=>{
        window.fixtureDraftCompleted=0;
        const add=EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener=function(type,listener,options) {
          if (type==='click' && this.id===action) return add.call(this,type,async function(event) {
            try { await listener.call(this,event); } finally { window.fixtureDraftCompleted++; }
          },options);
          return add.call(this,type,listener,options);
        };
      },action);
      const done={runId:'applied-1',version:4,phase:'APPLIED',objective:'Initial app',projectRef:{targetRoot:'C:/project'}};
      const other={...done,runId:'other',objective:'Other app',projectRef:{targetRoot:'C:/other'}};
      const editableFailure=scenario==='edited-read-failure' || scenario==='selection-read-failure';
      const idleFailure=editableFailure || scenario==='superseded-read-failure';
      const snapshot=url=>{
        const requested=new URL(url).searchParams;
        const idle=idleFailure || requested.get('view')==='start';
        const run=requested.get('runId')==='other' ? other : done;
        return {
        workflow:idle ? {stage:'START',state:'START_IDLE'} : {stage:'RESULT',state:'APPLIED',runId:run.runId,runVersion:run.version},
        run:idle ? null : run,
        runs:[{...done,targetRoot:'C:/project'},{...other,targetRoot:'C:/other'}],
        preparation:null,runtimeAvailability:{ready:true},
        dataKnowledge:{runs:{status:'AVAILABLE_NONEMPTY'}},
        preflight:{checks:{extensionAuthenticated:true}},commandCapabilities:['preparation.start'],
        projectConversations:[{targetRoot:'C:/project',conversationId:'saved',conversationUrl:'https://chatgpt.com/c/saved'}],
        messages:[],events:[],findings:[],assessments:[],evidence:[],
      }; };
      let hold=false, paused;
      let release;
      const pending=new Promise(resolve=>{ release=resolve; });
      const started=new Promise(resolve=>{ paused=resolve; });
      let releaseLatest, latestPaused;
      const latestPending=new Promise(resolve=>{ releaseLatest=resolve; });
      const latestStarted=new Promise(resolve=>{ latestPaused=resolve; });
      await page.route('**/api/state*',async route=>{
        if (hold && new URL(route.request().url()).searchParams.get('view')==='start') {
          hold=false; paused(); await pending;
          if (scenario==='read-failure' || scenario==='other-project-failure' || idleFailure) return route.abort();
        }
        if (scenario==='superseded-read-failure' && new URL(route.request().url()).searchParams.get('view')==='start') {
          latestPaused(); await latestPending; return route.abort();
        }
        if (scenario==='new-run' && new URL(route.request().url()).searchParams.get('view')==='start') return route.abort();
        return route.fulfill({json:snapshot(route.request().url())});
      });
      const mutations=[];
      await page.route('**/api/preparations**',route=>{ mutations.push(route.request().url()); return route.abort(); });
      await page.goto('https://dashboard.fixture/');
      assert.deepEqual(errors,[]);
      await page.waitForFunction(()=>!document.getElementById('newRun').disabled);
      if (action==='newProjectTask') await page.locator('.project-open[title="C:/project"]').click();
      const previous={startRoot:'C:/draft',objective:'Existing unsent draft',conversationUrl:'https://chatgpt.com/c/draft'};
      if (scenario==='read-failure' || idleFailure) await page.evaluate(previous=>{
        for (const [id,value] of Object.entries(previous)) document.getElementById(id).value=value;
      },previous);
      hold=true;
      await page.locator('#'+action).click();
      await started;
      try {
        if (scenario==='newer-start') {
          await page.locator('#startPanel').waitFor({state:'visible'});
          await page.locator('#objective').fill('Typed after the newer START');
          await page.locator('#startRoot').focus();
          assert.equal(await page.locator('#conversationUrl').inputValue(),'https://chatgpt.com/c/saved');
          assert.equal(await page.locator('#reuseProjectConversation').isChecked(),true);
          await page.locator('#reuseProjectConversation').uncheck();
          await page.locator('#conversationUrl').fill('https://chatgpt.com/c/manual-choice');
        } else if (scenario==='other-project' || scenario==='other-project-failure') {
          await page.locator('.project-open[title="C:/other"]').click();
          assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
          assert.equal(await page.locator('#followUpSource').textContent(),'');
        } else if (scenario==='other-run') {
          await page.locator('.run-item').filter({hasText:'Other app'}).click();
          assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
        } else if (scenario==='superseded-read-failure') {
          await latestStarted; release();
          await page.waitForFunction(()=>window.fixtureDraftCompleted===1);
        } else if (scenario==='new-run') {
          await page.locator('#newRun').click();
        } else if (editableFailure) {
          assert.equal(await page.locator('#startPanel').isVisible(),true);
          if (scenario==='edited-read-failure') await page.locator('#objective').fill('Typed while the failing read was pending');
          else {
            await page.locator('#reuseProjectConversation').uncheck();
            await page.locator('#conversationUrl').fill('https://chatgpt.com/c/saved');
          }
        } else if (scenario==='changed-focus') {
          // Focus can change while the accepted request is still pending, without another refresh.
          await page.locator('#historySearch').fill('project');
        }
      } finally { release(); releaseLatest(); }
      await page.waitForFunction(()=>window.fixtureDraftCompleted===1);
      if (scenario==='newer-start') {
        assert.equal(await page.locator('#startRoot').inputValue(),'C:/project');
        assert.equal(await page.locator('#objective').inputValue(),'Typed after the newer START');
        assert.equal(await page.locator('#conversationUrl').inputValue(),'https://chatgpt.com/c/manual-choice');
        assert.equal(await page.locator('#reuseProjectConversation').isChecked(),false);
        assert.equal(await page.evaluate(()=>document.activeElement.id),'conversationUrl');
      } else if (scenario==='other-project' || scenario==='other-project-failure') {
        assert.equal(await page.locator('#overviewPath').textContent(),'C:/other');
        assert.equal(await page.locator('#startPanel').isHidden(),true);
        assert.notEqual(await page.evaluate(()=>document.activeElement.id),'objective');
        assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
      } else if (scenario==='other-run') {
        await page.waitForFunction(()=>document.querySelector('.run-item.active')?.textContent.includes('Other app'));
        assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
        assert.equal(await page.locator('#followUpSource').textContent(),'');
      } else if (scenario==='new-run') {
        await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('error'));
        assert.equal(await page.locator('#projectOverview').isHidden(),true);
        assert.equal(await page.locator('#startRoot').inputValue(),'C:/project');
        assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
      } else if (editableFailure) {
        assert.equal(await page.locator('#startPanel').isVisible(),true);
        assert.equal(await page.locator('#projectOverview').isHidden(),true);
        assert.equal(await page.locator('#startRoot').inputValue(),'C:/project');
        assert.equal(await page.locator('#planRun').isDisabled(),true);
        assert.equal(await page.locator('#followUpSource').evaluate(el=>el.hidden),true);
        if (scenario==='edited-read-failure') assert.equal(await page.locator('#objective').inputValue(),'Typed while the failing read was pending');
        else {
          assert.equal(await page.locator('#reuseProjectConversation').isChecked(),false);
          assert.equal(await page.locator('#conversationUrl').inputValue(),'https://chatgpt.com/c/saved');
        }
      } else if (scenario==='read-failure' || scenario==='superseded-read-failure') {
        if (scenario==='superseded-read-failure') await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('error'));
        for (const [id,value] of Object.entries(previous)) assert.equal(await page.locator('#'+id).inputValue(),value,id);
        assert.equal(await page.locator('#planRun').isDisabled(),true);
        assert.equal(await page.locator('#startPanel').isHidden(),true);
        if (action==='newProjectTask') assert.equal(await page.locator('#overviewPath').textContent(),'C:/project');
        else assert.equal(await page.locator('#runPanel').isVisible(),true);
      } else {
        assert.equal(await page.evaluate(()=>document.activeElement.id),'historySearch');
      }
      assert.deepEqual(mutations,[]); assert.deepEqual(errors,[]);
      assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('clicks')),null);
    });
  }
}
