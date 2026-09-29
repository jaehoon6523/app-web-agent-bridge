import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { createUiScenarioFixture } from './ui-scenario-fixtures.mjs';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
// Real server initialization; preparation and provider transitions use explicit browser fixtures.
// This never launches a provider or edits the user's existing runs.
async function freePort() {
 const probe=net.createServer();
 await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
 const selected=probe.address().port;
 await new Promise(resolve=>probe.close(resolve));
 return selected;
}
const port=await freePort();
const output = path.resolve('.agent-controller/ui-qa'); fs.mkdirSync(output, {recursive:true});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-browser-qa-'));
const target = path.join(root, 'target'); fs.mkdirSync(target);
const config = loadConfig({cwd:root,env:{PORT:String(port),CODEX_EXECUTABLE:process.execPath,
  WEB_EXTENSION_SHARED_SECRET:'ui-fixture-only-secret-0123456789abcdef',
  WEB_EXTENSION_EXPECTED_IDENTITY:'ui-fixture-extension'}});
const bridge=createBridgeServer({runtimeConfig:config}); await bridge.listen();
const browser=await chromium.launch({ ...(process.env.UI_BROWSER_EXECUTABLE
  ? { executablePath: process.env.UI_BROWSER_EXECUTABLE } : { channel: process.env.UI_BROWSER_CHANNEL || 'chrome' }), headless:true })
  .catch(async error => { await bridge.close(); fs.rmSync(root, {recursive:true,force:true}); throw error; });
