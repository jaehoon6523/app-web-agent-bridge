import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
// Real local settings API; provider/run transitions below use explicit browser fixtures.
// This never launches a provider or edits the user's existing runs.
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const output = path.resolve('.agent-controller/ui-qa'); fs.mkdirSync(output, {recursive:true});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-browser-qa-'));
const target = path.join(root, 'target'); fs.mkdirSync(target);
const git=(...args)=>execFileSync('git',['-C',target,...args],{stdio:'ignore',windowsHide:true});
git('init'); git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','--allow-empty','-m','initial');
const config = loadConfig({cwd:root,env:{PORT:String(port),DASHBOARD_TOKEN:'browser-qa-token-0123456789abcdef0123456789',WEB_EXTENSION_SHARED_SECRET:'browser-qa-secret-0123456789abcdef0123456',WEB_EXTENSION_EXPECTED_IDENTITY:'qa-extension',CODEX_EXECUTABLE:process.execPath}});
const bridge=createBridgeServer({runtimeConfig:config}); await bridge.listen();
const browser=await chromium.launch({ ...(process.env.UI_BROWSER_EXECUTABLE
  ? { executablePath: process.env.UI_BROWSER_EXECUTABLE } : { channel: process.env.UI_BROWSER_CHANNEL || 'chrome' }), headless:true })
  .catch(async error => { await bridge.close(); fs.rmSync(root, {recursive:true,force:true}); throw error; });
