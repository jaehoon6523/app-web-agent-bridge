import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createLiveDiscussionRuntime } from '../../src/runtime/live-discussion-runtime.js';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../src/persistence/sqlite-store.js';
import { CodeChangeStore } from '../../src/persistence/code-change-store.js';
import { createBridgeServer } from '../../src/server.js';
import { resources } from '../../scripts/e2e/helpers/resources.mjs';
import { bounded } from '../../scripts/e2e/helpers/deadline.mjs';
import { assertNativeDatabaseClosed } from '../helpers/sqlite-closure.js';

test('native closure assertion rejects an open SQLite handle and accepts only a closed handle', () => {
  const database = new DatabaseSync(':memory:');
  try { assert.throws(() => assertNativeDatabaseClosed(database), {code:'ERR_ASSERTION'}); }
  finally { database.close(); }
  assertNativeDatabaseClosed(database);
});

test('SQLite initialization: shutdown cancels a real external writer wait before publishing a runtime', {timeout:7000}, async t => {
  const owner = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bootstrap-cancel-'));
  owner.add('contract workspace', () => fs.rmSync(root, {recursive:true,force:true}), 30);
  const runtimeConfig = {...loadConfig({cwd:root,env:{WORKSPACE:root,DEMO_MODE:'false',
    WEB_EXTENSION_SHARED_SECRET:'contract-bootstrap-secret-0123456789abcdef',
    WEB_EXTENSION_EXPECTED_IDENTITY:'contract-extension'}}),port:0};
  fs.mkdirSync(path.dirname(runtimeConfig.persistence.databasePath), {recursive:true});
  new SqliteStore(runtimeConfig.persistence.databasePath).close();
  new CodeChangeStore(runtimeConfig.persistence.databasePath).close();
  const locker = new DatabaseSync(runtimeConfig.persistence.databasePath);
  let locked = true;
  locker.exec('BEGIN IMMEDIATE');
  owner.add('contract writer', () => { if (locked) locker.exec('ROLLBACK'); locker.close(); }, 0);
  const events = [];
  let observedBusy;
  const busy = new Promise(resolve => { observedBusy = resolve; });
  const bridge = createBridgeServer({runtimeConfig,onDiagnostic:event => {
    events.push(event);
    if (event.type === 'runtime.initialization.sqlite-busy') observedBusy();
  }});
  owner.add('contract bridge', () => bridge.close(), 20);
  await bridge.listen();
  const initializing = bridge.getLiveRuntime();
  initializing.catch(() => {});
  await bounded(busy, 1000);
  // The writer remains locked throughout close. Cancellation must not wait for
  // the existing five-second initialization budget or create a usable runtime.
  await bounded(bridge.close(), 1000);
  await assert.rejects(initializing, error => error.code === 'SERVER_CLOSING');
  assert.equal(events.some(event => event.type === 'runtime.initialization.completed'), false);
  assert.ok(events.some(event => event.type === 'shutdown.stage.done' && event.stage === 'runtime initialization'));
  assert.equal(events.some(event => event.type === 'shutdown.stage.error'), false);
  assert.equal(bridge.server.listening, false);
  locker.exec('ROLLBACK'); locked = false;
});

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
    assertNativeDatabaseClosed(runtime.codeChanges.store.database);
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
    assertNativeDatabaseClosed(service.store.database);
    assert.ok(events.some(event=>event.type==='shutdown.stage.error' && event.stage==='registered workers close'));
    assert.ok(events.some(event=>event.type==='shutdown.stage.done' && event.stage==='worker SQLite store close'));
    await assert.rejects(service.close());
    assert.equal(closeCalls,1);
    fs.rmSync(root,{recursive:true,force:true});
  } finally {runtime.store.close();if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:true});}
});
