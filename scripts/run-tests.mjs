import fs from 'node:fs';
import {acquireLatestRun} from './latest-run.mjs';
import {verificationSource} from './verification-source.mjs';
import path from 'node:path';
import os from 'node:os';
import {ownedSpawn, forceProcessTree} from './e2e/platform/process.mjs';
import {fileURLToPath} from 'node:url';
import {observeChildClose, waitChildClose} from '../src/runtime/child-close.js';
import {atomicWrite} from './mv3-reload-core.mjs';
import {resourceClosureUnconfirmed} from './verification-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Node treats a Windows drive letter as a URL scheme if passed as a reporter path.
export const reporter = new URL('./test-completion-reporter.mjs', import.meta.url).href;

// Per-test deadlines remain in each test's node:test options. This is the
// separate wall-clock budget for an entire file and its completion receipt.
const DEFAULT_FILE_TIMEOUT_MS = 180000;
const fileTimeouts = new Map([
  ['tests/runtime-cleanup/contract.test.js', 12 * 60 * 1000],
  // One bounded setup plus eight 15-second cases and source cleanup.
  ['tests/verification-command.test.js', 4 * 60 * 1000],
  // Two full invocations and an early-failure invocation, including setup.
  ['tests/source-checkout.test.mjs', 12 * 60 * 1000],
]);
export function fileTimeoutMs(filename) {
  return fileTimeouts.get(path.relative(root,filename).split(path.sep).join('/')) ?? DEFAULT_FILE_TIMEOUT_MS;
}

export function discoverTests(directory) {
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? discoverTests(filename) : /\.test\.[cm]?js$/u.test(entry.name) ? [filename] : [];
  }).sort();
}

