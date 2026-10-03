import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { waitForState, canonicalText } from '../../scripts/e2e/helpers/observations.mjs';
import { commitExternalLock } from '../../scripts/e2e/helpers/external-lock.mjs';

const response = json => ({ url:()=> 'http://127.0.0.1/api/state', status:()=>200, json });
test('state observation retains parsed data without rereading a discarded navigation body', async () => {
  const page=new EventEmitter();let reads=0, discarded=false;
  const pending=waitForState(page,body=>body.run?.stage==='APPLIED',{timeout:1000});
  page.emit('response',response(async()=>{reads++;if(discarded)throw new Error('No resource with given identifier found');return {run:{stage:'APPLIED'}};}));
  discarded=true;
  assert.equal((await pending).run.stage,'APPLIED');assert.equal(reads,1);assert.equal(page.listenerCount('response'),0);
});
test('reload ignores only the discarded old body and reads the next real state', async () => {
  const page=new EventEmitter();const pending=waitForState(page,body=>body.run?.id==='new',{timeout:1000});
  page.emit('response',response(async()=>{throw new Error('Response body is not available for a response that was navigated away from');}));
  page.emit('response',response(async()=>({run:{id:'new'}})));
  assert.equal((await pending).run.id,'new');
});
test('state observation does not turn malformed JSON into a passing or synthetic snapshot', async () => {
  const page=new EventEmitter();const pending=waitForState(page,()=>true,{timeout:1000});
  page.emit('response',response(async()=>{throw new SyntaxError('Invalid JSON');}));
  await assert.rejects(pending,/Invalid JSON/u);assert.equal(page.listenerCount('response'),0);
});
test('canonical text permits checkout CRLF but preserves content differences',()=>{
  assert.equal(canonicalText('clock\r\n'),canonicalText('clock\n'));
  assert.notEqual(canonicalText('wrong\r\n'),canonicalText('clock\n'));
});
test('external writer COMMIT retries real rollback-journal BUSY and yields to reader release', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-commit-lock-'));
  const file=path.join(root,'state.sqlite'),writer=new DatabaseSync(file),reader=new DatabaseSync(file);
  t.after(()=>{reader.close();writer.close();fs.rmSync(root,{recursive:true,force:true});});
  writer.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE value(n); INSERT INTO value VALUES(1);');
  reader.exec('BEGIN');assert.equal(reader.prepare('SELECT n FROM value').get().n,1);
  writer.exec('BEGIN IMMEDIATE; UPDATE value SET n=2');let retries=0;
  const release=wait(60).then(()=>reader.exec('COMMIT'));
  await commitExternalLock(writer,{onBusy:()=>{retries++;}});await release;
  assert.ok(retries>0);assert.equal(reader.prepare('SELECT n FROM value').get().n,2);
});
test('external lock commit cannot swallow a non-lock error',async()=>{
  const error=Object.assign(new Error('disk failure'),{code:'ERR_SQLITE_ERROR',errcode:10});
  await assert.rejects(commitExternalLock({exec(){throw error;}}),e=>e===error);
});
