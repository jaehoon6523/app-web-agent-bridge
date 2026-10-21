import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { superviseTrial } from '../scripts/mv3-reload-core.mjs';
import { actualCommandLine, getWindowsCommandLine, nodeCommandLine, launchConditions } from '../scripts/diagnostics/environment.mjs';
import { discoverMinimalExtension, verifiedReloadIdentity, verifyExecutionContext } from '../scripts/direct-mv3-identity.mjs';
import { observeReload } from '../scripts/diagnostics/reload-observer.mjs';
import { classifyReload, readReceipt, writeReceipt, RELOAD_SCOPE } from '../scripts/diagnostics/reload-result.mjs';

const id = 'abcdabcdabcdabcdabcdabcdabcdabcd';
const other = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const context = { url: `chrome-extension://${id}/popup.html`, runtimeId: id,
  apis: { reload: true, sendMessage: true, storageGet: true, storageSet: true } };
const probeResult = { popupAccessible: true, backgroundResponded: true, sentinelPreserved: true,
  instanceId: 'old', context, stored: { matrixSentinel: 'retained' }, pong: { ok: true, instanceId: 'old' } };
const identity = verifiedReloadIdentity(id, [], [], probeResult);
const worker = (sequence, runningStatus, owner = id) => ({ sequence, runningStatus, scriptURL: `chrome-extension://${owner}/background.js` });
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-modules-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function validTrial() { return { verifiedExtension: identity, source: { commit: 'a'.repeat(40), files: {}, hashErrors: {} },
  actualArgsEvidence: { status: 'OBSERVED', matchesRequested: true, browserExecutableMatches: true }, fixtureHashesVerified: true,
  observations: { reloadInvocation: { attempted: true, evaluate: 'returned', context },
    beforeReloadWorkerInstance: 'old', popupAfter: { ...probeResult, instanceId: 'new' },
    window: { completed: true }, workerEventsAfterReload: [worker(1, 'stopped'), worker(2, 'running')],
    registrationEventsAfterReload: [] }, cleanup: { status: 'PASS' }, childExecution: { status: 'PASS' } }; }