const page=await browser.newPage({viewport:{width:1280,height:960}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const screenshot=async(name)=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
try {
 await page.goto(config.baseUrl); await page.locator('#editProject').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('editProject').disabled);
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
 // Verify real fetch cancellation, not only a simulated thrown timeout error.
 const held=[]; const holdState=route=>{held.push(route);};
 await page.route('**/api/state*',holdState);
 await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('시간이 초과'),null,{timeout:20000});
 assert.equal(await page.locator('.system-health summary').evaluateAll(es=>es.every(el=>el.classList.contains('unknown'))),true);
 assert.equal(await page.locator('#startRun').isDisabled(),true);
 await page.unroute('**/api/state*',holdState);
 for(const route of held) await route.abort().catch(()=>{});
 await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('ok'));
 await page.click('#editProject'); await page.waitForFunction(()=>!document.getElementById('saveProject').disabled);
 await page.check('#projectAdvanced');assert.equal(await page.locator('#projectJson').isVisible(),true);
 await page.uncheck('#projectAdvanced');
 await page.click('#saveProject'); await page.waitForFunction(()=>document.getElementById('projectStatus').textContent.includes('입력 내용을'));
 await page.fill('#projectName','scenario-project'); await page.fill('#projectRoot',target);
 await page.locator('.requirement-editor textarea').nth(0).fill('사용자가 새 작업을 직접 시작하고 중단할 수 있다.');
 await page.locator('.requirement-editor textarea').nth(1).fill('미종료 작업을 선택하고 중단하면 새 작업 버튼을 다시 사용할 수 있다.');
 await page.click('#addProjectRequirement');
 await page.locator('.requirement-editor textarea').nth(2).fill('프로젝트 설정을 화면에서 저장한다.');
 await page.locator('.requirement-editor textarea').nth(3).fill('저장 후 새로고침해도 설정이 유지된다.');
 await screenshot('02-settings-form');
 await page.click('#saveProject');
 await page.waitForFunction(()=>document.getElementById('projectStatus').textContent.includes('설정을 저장했습니다'));
 await screenshot('03-settings-saved');
 await page.click('#closeProject'); await page.reload(); await page.waitForFunction(()=>!document.getElementById('editProject').disabled);
 await page.click('#editProject'); await page.waitForFunction(()=>!document.getElementById('saveProject').disabled);
 assert.equal(await page.inputValue('#projectName'),'scenario-project');
 assert.equal(await page.isChecked('#projectAdvanced'),false);
 assert.equal(await page.locator('.requirement-editor').count(),2);
 await page.locator('.requirement-editor textarea').nth(0).fill('변경된 요구사항');
 await page.click('#saveProject'); await page.waitForFunction(()=>document.getElementById('projectStatus').textContent.includes('기준 버전'));
 await page.fill('#projectRevision','2'); await page.click('#saveProject'); await page.waitForFunction(()=>document.getElementById('projectStatus').textContent.includes('설정을 저장했습니다'));
 await page.click('#closeProject');
 const configured = await (await fetch(config.baseUrl+'/api/project',{headers:{authorization:`Bearer ${config.dashboard.token}`}})).json();
 const at='2026-09-09T01:00:00Z';
 let phase='CREATED', version=4, offline=false; const commands=[];
 await page.route('**/api/state*',async route=>{
   if(offline) { await route.abort(); return; }
   const requested=new URL(route.request().url()).searchParams.get('runId');
   const old=requested==='old'; const r={runId:old?'old':'active',version,mode:old?'DISCUSSION':'CODE_CHANGE',phase:old?'CANCELLED':phase,objective:old?'저녁추천':'채팅시스템',createdAt:at,updatedAt:at,requirements:old?null:configured.project.requirements,findings:[],candidate:{candidateId:'candidate-qa'},capture:{artifact:{sha256:'hash-qa'}},baseCommit:'base-qa',reviews:[{reviewId:'review-qa'}]};
   const caps=phase==='CANCELLED'||phase==='APPLIED'?['run.start']:old?[]:phase==='RECOVERY_REQUIRED'?['run.abandon']:phase==='AWAITING_APPLY'?['run.stop','code.apply','evidence.get']:['run.stop'];
   await route.fulfill({json:{run:r,runs:[{runId:'old',phase:'CANCELLED',objective:'저녁추천'},{runId:'active',phase,objective:'채팅시스템'}],preflight:{checks:{codexExecutableConfigured:true,extensionAuthenticated:true},readyForProvisioning:true,missing:[],project:{...configured.project,requirementsId:configured.project.requirements.requirementsId,revision:configured.project.requirements.revision}},commandCapabilities:caps,messages:[],events:[],findings:[],assessments:[],evidence:phase==='AWAITING_APPLY'?[{evidenceId:'evidence-qa',kind:'PATCH',producer:'CONTROLLER',candidateId:'candidate-qa',createdAt:at,result:{}}]:[]}});
 });
 await page.route('**/api/commands',async route=>{
   const body=route.request().postDataJSON();commands.push(body);
   if(['run.stop','run.abandon'].includes(body.type))phase='CANCELLED';
   if(body.type==='run.start')phase='WORKER_RUNNING';
   if(body.type==='code.apply')phase='APPLIED';
   if(body.type==='evidence.get'){await route.fulfill({json:{payload:{kind:'PATCH',content:'Verified UI fixture evidence',startLine:1,endLine:1,totalLines:1,omittedAfter:false}}});return;}
   version++;
   await route.fulfill({json:{payload:{runId:body.payload.runId || 'active'}}});
 });
 await page.reload(); await page.getByRole('button',{name:'저녁추천',exact:false}).click();
 await page.waitForFunction(()=>document.getElementById('runObjective').textContent==='저녁추천');
 await screenshot('04-blocked-history');
 await page.click('#showUnfinishedRun'); await page.waitForFunction(()=>document.getElementById('runObjective').textContent==='채팅시스템');
 assert.equal(await page.locator('#stopRun').isVisible(),true);
 await screenshot('05-stop-visible'); await page.click('#stopRun');
 await page.waitForFunction(()=>!document.getElementById('newRun').disabled);
 assert.equal(commands.at(-1).payload.runId,'active');
 await screenshot('06-stopped');
 phase='RECOVERY_REQUIRED'; await page.reload(); await page.getByRole('button',{name:'채팅시스템',exact:false}).click();
 await page.locator('#recoveryPanel').waitFor({state:'visible'});
 assert.equal(await page.locator('#abandonRun').isDisabled(),true);
 await page.check('#recoveryExternal'); await page.check('#recoveryTarget');await page.fill('#recoveryReason','테스트 환경의 외부 종료와 대상 상태 확인');
 await screenshot('07-recovery'); await page.click('#abandonRun'); await page.waitForFunction(()=>!document.getElementById('newRun').disabled);
 assert.equal(commands.at(-1).type,'run.abandon');
 await page.click('#newRun');await page.fill('#objective','시나리오 테스트');await page.fill('#conversationUrl','https://example.com/invalid');
 assert.equal(await page.locator('#startRun').isDisabled(),true);
 await page.fill('#conversationUrl','https://chatgpt.com/c/ui-scenario');await page.click('#startRun');
 await page.waitForFunction(()=>document.getElementById('runStatus').textContent==='구현·수정 중');
 assert.equal(commands.at(-1).type,'run.start'); await screenshot('08-started');
 // QA-146: Respect reduced-motion preferences for the active-run pulse.
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'status-pulse');
 offline=true;await page.waitForFunction(()=>document.getElementById('connectionNotice').textContent.includes('연결을 확인'));
 assert.equal(await page.locator('#stopRun').isDisabled(),true);await screenshot('09-disconnected');
 offline=false;await page.waitForFunction(()=>!document.getElementById('stopRun').disabled);await page.click('#stopRun');
 await page.waitForFunction(()=>!document.getElementById('newRun').disabled);
 phase='AWAITING_APPLY';version++;await page.reload();await page.getByRole('button',{name:'채팅시스템',exact:false}).click();
 await page.locator('#evidenceList .links button').click();await page.locator('#evidenceDialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#evidenceContent').textContent(),'Verified UI fixture evidence');await screenshot('10-evidence');await page.click('#closeEvidence');
 await page.locator('#intervention summary').click();await page.click('#applyCode');
 await page.waitForFunction(()=>document.getElementById('runStatus').textContent==='적용됨');
 assert.equal(commands.at(-1).payload.candidateId,'candidate-qa');assert.equal(commands.at(-1).payload.reviewId,'review-qa');
 await screenshot('11-applied');
 await page.setViewportSize({width:390,height:844});await page.click('#newRun');await screenshot('08-mobile');
 // QA-148: The longer engine explanation fits the mobile viewport.
 await page.click('#engineHealth');const mobileDetail=await page.locator('#engineHealthDetail').boundingBox();
 assert.ok(mobileDetail.x>=0 && mobileDetail.x+mobileDetail.width<=390);
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.click('#editProject');await page.waitForFunction(()=>!document.getElementById('saveProject').disabled);
 await screenshot('14-mobile-settings');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',screenshots:output,scenarios:['first-use','settings validation/save/reload/revision','blocked history','stop','recovery','start','disconnect/reconnect','evidence','apply','mobile'],pageErrors:errors},null,2));
} finally { await browser.close(); await bridge.close(); fs.rmSync(root, {recursive:true,force:true}); }
