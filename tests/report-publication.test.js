import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {enqueueAgentReport,readAgentReport,writeAgentReport} from '../src/diagnostics/report-store.js';
import {removeOwnedFixture} from '../scripts/e2e/helpers/owned-fixture.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-report-publication-'));
  t.after(()=>removeOwnedFixture(root));
  await enqueueAgentReport(root,'server',{source:'committed'});
  const filename = path.join(root,'runtime-latest.json');
  return {root,filename,lock:filename+'.lock',previous:fs.readFileSync(filename,'utf8')};
}

test('Windows publication retries retain ownership, the old report and every committed section',async t => {
  const {root,filename,lock,previous} = await fixture(t);
  const rename = io.rename.bind(io), events = [];
  let attempts = 0, candidate, owner;
  t.mock.method(io,'rename',async (from,to) => {
    if (to !== filename) return rename(from,to);
    attempts++;
    candidate ??= from;
    owner ??= fs.readFileSync(lock,'utf8');
    assert.equal(from,candidate);
    assert.equal(fs.readFileSync(lock,'utf8'),owner);
    assert.equal(fs.readFileSync(filename,'utf8'),previous);
    const pending = JSON.parse(fs.readFileSync(from,'utf8'));
    assert.equal(pending.server.source,'committed');
    assert.equal(pending.repair.code,'repaired');
    if (attempts <= 2) {
      await assert.rejects(writeAgentReport(root,'extension',{source:'peer'}),{code:'DIAGNOSTIC_WRITER_BUSY'});
      assert.equal(fs.readFileSync(lock,'utf8'),owner);
      throw Object.assign(new Error('Injected publication denial'),{code:'EPERM',syscall:'rename',path:from,dest:to});
    }
    return rename(from,to);
  });
  await enqueueAgentReport(root,'repair',{code:'repaired'},{platform:'win32',onDiagnostic:e=>events.push(e)});
  t.mock.restoreAll();
  assert.equal(attempts,3);
  assert.equal(events.filter(e=>e.type==='agent.report.publication.wait').length,2);
  await enqueueAgentReport(root,'extension',{source:'peer'});
  const report = readAgentReport(root);
  assert.equal(report.server.source,'committed');
  assert.equal(report.repair.code,'repaired');
  assert.equal(report.extension.source,'peer');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

for (const [platform,code,expectedAttempts] of [['win32','EPERM',5],['linux','EPERM',1],['win32','EACCES',1],['win32','EIO',1]]) {
  test(`${platform} persistent publication ${code} preserves the original error and committed report`,async t => {
    const {root,filename,previous} = await fixture(t);
    const rename = io.rename.bind(io);
    let attempts = 0, first;
    t.mock.method(io,'rename',async (from,to) => {
      if (to !== filename) return rename(from,to);
      const error = Object.assign(new Error('Denied '+(++attempts)),{code,syscall:'rename',path:from,dest:to});
      first ??= error;
      throw error;
    });
    await assert.rejects(enqueueAgentReport(root,'repair',{code:'unsaved'},{platform}),
      error=>error===first && error.diagnosticOperation==='output.rename');
    assert.equal(attempts,expectedAttempts);
    assert.equal(fs.readFileSync(filename,'utf8'),previous);
    assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
    t.mock.restoreAll();
    await enqueueAgentReport(root,'extension',{source:'next'});
    const report = readAgentReport(root);
    assert.equal(report.server.source,'committed');
    assert.equal(report.repair,null);
    assert.equal(report.extension.source,'next');
  });
}