test('A: failed spawn is execution failure, not browser readiness or functional success', async t => {
  const scratch = temp(t);
  const r = await superviseTrial({ command: path.join(scratch, 'missing-executable'), args: [], scratch,
    profile: path.join(scratch, 'profile'), snapshotFile: path.join(scratch, 'observation.json'), limitMs: 2000 });
  assert.equal(r.childExecution.status, 'FAIL'); assert.equal(r.childExecution.reason, 'SPAWN_ERROR');
  assert.equal(r.snapshotReceiptError, 'RESULT_NOT_CREATED'); assert.equal(r.reloadResult, 'UNVERIFIED');
  assert.equal(r.watchdog.timedOut, false);
});
test('A: actual argv distinguishes unknown from mismatch and records the live process', () => {
  const actual = actualCommandLine(process.pid);
  if (['linux', 'win32'].includes(process.platform)) assert.equal(actual.status, 'OBSERVED',JSON.stringify(actual));
  assert.equal(launchConditions(['--flag'], { status: 'UNVERIFIED' }, false).status, 'UNVERIFIED');
  assert.equal(launchConditions(['--flag'], { status: 'OBSERVED', argv: ['--other'] }, false).matchesRequested, false);
  assert.equal(launchConditions(['--flag'], { status: 'OBSERVED', argv: ['--flag', '--enable-unsafe-extension-debugging'] }, false).matchesRequested, false);
});
test('A: command-line timeout, missing process and invalid JSON retain different query evidence',()=>{
  const query=execute=>getWindowsCommandLine(123,{platform:'win32',execute,hash:()=> 'hash'});
  const timeout=query(()=>{throw Object.assign(Error('query deadline'),{code:'ETIMEDOUT',signal:'SIGTERM'});});
  assert.equal(timeout.status,'UNVERIFIED');assert.equal(timeout.query.timedOut,true);
  assert.equal(timeout.query.errorCode,'ETIMEDOUT');assert.equal(timeout.query.timeoutMs,6000);
  const missing=query(()=> '');assert.equal(missing.query.result,'PROCESS_NOT_FOUND');
  const malformed=query(()=> '{');assert.equal(malformed.query.result,'QUERY_FAILED');
  assert.equal(malformed.query.timedOut,false);
  const observed=query(()=>JSON.stringify({ProcessId:123,ParentProcessId:1,ExecutablePath:'node.exe',CommandLine:'node.exe test.js'}));
  assert.equal(observed.status,'OBSERVED');assert.equal(observed.executableSha256,'hash');
});
test('A: Node self-observation uses recorded startup argv and fails closed without report evidence',()=>{
  const observed=nodeCommandLine();
  assert.equal(observed.status,'OBSERVED',JSON.stringify(observed));
  assert.deepEqual(observed.argv,process.report.getReport().header.commandLine);
  assert.equal(observed.pid,process.pid);assert.equal(observed.source,'NODE_DIAGNOSTIC_REPORT');
  assert.equal(nodeCommandLine(()=>({header:{}})).status,'UNVERIFIED');
  assert.equal(nodeCommandLine(()=>{throw Error('report unavailable');}).status,'UNVERIFIED');
});
test('A: cleanup failure retains durable function observations and original stdout', async t => {
  const scratch = temp(t), logs = temp(t), snapshot = path.join(scratch, 'observation.json');
  const program = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({execution:'COMPLETE',functionalRecovery:'PASS',reloadResult:'PASS'}));console.log('raw-evidence');`;
  const r = await superviseTrial({ command: process.execPath, args: ['-e', program, snapshot], scratch,
    profile: path.join(scratch, 'profile'), snapshotFile: snapshot, stdoutFile: path.join(logs, 'raw.log'),
    // This assertion covers scratch removal after confirmed process closure.
    // Real OS process discovery is covered by the descendant and native tests.
    queryProfilePids: async (profile, roots) => {
      assert.equal(profile,path.join(scratch,'profile')); assert.equal(roots.length,1);
      return [];
    },
    removeScratch: () => { throw Error('REMOVAL_DENIED'); } });
  assert.equal(r.functionalRecovery, 'PASS'); assert.equal(r.cleanup.status, 'FAIL');
  assert.equal(r.childExecution.status,'PASS'); assert.equal(r.cleanup.childTerminationConfirmed,true);
  assert.equal(r.cleanup.browserTerminationConfirmed,true); assert.equal(r.cleanup.scratchRemoval,'FAIL');
  assert.equal(r.cleanup.scratchError, 'REMOVAL_DENIED');
  assert.match(fs.readFileSync(path.join(logs, 'raw.log'), 'utf8'), /raw-evidence/);
});
test('A: unavailable process discovery retains observations and prevents scratch removal', async t => {
  const scratch=temp(t), logs=temp(t), snapshot=path.join(scratch,'observation.json');
  const program=`require('node:fs').writeFileSync(process.argv[1],JSON.stringify({execution:'COMPLETE',functionalRecovery:'PASS',reloadResult:'PASS'}));console.log('raw-evidence');`;
  let removals=0;
  const r=await superviseTrial({command:process.execPath,args:['-e',program,snapshot],scratch,
    profile:path.join(scratch,'profile'),snapshotFile:snapshot,stdoutFile:path.join(logs,'raw.log'),
    queryProfilePids:async()=>{throw Error('PROCESS_QUERY_UNAVAILABLE');},removeScratch:()=>{removals++;}});
  assert.equal(r.childExecution.status,'PASS');assert.equal(r.functionalRecovery,'PASS');
  assert.equal(r.cleanup.status,'UNCONFIRMED');assert.equal(r.cleanup.browserTerminationConfirmed,false);
  assert.equal(r.cleanup.profileQueryError,'PROCESS_QUERY_UNAVAILABLE');assert.equal(r.cleanup.scratchRemoval,'SKIPPED');
  assert.equal(removals,0);assert.equal(fs.existsSync(snapshot),true);
  assert.match(fs.readFileSync(path.join(logs,'raw.log'),'utf8'),/raw-evidence/);
});
for (const [field, value, reason] of [['verificationRunId', 'old-run', 'RESULT_RUN_MISMATCH'], ['scope', 'other-scope', 'RESULT_SCOPE_MISMATCH']]) {
  test(`A/D: snapshot ${reason} cannot reuse PASS`, async t => {
    const scratch = temp(t), snapshot = path.join(scratch, 'observation.json');
    fs.writeFileSync(snapshot, JSON.stringify({ verificationRunId: 'this-run', scope: RELOAD_SCOPE,
      execution: 'COMPLETE', reloadResult: 'PASS', [field]: value }));
    const r = await superviseTrial({ command: process.execPath, args: ['-e', ''], scratch,
      profile: path.join(scratch, 'profile'), snapshotFile: snapshot, expectedRunId: 'this-run', expectedScope: RELOAD_SCOPE });
    assert.equal(r.snapshotReceiptError, reason); assert.equal(r.reloadResult, 'UNVERIFIED');
    assert.equal(r.rejectedSnapshot.reloadResult, 'PASS');
  });
}
test('A: a foreign profile path is rejected before launching or deleting resources', async t => {
  const scratch = temp(t), foreign = temp(t);
  await assert.rejects(superviseTrial({ command: process.execPath, args: [], scratch, profile: foreign,
    snapshotFile: path.join(scratch, 'x') }), /OWNED_SCRATCH_PATH_REQUIRED/);
  assert.ok(fs.existsSync(foreign));
});

for (const [name, invalid] of [['file URL', { ...context, url: 'file:///popup.html' }],
  ['other page', { ...context, url: 'chrome://extensions/' }], ['wrong runtime ID', { ...context, runtimeId: other }],
  ['missing API', { ...context, apis: { ...context.apis, reload: false } }], ['marker only', undefined]]) {
  test(`B: strict SETUP rejects ${name} before reload`, async () => {
    let now = 0;
    assert.equal(verifyExecutionContext(id, invalid), false);
    await assert.rejects(discoverMinimalExtension({ requireContext: true, timeoutMs: 20, pollMs: 5,
      clock: () => now, pause: async ms => { now += ms; }, collect: async () => [id],
      probe: async () => ({ ...probeResult, context: invalid }) }), /EXPECTED_MINIMAL_EXTENSION_NOT_FOUND/);
  });
}
test('B: strict SETUP returns verified ID, context, initial response and storage', async () => {
  let now = 0;
  const r = await discoverMinimalExtension({ requireContext: true, timeoutMs: 20, pollMs: 5,
    clock: () => now, pause: async ms => { now += ms; }, collect: async () => [id], probe: async () => probeResult });
  assert.equal(r.id, id); assert.equal(r.observation.stored.matrixSentinel, 'retained');
  assert.equal(verifiedReloadIdentity(r.id, [], [], r.observation).setupVerified, true);
});

function fakeTransport(observations, { interrupted = false } = {}) {
  return { closed: false, async send(method, params) {
    if (method === 'Target.createTarget') return { targetId: 'popup' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    if (method === 'Runtime.evaluate') {
      observations.workerEvents.push(worker(10, 'stopped', other), worker(11, 'stopped'),
        { sequence: 12, runningStatus: 'stopped', scriptURL: null }, worker(13, 'running'));
      if (interrupted) throw Error('Execution context destroyed');
      return { result: { value: { invoked: true } } };
    }
    return {};
  } };
}
function emptyObservations() { return { workerEvents: [], registrationEvents: [], popupAttempts: [], popupFailures: [] }; }

test('C → D: interrupted invocation retains raw foreign/unknown events and target subset; collection has no verdict', async () => {
  const observations = emptyObservations(), cdp = fakeTransport(observations, { interrupted: true });
  let now = 0, probes = 0;
  await observeReload({ cdp, identity, observations, budgetMs: 15,
    clock: () => now, pause: async ms => { now += ms; }, inspect: async () => ({ itemPresent: false }),
    probe: async () => ({ ...probeResult, instanceId: probes++ ? 'new' : 'old' }) });
  assert.equal(observations.reloadInvocation.evaluate, 'interrupted');
  assert.equal(observations.workerEventsAfterReload.length, 4);
  assert.deepEqual(observations.targetEvents.workers.map(x => x.sequence), [11, 13]);
  assert.equal(observations.afterUi.itemPresent, false);
  assert.equal(observations.reloadResult, undefined);
  const judged = classifyReload({ ...validTrial(), observations });
  assert.equal(judged.execution, 'INCOMPLETE'); assert.equal(judged.reloadResult, 'UNVERIFIED');
  assert.equal(judged.functionalRecovery, 'PASS');
});
test('C: popup failure after confirmed call is observed, not silently replaced with UI reload', async () => {
  const observations = emptyObservations(), cdp = fakeTransport(observations);
  let now = 0, probes = 0;
  await observeReload({ cdp, identity, observations, budgetMs: 20, clock: () => now,
    pause: async ms => { now += ms; }, inspect: async () => ({ status: 'UNVERIFIED' }),
    probe: async () => { if (probes++) throw Error('POPUP_ACCESS_DENIED'); return probeResult; } });
  assert.equal(observations.reloadInvocation.method, 'chrome.runtime.reload');
  assert.equal(observations.window.completed, true); assert.equal(observations.popupFailures[0].error, 'POPUP_ACCESS_DENIED');
  assert.equal(classifyReload({ ...validTrial(), observations }).reloadResult, 'FAIL');
});
test('C: connection loss stops observation and preserves a positive response before disconnect', async () => {
  const observations = emptyObservations(), cdp = fakeTransport(observations);
  let now = 0, probes = 0;
  await assert.rejects(observeReload({ cdp, identity, observations, budgetMs: 20, clock: () => now,
    pause: async ms => { now += ms; }, inspect: async () => ({}), probe: async () => {
      if (probes++) cdp.closed = true; return { ...probeResult, instanceId: probes > 1 ? 'new' : 'old' };
    } }), /CDP_SOCKET_CLOSED/);
  assert.equal(observations.window.completed, false); assert.equal(observations.window.stopReason, 'CDP_SOCKET_CLOSED');
  const judged = classifyReload({ ...validTrial(), observations });
  assert.equal(judged.execution, 'INCOMPLETE'); assert.equal(judged.functionalRecovery, 'PASS');
  assert.equal(judged.reloadResult, 'UNVERIFIED');
});
test('C: no verified initial context or initial reply prevents runtime.reload', async () => {
  let commands = 0;
  await assert.rejects(observeReload({ cdp: { send() { commands++; } }, identity: verifiedReloadIdentity(id),
    observations: emptyObservations() }), /VERIFIED_SETUP_REQUIRED/);
  assert.equal(commands, 0);
});

test('D: pure classification uses exact event references, does not mutate raw observations, preserves cleanup failure', () => {
  const trial = validTrial(); trial.cleanup = { status: 'FAIL', error: 'directory locked' };
  const before = JSON.stringify(trial), r = classifyReload(trial);
  assert.equal(JSON.stringify(trial), before);
  assert.equal(r.reloadResult, 'PASS'); assert.equal(r.cleanup.status, 'FAIL');
  assert.ok(r.evidenceUsed.includes('observations.workerEventsAfterReload[sequence=1]'));
});
test('D: normal Worker stop cannot prove reload invocation or extension-wide reload', () => {
  const trial = validTrial(); trial.observations.reloadInvocation.evaluate = 'interrupted';
  trial.observations.popupAfter = { popupAccessible: false }; trial.observations.workerEventsAfterReload = [worker(1, 'stopped')];
  const r = classifyReload(trial);
  assert.equal(r.functionalRecovery, 'FAIL'); assert.equal(r.execution, 'INCOMPLETE'); assert.equal(r.reloadResult, 'UNVERIFIED');
  assert.equal(r.reloadBoundaryEvidence, 'PARTIAL');
});
test('D: foreign/unknown termination cannot prove target reload', () => {
  const trial = validTrial(); trial.observations.reloadInvocation.evaluate = 'interrupted';
  trial.observations.workerEventsAfterReload = [worker(1, 'stopped', other), { sequence: 2, runningStatus: 'stopped' }];
  trial.observations.popupAfter = { popupAccessible: false };
  assert.equal(classifyReload(trial).reloadResult, 'UNVERIFIED');
});
test('D: in-progress observation remains incomplete even with positive recovery and boundary', () => {
  const trial = validTrial(); trial.observations.window.completed = false;
  const r = classifyReload(trial); assert.equal(r.execution, 'INCOMPLETE');
  assert.equal(r.functionalRecovery, 'PASS'); assert.equal(r.reloadResult, 'UNVERIFIED');
});
test('D: configuration mismatch is independent from observed successful function', () => {
  const trial = validTrial(); trial.actualArgsEvidence.matchesRequested = false;
  const r = classifyReload(trial); assert.equal(r.comparisonValidity, 'INVALID'); assert.equal(r.functionalRecovery, 'PASS');
});
test('D: fresh atomically updated receipt must match run, scope and terminal exit', t => {
  const d = temp(t), file = path.join(d, 'latest.json'), startedMs = Date.now();
  const r = { verificationRunId: 'new', scope: RELOAD_SCOPE, startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date().toISOString(), terminal: true, exitCode: 0, execution: 'COMPLETE',
    requestedConditions: [{id:'A',unsafe:false},{id:'B',unsafe:true}],
    cases: ['A','B'].map(id=>({id,verificationRunId:'new',scope:RELOAD_SCOPE})) };
  writeReceipt(file, r);
  const check = options => readReceipt(file, { runId: 'new', scope: RELOAD_SCOPE, startedMs, exitCode: 0, ...options });
  assert.equal(check({}).receiptFresh, true);
  assert.equal(check({ runId: 'old' }).reason, 'RESULT_RUN_MISMATCH');
  assert.equal(check({ scope: 'wrong' }).reason, 'RESULT_SCOPE_MISMATCH');
  assert.equal(check({ exitCode: 7 }).reason, 'RESULT_TERMINATION_MISMATCH');
  writeReceipt(file, { ...r, terminal: false });
  assert.equal(check({}).receiptFresh, false);
  fs.unlinkSync(file); assert.equal(check({}).reason, 'RESULT_NOT_CREATED');
});

test('B: a stalled collection is bounded by SETUP time, not left pending forever', async () => {
  const start = Date.now();
  await assert.rejects(discoverMinimalExtension({ requireContext: true, timeoutMs: 40,
    collect: () => new Promise(() => {}), probe: async () => probeResult }), /SETUP_DISCOVERY_INCOMPLETE/);
  assert.ok(Date.now() - start < 2000);
});
test('A: command line token comparison rejects profile-prefix and unrequested unsafe flag', async () => {
  const { windowsArgv } = await import('../scripts/diagnostics/environment.mjs');
  const line = '"C:\\Program Files\\Chromium\\chrome.exe" "--user-data-dir=C:\\My Profile" --remote-debugging-port=0';
  assert.deepEqual(windowsArgv(line), ['C:\\Program Files\\Chromium\\chrome.exe', '--user-data-dir=C:\\My Profile', '--remote-debugging-port=0']);
  assert.equal(launchConditions(['--user-data-dir=C:\\My'], { status: 'OBSERVED', commandLine: line }, false).matchesRequested, false);
  assert.equal(launchConditions(['--user-data-dir=C:\\My Profile'], { status: 'OBSERVED', commandLine: line }, false).matchesRequested, true);
});
test('D: abnormal browser exit is independent of collector exit and successful observations', () => {
  const trial = validTrial(); trial.browserProcessLifecycle = { code: null, signal: 'SIGSEGV', exitedAt: new Date().toISOString() };
  const r = classifyReload(trial);
  assert.equal(r.childExecution.status, 'PASS'); assert.equal(r.browserExecution.status, 'FAIL');
  assert.equal(r.functionalRecovery, 'PASS'); assert.equal(r.reloadResult, 'PASS');
});

test('D: a current matching top-level scope with missing A/B cases cannot claim full completion', t => {
  const file = path.join(temp(t), 'latest.json'), start = Date.now();
  writeReceipt(file, { verificationRunId: 'run', scope: RELOAD_SCOPE, startedAt: new Date(start).toISOString(),
    finishedAt: new Date().toISOString(), terminal: true, exitCode: 0, execution: 'COMPLETE',
    requestedConditions: [{ id: 'A', unsafe: false }, { id: 'B', unsafe: true }], cases: [] });
  assert.equal(readReceipt(file, { runId: 'run', scope: RELOAD_SCOPE, startedMs: start, exitCode: 0 }).reason, 'RESULT_SCOPE_MISMATCH');
});

test('C → D: real WebSocket CDP transport records call interruption, owned events and connection loss', async t => {
  const { WebSocketServer } = await import('ws');
  const { once } = await import('node:events');
  const { Cdp } = await import('../scripts/diagnostics/reload-observer.mjs');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let peer, evaluations = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', buffer => {
      const packet = JSON.parse(String(buffer));
      const reply = result => socket.send(JSON.stringify({ id: packet.id, result }));
      if (packet.method === 'Target.createTarget') return reply({ targetId: 'popup' });
      if (packet.method === 'Target.attachToTarget') return reply({ sessionId: 'session' });
      if (packet.method === 'Runtime.evaluate') {
        evaluations++;
        socket.send(JSON.stringify({ method: 'ServiceWorker.workerVersionUpdated', params: {
          versions: [worker(1, 'stopped', other), worker(2, 'stopped'), worker(3, 'running'), { runningStatus: 'stopped' }] } }));
        socket.send(JSON.stringify({ id: packet.id, error: { message: 'Execution context destroyed' } }));
        return;
      }
      reply({});
    });
  });
  const cdp = new Cdp(`ws://127.0.0.1:${server.address().port}`), observations = emptyObservations();
  let sequence = 0;
  cdp.onEvent(packet => { for (const value of packet.params?.versions ?? [])
    observations.workerEvents.push({ ...value, sequence: ++sequence }); });
  t.after(async () => { cdp.close(); for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve)); });
  await cdp.ready();
  let probes = 0;
  await assert.rejects(observeReload({ cdp, identity, observations, budgetMs: 1000, inspect: async () => ({}),
    probe: async () => {
      if (probes++) { peer.close(); await new Promise(resolve => cdp.ws.addEventListener('close', resolve, { once: true })); }
      return { ...probeResult, instanceId: probes > 1 ? 'new' : 'old' };
    } }), /CDP_SOCKET_CLOSED/);
  assert.equal(evaluations, 1);
  assert.equal(observations.reloadInvocation.evaluate, 'interrupted');
  assert.equal(observations.window.completed, false);
  assert.equal(observations.targetEvents.workers.length, 2);
  assert.ok(cdp.rawEvents.length > 0);
  const r = classifyReload({ ...validTrial(), observations });
  assert.equal(r.functionalRecovery, 'PASS'); assert.equal(r.reloadResult, 'UNVERIFIED');
});

