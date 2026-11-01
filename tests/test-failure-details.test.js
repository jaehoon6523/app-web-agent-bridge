import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {failureCollector, failureDetail, failureDetailsIntegrity} from '../scripts/test-failure-details.mjs';
import {runFile} from '../scripts/run-tests.mjs';

const event = error => ({name:'failure',file:'fixture.test.js',line:3,column:2,details:{error}});
function collection() {
  const summary = {failed:0};
  return {summary, collect:failureCollector(summary)};
}

test('nested causes retain socket codes; missing fields and non-Error throws are representable', () => {
  const socket = Object.assign(new Error('socket closed'),{code:'ECONNRESET'});
  const detail = failureDetail(event(new Error('test failed', {cause:new TypeError('fetch failed',{cause:socket})})));
  assert.equal(detail.error.cause.cause.code,'ECONNRESET');
  assert.equal(detail.collectionStatus,'COLLECTED');
  assert.equal(detail.testId,null);
  assert.equal(detail.line,3);
  assert.equal(failureDetail(event('plain throw')).error.message,'plain throw');
  assert.equal(failureDetail(event({message:'no code'})).error.code,null);
  assert.equal(failureDetail(event(null)).collectionStatus,'COLLECTED');
});

test('throwing getters, cyclic causes and deep chains cannot replace the original failure', () => {
  const error = {message:'original'};
  Object.defineProperty(error,'stack',{get(){throw Error('getter failed');}});
  error.cause = error;
  const {summary,collect} = collection();
  collect(event(error));
  assert.equal(summary.failedDetails[0].error.message,'original');
  assert.equal(summary.failedDetails[0].collectionStatus,'ERROR');
  assert.ok(summary.failedDetails[0].truncated.includes('causeCycle'));
  assert.equal(failureDetailsIntegrity(summary),'PARTIAL');
  let deep = new Error('leaf');
  for(let i=0;i<7;i++) deep = new Error('wrapper',{cause:deep});
  assert.ok(failureDetail(event(deep)).truncated.includes('causeDepth'));
});

test('count limits preserve 99 and 100 details and account for the 101st without correcting failed', () => {
  const {summary,collect} = collection();
  for(let i=0;i<99;i++) collect(event('failure'));
  assert.equal(summary.failedDetails.length,99);
  collect(event('failure'));
  assert.equal(summary.failedDetails.length,100);
  assert.equal(summary.failedDetailsOmitted,0);
  collect(event('failure'));
  assert.equal(summary.failed,101);
  assert.equal(summary.failedDetails.length,100);
  assert.equal(summary.failedDetailsOmitted,1);
  assert.equal(summary.failedDetailsTruncated,true);
  assert.equal(failureDetailsIntegrity(summary),'OK');
});

test('UTF-8 budget and field limits are independent and omission accounting stays exact', () => {
  const {summary,collect} = collection();
  const error = {message:'한'.repeat(5000),stack:'한'.repeat(9000),code:'E'.repeat(300)};
  const detail = failureDetail(event(error));
  assert.equal(detail.error.message.length,4096);
  assert.equal(detail.error.stack.length,8192);
  assert.ok(detail.truncated.includes('error.0.message'));
  const firstSize = Buffer.byteLength(JSON.stringify(detail));
  const capacity = Math.floor((1024*1024-1)/(firstSize+1));
  for(let i=0;i<capacity;i++) collect(event(error));
  assert.equal(summary.failedDetailsOmitted,0);
  collect(event(error));
  assert.equal(summary.failedDetailsOmitted,1);
  assert.ok(Buffer.byteLength(JSON.stringify(summary.failedDetails))<=1024*1024);
  assert.equal(failureDetailsIntegrity(summary),'OK');
});

test('live summaries reject missing versions, inconsistent counts and malformed details', () => {
  const {summary,collect} = collection();
  assert.equal(failureDetailsIntegrity(summary),'OK');
  collect(event(new Error('failure')));
  assert.equal(failureDetailsIntegrity(summary),'OK');
  for(const mutate of [
    x=>{delete x.failedDetailsSchemaVersion;},
    x=>{x.failedDetailsSchemaVersion=2;},
    x=>{delete x.failedDetails;},
    x=>{x.failed++;},
    x=>{x.failedDetails[0].error.code=123;},
    x=>{x.failedDetails[0].collectionStatus='UNKNOWN';},
    x=>{x.failedDetailsOmitted=-1;},
    x=>{x.failedDetailsTruncated=true;},
  ]) {
    const changed = structuredClone(summary); mutate(changed);
    assert.equal(failureDetailsIntegrity(changed),'INVALID');
  }
});

test('real reporter and runner preserve failures, causes, skips, todos and invalid boundary receipts', {timeout:60000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'failure-details-'));
  const fixtures = {
    pass:"test('ok',()=>{});",
    fail:"test('network',()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('socket closed'),{code:'ECONNRESET'})});});",
    skip:"test.skip('skipped case',()=>{});",
    todo:"test.todo('todo case',()=>{});",
    boundary:"test('bad receipt',t=>{t.diagnostic('__RECEIPT__:{invalid');});",
    early:"test('early',()=>process.exit(0));",
    old:"import fs from 'node:fs'; const write=fs.writeFileSync; fs.writeFileSync=(fd,bytes,...args)=>{if(fd===3){const value=JSON.parse(bytes);delete value.failedDetailsSchemaVersion;bytes=JSON.stringify(value);}return write(fd,bytes,...args);}; test('old summary',()=>{});",
    brokenFailure:"import fs from 'node:fs'; const write=fs.writeFileSync; fs.writeFileSync=(fd,bytes,...args)=>{if(fd===3){const value=JSON.parse(bytes);value.failedDetails=[];bytes=JSON.stringify(value);}return write(fd,bytes,...args);}; test('original failure',()=>{throw Error('original');});",
  };
  try {
    const results = {};
    for(const [name,source] of Object.entries(fixtures)) {
      const filename = path.join(directory,name+'.test.mjs');
      fs.writeFileSync(filename,"import test from 'node:test';\n"+source);
      results[name] = await runFile(filename,{output:()=>{},timeoutMs:10000});
    }
    assert.equal(results.pass.pass,true);
    assert.deepEqual(results.pass.summary.failedDetails,[]);
    assert.equal(results.fail.reason,'TEST_FAILURE');
    assert.equal(results.fail.collectionIntegrity,'OK');
    const errors = results.fail.summary.failedDetails.flatMap(detail=>{
      const chain=[]; for(let error=detail.error;error;error=error.cause) chain.push(error); return chain;
    });
    assert.ok(errors.some(error=>error.code==='ECONNRESET'));
    assert.deepEqual(results.skip.summary.skipped,['skipped case']);
    assert.equal(results.skip.pass,false);
    assert.deepEqual(results.todo.summary.todo,['todo case']);
    assert.equal(results.todo.pass,false);
    assert.equal(results.boundary.reason,'INVALID_BOUNDARY_RECEIPT');
    assert.equal(results.early.reason,'MISSING_RECEIPT');
    assert.equal(results.old.pass,false);
    assert.equal(results.old.reason,'INVALID_FAILURE_DETAILS');
    assert.equal(results.brokenFailure.reason,'TEST_FAILURE');
    assert.equal(results.brokenFailure.failureDetailsError,'INVALID_FAILURE_DETAILS');
    assert.ok(results.brokenFailure.summary.failed>0);
  } finally { fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
});
