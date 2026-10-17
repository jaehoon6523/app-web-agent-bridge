import {requiredGuiScenarios} from './verification-gui-contract.mjs';
import {beginVerificationIdentity,finishVerificationIdentity} from './verification-identity.mjs';
import strictAssert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const evidence={schemaVersion:1,startedAt:new Date().toISOString(),node:process.version,platform:process.platform,command:[process.execPath,...process.argv.slice(1)],executablePath:process.env.CHROME_PATH??process.env.UI_BROWSER_EXECUTABLE??null,scope:'LOCAL_FIXTURE_NOT_INSTALLED_EXTENSION',scheduledScenarios:[...requiredGuiScenarios],scenarioResults:[],assertions:[],exitCode:1};
let currentScenario;
function completeScenario() {
  if(!currentScenario) return;
  const observations=evidence.assertions.filter(item=>item.scenarioId===currentScenario.id);
  strictAssert.ok(observations.length>0 && observations.every(item=>item.status==='PASS'),'Scenario requires completed assertions');
  currentScenario.status='PASS';currentScenario.finishedAt=new Date().toISOString();currentScenario=null;
}
function beginScenario(id) {
  completeScenario();
  strictAssert.ok(requiredGuiScenarios.includes(id) && !evidence.scenarioResults.some(item=>item.id===id),'Unknown or duplicate GUI scenario');
  currentScenario={id,status:'RUNNING',startedAt:new Date().toISOString()};evidence.scenarioResults.push(currentScenario);
}
const assert=new Proxy(strictAssert,{get(target,key){const value=target[key];if(typeof value!=='function')return value;return (...args)=>{strictAssert.ok(currentScenario,'Assertion outside GUI scenario');const entry={scenarioId:currentScenario.id,index:evidence.assertions.length+1,method:String(key),at:new Date().toISOString(),site:new Error().stack.split('\n')[2]?.trim(),status:'RUNNING'};evidence.assertions.push(entry);try{const result=value(...args);entry.status='PASS';return result;}catch(error){entry.status='FAIL';throw error;}};}});
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { chromium } from 'playwright-core';
const root=resolve(import.meta.dirname,'..');
const identity=beginVerificationIdentity(root);
const server=createServer(async(req,res)=>{
  try { const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/fixture') {res.setHeader('Content-Type','text/html');res.end('<link rel="stylesheet" href="/public/styles.css"><main id="fixture"></main>');return;}
    const file=resolve(root,'.'+path), local=relative(root,file);if(local==='..'||local.startsWith('..'+sep)||isAbsolute(local)) throw Error('path');
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));
  }catch{res.statusCode=404;res.end();}
});

