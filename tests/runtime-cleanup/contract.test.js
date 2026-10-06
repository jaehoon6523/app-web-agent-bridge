import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig} from '../../src/config.js';
import {SqliteStore} from '../../src/persistence/sqlite-store.js';
import {observeChildClose, waitChildClose} from '../../src/runtime/child-close.js';
import {seedHistory} from '../helpers/code-history-fixture.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const identity = {
  commit:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repository, encoding:'utf8'}).trim(),
  tree:execFileSync('git', ['write-tree'], {cwd:repository, encoding:'utf8'}).trim(),
  os:{platform:process.platform, release:os.release(), arch:process.arch}, node:process.version,
};
const definitions = [
  {id:'T00', paths:['P12'], ready:true},
  {id:'T01', paths:['P01','P11','P12'], open:'Controller'},
  {id:'T02', paths:['P02','P11','P12'], init:'Controller'},
  {id:'T03', paths:['P02','P11','P12'], init:'Controller', close:['Controller']},
  {id:'T04', paths:['P03','P11','P12'], artifact:true},
  {id:'T05', paths:['P03','P11','P12'], artifact:true, close:['Controller']},
  {id:'T06', paths:['P04','P11','P12'], open:'Code'},
  {id:'T07', paths:['P04','P11','P12'], open:'Code', close:['Controller']},
  {id:'T08', paths:['P05','P11','P12'], init:'Code'},
  {id:'T09', paths:['P05','P11','P12'], init:'Code', close:['Code']},
  {id:'T10', paths:['P05','P11','P12'], init:'Code', close:['Controller']},
  {id:'T11', paths:['P05','P11','P12'], init:'Code', close:['Code','Controller']},
  {id:'T12', paths:['P06','P11','P12'], corrupt:true},
  {id:'T13', paths:['P06','P11','P12'], worker:'exit7', failed:true},
  {id:'T14', paths:['P06','P11','P12'], worker:'throw', failed:true},
  {id:'T15', paths:['P06','P11','P12'], worker:'resultless'},
  {id:'T16', paths:['P06','P11','P12'], close:['HistoryWorker'], failed:true},
  {id:'T17', paths:['P07','P11','P12'], worker:'cooperative', pending:true},
  {id:'T18', paths:['P07','P11','P12'], worker:'noncooperative', pending:true, failed:true},
  {id:'T19', paths:['P08','P11','P12'], setup:true},
  {id:'T20', paths:['P08','P11','P12'], setup:true, close:['Code']},
  {id:'T21', paths:['P08','P11','P12'], setup:true, close:['Controller']},
  {id:'T22', paths:['P08','P11','P12'], setup:true, close:['Code','Controller']},
  {id:'T23', paths:['P09','P12'], ready:true, close:['Code']},
  {id:'T24', paths:['P10','P12'], ready:true, close:['Controller']},
  // Same P08 boundary as T19: an operation may coincidentally carry this code.
  {id:'N01', paths:['P08','P11','P12'], setup:true, operationCode:'LIVE_RUNTIME_CLEANUP_FAILED'},
  // A real schema COMMIT error followed by native rollback failure is operation evidence.
  {id:'N02', paths:['P02','P11','P12'], rollback:true},
  {id:'N03', paths:['P03','P11','P12'], artifact:true, close:['Controller'], attempts:2},
];
function errorGraph(error, seen = new Set()) {
  if (!error || seen.has(error)) return null;
  seen.add(error);
  return {name:error.name, message:error.message, code:error.code,
    resourceClosureFailed:error.resourceClosureFailed, resourceOwner:error.resourceOwner, failureStage:error.failureStage,
    cause:errorGraph(error.cause, seen), operationError:errorGraph(error.operationError, new Set()),
    cleanupErrors:error.cleanupErrors?.map(e => errorGraph(e, new Set())),
    resourceFailures:error.resourceFailures?.map(f => ({resourceOwner:f.resourceOwner, failureStage:f.failureStage, error:errorGraph(f.error, new Set())})),
    detailsCause:errorGraph(error.details?.cause, new Set()),
    errors:error.errors?.map(e => errorGraph(e, new Set()))};
}
function reachable(error, predicate, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  return predicate(error) || [error.cause, error.operationError, ...(error.errors ?? []), ...(error.cleanupErrors ?? [])]
    .some(e => reachable(e, predicate, seen));
}
function prepare(root, config, mode) {
  const work = path.join(root, mode); fs.mkdirSync(work);
  const program = path.join(work, 'program'); fs.mkdirSync(program);
  for (const directory of ['src','scripts']) fs.cpSync(path.join(repository, directory), path.join(program, directory), {recursive:true});
  fs.writeFileSync(path.join(program, 'package.json'), '{"type":"module"}');
  const runtimeConfig = loadConfig({cwd:work, env:{WORKSPACE:work, CONTROLLER_DATA_DIR:work,
    DASHBOARD_TOKEN:'cleanup-contract-token-0123456789abcdef',
    WEB_EXTENSION_SHARED_SECRET:'cleanup-extension-secret-0123456789abcdef', WEB_EXTENSION_EXPECTED_IDENTITY:'cleanup-extension'}});
  new SqliteStore(runtimeConfig.persistence.databasePath).close();
  seedHistory(runtimeConfig.persistence.databasePath, {versions:8});
  if (config.corrupt) {
    const db = new DatabaseSync(runtimeConfig.persistence.databasePath);
    try { db.exec("UPDATE code_change_history SET record_json='{broken' WHERE version=1"); } finally { db.close(); }
  }
  if (config.artifact) {
    fs.mkdirSync(path.dirname(runtimeConfig.persistence.artifactDirectory), {recursive:true});
    fs.writeFileSync(runtimeConfig.persistence.artifactDirectory, 'actual mkdir obstruction');
  }
  const injectionFile = path.join(work, 'injection.jsonl');
  // Observe actual Job exit and forced state before it is cleared by prepare.
  // This adds no policy change, result substitution, or cancellation timing.
  const jobFile = path.join(program,'src/persistence/code-change-history-job.js');
  const jobSource = fs.readFileSync(jobFile,'utf8');
  fs.writeFileSync(jobFile, "import fs from 'node:fs';\n"+jobSource.replace('this.exited = true;',
    `this.exited = true; fs.appendFileSync(${JSON.stringify(injectionFile)}, JSON.stringify({owner:'HistoryJob', stage:'worker-exit-observed', filename, code, forced:Boolean(this.forced), cancelled:Boolean(this.cancelled)})+'\\n');`));
  // Keep the production adapter intact. Only its native dependency boundary is
  // instrumented in a byte-for-byte source copy, never a runtime return value.
  const adapter = path.join(program, 'src/persistence/sqlite-database.js');
  let source = fs.readFileSync(adapter, 'utf8');
  source = source.replace('DatabaseSync as NativeDatabaseSync', 'DatabaseSync as ActualDatabaseSync');
  source = source.replace('const needsEmptyRowCompatibility', `
import fs from 'node:fs';
import path from 'node:path';
import {isMainThread} from 'node:worker_threads';
const config = ${JSON.stringify(config)};
const target = ${JSON.stringify(runtimeConfig.persistence.databasePath)};
const injectionFile = ${JSON.stringify(injectionFile)};
function record(detail) { fs.appendFileSync(injectionFile, JSON.stringify({at:new Date().toISOString(), ...detail})+'\\n'); }
function fault(code) { return Object.assign(new Error(code), {code}); }
class NativeDatabaseSync extends ActualDatabaseSync {
  constructor(filename, options) {
    const stack = new Error().stack;
    const owner = path.resolve(String(filename)) !== path.resolve(target) ? 'OtherDatabase'
      : !isMainThread ? 'HistoryWorker' : stack.includes('new SqliteStore') ? 'Controller'
      : stack.includes('new CodeChangeStore') ? 'Code' : 'Prepare';
    record({owner, filename, stage:'open-attempt'});
    if (config.open === owner) { record({owner, stage:'open-failure-before-native'}); throw fault('INJECTED_'+owner+'_OPEN'); }
    super(filename, options ?? {}); this.owner = owner;
    record({owner, stage:'native-open-complete'});
  }
  exec(sql) {
    if (config.init === this.owner && ((this.owner === 'Controller' && sql === 'PRAGMA journal_mode = WAL')
      || (this.owner === 'Code' && sql.includes('CREATE TABLE IF NOT EXISTS main.code_change_runs')))) {
      record({owner:this.owner, stage:'initialization-failure-before-native-exec'}); throw fault('INJECTED_'+this.owner+'_INIT');
    }
    if (config.setup && this.owner === 'Code' && sql === 'PRAGMA busy_timeout=5000') {
      record({owner:this.owner, stage:'published-timeout-configuration-failure-before-native-exec'});
      const primary = fault('INJECTED_SETUP');
      const aggregate = new AggregateError([primary, fault('INJECTED_OPERATION_SECONDARY')], 'operation aggregate', {cause:primary});
      if (config.operationCode) aggregate.code = config.operationCode;
      throw aggregate;
    }
    const result = super.exec(sql);
    if (config.rollback && this.owner === 'Controller' && sql === 'COMMIT') {
      record({owner:this.owner, stage:'commit-reporting-failure-after-native-commit'});
      throw fault('INJECTED_COMMIT');
    }
    return result;
  }
  close() {
    record({owner:this.owner, stage:'native-close-attempt'});
    super.close(); record({owner:this.owner, stage:'native-close-complete'});
    if (config.close?.includes(this.owner)) {
      record({owner:this.owner, stage:'reporting-failure-after-native-close'}); throw fault('INJECTED_'+this.owner+'_CLOSE');
    }
  }
}
const needsEmptyRowCompatibility`);
  fs.writeFileSync(adapter, source);
  const workers = {
    exit7:'process.exit(7);', throw:'throw new Error("controlled Worker failure");', resultless:'',
    cooperative:`import {parentPort,workerData} from 'node:worker_threads';
      parentPort.postMessage({progress:0});
      const cancellation = new Int32Array(workerData.cancellation);
      const timer = setInterval(() => { if (Atomics.load(cancellation,0)) { clearInterval(timer); parentPort.close(); } },10);`,
    noncooperative:`import {parentPort} from 'node:worker_threads'; parentPort.postMessage({progress:0}); setInterval(()=>{},1000);`,
  };
  if (config.worker) fs.writeFileSync(path.join(program, 'src/persistence/code-change-history-worker.js'), workers[config.worker]);
  const copies = {};
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function inspect(directory, relative = '') {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const name = path.join(relative,entry.name);
      if (entry.isDirectory()) inspect(path.join(directory,entry.name),name);
      else if (entry.isFile()) copies[name] = {production:hash(path.join(repository,name)), probe:hash(path.join(program,name))};
    }
  }
  for (const dir of ['src','scripts']) inspect(path.join(program,dir),dir);
  const allowed = ['src/persistence/sqlite-database.js','src/persistence/code-change-history-job.js',
    ...(config.worker ? ['src/persistence/code-change-history-worker.js'] : [])];
  for (const [name,values] of Object.entries(copies)) if (!allowed.includes(name)) assert.equal(values.probe,values.production,name+' source copy identity');
  return {work, program, runtimeConfig, injectionFile, copies};
}
function readInjection(context) { return fs.existsSync(context.injectionFile) ? fs.readFileSync(context.injectionFile,'utf8').trim().split('\n').map(JSON.parse) : []; }
function assertOwners(config, entries) {
  assert.equal(entries.some(e => e.owner === 'OtherDatabase' && e.stage.includes('failure')), false);
  assert.equal(entries.some(e => e.owner === 'Prepare' && e.stage.includes('failure')), false);
  const expected = config.open === 'Controller' ? [] : config.init === 'Controller' || config.artifact || config.rollback ? ['Controller']
    : config.open === 'Code' ? ['Controller'] : ['Code','Controller'];
  for (const owner of expected) assert.equal(entries.filter(e => e.owner === owner && e.stage === 'native-close-complete').length, config.attempts ?? 1, owner+' must close once per attempt');
  for (const owner of config.close ?? []) assert.ok(entries.some(e => e.owner === owner && e.stage === 'reporting-failure-after-native-close'), owner+' fault reached');
}
async function directProbe(context, config) {
  if (config.attempts) {
    const {createBridgeServer} = await import(pathToFileURL(path.join(context.program,'src/server.js')));
    const events = [], attemptErrors = [];
    const bridge = createBridgeServer({runtimeConfig:context.runtimeConfig, onDiagnostic:event => events.push(event)});
    let closure;
    try {
      for (let attempt = 0; attempt < config.attempts; attempt++) {
        await assert.rejects(bridge.getLiveRuntime(), error => {attemptErrors.push(error); return true;});
      }
      const settled = await Promise.allSettled([bridge.close(), bridge.close()]);
      assert.equal(settled[0].status,'rejected'); assert.equal(settled[1].status,'rejected');
      closure = settled[0].reason;
      assert.equal(settled[1].reason,closure);
      await assert.rejects(bridge.close(), error => error === closure);
      const collected = closure.errors.find(error => error.cause?.resourceOwner === 'BridgeServer').cause;
      assert.deepEqual(collected.errors,attemptErrors);
      assert.equal(collected.cause,attemptErrors[0]);
      assert.equal(collected.operationError,attemptErrors[0].operationError);
      assert.notEqual(attemptErrors[0],attemptErrors[1]);
      assert.deepEqual(collected.cleanupErrors,attemptErrors.flatMap(error => error.cleanupErrors));
      assert.deepEqual(collected.resourceFailures,attemptErrors.flatMap(error => error.resourceFailures));
      return {runtime:null, operation:attemptErrors.at(-1), closure, error:closure, events, attemptErrors};
    } finally {await bridge.close().catch(() => {});}
  }
  const {createLiveDiscussionRuntime} = await import(pathToFileURL(path.join(context.program,'src/runtime/live-discussion-runtime.js')));
  const abort = new AbortController(), events = [];
  let runtime, operation, closure;
  try {
    runtime = await createLiveDiscussionRuntime({runtimeConfig:context.runtimeConfig, webSession:{start() {}},
      initializationSignal:abort.signal, onDiagnostic:event => {
        events.push(event);
        if (config.pending && event.type === 'persistence.code-store.history-background.progress') abort.abort(Object.assign(new Error('controlled cancellation'), {code:'INJECTED_ABORT'}));
      }});
  } catch (error) { operation = error; }
  if (runtime) {
    const settled = await Promise.allSettled([runtime.close(), runtime.close()]);
    if (settled[0].status === 'rejected') {
      closure = settled[0].reason;
      assert.equal(settled[1].status,'rejected'); assert.equal(settled[1].reason,closure);
    } else assert.equal(settled[1].status,'fulfilled');
    // Repeated public close must preserve the same settled rejection.
    if (closure) await assert.rejects(runtime.close(), error => error === closure);
    else await runtime.close();
  }
  const error = closure ?? operation;
  return {runtime, operation, closure, error, events};
}
async function serverProbe(context, config) {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  context.runtimeConfig = {...context.runtimeConfig, port, baseUrl:'http://127.0.0.1:'+port};
  const events = [], changed = new EventEmitter();
  const {runDiagnosticServer} = await import(pathToFileURL(path.join(context.program,'scripts/diagnose-server.mjs')));
  const child = runDiagnosticServer({runtimeConfig:context.runtimeConfig, outputFile:path.join(context.work,'server.jsonl'),
    onEvent:event => { events.push(event); changed.emit('event',event); }});
  const observation = observeChildClose(child); let stopped;
  const stop = () => stopped ??= waitChildClose(child, observation, {timeoutMs:8000, request:() => {if(child.connected) child.send({type:'bridge.shutdown'});}});
  async function until(type) {
    if (events.some(e => e.type === type)) return;
    let timer, listener;
    try { await new Promise((resolve,reject) => {
      listener = e => {if(e.type === type) resolve();}; changed.on('event',listener);
      timer = setTimeout(() => reject(new Error('Missing checkpoint '+type)), 10000);
    }); } finally { clearTimeout(timer); changed.off('event',listener); }
  }
  const http = [];
  try {
    await until('server.listening');
    const pending = fetch(context.runtimeConfig.baseUrl+'/api/state', {headers:{authorization:'Bearer cleanup-contract-token-0123456789abcdef'}, signal:AbortSignal.timeout(6000)});
    pending.catch(() => {});
    let state;
    if (config.pending) await until('persistence.code-store.history-background.progress');
    else {
      const response = await pending; http.push({route:'/api/state',status:response.status});
      state = await response.json();
      for (let attempt = 1; attempt < (config.attempts ?? 1); attempt++) {
        const repeated = await fetch(context.runtimeConfig.baseUrl+'/api/state', {headers:{authorization:'Bearer cleanup-contract-token-0123456789abcdef'}, signal:AbortSignal.timeout(6000)});
        http.push({route:'/api/state',status:repeated.status}); state = await repeated.json();
        assert.equal(state.runtimeAvailability.ready,false);
      }
    }
    for (const route of ['/api/health','/api/preflight']) {
      const response = await fetch(context.runtimeConfig.baseUrl+route, {signal:AbortSignal.timeout(1500)});
      await response.arrayBuffer(); http.push({route,status:response.status});
    }
    const childClosure = await stop();
    let pendingError;
    if (config.pending) {
      try { const response = await pending; http.push({route:'/api/state',status:response.status}); state = await response.json(); }
      catch (error) { pendingError = errorGraph(error); }
    }
    return {events, http, state, childClosure, pendingError};
  } finally { await stop(); }
}
const selected = process.env.RUNTIME_CLEANUP_IDS?.split(',');
for (const config of definitions.filter(c => !selected || selected.includes(c.id))) {
  test(config.id+' '+config.paths.join(' → '), {timeout:30000}, async t => {
    const root = fs.mkdtempSync(path.join(repository,'.runtime-cleanup-contract-'));
    const evidenceRoot = path.resolve(process.env.RUNTIME_CLEANUP_EVIDENCE ?? path.join(repository,'evidence/runtime-cleanup'));
    fs.mkdirSync(evidenceRoot, {recursive:true});
    const evidence = {id:config.id, paths:config.paths, ...identity, injection:config,
      injectionBoundary:'sqlite-database native dependency adapter; exact filename plus constructor stack/thread owner; close reporting failure AFTER native close',
      sourceCopy:'src and scripts copied without product edits; only sqlite native dependency and selected controlled Worker program instrumented'};
    try {
      const direct = prepare(root, config, 'direct');
      const result = await directProbe(direct, config);
      evidence.operation = errorGraph(result.operation); evidence.closure = errorGraph(result.closure);
      evidence.attemptErrors = result.attemptErrors?.map(error => errorGraph(error));
      evidence.directEvents = result.events; evidence.directInjection = readInjection(direct); evidence.directSourceHashes = direct.copies;
      const server = prepare(root, config, 'server');
      const observed = await serverProbe(server, config);
      evidence.pendingHttpError = observed.pendingError; evidence.http = observed.http; evidence.ready = observed.state?.runtimeAvailability?.ready;
      evidence.knowledge = observed.state?.dataKnowledge?.runs?.status;
      evidence.childClosure = observed.childClosure;
      evidence.shutdownErrors = observed.events.filter(e => e.type === 'shutdown.stage.error');
      evidence.deadline = observed.events.some(e => e.type === 'shutdown.deadline');
      evidence.forced = readInjection(server).filter(e => e.stage === 'worker-exit-observed').map(e => e.forced);
      evidence.serverInjection = readInjection(server); evidence.serverSourceHashes = server.copies;
      fs.copyFileSync(path.join(server.work,'server.jsonl'), path.join(evidenceRoot,config.id+'-server.jsonl'));
      const failed = Boolean(config.failed || config.close?.length);
      assert.equal(Boolean(result.runtime), Boolean(config.ready));
      if (!config.ready) {
        assert.ok(result.operation);
        if (config.operationCode) assert.equal(result.operation.code,config.operationCode);
        else assert.equal(result.operation.code === 'LIVE_RUNTIME_CLEANUP_FAILED', failed);
        assert.equal(result.operation.resourceClosureFailed === true, failed);
        if (failed) {
          assert.equal(result.operation.resourceOwner,'LiveDiscussionRuntime');
          assert.ok(result.operation.failureStage);
          assert.ok(result.operation.operationError);
          assert.ok(result.operation.cleanupErrors.length > 0);
          assert.equal(result.operation.errors[0],result.operation.cause);
        }
      }
      for (const owner of config.close ?? []) {
        // Worker errors are intentionally sanitized at the existing worker boundary.
        if (owner !== 'HistoryWorker') assert.ok(reachable(result.error,e => e.code === 'INJECTED_'+owner+'_CLOSE'), owner+' cleanup preserved');
      }
      if (config.init || config.open) assert.ok(reachable(result.error,e => e.code === 'INJECTED_'+(config.init ?? config.open)+'_'+(config.init ? 'INIT' : 'OPEN')), 'original operation preserved');
      if (config.init && failed) {
        assert.equal(result.operation.operationError.code,'INJECTED_'+config.init+'_INIT');
        const owners = result.operation.resourceFailures.map(f => f.resourceOwner);
        for (const owner of config.close) assert.ok(owners.includes(owner === 'Code' ? 'CodeChangeStore' : 'SqliteStore'));
        assert.equal(result.operation.cleanupErrors.length,config.close.length);
        for (const failure of result.operation.resourceFailures) {
          const owner = failure.resourceOwner === 'CodeChangeStore' ? 'Code' : 'Controller';
          assert.equal(failure.error.code,'INJECTED_'+owner+'_CLOSE');
          assert.ok(result.operation.cleanupErrors.includes(failure.error));
        }
        if (config.close.includes(config.init)) {
          const constructorError = result.operation.cause;
          assert.equal(constructorError.operationError,result.operation.operationError);
          assert.equal(constructorError.cause,result.operation.operationError);
          assert.equal(constructorError.errors[0],result.operation.operationError);
        }
      }
      if (config.setup) {
        assert.ok(reachable(result.error,e => e.code === 'INJECTED_SETUP'));
        assert.ok(reachable(result.error,e => e.code === 'INJECTED_OPERATION_SECONDARY'));
        const operation = failed ? result.operation.operationError : result.operation;
        assert.ok(operation instanceof AggregateError);
        assert.equal(operation.cause,operation.errors[0]);
        assert.deepEqual(operation.errors.map(error => error.code),['INJECTED_SETUP','INJECTED_OPERATION_SECONDARY']);
        if (failed) {
          assert.equal(result.operation.cause,operation);
          assert.equal(result.operation.errors[0],operation);
          assert.equal(result.operation.resourceFailures.length,config.close.length);
          assert.deepEqual(result.operation.resourceFailures.map(failure => failure.resourceOwner),
            config.close.map(owner => owner === 'Code' ? 'CodeChangeStore' : 'SqliteStore'));
          for (const [index,failure] of result.operation.resourceFailures.entries()) {
            assert.equal(failure.failureStage,'initialization.close');
            assert.equal(failure.error,result.operation.cleanupErrors[index]);
            assert.equal(failure.error,result.operation.errors[index+1]);
            assert.equal(failure.error.code,'INJECTED_'+config.close[index]+'_CLOSE');
          }
        }
      }
      if (config.rollback) {
        assert.ok(result.operation instanceof AggregateError);
        assert.equal(result.operation.cause,result.operation.errors[0]);
        assert.equal(result.operation.errors[0].code,'INJECTED_COMMIT');
        assert.equal(result.operation.errors[1].code,'ERR_SQLITE_ERROR');
        assert.match(result.operation.errors[1].message,/no transaction is active/u);
        assert.equal(result.operation.resourceClosureFailed,undefined);
      }
      assertOwners(config,evidence.directInjection); assertOwners(config,evidence.serverInjection);
      if (!config.pending) {
        assert.equal(evidence.ready, Boolean(config.ready));
        if (!config.ready) assert.equal(evidence.knowledge,'UNAVAILABLE');
      }
      for (const response of evidence.http) assert.equal(response.status,200);
      assert.deepEqual(observed.childClosure,{code:failed ? 1 : 0,signal:null});
      assert.equal(evidence.deadline,false);
      assert.ok(observed.events.some(e => e.type === 'shutdown.stage.done' && e.stage === 'HTTP server close'));
      assert.ok(observed.events.some(e => e.type === 'shutdown.ipc.start'));
      assert.equal(evidence.shutdownErrors.length > 0, failed);
      if (!config.ready && failed) assert.equal(evidence.shutdownErrors[0].errorCode,'LIVE_RUNTIME_CLEANUP_FAILED');
      if (!config.ready) assert.equal(observed.events.some(e => e.type === 'persistence.code-store.history-background.completed') && !config.setup,false);
      if (config.pending) assert.deepEqual(evidence.forced,[config.id === 'T18']);
      evidence.verdict = 'PASS';
    } catch (error) { evidence.verdict = 'FAIL'; evidence.assertion = errorGraph(error); throw error; }
    finally {
      fs.writeFileSync(path.join(evidenceRoot,config.id+'.json'),JSON.stringify(evidence,null,2)+'\n');
      t.diagnostic(JSON.stringify({id:config.id,verdict:evidence.verdict,childClosure:evidence.childClosure,log:path.join(evidenceRoot,config.id+'.json')}));
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
}

for (const owner of ['Controller','Code']) {
  for (const failed of [false,true]) {
    test(`C08 ${owner} Store repeated close preserves ${failed ? 'failure' : 'success'}`, async () => {
      const root = fs.mkdtempSync(path.join(repository,'.runtime-cleanup-store-'));
      try {
        const context = prepare(root,{close:failed ? [owner] : []},'store');
        const {SqliteStore} = await import(pathToFileURL(path.join(context.program,'src/persistence/sqlite-store.js')));
        const {CodeChangeStore} = await import(pathToFileURL(path.join(context.program,'src/persistence/code-change-store.js')));
        const store = owner === 'Controller' ? new SqliteStore(context.runtimeConfig.persistence.databasePath)
          : new CodeChangeStore(context.runtimeConfig.persistence.databasePath,{verification:'background'});
        let first;
        try {await store.close();} catch (error) {first = error;}
        assert.equal(Boolean(first),failed);
        const close = async () => store.close();
        if (failed) {
          assert.equal(first.code,'INJECTED_'+owner+'_CLOSE');
          const settled = await Promise.allSettled([close(),close()]);
          for (const result of settled) {assert.equal(result.status,'rejected'); assert.equal(result.reason,first);}
          await assert.rejects(close(), error => error === first);
        } else {await Promise.all([close(),close()]); await close();}
        assert.equal(readInjection(context).filter(event => event.owner === owner && event.stage === 'native-close-attempt').length,1);
      } finally {fs.rmSync(root,{recursive:true,force:true});}
    });
  }
}