export async function runFile(filename, {output = chunk => process.stdout.write(chunk), timeoutMs, diagnostics} = {}) {
  const budgetMs = timeoutMs ?? fileTimeoutMs(filename);
  const trace = (event, fields = {}) => {
    if (!diagnostics) return;
    try {
      fs.appendFileSync(diagnostics.parentLog, JSON.stringify({at:new Date().toISOString(),
        runId:diagnostics.runId, verificationRunId:diagnostics.verificationRunId,
        sourceSha256:diagnostics.sourceSha256, pid:process.pid, event, ...fields})+'\n');
    } catch {}
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-receipt-'));
  const receipt = path.join(scratch, 'completion.json');
  let child, descriptor, failure;
  let watchdogTimer;
  let closure, error, errorCode, cleanupError, summary, receiptError, receiptSize = null, item, deadline = false;
  const childEnv = {...process.env, BRIDGE_TEST_RECEIPT:receipt, BRIDGE_TEST_RECEIPT_FD:'3', BRIDGE_TEST_FILE:path.resolve(filename)};
  if (diagnostics) Object.assign(childEnv, {BRIDGE_PRIVATE_RECOVERY_DIAGNOSTICS:'1',
    BRIDGE_PRIVATE_RECOVERY_TEST_LOG:diagnostics.testLog, BRIDGE_TEST_RUN_ID:diagnostics.runId,
    BRIDGE_TEST_SOURCE_SHA:diagnostics.sourceSha256});
  // A gate regression may itself execute inside node:test. Do not let that
  // worker's private context suppress the nested file's completion reporter.
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    // Allocate the proof's file object before the producer starts. The child
    // receives a duplicate at fd 3; namespace cleanup cannot replace this object.
    descriptor = fs.openSync(receipt, 'wx+', 0o600);
    child = ownedSpawn(['--test', '--experimental-test-isolation=none',
      '--test-reporter='+reporter, filename], {cwd:root, env:childEnv, extraStdio:[descriptor]});
    trace('child.spawn', {childPid:child.pid, file:path.relative(root,filename)});
    const observation = observeChildClose(child);
    child.on('exit', (code, signal) => trace('child.exit', {childPid:child.pid, code, signal}));
    child.on('close', (code, signal) => trace('child.close', {childPid:child.pid, code, signal}));
    observation.promise.then(closure => trace('child.close_observation.resolved', {childPid:child.pid, closure}));
    child.on('error', cause => {error = cause.message; errorCode = cause.code;});
    if (process.env.BRIDGE_WATCHDOG === '1') {
      const watchdogMs = 30000;
      const noOutputMs = 60000;
      let lastOutputAt = performance.now();
      const forwardOutput = chunk => {
        lastOutputAt = performance.now();
        output(chunk);
      };
      child.stdout.on('data', forwardOutput);
      child.stderr.on('data', forwardOutput);
      watchdogTimer = setInterval(() => {
        if (deadline || observation.result) return;
        const gapMs = Math.floor(performance.now() - lastOutputAt);
        if (gapMs < noOutputMs) return;
        try {
          output('\nNO_PROGRESS_OBSERVED '+JSON.stringify({
            at:new Date().toISOString(), file:path.relative(root,filename).split(path.sep).join('/'),
            childPid:child.pid, gap_ms:gapMs,
          })+'\n');
        } catch { /* Observation failure must not replace the test result. */ }
      }, watchdogMs);
      watchdogTimer.unref();
    } else {
      child.stdout.on('data', output); child.stderr.on('data', output);
    }
    try {
      closure = await waitChildClose(child, observation, {timeoutMs:budgetMs,
        onDeadline:()=>{deadline = true; trace('child.close.deadline', {childPid:child.pid, timeoutMs:budgetMs});},
        forceClose:async()=>{
          trace('process_tree_cleanup.start', {childPid:child.pid, mechanism:process.platform === 'win32' ? 'taskkill.exe' : 'process.kill'});
          try {
            await forceProcessTree(child);
            trace('process_tree_cleanup.command.succeeded', {childPid:child.pid});
          } catch (cause) {
            trace('process_tree_cleanup.command.failed', {childPid:child.pid, errorCode:cause.code ?? null,
              signal:cause.signal ?? null, killed:cause.killed ?? null, message:cause.message});
            throw cause;
          }
        }});
    } catch (cause) {
      error = cause.message; errorCode = cause.code; cleanupError = cause.cleanupError ?? null;
      child.stdout.destroy(); child.stderr.destroy();
    }
    try {
      receiptSize = fs.fstatSync(descriptor).size;
      if (receiptSize) {
        const bytes = Buffer.alloc(receiptSize);
        let read = 0;
        while (read < receiptSize) {
          const count = fs.readSync(descriptor, bytes, read, receiptSize-read, read);
          if (!count) throw Error('INCOMPLETE_RECEIPT_READ');
          read += count;
        }
        summary = JSON.parse(bytes.toString('utf8'));
      }
    } catch (cause) {receiptError = cause.message;}
    const allowedSkip = path.resolve(filename) === path.join(root,'tests/certify.test.js') && process.platform !== 'win32'
      ? ['certification command runner launches npm on Windows'] : [];
    const summaryStatus = receiptError ? 'INVALID' : !summary ? 'MISSING' : summary.completed === true ? 'COMPLETE' : 'INCOMPLETE';
    trace('completion.receipt.read', {childPid:child.pid, bytes:receiptSize, summaryStatus,
      receiptError:receiptError ?? null, exitCode:child.exitCode, signal:child.signalCode});
    const unexpectedSkips = summary?.skipped?.filter(name => !allowedSkip.includes(name)) ?? [];
    const boundaryReceiptInvalid = (summary?.boundaryReceiptErrors?.length ?? 0) > 0;
    const pass = !error && !receiptError && closure?.code === 0 && closure?.signal === null && summaryStatus === 'COMPLETE'
      && summary.failed === 0 && summary.todo.length === 0 && unexpectedSkips.length === 0 && !boundaryReceiptInvalid;
    const reason = pass ? 'COMPLETE' : deadline || errorCode === 'CHILD_CLOSE_DEADLINE' ? 'FILE_TIMEOUT'
      : error ? 'PROCESS_ERROR' : receiptError ? 'INVALID_RECEIPT'
      : summaryStatus === 'MISSING' ? 'MISSING_RECEIPT' : summaryStatus === 'INCOMPLETE' ? 'INCOMPLETE_TEST_RUN'
      : boundaryReceiptInvalid ? 'INVALID_BOUNDARY_RECEIPT'
      : summary?.failed > 0 || summary?.todo?.length > 0 || unexpectedSkips.length > 0 ? 'TEST_FAILURE'
      : closure?.code !== 0 || closure?.signal !== null ? 'CHILD_EXIT_NONZERO' : 'TEST_FAILURE';
    item = {file:path.relative(root,filename).split(path.sep).join('/'), pass, closure, error, errorCode,
      cleanupError, timeoutMs:budgetMs, deadline, childPid:child.pid, childExitCode:child.exitCode,
      childSignal:child.signalCode, summaryStatus, receiptError, unexpectedSkips, reason, summary};
  } catch (cause) { failure = cause; throw cause; }
  finally {
    clearInterval(watchdogTimer);
    const errors = [];
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (cause) { errors.push(cause); }
    }
    try { fs.rmSync(scratch, {recursive:true,force:true}); }
    catch (cause) { errors.push(cause); }
    if (errors.length) {
      const message = errors.map(cause => cause.message).join('; ');
      if (item) {
        item.receiptCleanupError = message;
        if (item.pass) item.reason = 'CLEANUP_FAILURE';
        item.pass = false;
      } else if (failure) failure.cleanupError = message;
      else throw new AggregateError(errors, message);
    }
  }
  return item;
}

