import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {seedHistory} from './helpers/code-history-fixture.js';
import {canonicalJson,sha256CanonicalJson} from '../src/domain/canonical-json.js';
import {diagnosticErrorDetails} from '../src/diagnostics/server-observer.js';

for (const legacy of [false,true]) test(`history fixture preserves canonical records and chain (legacy=${legacy})`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-fixture-contract-'));
  let db;
  try {
    const filename=path.join(root,'history.sqlite');
    const seeded=seedHistory(filename,{versions:32,eventBytes:64,legacy});
    db=new DatabaseSync(filename);
    const rows=db.prepare('SELECT * FROM code_change_history ORDER BY version').all();
    assert.equal(rows.length,32);
    let previousHash=null;
    for (const row of rows) {
      const record=JSON.parse(row.record_json);
      assert.equal(record.events.length,row.version);
      assert.ok(record.events.every((event,index)=>event.version===index+1 && event.detail==='x'.repeat(64)));
      assert.equal(row.record_json,canonicalJson(record));
      assert.equal(row.record_hash,sha256CanonicalJson(record));
      const entryHash=sha256CanonicalJson({kind:'CODE_CHANGE_HISTORY',runId:record.runId,
        version:row.version,recordHash:row.record_hash,previousHash});
      assert.equal(row.previous_hash,legacy?null:previousHash);
      assert.equal(row.entry_hash,legacy?null:entryHash);
      previousHash=entryHash;
    }
    assert.equal(seeded.headHash,previousHash);
    const current=db.prepare('SELECT * FROM code_change_runs').get();
    assert.equal(current.record_json,canonicalJson(seeded.record));
    assert.equal(current.record_hash,rows.at(-1).record_hash);
  } finally {db?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('nested failure diagnostics retain codes without messages or paths and bound cycles',()=>{
  const cause=Object.assign(new Error('secret body'),{code:'SQLITE_BUSY',errcode:5,path:'/secret'});
  const exit=Object.assign(new Error('private URL'),{code:'WORKER_EXIT',exitCode:1,terminationConfirmed:true});
  const aggregate=new AggregateError([cause,exit],'private aggregate');
  cause.cause=aggregate;
  assert.deepEqual(diagnosticErrorDetails(aggregate),[
    {code:'AggregateError',parent:null},
    {code:'SQLITE_BUSY',parent:0,errcode:5},
    {code:'WORKER_EXIT',parent:0,exitCode:1,terminationConfirmed:true},
  ]);
  assert.equal(diagnosticErrorDetails(new AggregateError(Array.from({length:30},()=>new Error('secret')))).length,8);
  assert.deepEqual(diagnosticErrorDetails({code:'https://private/?token=secret'}),[{code:'ERROR',parent:null}]);
});
