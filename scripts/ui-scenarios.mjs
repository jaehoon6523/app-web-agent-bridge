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
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
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
 // Verify real fetch cancellation, not only a simulated thrown timeout error.
 const held=[]; const holdState=route=>{held.push(route);};
 await page.route('**/api/state*',holdState);
 await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('unknown'),null,{timeout:20000});
 assert.ok(held.length > 0);
 assert.match(await page.locator('#connectionNotice').textContent(),/UNKNOWN_RESULT/);
 assert.equal(await page.locator('.system-health summary').evaluateAll(es=>es.every(el=>el.classList.contains('unknown'))),true);
 assert.equal(await page.locator('#planRun').isDisabled(),true);
 await page.unroute('**/api/state*',holdState);
 for(const route of held) await route.abort().catch(()=>{});
 await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('ok'));
 const enabled = id => page.waitForFunction(id => !document.getElementById(id).disabled, id);
 const visible = id => page.locator(`#${id}`).waitFor({state:'visible'});
 const stage = id => page.waitForFunction(id => document.getElementById(id).getAttribute('aria-current') === 'step', id);
 const fixture = createUiScenarioFixture(target); await fixture.install(page);
 await page.reload(); await enabled('planRun');
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
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await page.locator('#runStatus').evaluate(el=>getComputedStyle(el,'::before').animationName),'status-pulse');
 await page.getByRole('button',{name:'Previous task',exact:false}).click();
 await page.waitForFunction(()=>document.getElementById('runObjective').textContent==='Previous task');
 assert.equal(await page.locator('#newRun').isDisabled(),true);
 await page.click('#showUnfinishedRun'); await stage('stepWork');
 fixture.offline=true; await page.waitForFunction(()=>document.getElementById('apiHealth').classList.contains('unknown'));
 assert.equal(await page.locator('#stopRun').isDisabled(),true); await screenshot('07-disconnected');
 fixture.offline=false; await enabled('stopRun'); await page.click('#stopRun'); await stage('stepResult');
 assert.equal(fixture.mutations.at(-1).body.type,'run.stop');
 fixture.phase='RECOVERY_REQUIRED'; await page.reload(); await visible('recoveryPanel');
 assert.equal(await page.locator('#abandonRun').isDisabled(),true);
 await page.click('#reconcileRun');
 await page.waitForFunction(()=>document.getElementById('reconcileResult').textContent.includes('RECOVERY_REQUIRED'));
 assert.equal(fixture.mutations.at(-1).body.type,'run.reconcile');
 assert.equal(await page.locator('#abandonRun').isDisabled(),true);
 await page.check('#recoveryConfirm');
 await screenshot('08-recovery'); await page.click('#abandonRun'); await enabled('newRun');
 assert.equal(fixture.mutations.at(-1).body.type,'run.abandon');
 fixture.phase='AWAITING_APPLY'; await page.reload(); await stage('stepResult');
 await page.locator('#evidenceList .links button').click(); await visible('evidenceDialog');
 assert.equal(await page.locator('#evidenceContent').textContent(),'Verified UI fixture evidence');
 await screenshot('09-evidence'); await page.click('#closeEvidence');
 await page.locator('#intervention summary').click(); await page.click('#applyCode');
 await page.waitForFunction(()=>document.getElementById('runStatus').textContent==='적용됨');
 assert.equal(fixture.mutations.at(-1).body.payload.candidateId,'candidate-qa');
 assert.equal(fixture.mutations.at(-1).body.payload.reviewId,'review-qa');
 await screenshot('10-applied');
 await page.setViewportSize({width:390,height:844}); await page.click('#newRun'); await visible('startPanel');
 await page.click('#engineHealth'); const mobile=await page.locator('#engineHealthDetail').boundingBox();
 assert.ok(mobile.x>=0 && mobile.x+mobile.width<=390); await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await screenshot('11-mobile');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',screenshots:output,scenarios:['first-use','health/timeout','input validation',
   'root waiting','document-change diagnostic/cancel','preparation/reply/reload/approval','blocked history',
   'stop','recovery','disconnect/reconnect','evidence/apply','mobile'],pageErrors:errors},null,2));
} catch(error) {
 await screenshot('failure').catch(()=>{});
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({message:error.message,pageErrors:errors,
   notice:await page.locator('#connectionNotice').textContent().catch(()=>null)},null,2));
 throw error;
} finally { await browser.close(); await bridge.close(); fs.rmSync(root,{recursive:true,force:true}); }