export async function runFiles(files, {directory = path.join(root,'.agent-controller'), output = chunk => process.stdout.write(chunk),
  verificationRunId = process.env.BRIDGE_VERIFICATION_RUN_ID ?? null} = {}) {
  if (process.env.RUNTIME_CLEANUP_IDS) throw new Error('Partial cleanup selection is diagnostic-only; clear RUNTIME_CLEANUP_IDS for a gate run');
  if (!files.length || new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error('Expected a nonempty, unique test file list');
  for (const file of files) if (!fs.statSync(file).isFile()) throw new Error('Missing test file: '+file);
  fs.mkdirSync(directory, {recursive:true});
  const lease = acquireLatestRun(directory,'test-gate');
  try {
  const logPath = path.join(directory,'latest-test.log');
  fs.writeFileSync(logPath,'');
  const resultPath = path.join(directory,'latest-test-result.json');
  const result = {status:'RUNNING', verificationRunId:verificationRunId ?? lease.runId,
    startedAt:new Date().toISOString(), terminal:false,
    node:process.version, platform:process.platform,
    scheduled:files.map(file => path.relative(root,file).split(path.sep).join('/')), results:[]};
  const save = () => atomicWrite(resultPath,result);
  const write = chunk => {fs.appendFileSync(logPath,chunk); output(chunk);};
  save();
  try {
    result.source = verificationSource(root); save();
    const diagnosticsEnabled = process.env.BRIDGE_PRIVATE_RECOVERY_DIAGNOSTICS === '1';
    const isPrivateRecovery = file => path.relative(root,file).split(path.sep).join('/') === 'tests/audit-ack-private-recovery.test.js';
    let privateRecoveryDiagnostics = null;
    if (diagnosticsEnabled && files.some(isPrivateRecovery)) {
      try {
        const runDir = path.join(directory,'test-runs',lease.runId);
        fs.mkdirSync(runDir,{recursive:true});
        privateRecoveryDiagnostics = {runId:lease.runId, verificationRunId:result.verificationRunId,
          sourceSha256:result.source.sourceSha256, parentLog:path.join(runDir,'private-recovery-parent.ndjson'),
          testLog:path.join(runDir,'private-recovery-test.ndjson')};
      } catch (cause) {
        write('PRIVATE_RECOVERY_DIAGNOSTICS_INIT_FAILED '+JSON.stringify({code:cause.code ?? null,message:cause.message})+'\n');
      }
    }
    write('RUN_CONTEXT '+JSON.stringify({verificationRunId:result.verificationRunId,node:result.node,platform:result.platform,
      head:result.source.head,sourceSha256:result.source.sourceSha256})+'\n');
    for (const file of files) {
      const budgetMs = fileTimeoutMs(file);
      write('\nFILE '+path.relative(root,file)+' timeoutMs='+budgetMs+'\n');
      const item = await runFile(file,{output:write,timeoutMs:budgetMs,
        diagnostics:isPrivateRecovery(file) ? privateRecoveryDiagnostics : null});
      result.results.push(item);
      write('FILE_RESULT '+JSON.stringify({file:item.file,reason:item.reason,pass:item.pass,
        timeoutMs:item.timeoutMs,deadline:item.deadline,childPid:item.childPid,
        childExitCode:item.childExitCode,childSignal:item.childSignal,
        closure:item.closure,error:item.error,errorCode:item.errorCode,cleanupError:item.cleanupError,receiptCleanupError:item.receiptCleanupError,
        summaryStatus:item.summaryStatus,receiptError:item.receiptError,
        plan:item.summary?.plan,topLevel:item.summary?.topLevel,
        passed:item.summary?.passed,failed:item.summary?.failed,skipped:item.summary?.skipped})+'\n');
      save();
      if (resourceClosureUnconfirmed(item)) {
        result.cleanupError = item.receiptCleanupError ?? item.cleanupError ?? 'RESOURCE_CLOSURE_UNCONFIRMED';
        result.blockedAfter = item.file;
        break;
      }
    }
    result.sourceAfter = verificationSource(root);
    result.candidateUnchanged = result.source.sourceSha256 === result.sourceAfter.sourceSha256 && result.source.head === result.sourceAfter.head;
    result.status = result.candidateUnchanged && result.results.length === result.scheduled.length && result.results.every(item => item.pass) ? 'PASS' : 'FAIL';
    if (!result.candidateUnchanged) write('SOURCE_CHANGED '+JSON.stringify({before:result.source.sourceSha256,after:result.sourceAfter.sourceSha256})+'\n');
    write('\nTEST_GATE '+result.status+' '+result.results.filter(item=>item.pass).length+'/'+files.length+' files\n');
    save();
    return result;
  } catch (cause) {
    result.status = 'FAIL'; result.error = cause.message; result.cleanupError ??= cause.cleanupError ?? null;
    write('TEST_GATE_EXCEPTION '+JSON.stringify({error:cause.message,code:cause.code ?? null,cleanupError:result.cleanupError})+'\n');
    throw cause;
  } finally {result.finishedAt=new Date().toISOString();result.terminal=true;
    result.exitCode=result.status==='PASS'?0:1;save();}
  } finally { lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => { /* Durable logs remain authoritative after a terminal disconnect. */ });
  try {
    const args = process.argv.slice(2);
    const files = args.length ? args.map(file => path.resolve(file)) : discoverTests(path.join(root,'tests'));
    const result = await runFiles(files);
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) {console.error(error); process.exitCode = 1;}
}