let browser;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  evidence.sourceHashes={};
  for(const file of ['public/preparation-tab-choice.js','public/diagnostic-export.js','extension/popup.js','extension/runtime/diagnostic-redaction.js','scripts/preparation-tab-ux-browser.mjs']) evidence.sourceHashes[file]=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH??process.env.UI_BROWSER_EXECUTABLE,headless:true,args:['--no-sandbox']});
  evidence.browserVersion=browser.version();
  const page=await browser.newPage({viewport:{width:800,height:900}});
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.evaluate(async()=>{
    const {renderPreparationTabChoice}=await import('/public/preparation-tab-choice.js');
    window.calls=[]; window.views=[];
    window.mount=(patch={})=>document.querySelector('#fixture').replaceChildren(renderPreparationTabChoice({
      candidates:[{tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}], hint:'7',operation:'IDLE',allowed:true,
      onView:async id=>{window.views.push(id);},onSubmit:async id=>{window.calls.push(id);},onRefresh:async()=>{},...patch})); window.mount();
  });
  beginScenario('tab-explicit-selection');
  assert.equal(await page.locator('input:checked').count(),0);
  assert.equal(await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).isDisabled(),true);
  await page.getByRole('button',{name:'탭 화면 보기'}).first().click();
  assert.deepEqual(await page.evaluate(()=>window.views),[7]);
  assert.equal(await page.locator('input:checked').count(),0);
  await page.getByRole('button',{name:'뒤로',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'탭 선택을 보류했습니다'}).isVisible(),true);
  await page.getByRole('button',{name:'탭 선택으로 돌아가기'}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.locator('input[value="8"]').check();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[8]);
  assert.equal(await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).isDisabled(),true);
  if (process.env.UX_SCREENSHOT) await page.screenshot({path:process.env.UX_SCREENSHOT});
  console.log('PASS explicit selection, hint is not selection, one submit, no optimistic success');
  beginScenario('tab-stale-hint-unknown-result');
  await page.evaluate(()=>window.mount({hint:'99'}));
  assert.equal(await page.locator('input:disabled').count(),0);
  assert.equal(await page.locator('input:checked').count(),0);
  await page.locator('input[value="7"]').check();
  assert.equal(await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).isEnabled(),true);
  await page.evaluate(()=>window.mount({operation:'UNKNOWN_RESULT'}));
  assert.equal(await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'최신 상태 조회'}).isEnabled(),true);
  console.log('PASS stale hint permits explicit current choice; unknown result blocks send');
  beginScenario('controller-responsive-states');
  await page.evaluate(()=>window.mount());
  await page.setViewportSize({width:390,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for (const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme});
    await page.setViewportSize({width:360,height:900});
    for (const patch of [{},{hint:'99'},{operation:'RUNNING'},{operation:'UNKNOWN_RESULT'},{rejection:'탭이 이미 대화 화면으로 이동했습니다.'}]) {
      await page.evaluate(patch=>window.mount(patch),patch);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if (patch.rejection) assert.equal(await page.getByRole('button',{name:'이 탭에서 요청 전송 계속'}).isVisible(),false);
    }
  }
  await page.emulateMedia({colorScheme:'light'});
  await page.evaluate(()=>window.mount());
  if (process.env.GUI_SCREENSHOT_DIR) await page.screenshot({path:process.env.GUI_SCREENSHOT_DIR+'/controller.png',fullPage:true});
  beginScenario('transmission-progress');
  await page.evaluate(async()=>{
    const {renderPreparationTransmission}=await import('/public/preparation-tab-choice.js');
    document.querySelector('#fixture').replaceChildren(renderPreparationTransmission({state:'ACKNOWLEDGED',processingState:'COMPLETE'}));
  });
  assert.equal(await page.locator('.tab-choice-rail .done').count(),3);
  if (process.env.GUI_SCREENSHOT_DIR) await page.screenshot({path:process.env.GUI_SCREENSHOT_DIR+'/success.png',fullPage:true});
  console.log('PASS view-only focus, back, rejection, progress rail, 360px light/dark states');
  beginScenario('popup-window-recovery');
  await page.addInitScript(()=>{
    window.messages=[]; window.createdWindows=[];
    window.popupState={connected:true,bindingStatus:'NEEDS_REBIND',extensionVersion:'0.2.19'};
    const tab={tabId:7,url:'https://chatgpt.com/',reachable:true,ready:true,composerPresent:true,busy:false,generating:false,runtimeVersion:'0.2.19'};
    window.chrome={windows:{create:async options=>{
      if(window.rejectWindowOpen)throw new Error('injected window creation failure');
      window.createdWindows.push(options);return {id:42};
    }},runtime:{getURL:path=>'chrome-extension://fixture/'+path,onMessage:{addListener(){}},sendMessage:async message=>{
      window.messages.push(message);
      if(message.type==='bridge.getState') return {ok:true,state:window.popupState};
      if(message.type==='bridge.exportDiagnostics') return {ok:true,report:{server:{status:'AVAILABLE'},diagnosticId:'test-report',rawText:'raw fixture',message:'Cookie: session=VISIBLE_BROWSER'}};
      if(message.type==='bridge.inspectTabs') return {ok:true,result:[tab]};
      return {ok:true};
    }}};
  });
  await page.setViewportSize({width:1000,height:1000});
  await page.goto(`http://127.0.0.1:${server.address().port}/extension/popup.html`);
  await page.locator('#openResizableWindow').click();
  const created=await page.evaluate(()=>window.createdWindows);
  assert.equal(created.length,1);
  assert.equal(created[0].url,'chrome-extension://fixture/popup.html?view=window');
  assert.equal(created[0].type,'popup');
  assert.equal(created[0].focused,true);
  assert.ok(created[0].width>390 && created[0].height>600);
  assert.equal((await page.evaluate(()=>window.messages)).every(message=>message.type==='bridge.getState'),true);
  await page.evaluate(()=>{window.rejectWindowOpen=true;});
  await page.locator('#openResizableWindow').click();
  assert.match(await page.locator('#popupWindowStatus').textContent(),/다시 시도/u);
  assert.equal(await page.locator('#openResizableWindow').isEnabled(),true);
  await page.evaluate(()=>{window.rejectWindowOpen=false;});
  await page.getByRole('button',{name:'열린 탭 다시 확인'}).click();
  assert.equal(await page.locator('#choosePreparationTab').isEnabled(),true);
  assert.equal(await page.locator('#tabDiagnosticDetail,#recoveryRaw').count(),0);
  assert.equal(await page.getByRole('button',{name:'진단 로그 내보내기'}).isVisible(),true);
  await page.locator('#choosePreparationTab').click();
  const messages=await page.evaluate(()=>window.messages);
  assert.equal(messages.filter(m=>m.type==='bridge.openPreparationTab').length,1);
  assert.equal(messages.some(m=>/discard|rebind|sendTurn/.test(m.type)),false);
  for (const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.emulateMedia({colorScheme:'light'});
  if (process.env.GUI_SCREENSHOT_DIR) await page.screenshot({path:process.env.GUI_SCREENSHOT_DIR+'/popup.png',fullPage:true});
  beginScenario('popup-diagnostic-export');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'진단 로그 내보내기'}).click();
  const download=await downloadEvent;
  const stream=await download.createReadStream(), chunks=[];
  for await (const chunk of stream) chunks.push(chunk);
  const report=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(report.diagnosticId,'test-report');
  assert.equal(report.exportMode,'DIAGNOSTIC_ONLY');
  assert.equal(report.rawText,'[OMITTED:RAW_CONTENT]');
  assert.doesNotMatch(JSON.stringify(report),/VISIBLE_BROWSER/);
  await page.locator('#includeRawDiagnostic').check();
  const rawEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'진단 로그 내보내기'}).click();
  const rawFile=await rawEvent, rawStream=await rawFile.createReadStream(), rawChunks=[];
  for await(const chunk of rawStream)rawChunks.push(chunk);
  const rawReport=JSON.parse(Buffer.concat(rawChunks).toString());
  assert.equal(rawReport.exportMode,'WITH_RAW');assert.equal(rawReport.rawText,'raw fixture');
  assert.doesNotMatch(JSON.stringify(rawReport),/VISIBLE_BROWSER/);
  assert.equal(report.popupObservation.tabs[0].tabId,7);
  assert.equal(download.suggestedFilename(),'runtime-latest.json');
  console.log('PASS actual popup DOM: raw panels absent; export downloads report plus tab observation');
  beginScenario('controller-offline-export');
  const controllerDownload=page.waitForEvent('download');
  await page.evaluate(async()=>{
    const {exportDiagnosticLog}=await import('/public/diagnostic-export.js');
    await exportDiagnosticLog({includeRaw:true,preparation:{deliveries:[{response:{rawText:'raw-for-export'},trace:{documentId:'doc-export'}}]},
      connectionState:{},lastConfirmed:null,request:async()=>{throw Object.assign(new Error('offline'),{code:'OFFLINE'});}});
  });
  const controllerFile=await controllerDownload, input=await controllerFile.createReadStream(), data=[];
  for await (const chunk of input) data.push(chunk);
  const controllerReport=JSON.parse(Buffer.concat(data).toString());
  assert.equal(controllerReport.partial,true);
  assert.equal(controllerReport.displayed.preparation.deliveries[0].response.rawText,'raw-for-export');
  assert.equal(controllerFile.suggestedFilename(),'controller-diagnostics-latest.json');
  console.log('PASS controller download retains raw response when server is unavailable');
  beginScenario('detached-popup-layout');
  await page.goto(`http://127.0.0.1:${server.address().port}/extension/popup.html?source=fixture&view=window&extra=1`);
  await page.evaluate(async()=>{
    Object.assign(window.popupState,{connected:false,bindingStatus:'AMBIGUOUS',currentDeliveryId:'resize-preserved-owner',deliveryPhase:'UNRESOLVED'});
    await refresh();
  });
  assert.equal(await page.locator('#openResizableWindow').isVisible(),false);
  assert.equal(await page.locator('#deliveryRecovery').isVisible(),true);
  await page.locator('.settings > summary').click();
  for (const width of [360,520,900,1200]) {
    for (const height of [480,900]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.locator('body').evaluate(element=>Math.round(element.getBoundingClientRect().width)),width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await page.locator('#inspectTabs').isVisible(),true);
      if(height===480) assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight),true);
    }
  }
  console.log('PASS detached popup view follows width and height; native ownership is checked by the installed-extension suite');
  completeScenario();
  strictAssert.deepEqual(evidence.scenarioResults.map(item=>item.id),[...requiredGuiScenarios]);
  evidence.exitCode=0;
} catch(error) { if(currentScenario) currentScenario.status='FAIL'; evidence.failure={name:error.name,message:error.message};process.exitCode=1;console.error(error); }
finally {
  try { await browser?.close(); if(server.listening) await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  catch(error) {evidence.cleanupFailure=error.message;evidence.exitCode=1;process.exitCode=1;}
  Object.assign(evidence,finishVerificationIdentity(root,identity));
  if(!evidence.candidateUnchanged) {evidence.exitCode=1;evidence.failure={message:'Source changed during GUI verification'};process.exitCode=1;}
  evidence.finishedAt=new Date().toISOString();
  const directory=resolve(process.env.BRIDGE_VERIFICATION_OUTPUT ?? resolve(root,'.agent-controller'));await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,'tab-ux-browser-latest.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('BROWSER_RESULT '+JSON.stringify({exitCode:evidence.exitCode,browserVersion:evidence.browserVersion,assertions:evidence.assertions.length}));
}
