import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { generateSelectorRepair, applySelectorRepair, inspectSelectorRepair, SelectorRepairJournal } from '../src/orchestration/selector-repair.js';
import { collectSelectorDiagnostics } from '../src/orchestration/selector-diagnostics.js';

const snapshot = { tabs:[{ tabId:7, runtimeVersion:"0.2.11", extensionVersion:"0.2.11", url:"https://chatgpt.com/", pageUrl:"https://chatgpt.com/", composerPresent:false, busy:false, generating:false,
  pageStatus:'UI_CONTRACT_CHANGED', diagnostics:{ editableCandidates:[{ selector:"[contenteditable='true']", visible:1, samples:[{
    tagName:'DIV', controls:[{controlLabel:'음성 입력', secret:'PRIVATE_SECRET'}], responseBody:'PRIVATE_RESPONSE' }]}] } }] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-selector-repair-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const targetRoot = path.join(root, 'target'); fs.mkdirSync(targetRoot);
  const write = (name, value) => { const filename = path.join(targetRoot, name); fs.mkdirSync(path.dirname(filename), { recursive:true }); fs.writeFileSync(filename, value); };
  write('package.json', '{"name":"app-web-agent-bridge"}');
  write('extension/manifest.json', '{"version":"0.2.11"}');
  write('.gitignore', '.agent-controller/\nnode_modules/\n');
  write('extension/selectors/composer-selectors.js', 'export const selectors = [];\n');
  write('tests/existing.test.js', 'unchanged test');
  const git = (...args) => execFileSync('git', ['-C', targetRoot, ...args], { encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'baseline');
  let started = 0, closed = 0, prompt = '';
  const createWorker = async ({ workspace }) => ({
    async start() { started++; },
    async close() { closed++; },
    async submitTurn({ text }) {
      prompt = text;
      fs.writeFileSync(path.join(workspace.root, 'extension/selectors/composer-selectors.js'), 'export const selectors = ["new"];\n');
      fs.writeFileSync(path.join(workspace.root, 'tests/selector-repair-observed.test.js'), 'regression');
      return { completion:Promise.resolve({status:'completed'}) };
    },
  });
  return { targetRoot, git, createWorker, counters:() => ({ started, closed, prompt }) };
}

test('repair supplies purpose and bounded DOM to an isolated worker, logs before mutation, and requires exact approval', async t => {
  const f = fixture(t);
  const result = await generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:async () => {} });
  assert.equal(result.stage, 'AWAITING_APPROVAL');
  assert.equal(f.git('status', '--porcelain'), '');
  const c = f.counters(); assert.equal(c.started, 1); assert.equal(c.closed, 1);
  assert.match(c.prompt, /REPAIR_COMPOSER_DETECTION/u); assert.match(c.prompt, /음성 입력/u);
  assert.doesNotMatch(c.prompt, /PRIVATE_SECRET|PRIVATE_RESPONSE/u);
  const log = fs.readFileSync(result.logFile, 'utf8');
  assert.match(log, /REPAIR_STARTED/u); assert.match(log, /VERIFICATION_STARTED/u);
  assert.doesNotMatch(log, /음성 입력|PRIVATE_|summary/u);
  assert.throws(() => applySelectorRepair(f.targetRoot, result.jobId, 'wrong'), {code:'REPAIR_APPROVAL_REQUIRED'});
  applySelectorRepair(f.targetRoot, result.jobId, result.patchHash);
  assert.equal(inspectSelectorRepair(f.targetRoot, result.jobId).applicationState, 'APPLIED');
  assert.throws(() => applySelectorRepair(f.targetRoot, result.jobId, result.patchHash), {code:'REPAIR_APPROVAL_REQUIRED'});
  assert.match(fs.readFileSync(result.logFile, 'utf8'), /APPLY_STARTED.*\n.*APPLIED/su);
});

test('failed verification preserves the target and blocks application', async t => {
  const f = fixture(t); let failure;
  try { await generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:async () => { throw Object.assign(new Error('PRIVATE_BODY'), {code:'REPAIR_VERIFICATION_FAILED'}); } }); }
  catch (error) { failure = error; }
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.counters().closed, 1);
  assert.equal(inspectSelectorRepair(f.targetRoot, failure.jobId).stage, 'FAILED');
  assert.throws(() => applySelectorRepair(f.targetRoot, failure.jobId, 'wrong'), {code:'REPAIR_APPROVAL_REQUIRED'});
  assert.doesNotMatch(fs.readFileSync(failure.logFile, 'utf8'), /PRIVATE_BODY/u);
});