const page=await browser.newPage({viewport:{width:1280,height:960}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const screenshot=async(name)=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
try {
 // CASE 0: no snapshot has ever been observed. A cold-start state failure must render safely and polling must recover.
 const coldPage=await browser.newPage({viewport:{width:1280,height:960}});
 const coldErrors=[]; coldPage.on('pageerror',e=>coldErrors.push(e.message));
 const coldStateFailure=route=>route.abort();
 await coldPage.route('**/api/state*',coldStateFailure);
 await coldPage.goto(config.baseUrl);
 await coldPage.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('서버 응답 없음'),null,{timeout:20000});
 assert.equal(await coldPage.locator('#newRun').isDisabled(),true);
 assert.equal(await coldPage.locator('#planRun').isDisabled(),true);
 assert.match(await coldPage.locator('#historyFilterSummary').textContent(),/확인할 수 없습니다|확인하지 못했습니다/u);
 assert.deepEqual(coldErrors,[]);
 await coldPage.unroute('**/api/state*',coldStateFailure);
 await coldPage.waitForFunction(()=>!document.getElementById('newRun').disabled,null,{timeout:20000});
 assert.deepEqual(coldErrors,[]);
 await coldPage.close();

 // CASE S: actual server-side projection exception -> real 503 -> UI degradation, with transport/auth still known.
 const faultPort=await freePort();
 const faultRoot=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-browser-projection-fault-'));
 const faultConfig=loadConfig({cwd:faultRoot,env:{PORT:String(faultPort),CODEX_EXECUTABLE:process.execPath,
   WEB_EXTENSION_SHARED_SECRET:'ui-projection-fault-secret-0123456789abcdef',WEB_EXTENSION_EXPECTED_IDENTITY:'ui-projection-fault-extension'}});
 const faultRuntime={store:{listRuns:()=>[]},codeChanges:{list:()=>[{runId:'run-projection-fault'}],snapshot:()=>{
   throw Object.assign(new Error('injected browser-visible state projection failure'),{code:'STATE_PROJECTION_FAULT_INJECTED'});}},composition:{},async close(){}};
 const faultBridge=createBridgeServer({runtimeConfig:faultConfig,createLiveRuntime:async()=>faultRuntime}); await faultBridge.listen();
 const faultPage=await browser.newPage({viewport:{width:1280,height:960}}); const faultErrors=[]; faultPage.on('pageerror',e=>faultErrors.push(e.message));
 try {
   await faultPage.goto(faultConfig.baseUrl);
   await faultPage.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('상태 조회 실패'),null,{timeout:20000});
   assert.equal(await faultPage.locator('#apiHealth').evaluate(el=>el.classList.contains('ok')),true);
   assert.equal(await faultPage.locator('#sessionHealth').evaluate(el=>el.classList.contains('ok')),true);
   assert.equal(await faultPage.locator('#newRun').isDisabled(),true); assert.equal(await faultPage.locator('#planRun').isDisabled(),true);
   assert.doesNotMatch(await faultPage.locator('#connectionNotice').textContent(),/서버 응답 없음|UNKNOWN_RESULT|npm start/u);
   assert.deepEqual(faultErrors,[]);
 } finally { await faultPage.close(); await faultBridge.close(); fs.rmSync(faultRoot,{recursive:true,force:true}); }

 await page.goto(config.baseUrl); await page.locator('#startPanel').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('newRun').disabled);
 await screenshot('01-first-use');
 // The health disclosure controls remain usable with a keyboard and outside clicks.
 await page.click('#apiHealth'); await page.keyboard.press('Escape');
 assert.equal(await page.locator('#apiHealthDetail').isVisible(),false);
 assert.equal(await page.locator('#apiHealth').evaluate(el=>document.activeElement===el),true);
 await page.click('#channelHealth'); await page.locator('.top strong').click();
 assert.equal(await page.locator('#channelHealthDetail').isVisible(),false);
 // QA-149: Space toggles native disclosure controls without submitting anything.
 await page.locator('#engineHealth').focus(); await page.keyboard.press('Space');
 assert.equal(await page.locator('#engineHealthDetail').isVisible(),true);
 // QA-147: Desktop disclosure stays below its trigger and within the viewport.
 const desktopDetail=await page.locator('#engineHealthDetail').boundingBox();
 const desktopTrigger=await page.locator('#engineHealth').boundingBox();
 assert.ok(desktopDetail.y>=desktopTrigger.y+desktopTrigger.height);
 assert.ok(desktopDetail.x>=0 && desktopDetail.x+desktopDetail.width<=1280);
 await page.keyboard.press('Space');assert.equal(await page.locator('#engineHealthDetail').isVisible(),false);
 // QA-150: No duplicate IDs can redirect a status update to another element.
 assert.equal(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return ids.length===new Set(ids).size;}),true);
 // CASE A: a received 503 is state degradation, not proof that the HTTP server is down.
 const state503=route=>route.fulfill({status:503,contentType:'application/json',
   body:JSON.stringify({error:'injected state read failure'})});
 await page.route('**/api/state*',state503);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('상태 조회 실패'),null,{timeout:20000});
 assert.equal(await page.locator('#apiHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#sessionHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.doesNotMatch(await page.locator('#connectionNotice').textContent(),/UNKNOWN_RESULT|서버 응답 없음|npm start/u);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 await page.unroute('**/api/state*',state503);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent==='');

 // CASE B: a network-level failure is a distinct transport failure and still is not mutation UNKNOWN_RESULT.
 const unreachable=route=>route.abort();
 await page.route('**/api/state*',unreachable);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('서버 응답 없음'),null,{timeout:20000});
 assert.equal(await page.locator('#apiHealth').evaluate(el=>el.classList.contains('error')),true);
 assert.equal(await page.locator('#sessionHealth').evaluate(el=>el.classList.contains('unknown')),true);
 assert.doesNotMatch(await page.locator('#connectionNotice').textContent(),/UNKNOWN_RESULT/u);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 await page.unroute('**/api/state*',unreachable);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent==='');

 // CASE C: an otherwise valid 200 snapshot missing required run knowledge is a projection failure.
 const malformed=route=>route.fulfill({status:200,contentType:'application/json',
   body:JSON.stringify({
     workflow:{stage:'START',state:'START_IDLE'},
     runs:[],
     commandCapabilities:['preparation.start'],
     preflight:{checks:{extensionAuthenticated:true}},
     runtimeAvailability:{ready:true,code:null,message:null},
   })});
 await page.route('**/api/state*',malformed);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('상태 응답 해석 실패'),null,{timeout:20000});
 assert.equal(await page.locator('#apiHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#sessionHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.doesNotMatch(await page.locator('#connectionNotice').textContent(),/서버 응답 없음|UNKNOWN_RESULT|npm start/u);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 await page.unroute('**/api/state*',malformed);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent==='');
 const enabled = id => page.waitForFunction(id => !document.getElementById(id).disabled, id);
 const visible = id => page.locator(`#${id}`).waitFor({state:'visible'});
 const stage = id => page.waitForFunction(id => document.getElementById(id).getAttribute('aria-current') === 'step', id);
 const fixture = createUiScenarioFixture(target); await fixture.install(page);
 await page.reload(); await enabled('planRun');

 // CASE D: authenticated extension without a bound conversation is not an extension failure.
 assert.equal(await page.locator('#channelHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#webBindingSignal').evaluate(el=>el.classList.contains('warn')),true);
 assert.match(await page.locator('#webBindingSignal').getAttribute('aria-label'),/연결 필요/u);
 assert.equal(await page.locator('#planRun').isDisabled(),false,
   'preparation may bootstrap a new conversation when no exact binding exists yet');

 // CASE E: extension disconnect leaves HTTP/dashboard state usable and blocks only Web-dependent start.
 fixture.extensionAuthenticated=false; await page.reload();
 await page.waitForFunction(()=>document.getElementById('channelHealth').classList.contains('warn'));
 assert.equal(await page.locator('#apiHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#sessionHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 assert.equal(await page.locator('#newRun').isDisabled(),false);
 assert.doesNotMatch(await page.locator('#connectionNotice').textContent(),/서버 응답 없음|대시보드 인증 실패/u);
 fixture.extensionAuthenticated=true; await page.reload(); await enabled('planRun');

 // CASE F: runtime failure with runs=[] is unknown history, not a verified empty history.
 fixture.runtimeAvailable=false; await page.reload();
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('실행 런타임 준비 필요'));
 assert.equal(await page.locator('#apiHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.equal(await page.locator('#sessionHealth').evaluate(el=>el.classList.contains('ok')),true);
 assert.match(await page.locator('#engineHealthDetail').textContent(),/런타임 준비 필요/u);
 assert.match(await page.locator('#historyFilterSummary').textContent(),/작업 기록 조회 불가/u);
 assert.doesNotMatch(await page.locator('#historyFilterSummary').textContent(),/전체 0건/u);
 assert.equal(await page.locator('#newRun').isDisabled(),true);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 assert.doesNotMatch(await page.locator('#connectionNotice').textContent(),/서버 응답 없음|대시보드 인증 실패/u);
 fixture.runtimeAvailable=true; await page.reload(); await enabled('planRun');

 await page.fill('#objective','UI scenario task'); await page.fill('#startRoot',target);
 await page.fill('#conversationUrl','https://example.com/invalid'); await page.click('#planRun');
 assert.equal(fixture.mutations.length,0);
 await page.fill('#conversationUrl',''); await page.click('#planRun'); await visible('startProgress');
 assert.equal(fixture.mutations[0].body.conversationUrl,'https://chatgpt.com/');
 assert.equal(Object.hasOwn(fixture.mutations[0].body,'expectedVersion'),false);
 assert.equal(typeof fixture.mutations[0].body.requestId,'string');
 assert.ok(fixture.mutations[0].body.requestId.length > 0);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 await screenshot('02-root-waiting');
 fixture.block(); await page.reload();
 await page.waitForFunction(()=>document.getElementById('startReason').textContent.includes('WEB_DOCUMENT_CHANGED'));
 await screenshot('03-document-changed');
 await page.click('#cancelInitialPreparation'); await enabled('planRun');
 await page.fill('#objective','UI scenario task'); await page.fill('#startRoot',target);
 await page.fill('#conversationUrl','https://chatgpt.com/'); await page.click('#planRun'); await visible('startProgress');
 fixture.discuss(); await page.reload(); await visible('projectPanel');
 assert.equal(await page.inputValue('#planningUrl'),'https://chatgpt.com/c/created');
 assert.equal(await page.locator('#saveProject').isDisabled(),true);
 await screenshot('04-preparation');
 await page.fill('#proposalFeedback','Show a greeting.'); await page.click('#reviseRequirements'); await enabled('saveProject');
 assert.equal(fixture.mutations.at(-1).pathname,'/api/preparations/prep-qa/reply');
 assert.equal(Object.hasOwn(fixture.mutations.at(-1).body,'expectedVersion'),false);
 assert.equal(typeof fixture.mutations.at(-1).body.requestId,'string');
 assert.ok(fixture.mutations.at(-1).body.requestId.length > 0);
 await page.reload(); await enabled('saveProject');
 assert.equal(await page.inputValue('#planningObjective'),'UI scenario task');
 assert.match(await page.locator('#preparationPersistence').textContent(),/prep-qa/);
 await screenshot('05-agreement-ready');
 await page.click('#saveProject'); await stage('stepWork');
 assert.equal(fixture.mutations.at(-1).pathname,'/api/preparations/prep-qa/approve');
 await screenshot('06-working');
 assert.match(await page.locator('#runWorkerRole').textContent(),/Worker · codex \/ fixture-model · 구현 중/);
 assert.match(await page.locator('#runJudgeRole').textContent(),/Judge · Claude Web · 감사 대기/);
 assert.match(await page.locator('#runCriticRole').textContent(),/Critic · ChatGPT Web · 감사 대기/);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'status-pulse');
 await page.getByRole('button',{name:'Previous task',exact:false}).click();
 await page.waitForFunction(()=>document.getElementById('runObjective').textContent==='Previous task');
 assert.equal(await page.locator('#newRun').isDisabled(),true);
 await page.click('#showUnfinishedRun'); await stage('stepWork');
 await page.locator('#runSecondaryTier > summary').click();
 fixture.offline=true; await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('unknown'));
 assert.equal(await page.locator('#stopRun').isDisabled(),true); await screenshot('07-disconnected');
 fixture.offline=false; await enabled('stopRun'); await page.click('#stopRun'); await stage('stepResult');
 assert.equal(fixture.mutations.at(-1).body.type,'run.stop');
 fixture.phase='RECOVERY_REQUIRED'; await page.reload(); await visible('recoveryPanel');
 assert.equal(await page.locator('#runRecoveryTier').isVisible(),true);
 assert.equal(await page.locator('#recoveryPanel').evaluate(el=>el.closest('#runRecoveryTier')!==null),true);
 assert.equal(await page.locator('#runPrimaryTier').isVisible(),false);
 assert.equal(await page.locator('#abandonRun').isDisabled(),true);
 await page.click('#reconcileRun');
 await page.waitForFunction(()=>document.getElementById('reconcileResult').textContent.includes('RECOVERY_REQUIRED'));
 assert.equal(fixture.mutations.at(-1).body.type,'run.reconcile');
 assert.equal(await page.locator('#abandonRun').isDisabled(),true);
 await page.check('#recoveryConfirm');
 await screenshot('08-recovery'); await page.click('#abandonRun'); await enabled('newRun');
 assert.equal(fixture.mutations.at(-1).body.type,'run.abandon');
 fixture.phase='HOLD'; await page.reload(); await visible('runPanel'); await enabled('retryRun');
 assert.equal(await page.locator('#runPrimaryTier').isVisible(),true);
 assert.equal(await page.locator('#retryRun').evaluate(el=>el.parentElement?.id),'runPrimaryActionSlot');
 assert.equal(await page.locator('#runSecondaryTier').evaluate(el=>el.open),false);
 await page.click('#retryRun');
 await page.waitForFunction(()=>document.getElementById('runStatus').textContent==='웹 감사 중');
 assert.match(await page.locator('#runJudgeRole').textContent(),/Judge · Claude Web · 감사 중/);
 assert.match(await page.locator('#runCriticRole').textContent(),/Critic · ChatGPT Web · 감사 대기/);
 assert.equal(fixture.mutations.at(-1).body.type,'code.review.retry');
 assert.equal(fixture.mutations.at(-1).body.payload.runId,'active');
 assert.equal(fixture.mutations.at(-1).body.payload.expectedVersion,fixture.version-1);
 fixture.phase='AWAITING_APPLY'; await page.reload(); await stage('stepResult');
 assert.match(await page.locator('#runJudgeRole').textContent(),/현재 후보 검토 완료/);
 assert.match(await page.locator('#runCriticRole').textContent(),/현재 후보 검토 완료/);
 assert.equal(await page.locator('#runPrimaryTier').isVisible(),true);
 assert.equal(await page.locator('#applyCode').evaluate(el=>el.parentElement?.id),'runPrimaryActionSlot');
 assert.equal(await page.locator('#applyCode').evaluate(el=>el.classList.contains('primary')),true);
 await page.click('#showAudit'); await visible('auditPanel');
 await page.locator('#evidenceList .links button').click(); await visible('evidenceDialog');
 assert.equal(await page.locator('#evidenceContent').textContent(),'Verified UI fixture evidence');
 await screenshot('09-evidence'); await page.click('#closeEvidence');
 await page.click('#applyCode');
 await page.waitForFunction(()=>document.getElementById('runStatus').textContent==='적용됨');
 assert.equal(await page.locator('#continueProject').evaluate(el=>el.parentElement?.id),'runPrimaryActionSlot');
 assert.equal(await page.locator('#continueProject').isVisible(),true);
 assert.equal(fixture.mutations.at(-1).body.payload.candidateId,'candidate-qa');
 assert.equal(fixture.mutations.at(-1).body.payload.reviewId,'review-qa');
 const commands=fixture.mutations.filter(({pathname})=>pathname==='/api/commands').map(({body})=>body);
 assert.deepEqual(commands.map(({type})=>type),[
   'run.stop','run.reconcile','run.abandon','code.review.retry','evidence.get','code.apply']);
 assert.equal(commands.every(({payload})=>payload.runId==='active'&&Number.isSafeInteger(payload.expectedVersion)),true);
 assert.equal(commands[1].payload.expectedVersion,commands[2].payload.expectedVersion,
   'read-only reconcile must not change run version');
 assert.equal(new Set(commands.map(({requestId})=>requestId)).size,commands.length,
   'commands must each have a unique request identity');
 await screenshot('10-applied');
 await page.setViewportSize({width:390,height:844}); await page.click('#newRun'); await visible('startPanel');
 await page.click('#engineHealth'); const mobile=await page.locator('#engineHealthDetail').boundingBox();
 assert.ok(mobile.x>=0 && mobile.x+mobile.width<=390); await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await screenshot('11-mobile');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',screenshots:output,scenarios:['first-use','health/degraded-state-matrix','server-projection-fault','input validation',
   'root waiting','document-change diagnostic/cancel','preparation/reply/reload/approval','blocked history',
   'stop','recovery/action hierarchy','disconnect/reconnect','review retry primary','evidence/apply primary','applied follow-up primary','mobile'],pageErrors:errors},null,2));
} catch(error) {
 await screenshot('failure').catch(()=>{});
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({message:error.message,pageErrors:errors,
   notice:await page.locator('#connectionNotice').textContent().catch(()=>null)},null,2));
 throw error;
} finally { await browser.close(); await bridge.close(); fs.rmSync(root,{recursive:true,force:true}); }
