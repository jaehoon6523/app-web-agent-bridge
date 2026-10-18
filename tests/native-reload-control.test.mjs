import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectNativeReloadControl} from '../scripts/native-reload-control.mjs';
import {runOwnedNode} from '../scripts/e2e/platform/process.mjs';
import {resourceClosureUnconfirmed} from '../scripts/verification-identity.mjs';
import {executeVerification} from '../scripts/verification-engine.mjs';
import {verificationPlan} from '../scripts/verification-plan.mjs';
import {forceProcessTree} from '../scripts/e2e/platform/process.mjs';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const source={head:'candidate',sourceSha256:'source'};
const cleanReceipt=()=>({cleanupStatus:'PASS',exitCode:0,cases:[{id:'B',cleanup:{status:'PASS'}}]});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-control-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'.agent-controller');
  const result={nativeExtension:true,status:'FAIL',completed:true,steps:[],source,
    sourceAfter:source,candidateUnchanged:true,extensionReloadDiagnostics:{popupOpened:false},browserExecutable:{path:process.execPath}};
  const write=receipt=>{
    const destination=path.join(directory,'native-reload-control');fs.mkdirSync(destination,{recursive:true});
    fs.writeFileSync(path.join(destination,'latest-minimal-native-reload-matrix-v2.json'),typeof receipt==='string'?receipt:JSON.stringify(receipt));
  };
  return {root,directory,result,write};
}
async function gate(f,produce=()=>{}) {
  const seen=[];
  const plan=[{id:'native',receipt:'native',evidencePaths:verificationPlan().find(item=>item.id==='native').evidencePaths},{id:'after'}].map(item=>({required:true,applicable:true,needs:[],status:'NOT_RUN',...item}));
  const result=await executeVerification({root:f.root,directory:f.directory,source,readSource:()=>source,plan,
    run:async(stage,{stageRunId})=>{
      seen.push(stage.id);
      if(stage.id==='native') {
        await produce();
        fs.writeFileSync(path.join(f.directory,'latest-native-extension.json'),JSON.stringify({...f.result,verificationRunId:stageRunId}));
      }
      return {code:stage.id==='native'?1:0,signal:null,forced:false};
    }});
  return {result,seen};
}
test('returned exit 3 with UNCONFIRMED receipt blocks the actual verification engine follow-up',async t=>{
  const f=fixture(t);
  const receipt={...cleanReceipt(),cleanupStatus:'UNCONFIRMED',exitCode:3};
  // Exercise runOwnedNode's normal return for a real child exiting 3, not a thrown error.
  await collectNativeReloadControl({...f,identity:{source},onStdout:()=>{},onStderr:()=>{},
    run:async(_args,options)=>runOwnedNode(['-e',
      "const fs=require('node:fs'),p=require('node:path');const d=process.env.BRIDGE_VERIFICATION_OUTPUT;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'latest-minimal-native-reload-matrix-v2.json'),process.argv[1]);process.exit(3)",JSON.stringify(receipt)],options)});
  assert.equal(f.result.reloadControl.closure.code,3);
  assert.equal(f.result.reloadControl.status,'CLEANUP_UNCONFIRMED');assert.ok(f.result.cleanupError);
  assert.equal(resourceClosureUnconfirmed(f.result),true);assert.equal(f.result.status,'FAIL');
  const {result,seen}=await gate(f);
  assert.deepEqual(seen,['native']);assert.equal(result.status,'FAIL');
  assert.equal(result.stages[0].failurePhase,'CLEANUP');
  assert.equal(result.stages[1].reason,'RESOURCE_CLOSURE_UNCONFIRMED');
});

