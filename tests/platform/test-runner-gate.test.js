import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {reporter, fileTimeoutMs, runFile, runFiles} from '../../scripts/run-tests.mjs';
import {removeOwnedPipeFixture} from '../helpers/inherited-pipes-fixture.js';

test('file gate distinguishes process timeout, exit and missing completion receipt', {timeout:30000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gate-contract-'));
  const fixtures = {
    pass:"import test from 'node:test'; test('passes',()=>{});\n",
    fail:"import test from 'node:test'; test('fails',()=>{throw new Error('expected');});\n",
    early:"import test from 'node:test'; test('early exit',()=>{process.exit(0);});\n",
    hung:"import test from 'node:test'; test('hang',()=>new Promise(()=>{setInterval(()=>{},1000);}));\n",
  };
  for (const [name,source] of Object.entries(fixtures)) fs.writeFileSync(path.join(root,name+'.test.mjs'),source);
  const filename = name => path.join(root,name+'.test.mjs');
  try {
    const run = name => runFile(filename(name),{output:()=>{},timeoutMs:name==='hung' ? 400 : 10000});
    const passed = await run('pass');
    assert.equal(passed.pass,true);
    assert.equal(passed.summaryStatus,'COMPLETE');
    assert.equal(passed.closure.code,0);
    const failed = await run('fail');
    assert.equal(failed.reason,'TEST_FAILURE');
    assert.equal(failed.closure.code,1);
    assert.ok(failed.summary.failed>0);
    const early = await run('early');
    assert.equal(early.reason,'MISSING_RECEIPT');
    assert.equal(early.closure.code,0);
    assert.equal(early.summaryStatus,'MISSING');
    const hung = await run('hung');
    assert.equal(hung.reason,'FILE_TIMEOUT');
    assert.equal(hung.errorCode,'CHILD_CLOSE_DEADLINE');
    assert.equal(hung.deadline,true);
    const outputDirectory=path.join(root,'receipts');
    const gate=await runFiles([filename('pass'),filename('early')],{directory:outputDirectory,output:()=>{}});
    assert.equal(gate.status,'FAIL');
    assert.equal(gate.results.length,2);
    const log=fs.readFileSync(path.join(outputDirectory,'latest-test.log'),'utf8');
    assert.match(log,/FILE_RESULT .*"reason":"MISSING_RECEIPT"/u);
    assert.match(log,/"childExitCode":0/u);
    assert.match(log,/"summaryStatus":"MISSING"/u);
    assert.match(log,/TEST_GATE FAIL/u);
    const receipt=JSON.parse(fs.readFileSync(path.join(outputDirectory,'latest-test-result.json'),'utf8'));
    assert.equal(receipt.status,'FAIL');
    assert.equal(receipt.results[1].reason,'MISSING_RECEIPT');
  } finally {await fs.promises.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test('file reporter is a file URL on every platform', () => {
  assert.match(reporter, /^file:\/\//u);
});

test('fixture cleanup stops on its own deadline and preserves lock errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-fixture-budget-'));
  const locked = Object.assign(new Error('synthetic persistent lock'),{code:'EBUSY'});
  try {
    const started=performance.now();
    await assert.rejects(removeOwnedPipeFixture(root,{timeoutMs:65,retryDelayMs:10,
      remove:async () => {throw locked;}}),error =>
      error.code === 'OWNED_FIXTURE_CLEANUP_DEADLINE' && error.cause === locked && error.retries > 0);
    assert.ok(performance.now()-started < 500,'cleanup exceeded the test-owned budget');
    assert.ok(fs.existsSync(root),'persistent lock did not disappear silently');
    let attempts=0;
    await removeOwnedPipeFixture(root,{timeoutMs:150,retryDelayMs:10,
      remove:async target => {
        if (++attempts <= 2) throw locked;
        await fs.promises.rm(target,{recursive:true,force:true});
      }});
    assert.equal(attempts,3);
    assert.equal(fs.existsSync(root),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('slow successful removal cannot pass after the retry budget', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-fixture-late-success-'));
  try {
    await assert.rejects(removeOwnedPipeFixture(root,{timeoutMs:20,retryDelayMs:5,
      remove:async target => {
        await wait(100);
        await fs.promises.rm(target,{recursive:true,force:true});
      }}),error => error.code === 'OWNED_FIXTURE_CLEANUP_DEADLINE' && error.completedAfterDeadline === true);
    assert.equal(fs.existsSync(root),false,'deletion happened, but must not be recorded as a timely PASS');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('slow lock failures do not start further deletion attempts after expiry', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-fixture-late-lock-'));
  const locked=Object.assign(new Error('synthetic lock'),{code:'EBUSY'});
  let attempts=0;
  try {
    await assert.rejects(removeOwnedPipeFixture(root,{timeoutMs:20,retryDelayMs:5,
      remove:async () => {attempts++; await wait(100); throw locked;}}),error =>
      error.code === 'OWNED_FIXTURE_CLEANUP_DEADLINE' && error.cause === locked);
    assert.equal(attempts,1,'expired lock must not trigger another filesystem attempt');
    assert.equal(fs.existsSync(root),true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('cleanup contract has a separate file budget from ordinary tests', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(fileTimeoutMs(path.join(repoRoot,'tests/runtime-cleanup/contract.test.js')),720000);
  assert.equal(fileTimeoutMs(path.join(repoRoot,'tests/test-completion-gate.test.js')),180000);
});
