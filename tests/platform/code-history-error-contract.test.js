import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CodeChangeHistoryJob} from '../../src/persistence/code-change-history-job.js';
import {seedHistory} from '../helpers/code-history-fixture.js';

for (const [index,prefix] of ['', 'Code change '].entries()) {
  test(`case ${index+1}: arbitrary SQLite trigger text is suppressed with prefix ${JSON.stringify(prefix)}`, async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-review-prefix-'));
    const filename=path.join(root,'state.sqlite');
    const marker='TEST_ONLY_PRIVATE_LOCATION';
    let job;
    try {
      seedHistory(filename,{legacy:true});
      const database=new DatabaseSync(filename);
      try {database.exec(`CREATE TRIGGER reject_migration BEFORE UPDATE ON main.code_change_history BEGIN SELECT RAISE(ABORT,'${prefix}${marker}'); END`);}
      finally {database.close();}
      job=new CodeChangeHistoryJob(filename,{migrate:true});
      const result=await job.result.then(value=>({value}),error=>({error}));
      await job.closed;
      assert.equal(result.error?.code,'ERR_SQLITE_ERROR');
      assert.equal(job.exited,true);
      console.log(JSON.stringify({prefix,message:result.error.message,threadExited:job.exited,forced:!!job.forced}));
      assert.equal(result.error.message.includes(marker),false,'arbitrary trigger payload must not cross the Worker error boundary');
    } finally {
      if(job){job.cancel();await job.closed.catch(()=>{});}
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
}

const source=new URL('../../src/',import.meta.url);

const serial=error=> error===undefined ? null : ({message:error.message,code:error.code,errcode:error.errcode,
  errors:error.errors?.map(serial),causeIndex:error.errors?.indexOf(error.cause)});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function setup(config){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-error-contract-'));
  fs.mkdirSync(path.join(root,'persistence'));fs.mkdirSync(path.join(root,'domain'));
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const copied={};
  for(const name of ['persistence/code-change-history-job.js','persistence/code-change-history-worker.js','persistence/code-change-history.js','domain/canonical-json.js']){
    const bytes=fs.readFileSync(new URL(name,source));fs.writeFileSync(path.join(root,name),bytes);copied[name]=hash(bytes);
  }
  const filename=path.join(root,'state.sqlite');
  seedHistory(filename,{legacy:config.id!==3});
  const db=new DatabaseSync(filename);
  try{
    if(config.id===3)db.exec("UPDATE code_change_history SET record_hash='broken' WHERE version=1");
    if(config.primary)db.exec(`CREATE TRIGGER reject_migration BEFORE UPDATE ON main.code_change_history BEGIN SELECT RAISE(ABORT,'${config.primary}'); END`);
  }finally{db.close();}
  if(config.rollback || config.close || config.id===4){
    fs.writeFileSync(path.join(root,'persistence/sqlite-database.js'),`
      import {DatabaseSync as Native} from 'node:sqlite';
      import {parentPort,workerData} from 'node:worker_threads';
      export class DatabaseSync extends Native {
        exec(sql){const result=super.exec(sql);if(sql==='ROLLBACK' && ${!!config.rollback})throw Object.assign(new Error(${JSON.stringify(config.rollback??'')}),{code:'ROLLBACK_REPORT_FAILED'});return result;}
        close(){super.close();if(${!!config.close})throw Object.assign(new Error(${JSON.stringify(config.close??'')}),{code:'CLOSE_REPORT_FAILED'});}
        prepare(sql){const stmt=super.prepare(sql);
          if(${config.id===4} && sql.startsWith('UPDATE main.code_change_history SET previous_hash=')){
            const run=stmt.run.bind(stmt);let notified=false;
            stmt.run=(...args)=>{const result=run(...args);if(!notified){notified=true;parentPort.postMessage({progress:1});
              const cancellation=new Int32Array(workerData.cancellation);
              const outcome=Atomics.wait(cancellation,0,0,1500);
              if(!Atomics.load(cancellation,0))throw new Error('fixture cancellation checkpoint timed out: '+outcome);
            }return result;};
          }return stmt;
        }
      }
    `);
  }else{fs.copyFileSync(new URL('persistence/sqlite-database.js',source),path.join(root,'persistence/sqlite-database.js'));}
  return {root,filename,copied};
}
const cases=[
  {id:3,label:'internal integrity error keeps its fixed meaning'},
  {id:4,label:'cooperative cancel preserves operation rejection and normal closure'},
  {id:5,label:'primary plus rollback reporting failure preserves two errors',primary:'TEST_ONLY_primary',rollback:'TEST_ONLY_rollback'},
  {id:6,label:'primary plus close reporting failure preserves two errors',primary:'TEST_ONLY_primary',close:'TEST_ONLY_close'},
  {id:7,label:'primary plus rollback and close preserves three errors and suppresses each arbitrary text',primary:'Code change TEST_ONLY_primary',rollback:'Code change TEST_ONLY_rollback',close:'Code change TEST_ONLY_close'},
  {id:8,label:'successful operation plus close failure never publishes a success',close:'TEST_ONLY_close'},
];
for(const config of cases){
  test(`case ${config.id}: ${config.label}`,{timeout:10000},async()=>{
    const {root,filename,copied}=setup(config);
    let job,record;
    try{
      const {CodeChangeHistoryJob}=await import(pathToFileURL(path.join(root,'persistence/code-change-history-job.js')));
      const reason=Object.assign(new Error('operator cancellation'),{code:'TEST_CANCEL'});
      job=new CodeChangeHistoryJob(filename,{migrate:config.id!==3,onProgress:()=>{
        if(config.id===4){job.cancel(reason);Atomics.notify(job.cancellation,0);}
      }});
      const messages=[];job.worker.on('message',message=>messages.push(message));
      const operation=await job.result.then(value=>({resolved:true,value}),error=>({resolved:false,error}));
      const closure=await job.closed.then(()=>({resolved:true}),error=>({resolved:false,error}));
      const durable=new DatabaseSync(filename);
      let rows;
      try{rows=durable.prepare('SELECT count(*) AS total,sum(entry_hash IS NOT NULL) AS hashed FROM code_change_history').get();}
      finally{durable.close();}
      record={case:config.id,label:config.label,operation:{resolved:operation.resolved,error:serial(operation.error)},
        closure:{resolved:closure.resolved,error:serial(closure.error)},wire:messages.filter(m=>m.progress===undefined),
        exited:job.exited,forced:!!job.forced,durable:{...rows},unchangedProductionCopies:copied};console.log(JSON.stringify(record));
      assert.equal(operation.resolved,false,'failure/cancel/cleanup case must not publish success');
      assert.equal(job.exited,true);assert.equal(!!job.forced,false);
      if(config.id===3){
        assert.equal(operation.error.message,'Code change history integrity check failed.');assert.equal(closure.resolved,true);
      }else if(config.id===4){
        assert.equal(job.cancelled,true);assert.equal(operation.error,reason);assert.equal(closure.resolved,true);
        assert.equal(record.wire.at(-1).error.message,'Code change history verification cancelled.');assert.equal(rows.hashed,0);
      }else{
        assert.ok(operation.error instanceof AggregateError);assert.equal(closure.resolved,false);
        assert.equal(closure.error.code,'CODE_CHANGE_HISTORY_CLEANUP_FAILED');
        const errors=operation.error.errors;
        assert.equal(errors.length,config.id===7?3:config.id===8?1:2);
        assert.equal(operation.error.cause,errors[0]);
        if(config.id!==8){assert.equal(errors[0].code,'ERR_SQLITE_ERROR');assert.equal(rows.hashed,0);}
        else{assert.equal(errors[0].code,'CLOSE_REPORT_FAILED');assert.equal(rows.hashed,8);}
        if(config.rollback)assert.equal(errors[1].code,'ROLLBACK_REPORT_FAILED');
        if(config.close)assert.equal(errors.at(-1).code,'CLOSE_REPORT_FAILED');
        const text=JSON.stringify(record.wire);
        assert.equal(text.includes('TEST_ONLY_'),false,'each arbitrary primary/cleanup message must be suppressed');
      }
      record.test='PASS';
    }catch(error){if(record){record.test='FAIL';record.assertion=error.message;}throw error;}
    finally{
      if(job){job.cancel();await job.closed.catch(()=>{});}
      fs.rmSync(root,{recursive:true,force:true});if(record)record.fixtureRemoved=!fs.existsSync(root);
      if(record) console.log(JSON.stringify({case:config.id,test:record.test,fixtureRemoved:record.fixtureRemoved}));
    }
  });
}