test('A: a live descendant without a profile argument is collected after its parent exits normally', async t => {
  const scratch = temp(t), signals = temp(t), marker = path.join(signals, 'heartbeat.json');
  const heartbeat = path.join(signals, 'heartbeat.ticks');
  t.after(() => {
    if (!fs.existsSync(marker)) return;
    try { process.kill(JSON.parse(fs.readFileSync(marker)).pid,'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  // Publish immutable identity only after the first heartbeat is complete.
  // Killing a writer must not truncate the identity needed for cleanup.
  const child = `const fs=require('node:fs');const beat=()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.');beat();fs.writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});setInterval(beat,40);`;
  // A Windows child must be independent of the collector parent's console.
  // POSIX retains the inherited group so supervision can discover the orphan.
  const parent = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',detached:process.platform==='win32',windowsHide:true});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.exit(0)}},20);`;
  const result = await superviseTrial({ command: process.execPath, args: ['-e', parent], scratch,
    profile: path.join(scratch, 'profile'), snapshotFile: path.join(scratch, 'missing.json'), limitMs: 4000 });
  if (!result.cleanup.browserForceRequired || result.cleanup.status !== 'FORCED_TERMINATED')
    t.diagnostic(JSON.stringify({childExit:result.childExit,cleanup:result.cleanup,
      heartbeat:fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null}));
  assert.equal(result.watchdog.timedOut, false); assert.equal(result.childExit.code, 0);
  assert.equal(result.cleanup.browserForceRequired, true); assert.equal(result.cleanup.status, 'FORCED_TERMINATED');
  const stopped = fs.statSync(heartbeat).size;
  assert.ok(stopped > 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fs.statSync(heartbeat).size, stopped);
});

test('B: a positive first candidate cannot finish SETUP while a late second candidate remains pending', async () => {
  await assert.rejects(discoverMinimalExtension({ requireContext: true, timeoutMs: 50, collect: async () => [id, other],
    probe: candidate => candidate === id ? Promise.resolve(probeResult) : new Promise(() => {}) }), /SETUP_DISCOVERY_INCOMPLETE/);
});

test('A: an untracked directory symlink does not erase source commit or other file hashes', async t => {
  const { sourceRecord } = await import('../scripts/diagnostics/environment.mjs');
  const { execFileSync } = await import('node:child_process');
  const directory = temp(t), target = temp(t);
  execFileSync('git', ['init', '--quiet', directory]);
  execFileSync('git', ['-c', 'user.name=Diagnostic Fixture', '-c', 'user.email=fixture@localhost',
    'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'changed.txt'), 'source bytes');
  fs.symlinkSync(target, path.join(directory, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = sourceRecord(directory);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(result.fileKinds['linked-directory'], 'SYMLINK_TARGET_TEXT');
  assert.match(result.files['linked-directory'], /^[a-f0-9]{64}$/);
  assert.match(result.files['changed.txt'], /^[a-f0-9]{64}$/);
  assert.deepEqual(result.hashErrors, {});
});

test('A: tracked paths below a directory link are attributed to the link without hashing outside source', async t => {
  const { sourceRecord } = await import('../scripts/diagnostics/environment.mjs');
  const { execFileSync } = await import('node:child_process');
  const directory = temp(t), target = temp(t);
  const git = (args, input) => execFileSync('git',args,{cwd:directory,encoding:'utf8',input});
  git(['init','--quiet']);
  git(['-c','user.name=Diagnostic Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false',
    'commit','--allow-empty','--quiet','-m','fixture']);
  fs.writeFileSync(path.join(target,'outside.txt'),'external dependency bytes');
  fs.symlinkSync(target,path.join(directory,'linked-directory'),process.platform === 'win32' ? 'junction' : 'dir');
  const blob = git(['hash-object','-w','--stdin'],'indexed bytes').trim();
  git(['update-index','--add','--cacheinfo',`100644,${blob},linked-directory/outside.txt`]);
  git(['-c','user.name=Diagnostic Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false',
    'commit','--quiet','-m','tracked path']);
  assert.ok(git(['diff','--name-only','HEAD']).includes('linked-directory/outside.txt'));
  const result = sourceRecord(directory);
  assert.equal(result.fileKinds['linked-directory'],'SYMLINK_TARGET_TEXT');
  assert.match(result.files['linked-directory'],/^[a-f0-9]{64}$/u);
  assert.equal(result.files['linked-directory/outside.txt'],undefined);
  assert.equal(result.fileKinds['linked-directory/outside.txt'],undefined);
});
