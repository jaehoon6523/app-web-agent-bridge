import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verificationPlan,verificationCatalog} from '../scripts/verification-plan.mjs';
import {nativeExtensionSteps} from '../scripts/native-extension-contract.js';

import {createSourceCheckout,linkDependencies} from './helpers/source-checkout.mjs';
import {beginTestEvidenceRun} from './helpers/failure-evidence.mjs';
const repository = fileURLToPath(new URL('../',import.meta.url));
const run = promisify(execFile);
const contexts = new WeakMap();
// Exercise the direct Node dispatch on every host, while keeping OS policy
// changes local to this contract-test process.
verificationCatalog.find(stage => stage.id === 'windows-focused').os = undefined;
let evidenceRun, suiteRoot, checkout, snapshot, originalContent;
// Full source copying, Git initialization and dependency linking belong to the
// file setup budget, rather than being repeated inside every 15-second case.
before(() => {
  evidenceRun = beginTestEvidenceRun(repository,'verification-command');
  const setup = evidenceRun.record.setup = {status:'RUNNING',startedAt:new Date().toISOString()}; evidenceRun.save();
  try {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-verification-command-'));
    checkout = path.join(suiteRoot,'checkout');
    snapshot = createSourceCheckout(repository,checkout); linkDependencies(repository,checkout);
    originalContent = fs.readFileSync(path.join(checkout,'extension/content.js'));
    Object.assign(setup,{status:'PASS',checkout,snapshot});
  } catch (error) {
    setup.status = 'FAIL'; evidenceRun.record.failure = {message:error.message,stack:error.stack}; throw error;
  } finally { setup.finishedAt = new Date().toISOString(); evidenceRun.save(); }
},{timeout:60000});
after(() => {
  if (!evidenceRun) return;
  try { if (suiteRoot) fs.rmSync(suiteRoot,{recursive:true,force:true}); }
  catch (error) { evidenceRun.record.cleanupErrors.push(error.message); throw error; }
  finally { evidenceRun.close(); }
});
function verificationTest(scenarioId, name, options, body) {
  test(name,options,async t => {
    const evidence = evidenceRun.scenario(scenarioId); contexts.set(t,evidence);
    evidence.record.snapshot = snapshot; evidence.save();
    t.after(() => { try { evidence.cleanup?.(); } finally { evidence.close(); } });
    try { await body(t); contexts.get(t)?.finish(null); }
    catch (error) { contexts.get(t)?.finish(error); t.diagnostic('Failure evidence: '+contexts.get(t)?.directory); throw error; }
  });
}
async function execute(t, mode) {
  const root = fs.mkdtempSync(path.join(suiteRoot,mode+'-'));
  const evidence = contexts.get(t);
  evidence.cleanup = () => {
    evidence.preserve(checkout);
    for (const name of ['latest-verification.json','latest-verification.log']) evidence.copy(path.join(root,name),name);
    const errors = [];
    for (const clean of [() => fs.writeFileSync(path.join(checkout,'extension/content.js'),originalContent),
      () => fs.rmSync(root,{recursive:true,force:true})]) {
      try { clean(); } catch (error) { evidence.record.cleanupErrors.push(error.message); errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors,'Verification scenario cleanup failed');
  };
  fs.rmSync(path.join(checkout,'.agent-controller'),{recursive:true,force:true});
  const command = path.join(checkout,'scripts/verify-all.mjs');
  const peer = path.join(root,'npm-peer.cjs');
  fs.writeFileSync(peer, `const fs=require('node:fs'),path=require('node:path');
    const root=process.env.BRIDGE_VERIFICATION_OUTPUT;
    const parent=JSON.parse(fs.readFileSync(path.join(root,'latest-verification.json')));
    const spec=parent.stages.find(s=>process.env.BRIDGE_VERIFICATION_RUN_ID===parent.runId+'-'+s.id);
    const stage=spec.command || spec.id;
    const binding={verificationRunId:process.env.BRIDGE_VERIFICATION_RUN_ID,source:parent.source,sourceAfter:parent.source,candidateUnchanged:true};
    console.log('peer '+stage);
    if (${JSON.stringify(mode)} === 'large') process.stdout.write('x'.repeat(500000)+'\\n');
    if (${JSON.stringify(mode)} !== 'missing' || stage==='verify:browser-install') {
      const uf=stage==='test:e2e:ci',native=stage==='test:extension:native',browser=stage==='verify:browser-install';
      const receiptRoot=(native||browser)?root:path.join(process.cwd(),'.agent-controller');
      const target=path.join(receiptRoot,browser?'latest-browser-preparation.json':uf?'ui-qa/e2e-summary.json':native?'latest-native-extension.json':'latest-test-result.json');
      fs.mkdirSync(path.dirname(target),{recursive:true});
      const ids=${JSON.stringify(nativeExtensionSteps)};
      fs.writeFileSync(target,JSON.stringify(browser?{...binding,status:'PASS',version:'controlled-peer',executable:process.execPath}:native?{...binding,nativeExtension:true,completed:true,status:${JSON.stringify(mode)}==='native-unavailable'?'UNVERIFIED':'PASS',
        steps:ids.filter(id=>${JSON.stringify(mode)}!=='missing-window-boundary'||id!=='window-resize').map(id=>({id,pass:true}))}:uf?{...binding,scheduledProfiles:spec.expectedProfiles,profileResults:spec.expectedProfiles.map(id=>({id,outcome:'PROFILE_PASS'})),fullRunnablePassed:spec.expectedProfiles.length,scope:'FULL SUITE',failed:0,unexpectedSkips:0,continuationBlocked:${JSON.stringify(mode)}==='blocked-e2e'?1:0}:
        {...binding,status:'PASS',terminal:true,scheduled:spec.expectedFiles||['peer'],results:(spec.expectedFiles||['peer']).map(file=>({file,pass:true,summary:{completed:true}}))}));
      if(stage==='test:tab-ux-browser' && ${JSON.stringify(mode)}!=='missing-gui') fs.writeFileSync(path.join(root,'tab-ux-browser-latest.json'),
        JSON.stringify({...binding,exitCode:0,browserVersion:'controlled-peer',scheduledScenarios:spec.expectedScenarios,scenarioResults:spec.expectedScenarios.map(id=>({id,status:'PASS'})),assertions:spec.expectedScenarios.map(scenarioId=>({scenarioId,status:'PASS'}))}));
    }
    if (${JSON.stringify(mode)} === 'source-changed' && stage==='lint') fs.appendFileSync(path.join(process.cwd(),'extension/content.js'),'\\n// changed during verification\\n');
    if (${JSON.stringify(mode)} === 'first-fails' && stage==='lint') process.exitCode=7;
    if (${JSON.stringify(mode)} === 'native-unavailable' && stage==='test:extension:native') process.exitCode=2;
  `);
  // npm_execpath controls npm stages only. Preload the same controlled peer
  // for direct Node stages too; retain their original argv so expectedFiles
  // is still derived from the real catalog. No checkout source bytes change.
  const preload = path.join(root,'controlled-dispatch.mjs');
  fs.writeFileSync(preload,`import {verificationCatalog} from ${JSON.stringify(pathToFileURL(path.join(checkout,'scripts/verification-plan.mjs')).href)};
    verificationCatalog.find(stage=>stage.id==='windows-focused').os=undefined;
    for (const stage of verificationCatalog) if (stage.nodeArgs)
      stage.nodeArgs=[${JSON.stringify(peer)},'run',stage.id,...stage.nodeArgs];`);
  try {
    await evidence.command(process.execPath,['--import',pathToFileURL(preload).href,command],{cwd:checkout,
      env:{...process.env,npm_execpath:peer,BRIDGE_VERIFICATION_OUTPUT:root},signal:t.signal,timeout:12000,maxBuffer:16*1024*1024},run);
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
  }
  const closed = evidence.record.commands.at(-1);
  assert.match(closed.stdout,/^peer windows-focused$/mu);
  const code = closed.exitCode, signal = closed.signal;
  const result=JSON.parse(fs.readFileSync(path.join(root,'latest-verification.json'),'utf8'));
  const log=fs.readFileSync(path.join(root,'latest-verification.log'),'utf8');
  assert.equal(signal,null);
  assert.equal(result.logBytes,Buffer.byteLength(log));
  assert.equal(result.expectedLogBytes,result.logBytes);
  assert.equal(result.stages.length,verificationPlan().length);
  assert.match(result.runId,/^[a-f0-9-]{36}$/u);
  assert.equal(result.source.head,result.sourceAfter.head);
  if (mode === 'source-changed') assert.notEqual(result.source.sourceSha256,result.sourceAfter.sourceSha256);
  else assert.equal(result.source.sourceSha256,result.sourceAfter.sourceSha256);
  assert.equal(result.source.sourceSha256,evidence.record.snapshot.sourceSha256);
  assert.equal((log.match(/^STAGE_RESULT /gm)||[]).length,verificationPlan().filter(s=>s.applicable).length);
  return {code,result,log};
}

verificationTest('missing','verification command rejects exit zero without fresh completion receipts', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'missing');
  assert.equal(code,1);assert.equal(result.status,'FAIL');
  assert.ok(result.stages.some(stage=>stage.status==='FAIL'));
  assert.equal(result.stages.find(s=>s.id==='discovery').failurePhase,'EVIDENCE');
  assert.ok(log.endsWith('VERIFICATION FAIL\n'));
});
verificationTest('first-fails','verification command retains earlier failure after later successful stages', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'first-fails');
  assert.equal(code,1);assert.equal(result.stages.find(s=>s.id==='lint').status,'FAIL');
  assert.ok(result.stages.filter(s=>s.applicable && s.id!=='lint').every(s=>s.status==='PASS'));
  assert.ok(log.endsWith('VERIFICATION FAIL\n'));
});