test('candidate drift and target drift after verification refuse application', async t => {
  const f = fixture(t);
  const result = await generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:async () => {} });
  fs.writeFileSync(path.join(f.targetRoot, 'tests/existing.test.js'), 'user edit');
  assert.throws(() => applySelectorRepair(f.targetRoot, result.jobId, result.patchHash));
  assert.doesNotMatch(fs.readFileSync(result.logFile, 'utf8'), /APPLY_STARTED/u);
});

test('an existing test edit is rejected before any verification or application', async t => {
  const f = fixture(t); let verified = false;
  await assert.rejects(generateSelectorRepair({ ...f, snapshot, tabId:7,
    createWorker:async options => {
      const worker = await f.createWorker(options);
      const submit = worker.submitTurn;
      worker.submitTurn = async input => { const handle = await submit(input); fs.writeFileSync(path.join(options.workspace.root, 'tests/existing.test.js'), 'weakened'); return handle; };
      return worker;
    }, verifyCandidate:async () => { verified = true; } }));
  assert.equal(verified, false); assert.equal(f.git('status', '--porcelain'), '');
});

test('a missing, busy or ready diagnostic cannot launch a worker', async t => {
  const f = fixture(t);
  for (const changes of [{busy:true}, {composerPresent:true}, {pageStatus:'READY'}, {generating:true}]) {
    await assert.rejects(generateSelectorRepair({ ...f, snapshot:{tabs:[{...snapshot.tabs[0], ...changes}]}, tabId:7 }), {code:'REPAIR_DIAGNOSTIC_NOT_ACTIONABLE'});
  }
  assert.equal(f.counters().started, 0);
});

test('journal failure prevents the repair from starting', async t => {
  const f = fixture(t); const original = SelectorRepairJournal.prototype.append;
  SelectorRepairJournal.prototype.append = () => { throw new Error('Synthetic journal failure'); };
  try { await assert.rejects(generateSelectorRepair({ ...f, snapshot, tabId:7 })); }
  finally { SelectorRepairJournal.prototype.append = original; }
  assert.equal(f.counters().started, 0); assert.equal(f.git('status', '--porcelain'), '');
});

test('diagnostic reads share one request, ignore unrelated replies and remove listeners after timeout', async () => {
  const transport = new EventEmitter(); transport.authenticated = true;
  const messages = []; transport.send = message => messages.push(message);
  const first = collectSelectorDiagnostics(transport, {timeoutMs:50});
  assert.equal(collectSelectorDiagnostics(transport), first); assert.equal(messages.length, 1);
  transport.emit('message', {type:'extension.diagnostics.inspected', requestId:'unrelated', payload:snapshot});
  transport.emit('message', {type:'extension.diagnostics.inspected', requestId:messages[0].requestId, payload:snapshot});
  const result = await first; assert.equal(result.tabs[0].tabId, 7);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u); assert.equal(transport.listenerCount('message'), 0);
  await assert.rejects(collectSelectorDiagnostics(transport, {timeoutMs:5}), {code:'TAB_INSPECTION_TIMEOUT'});
  assert.equal(transport.listenerCount('message'), 0);
});

test('concurrent repair requests cannot launch two workers for the same target', async t => {
  const f = fixture(t); let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const first = generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:() => waiting });
  while (f.counters().closed === 0) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(generateSelectorRepair({ ...f, snapshot, tabId:7 }), {code:'SELECTOR_REPAIR_BUSY'});
  finish(); await first; assert.equal(f.counters().started, 1);
});

test('worker timeout closes the worker and never creates application authority', async t => {
  const f = fixture(t);
  let failure;
  try {
    await generateSelectorRepair({ ...f, snapshot, tabId:7, timeoutMs:20,
      createWorker:async options => {
        const worker = await f.createWorker(options);
        worker.submitTurn = async () => ({completion:new Promise(() => {})}); return worker;
      }, verifyCandidate:async () => {} });
  } catch (error) { failure = error; }
  assert.equal(f.counters().closed, 1);
  assert.equal(inspectSelectorRepair(f.targetRoot, failure.jobId).stage, 'FAILED');
  assert.equal(f.git('status', '--porcelain'), '');
});

