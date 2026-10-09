import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const command = fileURLToPath(new URL('../scripts/verify-all.mjs',import.meta.url));
async function execute(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-verification-command-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const peer = path.join(root,'npm-peer.cjs');
  fs.writeFileSync(peer, `const fs=require('node:fs'),path=require('node:path');
    const stage=process.argv[3], root=process.env.BRIDGE_VERIFICATION_OUTPUT;
    console.log('peer '+stage);
    if (${JSON.stringify(mode)} === 'large') process.stdout.write('x'.repeat(500000)+'\\n');
    if (${JSON.stringify(mode)} !== 'missing') {
      const uf=stage==='test:e2e:ci',native=stage==='test:extension:native';
      const target=path.join(root,uf?'ui-qa/e2e-summary.json':native?'latest-native-extension.json':'latest-test-result.json');
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,JSON.stringify(native?{nativeExtension:true,completed:true,status:${JSON.stringify(mode)}==='native-unavailable'?'UNVERIFIED':'PASS',steps:Array.from({length:5},()=>({pass:true}))}:uf?{scope:'FULL SUITE',failed:0,unexpectedSkips:0}:
        {status:'PASS',scheduled:['peer'],results:[{pass:true,summary:{completed:true}}]}));
    }
    if (${JSON.stringify(mode)} === 'first-fails' && stage==='check') process.exitCode=7;
    if (${JSON.stringify(mode)} === 'native-unavailable' && stage==='test:extension:native') process.exitCode=2;
  `);
  const child=spawn(process.execPath,[command],{env:{...process.env,npm_execpath:peer,BRIDGE_VERIFICATION_OUTPUT:root},stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  const [code,signal]=await once(child,'close');
  const result=JSON.parse(fs.readFileSync(path.join(root,'latest-verification.json'),'utf8'));
  const log=fs.readFileSync(path.join(root,'latest-verification.log'),'utf8');
  assert.equal(signal,null);
  assert.equal(result.logBytes,Buffer.byteLength(log));
  assert.equal(result.expectedLogBytes,result.logBytes);
  assert.equal(result.stages.length,5);
  assert.equal((log.match(/^STAGE_RESULT /gm)||[]).length,5);
  return {code,result,log};
}

test('verification command rejects exit zero without fresh completion receipts', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'missing');
  assert.equal(code,1);assert.equal(result.status,'FAIL');
  assert.ok(result.stages.every(stage=>stage.status==='FAIL'));
  assert.ok(log.endsWith('VERIFICATION FAIL\n'));
});
test('verification command retains earlier failure after later successful stages', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'first-fails');
  assert.equal(code,1);assert.deepEqual(result.stages.map(stage=>stage.status),['FAIL','PASS','PASS','PASS','PASS']);
  assert.ok(log.endsWith('VERIFICATION FAIL\n'));
});

test('verification command preserves the entire large output across all stages', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'large');
  assert.equal(code,0);assert.equal(result.status,'PASS');
  assert.ok(log.length>2500000);
  const chunks = log.match(/^x+$/gm) ?? [];
  assert.equal(chunks.length,5); assert.ok(chunks.every(chunk=>chunk.length===500000));
  assert.ok(log.endsWith('VERIFICATION PASS\n'));
});
test('an unavailable native extension loader cannot be reported as complete approval', {timeout:15000}, async t=>{
  const {code,result,log}=await execute(t,'native-unavailable');
  assert.equal(code,2); assert.equal(result.status,'PARTIAL');
  assert.equal(result.stages[2].status,'UNVERIFIED'); assert.ok(log.endsWith('VERIFICATION PARTIAL\n'));
});
