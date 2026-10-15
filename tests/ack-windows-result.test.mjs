import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateAckReceipt, expectedAckFiles, writeAckReceipt } from '../scripts/ack-windows-result.mjs';

test('a prior PASS result cannot become this run result if the runner fails before generating output',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-stale-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old=path.join(dir,'latest-test-result.json');
  fs.writeFileSync(old,JSON.stringify({status:'PASS',scheduled:expectedAckFiles,
    results:expectedAckFiles.map(file=>({file,pass:true,summaryStatus:'COMPLETE'}))}));
  const previous=Date.now()-60_000;
  fs.utimesSync(old,new Date(previous),new Date(previous));
  const report=evaluateAckReceipt({runId:'this-run',startedMs:Date.now(),exitCode:1,resultFile:old});
  assert.equal(report.status,'FAIL');
  assert.equal(report.reason,'STALE_RESULT_REJECTED');
  assert.equal(report.receiptFresh,false);
  assert.equal(report.result,undefined);
});
test('missing runner receipt creates explicit missing result instead of reusing prior PASS',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-none-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const report=writeAckReceipt({runId:'this-run',startedMs:Date.now(),exitCode:1,
    resultFile:path.join(dir,'missing.json')},path.join(dir,'latest-ack-windows-result.json'));
  assert.equal(report.reason,'RESULT_NOT_CREATED');
  assert.equal(report.receiptFresh,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'latest-ack-windows-result.json'))).status,'FAIL');
});
test('current PASS requires exact scheduled files, completed results and runner success',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-new-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=path.join(dir,'latest-test-result.json');
  const start=Date.now()-3000;
  fs.writeFileSync(p,JSON.stringify({status:'PASS',scheduled:expectedAckFiles,
    results:expectedAckFiles.map(file=>({file,pass:true,summaryStatus:'COMPLETE'}))}));
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:start,exitCode:0,resultFile:p}).status,'PASS');
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:start,exitCode:1,resultFile:p}).status,'FAIL');
});
test('fresh receipt for wrong files fails even with PASS status and exit code 0',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-scope-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=path.join(dir,'latest-test-result.json');
  fs.writeFileSync(p,JSON.stringify({status:'PASS',scheduled:['tests/other.test.js'],
    results:[{file:'tests/other.test.js',pass:true,summaryStatus:'COMPLETE'}]}));
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:Date.now()-3000,exitCode:0,resultFile:p}).reason,'RESULT_SCOPE_MISMATCH');
});