test('candidate modification after verification blocks the exact-hash apply command', async t => {
  const f = fixture(t);
  const result = await generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:async () => {} });
  const state = JSON.parse(fs.readFileSync(path.join(f.targetRoot,'.agent-controller','selector-repair',result.jobId,'state.json')));
  fs.appendFileSync(path.join(state.workspaceRoot,'extension/selectors/composer-selectors.js'), '// late change\n');
  assert.throws(() => applySelectorRepair(f.targetRoot,result.jobId,result.patchHash));
  assert.equal(f.git('status','--porcelain'), '');
});

test('a lost application receipt is inspected as applied without applying the patch again', async t => {
  const f = fixture(t);
  const result = await generateSelectorRepair({ ...f, snapshot, tabId:7, verifyCandidate:async () => {} });
  applySelectorRepair(f.targetRoot,result.jobId,result.patchHash);
  const filename=path.join(f.targetRoot,'.agent-controller','selector-repair',result.jobId,'state.json');
  const state=JSON.parse(fs.readFileSync(filename)); state.stage='APPLY_STARTED';fs.writeFileSync(filename,JSON.stringify(state));
  assert.equal(inspectSelectorRepair(f.targetRoot,result.jobId).applicationState,'APPLIED');
  assert.throws(() => applySelectorRepair(f.targetRoot,result.jobId,result.patchHash), {code:'REPAIR_APPROVAL_REQUIRED'});
});

test('cancellation waits for the verifier to drain before releasing the target lease', async t => {
  const f=fixture(t);let finish, entered=false;
  const control=new AbortController();const drained=new Promise(resolve=>{finish=resolve;});
  const first=generateSelectorRepair({...f,snapshot,tabId:7,signal:control.signal,
    verifyCandidate:async()=>{entered=true;await drained;}});
  while(!entered)await new Promise(resolve=>setImmediate(resolve));
  control.abort();
  await assert.rejects(generateSelectorRepair({...f,snapshot,tabId:7}),{code:'SELECTOR_REPAIR_BUSY'});
  finish();await assert.rejects(first,{code:'REPAIR_INTERRUPTED'});
  assert.equal(fs.existsSync(path.join(f.targetRoot,'.agent-controller','selector-repair','active.lock')),false);
});

test('failure to record apply intent prevents all target changes', async t => {
  const f=fixture(t);
  const result=await generateSelectorRepair({...f,snapshot,tabId:7,verifyCandidate:async()=>{}});
  const append=SelectorRepairJournal.prototype.append;
  SelectorRepairJournal.prototype.append=()=>{throw new Error('Synthetic disk failure');};
  try {assert.throws(()=>applySelectorRepair(f.targetRoot,result.jobId,result.patchHash));}
  finally {SelectorRepairJournal.prototype.append=append;}
  assert.equal(f.git('status','--porcelain'),'');
});

test('unknown worker closure retains the lease and exposes its recovery log', async t => {
  const f=fixture(t);let failure;
  try {await generateSelectorRepair({...f,snapshot,tabId:7,createWorker:async options=>{
    const worker=await f.createWorker(options);worker.close=async()=>{throw new Error('Synthetic unknown closure');};return worker;
  },verifyCandidate:async()=>{}});}catch(error){failure=error;}
  assert.equal(failure.code,'WORKER_CLEANUP_FAILED');
  assert.equal(inspectSelectorRepair(f.targetRoot,failure.jobId).stage,'CLEANUP_FAILED');
  assert.match(fs.readFileSync(failure.logFile,'utf8'),/CLEANUP_FAILED/u);
  assert.equal(fs.existsSync(path.join(f.targetRoot,'.agent-controller','selector-repair','active.lock')),true);
  await assert.rejects(generateSelectorRepair({...f,snapshot,tabId:7}),{code:'SELECTOR_REPAIR_BUSY'});
});

test('stale content and navigation mismatch are rejected before launching repair', async t => {
  const f=fixture(t);
  await assert.rejects(generateSelectorRepair({...f,snapshot:{tabs:[{...snapshot.tabs[0],runtimeVersion:'0.2.9'}]},tabId:7}),{code:'REPAIR_CONTENT_STALE'});
  await assert.rejects(generateSelectorRepair({...f,snapshot:{tabs:[{...snapshot.tabs[0],pageUrl:'https://chatgpt.com/c/new'}]},tabId:7}),{code:'REPAIR_DOCUMENT_CHANGED'});
  await assert.rejects(generateSelectorRepair({...f,snapshot:{tabs:[{...snapshot.tabs[0],runtimeVersion:'0.2.12',extensionVersion:'0.2.12'}]},tabId:7}),{code:'REPAIR_SOURCE_VERSION_MISMATCH'});
  assert.equal(f.counters().started,0);
});
