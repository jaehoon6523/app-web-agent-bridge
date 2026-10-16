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
  fs.writeFileSync(old,JSON.stringify({verificationRunId:'fresh',startedAt:new Date(Date.now()-1000).toISOString(),finishedAt:new Date().toISOString(),terminal:true,exitCode:0,status:'PASS',scheduled:expectedAckFiles,
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
  fs.writeFileSync(p,JSON.stringify({verificationRunId:'fresh',startedAt:new Date(Date.now()-1000).toISOString(),finishedAt:new Date().toISOString(),terminal:true,exitCode:0,status:'PASS',scheduled:expectedAckFiles,
    results:expectedAckFiles.map(file=>({file,pass:true,summaryStatus:'COMPLETE'}))}));
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:start,exitCode:0,resultFile:p}).status,'PASS');
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:start,exitCode:1,resultFile:p}).status,'FAIL');
});
test('fresh receipt for wrong files fails even with PASS status and exit code 0',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-scope-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=path.join(dir,'latest-test-result.json');
  fs.writeFileSync(p,JSON.stringify({verificationRunId:'fresh',startedAt:new Date(Date.now()-1000).toISOString(),finishedAt:new Date().toISOString(),terminal:true,exitCode:0,status:'PASS',scheduled:['tests/other.test.js'],
    results:[{file:'tests/other.test.js',pass:true,summaryStatus:'COMPLETE'}]}));
  assert.equal(evaluateAckReceipt({runId:'fresh',startedMs:Date.now()-3000,exitCode:0,resultFile:p}).reason,'RESULT_SCOPE_MISMATCH');
});

test('invalid JSON is rejected consistently even when the filesystem timestamp predates the stage',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-invalid-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'latest-test-result.json'),start=Date.now(),old=new Date(start-60_000);
  for(const text of ['{','null','[]','true','"invalid"']) {
    fs.writeFileSync(file,text);fs.utimesSync(file,old,old);
    const receipt=evaluateAckReceipt({runId:'current',startedMs:start,exitCode:0,resultFile:file});
    assert.equal(receipt.status,'FAIL');assert.equal(receipt.reason,'INVALID_RESULT_JSON',text);
    assert.equal(receipt.receiptFresh,false);assert.equal(receipt.result,undefined);
  }
});

test('a valid matching run receipt still cannot pass with an old filesystem timestamp',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-old-matching-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'latest-test-result.json'),start=Date.now()-3000,old=new Date(start-60_000);
  fs.writeFileSync(file,JSON.stringify({verificationRunId:'current',startedAt:new Date(start).toISOString(),
    finishedAt:new Date().toISOString(),terminal:true,exitCode:0,status:'PASS',scheduled:expectedAckFiles,
    results:expectedAckFiles.map(name=>({file:name,pass:true,summaryStatus:'COMPLETE'}))}));
  fs.utimesSync(file,old,old);
  const receipt=evaluateAckReceipt({runId:'current',startedMs:start,exitCode:0,resultFile:file});
  assert.equal(receipt.status,'FAIL');assert.equal(receipt.reason,'STALE_RESULT_REJECTED');
  assert.equal(receipt.receiptFresh,false);assert.equal(receipt.result,undefined);
});