test('control deadline terminates detached descendants before returning and retains partial evidence', {timeout:20000},async t=>{
  const f=fixture(t),marker=path.join(f.root,'heartbeat'),pids=path.join(f.root,'pids');
  const leaf=`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'x');process.send('ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
  const trial=`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));child.once('message',()=>process.send('ready'));setInterval(()=>{},1000);`;
  const parent=`const fs=require('node:fs'),path=require('node:path');const dir=process.env.BRIDGE_VERIFICATION_OUTPUT;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'latest-minimal-native-reload-matrix-v2.json'),JSON.stringify({execution:'INCOMPLETE',cases:[]}));fs.writeFileSync(path.join(dir,'case-A.json'),JSON.stringify({stage:'RELOAD',execution:'INCOMPLETE'}));const trial=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(trial)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});trial.once('message',()=>process.stdout.write('READY\\n'));setInterval(()=>{},1000);`;
  let ready=false;
  try {
    const {result,seen}=await gate(f,()=>collectNativeReloadControl({...f,identity:{source},
      run:(_args,options)=>runOwnedNode(['-e',parent],{...options,timeoutMs:10000,drainMs:150,
        isComplete:()=>ready,onStdout:chunk=>{if(String(chunk).includes('READY'))ready=true;}})}));
    assert.equal(ready,true,'two detached descendants must have started before the deadline');
    assert.equal(f.result.reloadControl.errorCode,'E2E_RUNNER_DEADLINE');
    t.diagnostic(JSON.stringify({reloadControl:f.result.reloadControl,cleanupError:f.result.cleanupError}));
    if(process.platform==='linux') {
      assert.equal(f.result.reloadControl.descendantCleanup.terminationConfirmed,true);
      assert.deepEqual(f.result.reloadControl.descendantCleanup.survivorPids,[]);
      for(const pid of JSON.parse(fs.readFileSync(pids)))assert.ok(f.result.reloadControl.descendantCleanup.pids.includes(pid));
      assert.equal(f.result.reloadControl.descendantCleanup.pids.includes(process.pid),false);
    }
    const before=fs.readFileSync(marker,'utf8').length;assert.ok(before>1);
    await pause(150);assert.equal(fs.readFileSync(marker,'utf8').length,before,'heartbeat must stop before collector returns');
    assert.equal(f.result.reloadControl.receipt.execution,'INCOMPLETE');
    assert.equal(resourceClosureUnconfirmed(f.result),true);
    assert.deepEqual(seen,['native']);
    const saved=path.join(result.stages[0].receiptPath,'..','evidence','native-reload-control');
    assert.equal(JSON.parse(fs.readFileSync(path.join(saved,'case-A.json'))).stage,'RELOAD');
    assert.equal(JSON.parse(fs.readFileSync(path.join(saved,'latest-minimal-native-reload-matrix-v2.json'))).execution,'INCOMPLETE');
  } finally {
    if(fs.existsSync(pids)) for(const pid of JSON.parse(fs.readFileSync(pids))) {
      try {await forceProcessTree({pid});} catch {}
      try {process.kill(pid,'SIGKILL');} catch {}
    }
  }
});
for(const [name,actual,bridgeActual,expected] of [
  ['different observed binary','b'.repeat(64),'a'.repeat(64),false],
  ['missing observed binary',undefined,'a'.repeat(64),false],
  ['different Bridge binary','a'.repeat(64),'b'.repeat(64),false],
  ['matching observed binaries','a'.repeat(64),'a'.repeat(64),true],
]) test(name+' determines executable match using observations',async t=>{
  const f=fixture(t);f.result.browserExecutable.sha256='a'.repeat(64);
  f.result.browserExecutable.observed={sha256:bridgeActual};
  const cases=['B','D'].map(id=>({id,cleanup:{status:'PASS'},launch:{executableSha256:'a'.repeat(64)},observations:{actualExecutableSha256:actual}}));
  await collectNativeReloadControl({...f,identity:{source},run:async()=>{f.write({...cleanReceipt(),cases});return {code:0,signal:null,forced:false};}});
  assert.equal(f.result.reloadControl.matchingExecutable,expected);assert.equal(f.result.status,'FAIL');
});
test('engine archives partial control evidence even when the Native runner itself times out',async t=>{
  const f=fixture(t);f.write({execution:'INCOMPLETE',cases:[]});
  const plan=[{...verificationPlan().find(item=>item.id==='native'),needs:[]}];
  const result=await executeVerification({root:f.root,directory:f.directory,source,readSource:()=>source,plan,
    run:async()=>{f.write({execution:'INCOMPLETE',cases:[]});throw Object.assign(Error('deadline'),{code:'E2E_RUNNER_DEADLINE'});}});
  assert.equal(result.status,'FAIL');
  assert.deepEqual(result.stages[0].collectedEvidence,['native-reload-control']);
  const saved=path.join(path.dirname(result.stages[0].logPath),'evidence','native-reload-control','latest-minimal-native-reload-matrix-v2.json');
  assert.equal(JSON.parse(fs.readFileSync(saved)).execution,'INCOMPLETE');
});
test('the real matrix child mirrors its active snapshot into the durable control directory without Chromium',async t=>{
  const f=fixture(t),scratch=path.join(f.root,'scratch'),output=path.join(f.root,'durable');
  fs.mkdirSync(scratch);
  // Deliberate launch failure exercises the real writer, not a fake receipt or
  // an installed browser. INCOMPLETE remains INCOMPLETE after preservation.
  await runOwnedNode([fileURLToPath(new URL('../scripts/minimal-native-reload-matrix-v2.mjs',import.meta.url)),'--child','A',scratch],{
    timeoutMs:10000,env:{...process.env,BRIDGE_VERIFICATION_OUTPUT:output,UI_BROWSER_EXECUTABLE:path.join(f.root,'missing-browser')}});
  const snapshot=JSON.parse(fs.readFileSync(path.join(scratch,'observation.json')));
  const durable=JSON.parse(fs.readFileSync(path.join(output,'case-A.json')));
  assert.deepEqual(durable,snapshot);assert.equal(durable.execution,'INCOMPLETE');assert.ok(durable.error);
  assert.equal(durable.stage,'SETUP');
});
for(const [name,closure,receipt] of [
  ['exit 3 even if receipt claims PASS',{code:3,signal:null,forced:false},cleanReceipt()],
  ['receipt UNCONFIRMED despite zero exit',{code:0,signal:null,forced:false},{...cleanReceipt(),cleanupStatus:'UNCONFIRMED'}],
  ['receipt FAIL despite zero exit',{code:0,signal:null,forced:false},{...cleanReceipt(),cleanupStatus:'FAIL'}],
  ['unclean case despite parent PASS',{code:0,signal:null,forced:false},{...cleanReceipt(),cases:[{cleanup:{status:'FORCED_TERMINATED'}}]}],
  ['forced parent termination',{code:0,signal:null,forced:true},cleanReceipt()],
  ['signalled parent termination',{code:null,signal:'SIGTERM',forced:false},cleanReceipt()],
  ['invalid cleanup receipt',{code:0,signal:null,forced:false},'{'],
]) test(name+' propagates cleanup uncertainty',async t=>{
  const f=fixture(t);
  await collectNativeReloadControl({...f,identity:{source},run:async()=>{f.write(receipt);return closure;}});
  assert.ok(f.result.cleanupError);assert.equal(resourceClosureUnconfirmed(f.result),true);
  const {seen}=await gate(f);assert.deepEqual(seen,['native']);
});
test('a thrown control deadline propagates cleanup uncertainty',async t=>{
  const f=fixture(t);
  await collectNativeReloadControl({...f,identity:{source},run:async()=>{throw Object.assign(Error('deadline'),{code:'E2E_RUNNER_DEADLINE'});}});
  assert.equal(f.result.reloadControl.errorCode,'E2E_RUNNER_DEADLINE');assert.ok(f.result.cleanupError);
  assert.deepEqual((await gate(f)).seen,['native']);
});
for(const code of [0,4]) test(`control exit ${code} with confirmed cleanup preserves Native FAIL but allows independent observation`,async t=>{
  const f=fixture(t);
  await collectNativeReloadControl({...f,identity:{source},run:async()=>{f.write({...cleanReceipt(),exitCode:code});return {code,signal:null,forced:false};}});
  assert.equal(f.result.reloadControl.status,'RECORDED');assert.equal(f.result.reloadControl.closureConfirmed,true);
  assert.equal(f.result.cleanupError,undefined);assert.equal(resourceClosureUnconfirmed(f.result),false);
  assert.equal(f.result.status,'FAIL');
  const {result,seen}=await gate(f);assert.deepEqual(seen,['native','after']);assert.equal(result.status,'FAIL');
});
