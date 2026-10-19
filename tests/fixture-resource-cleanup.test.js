import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {settleFixture,waitForResourceOwner} from './helpers/fixture-resource-cleanup.js';

test('recorder descriptor closes before destructive fixture cleanup', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-owner-close-'));
  const filename=path.join(root,'events.jsonl');
  const descriptor=fs.openSync(filename,'wx');
  let notifyOwnerClosed,cleaned=false;
  const ownerClosed=new Promise(resolve=>{notifyOwnerClosed=resolve;});
  let settled;
  try {
    settled=settleFixture({
      stop:()=>waitForResourceOwner(async()=>({code:0,signal:null}),ownerClosed,1000),
      cleanup:()=>{
        assert.throws(()=>fs.fstatSync(descriptor),{code:'EBADF'});
        fs.rmSync(root,{recursive:true,force:true});
        cleaned=true;
      },
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(cleaned,false);
    fs.closeSync(descriptor);
    notifyOwnerClosed();
    await settled;
    assert.equal(cleaned,true);
  } finally {
    try { fs.closeSync(descriptor); } catch(error) { if(error.code!=='EBADF')throw error; }
    if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:true});
  }
});

test('missing parent recorder close confirmation fails closed', async () => {
  await assert.rejects(waitForResourceOwner(async()=>({code:0,signal:null}),
    new Promise(()=>{}),5),{code:'RESOURCE_OWNER_CLOSE_UNCONFIRMED'});
});

test('confirmed child and recorder closure precedes cleanup', async () => {
  const steps=[];
  await settleFixture({stop:async()=>steps.push('closed'),cleanup:()=>steps.push('cleaned')});
  assert.deepEqual(steps,['closed','cleaned']);
});

test('unconfirmed closure blocks destructive cleanup and preserves the operation error', async () => {
  const primary=new Error('original operation failure');
  const stopError=new Error('close unconfirmed');
  let cleaned=false,diagnostic;
  await assert.rejects(settleFixture({operationError:primary,stop:async()=>{throw stopError;},
    cleanup:()=>{cleaned=true;},observe:state=>{diagnostic=state;}}),error=>{
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors,[primary,stopError]);
    return true;
  });
  assert.equal(cleaned,false);
  assert.equal(diagnostic.phase,'cleanup-skipped');
});

test('confirmed close and failed deletion preserve both independent errors', async () => {
  const primary=new Error('assertion failure'),cleanup=new Error('EPERM');
  await assert.rejects(settleFixture({operationError:primary,stop:async()=>{},
    cleanup:()=>{throw cleanup;}}),error=>{
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors,[primary,cleanup]);
    return true;
  });
});

test('cleanup failure cannot convert a passing operation into PASS', async () => {
  const deletion=new Error('EPERM');
  await assert.rejects(settleFixture({stop:async()=>{},cleanup:()=>{throw deletion;}}),
    error=>error===deletion);
});

test('diagnostic failure does not hide original cleanup failure', async () => {
  const deletion=new Error('EPERM'),observer=new Error('diagnostics unavailable');
  await assert.rejects(settleFixture({cleanup:()=>{throw deletion;},observe:()=>{throw observer;}}),error=>{
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors,[deletion,observer]);
    return true;
  });
});
