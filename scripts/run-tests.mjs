import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ownedSpawn, forceProcessTree} from './e2e/platform/process.mjs';
import {fileURLToPath} from 'node:url';
import {observeChildClose, waitChildClose} from '../src/runtime/child-close.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Node treats a Windows drive letter as a URL scheme if passed as a reporter path.
export const reporter = new URL('./test-completion-reporter.mjs', import.meta.url).href;

// Per-test deadlines remain in each test's node:test options. This is the
// separate wall-clock budget for an entire file and its completion receipt.
const DEFAULT_FILE_TIMEOUT_MS = 180000;
const fileTimeouts = new Map([
  ['tests/runtime-cleanup/contract.test.js', 12 * 60 * 1000],
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

export async function runFile(filename, {output = chunk => process.stdout.write(chunk), timeoutMs} = {}) {
  const budgetMs = timeoutMs ?? fileTimeoutMs(filename);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-receipt-'));
  const receipt = path.join(scratch, 'completion.json');
  let closure, error, errorCode, cleanupError, summary, receiptError, deadline = false;
  const childEnv = {...process.env, BRIDGE_TEST_RECEIPT:receipt, BRIDGE_TEST_FILE:path.resolve(filename)};
  // A gate regression may itself execute inside node:test. Do not let that
  // worker's private context suppress the nested file's completion reporter.
  delete childEnv.NODE_TEST_CONTEXT;
  const child = ownedSpawn(['--test', '--experimental-test-isolation=none',
    '--test-reporter='+reporter, filename], {cwd:root, env:childEnv});
  const observation = observeChildClose(child);
  child.on('error', cause => {error = cause.message; errorCode = cause.code;});
  child.stdout.on('data', output); child.stderr.on('data', output);
  try {
    try {
      closure = await waitChildClose(child, observation, {timeoutMs:budgetMs,
        onDeadline:()=>{deadline = true;}, forceClose:()=>forceProcessTree(child)});
    } catch (cause) {
      error = cause.message; errorCode = cause.code; cleanupError = cause.cleanupError ?? null;
      child.stdout.destroy(); child.stderr.destroy();
    }
    if (fs.existsSync(receipt)) {
      try {summary = JSON.parse(fs.readFileSync(receipt, 'utf8'));}
      catch (cause) {receiptError = cause.message;}
    }
    const allowedSkip = path.resolve(filename) === path.join(root,'tests/certify.test.js') && process.platform !== 'win32'
      ? ['certification command runner launches npm on Windows'] : [];
    const summaryStatus = receiptError ? 'INVALID' : !summary ? 'MISSING' : summary.completed === true ? 'COMPLETE' : 'INCOMPLETE';
    const unexpectedSkips = summary?.skipped?.filter(name => !allowedSkip.includes(name)) ?? [];
    const pass = !error && !receiptError && closure?.code === 0 && closure?.signal === null && summaryStatus === 'COMPLETE'
      && summary.failed === 0 && summary.todo.length === 0 && unexpectedSkips.length === 0;
    const reason = pass ? 'COMPLETE' : deadline || errorCode === 'CHILD_CLOSE_DEADLINE' ? 'FILE_TIMEOUT'
      : error ? 'PROCESS_ERROR' : receiptError ? 'INVALID_RECEIPT'
      : summaryStatus === 'MISSING' ? 'MISSING_RECEIPT' : summaryStatus === 'INCOMPLETE' ? 'INCOMPLETE_TEST_RUN'
      : summary?.failed > 0 || summary?.todo?.length > 0 || unexpectedSkips.length > 0 ? 'TEST_FAILURE'
      : closure?.code !== 0 || closure?.signal !== null ? 'CHILD_EXIT_NONZERO' : 'TEST_FAILURE';
    return {file:path.relative(root,filename).split(path.sep).join('/'), pass, closure, error, errorCode,
      cleanupError, timeoutMs:budgetMs, deadline, childPid:child.pid, childExitCode:child.exitCode,
      childSignal:child.signalCode, summaryStatus, receiptError, unexpectedSkips, reason, summary};
  } finally {fs.rmSync(scratch, {recursive:true,force:true});}
}

export async function runFiles(files, {directory = path.join(root,'.agent-controller'), output = chunk => process.stdout.write(chunk)} = {}) {
  if (process.env.RUNTIME_CLEANUP_IDS) throw new Error('Partial cleanup selection is diagnostic-only; clear RUNTIME_CLEANUP_IDS for a gate run');
  if (!files.length || new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error('Expected a nonempty, unique test file list');
  for (const file of files) if (!fs.statSync(file).isFile()) throw new Error('Missing test file: '+file);
  fs.mkdirSync(directory, {recursive:true});
  const logPath = path.join(directory,'latest-test.log');
  fs.writeFileSync(logPath,'');
  const resultPath = path.join(directory,'latest-test-result.json');
  const result = {status:'RUNNING', node:process.version, platform:process.platform,
    scheduled:files.map(file => path.relative(root,file).split(path.sep).join('/')), results:[]};
  const save = () => fs.writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
  const write = chunk => {fs.appendFileSync(logPath,chunk); output(chunk);};
  save();
  try {
    for (const file of files) {
      const budgetMs = fileTimeoutMs(file);
      write('\nFILE '+path.relative(root,file)+' timeoutMs='+budgetMs+'\n');
      const item = await runFile(file,{output:write,timeoutMs:budgetMs});
      result.results.push(item);
      write('FILE_RESULT '+JSON.stringify({file:item.file,reason:item.reason,pass:item.pass,
        timeoutMs:item.timeoutMs,deadline:item.deadline,childPid:item.childPid,
        childExitCode:item.childExitCode,childSignal:item.childSignal,
        closure:item.closure,error:item.error,errorCode:item.errorCode,cleanupError:item.cleanupError,
        summaryStatus:item.summaryStatus,receiptError:item.receiptError,
        plan:item.summary?.plan,topLevel:item.summary?.topLevel,
        passed:item.summary?.passed,failed:item.summary?.failed,skipped:item.summary?.skipped})+'\n');
      save();
    }
    result.status = result.results.length === result.scheduled.length && result.results.every(item => item.pass) ? 'PASS' : 'FAIL';
    write('\nTEST_GATE '+result.status+' '+result.results.filter(item=>item.pass).length+'/'+files.length+' files\n');
    save();
    return result;
  } catch (cause) {
    result.status = 'FAIL'; result.error = cause.message;
    write('TEST_GATE_EXCEPTION '+JSON.stringify({error:cause.message,code:cause.code ?? null})+'\n');
    throw cause;
  } finally {save();}
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
