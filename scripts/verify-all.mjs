import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runOwnedNode} from './e2e/platform/process.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const directory = path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT ?? path.join(root,'.agent-controller'));
fs.mkdirSync(directory,{recursive:true});
const logPath = path.join(directory,'latest-verification.log');
fs.writeFileSync(logPath,'');
const resultPath = path.join(directory,'latest-verification.json');
const result = {status:'RUNNING',node:process.version,platform:process.platform,stages:[]};
const identityFiles = ['extension/manifest.json','extension/content.js','extension/background.js',
  'extension/runtime/browser-runtime.js','extension/runtime/storage.js','src/orchestration/delivery-recovery-actions.js'];
result.source = {files:Object.fromEntries(identityFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))};
try {result.source.head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();} catch {result.source.head=null;}
const save = () => fs.writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
let logBytes = 0;
const logChunks = [];
process.stdout.on('error', error => {result.consoleError = error.message;});
const output = chunk => {
  const bytes = Buffer.from(chunk);
  logChunks.push(bytes);
  fs.appendFileSync(logPath,bytes); logBytes += bytes.length;
  if (!process.stdout.destroyed) process.stdout.write(chunk);
};
const npmCli = process.env.npm_execpath;
const stages = ['check','test:browser','test:extension:native','test:platform:browser','test:e2e:ci'];
save();
output('VERIFICATION_ENV '+JSON.stringify({node:result.node,platform:result.platform,source:result.source})+'\n');
try {
  if (!npmCli) throw new Error('Run this command with npm run verify:all');
  // Spawn the npm JavaScript entry with Node, avoiding npm.cmd shell semantics.
  for (const command of stages) {
    const stage = {command,status:'RUNNING'};
    result.stages.push(stage); save();
    output('\nSTAGE '+command+'\n');
    const receiptPath = path.join(directory, command === 'test:e2e:ci' ? 'ui-qa/e2e-summary.json'
      : command === 'test:extension:native' ? 'latest-native-extension.json' : 'latest-test-result.json');
    fs.rmSync(receiptPath,{force:true});
    try {
      const closed = await runOwnedNode([npmCli,'run',command],{cwd:root,timeoutMs:25*60*1000,
        onStdout:output,onStderr:output});
      stage.closure = closed;
      if (fs.existsSync(receiptPath)) stage.receipt = JSON.parse(fs.readFileSync(receiptPath,'utf8'));
      const complete = command === 'test:extension:native'
        ? stage.receipt?.nativeExtension === true && stage.receipt?.status === 'PASS'
          && stage.receipt.completed === true && stage.receipt.steps?.length === 5 && stage.receipt.steps.every(item=>item.pass)
        : command === 'test:e2e:ci'
        ? stage.receipt?.scope === 'FULL SUITE' && stage.receipt.failed === 0 && stage.receipt.unexpectedSkips === 0
        : stage.receipt?.status === 'PASS' && stage.receipt.results?.length > 0
          && stage.receipt.results.length === stage.receipt.scheduled?.length
          && stage.receipt.results.every(item=>item.pass && item.summary?.completed);
      stage.status = closed.code === 0 && closed.signal === null && !closed.forced && complete ? 'PASS' : 'FAIL';
      if (command === 'test:extension:native' && closed.code === 2 && closed.signal === null && !closed.forced
        && stage.receipt?.nativeExtension === true && stage.receipt.status === 'UNVERIFIED' && stage.receipt.completed === true) stage.status = 'UNVERIFIED';
    } catch (error) {stage.status='FAIL'; stage.error=error.message; output(stage.error+'\n');}
    // Do not let a subsequent success overwrite an earlier failed stage.
    output('STAGE_RESULT '+JSON.stringify({command,status:stage.status,closure:stage.closure,error:stage.error})+'\n');
    save();
  }
  result.status = result.stages.some(stage=>stage.status==='FAIL') ? 'FAIL'
    : result.stages.some(stage=>stage.status==='UNVERIFIED') ? 'PARTIAL' : 'PASS';
  output('\nVERIFICATION '+result.status+'\n');
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'PARTIAL' ? 2 : 1;
} catch (error) {
  result.status='FAIL'; result.error=error.message; process.exitCode=1; output(error.message+'\n');
} finally {
  // Commit the complete captured stream, then verify its durable byte count.
  fs.writeFileSync(logPath,Buffer.concat(logChunks));
  result.logBytes = fs.statSync(logPath).size; result.expectedLogBytes = logBytes;
  if (result.logBytes !== logBytes) {result.status='FAIL'; result.error='Incomplete verification log'; process.exitCode=1;}
  save();
}
