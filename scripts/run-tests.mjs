import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ownedSpawn, forceProcessTree} from './e2e/platform/process.mjs';
import {fileURLToPath} from 'node:url';
import {observeChildClose, waitChildClose} from '../src/runtime/child-close.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reporter = fileURLToPath(new URL('./test-completion-reporter.mjs', import.meta.url));

export function discoverTests(directory) {
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? discoverTests(filename) : /\.test\.[cm]?js$/u.test(entry.name) ? [filename] : [];
  }).sort();
}

export async function runFile(filename, {output = chunk => process.stdout.write(chunk), timeoutMs = 180000} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-receipt-'));
  const receipt = path.join(scratch, 'completion.json');
  let closure, error, summary;
  const child = ownedSpawn(['--test', '--experimental-test-isolation=none',
    '--test-reporter='+reporter, filename], {
    cwd:root,
    env:{...process.env, BRIDGE_TEST_RECEIPT:receipt, BRIDGE_TEST_FILE:path.resolve(filename)},
  });
  const observation = observeChildClose(child);
  child.on('error', cause => {error = cause.message;});
  child.stdout.on('data', output); child.stderr.on('data', output);
  try {
    try {closure = await waitChildClose(child, observation, {timeoutMs, forceClose:()=>forceProcessTree(child)});}
    catch (cause) {error = cause.message; child.stdout.destroy(); child.stderr.destroy();}
    if (fs.existsSync(receipt)) summary = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const allowedSkip = path.resolve(filename) === path.join(root,'tests/certify.test.js') && process.platform !== 'win32'
      ? ['certification command runner launches npm on Windows'] : [];
    const pass = !error && closure?.code === 0 && closure?.signal === null && summary?.completed === true
      && summary.failed === 0 && summary.todo.length === 0
      && summary.skipped.every(name => allowedSkip.includes(name));
    return {file:path.relative(root,filename).split(path.sep).join('/'), pass, closure, error,
      reason:pass ? 'COMPLETE' : !summary?.completed ? 'INCOMPLETE_TEST_RUN' : 'TEST_FAILURE', summary};
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
      write('\nFILE '+path.relative(root,file)+'\n');
      result.results.push(await runFile(file,{output:write}));
      save();
    }
    result.status = result.results.length === result.scheduled.length && result.results.every(item => item.pass) ? 'PASS' : 'FAIL';
    write('\nTEST_GATE '+result.status+' '+result.results.filter(item=>item.pass).length+'/'+files.length+' files\n');
    save();
    return result;
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