verificationTest('large','verification command preserves the entire large output across all stages', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'large');
  assert.equal(code,0);assert.equal(result.status,'PASS');
  assert.ok(log.length>2500000);
  const chunks = log.match(/^x+$/gm) ?? [];
  assert.equal(chunks.length,verificationPlan().filter(s=>s.applicable).length); assert.ok(chunks.every(chunk=>chunk.length===500000));
  assert.ok(log.endsWith('VERIFICATION PASS\n'));
});
verificationTest('native-unavailable','an unavailable native extension loader cannot be reported as complete approval', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'native-unavailable');
  assert.equal(code,2); assert.equal(result.status,'PARTIAL');
  assert.equal(result.stages.find(s=>s.id==='native').status,'NOT_RUN'); assert.ok(log.endsWith('VERIFICATION PARTIAL\n'));
});
for (const [mode,command] of [['missing-gui','test:tab-ux-browser'],['missing-window-boundary','test:extension:native'],['blocked-e2e','test:e2e:ci']])
  verificationTest(mode,`verification command rejects exit zero with ${mode} evidence`, {timeout:15000}, async t=>{
    const {code,result}=await execute(t,mode);
    assert.equal(code,1); assert.equal(result.status,'FAIL');
    assert.equal(result.stages.find(stage=>stage.command===command).status,'FAIL');
  });

verificationTest('source-changed','verification refuses a source change despite five successful stage receipts', {timeout:15000}, async t => {
  const {code,result,log} = await execute(t,'source-changed');
  assert.equal(code,1); assert.equal(result.status,'FAIL');
  assert.ok(result.stages.filter(s=>s.applicable).every(stage => stage.status === 'PASS'));
  assert.match(result.error,/Source changed/u); assert.ok(log.endsWith('VERIFICATION FAIL\n'));
});
