import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createLiveDiscussionRuntime } from '../../src/runtime/live-discussion-runtime.js';

test('runtime close rejection still closes both real SQLite handles before workspace deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-platform-sqlite-'));
  const runtimeConfig = loadConfig({cwd:root,env:{WORKSPACE:root,DEMO_MODE:'false'}});
  const events = [];
  const runtime = await createLiveDiscussionRuntime({runtimeConfig,webSession:{start(){}},onDiagnostic:event => events.push(event)});
  const codeClose = runtime.codeChanges.close.bind(runtime.codeChanges);
  const storeClose = runtime.store.close.bind(runtime.store);
  let storeCloses = 0;
  runtime.store.close = () => {storeCloses++; storeClose();};
  runtime.codeChanges.close = async () => {await codeClose(); throw new Error('controlled registry close rejection');};
  try {
    await assert.rejects(runtime.close(), /worker registry close/u);
    assert.equal(storeCloses, 1);
    assert.equal(runtime.codeChanges.store.database.isOpen, false);
    assert.throws(() => runtime.store.listRuns(), error => error.code === 'STORE_CLOSED');
    assert.ok(events.some(event => event.type === 'shutdown.stage.done' && event.stage === 'controller store close'));
    await assert.rejects(runtime.close());
    assert.equal(storeCloses, 1);
    // Windows deletion is attempted only after handle closure; no rm retry masks it.
    fs.rmSync(root, {recursive:true,force:true});
    assert.equal(fs.existsSync(root), false);
  } finally {await codeClose(); storeClose(); if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:true});}
});

test('unconfirmed worker close cannot become a successful registry shutdown or skip SQLite close', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-platform-registry-'));
  const runtimeConfig=loadConfig({cwd:root,env:{WORKSPACE:root,DEMO_MODE:'false'}});
  const events=[];
  const runtime=await createLiveDiscussionRuntime({runtimeConfig,webSession:{start(){}},onDiagnostic:event=>events.push(event)});
  const service=runtime.codeChanges;
  const run=service.store.save({runId:'contract-close-run',stage:'WORKER_RUNNING'});
  let closeCalls=0;
  service.workers.set(run.runId,{close:async()=>{closeCalls++;throw new Error('controlled worker resource leak');}});
  try {
    await assert.rejects(runtime.close(),/worker registry close/u);
    assert.equal(closeCalls,1);
    assert.equal(service.store.database.isOpen,false);
    assert.ok(events.some(event=>event.type==='shutdown.stage.error' && event.stage==='registered workers close'));
    assert.ok(events.some(event=>event.type==='shutdown.stage.done' && event.stage==='worker SQLite store close'));
    await assert.rejects(service.close());
    assert.equal(closeCalls,1);
    fs.rmSync(root,{recursive:true,force:true});
  } finally {runtime.store.close();if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:true});}
});
