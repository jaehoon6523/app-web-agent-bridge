import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runOwnedNode} from './e2e/platform/process.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'.agent-controller');
fs.mkdirSync(directory,{recursive:true});
const log=path.join(directory,'delivery-recovery-verification-latest.log');
fs.writeFileSync(log,'');
const output=chunk=>{fs.appendFileSync(log,chunk);process.stdout.write(chunk);};
const files=['extension/manifest.json','extension/background.js','extension/runtime/delivery-discard.js',
  'src/orchestration/delivery-recovery-actions.js','src/orchestration/terminal-delivery-reconciliation.js','public/delivery-recovery.js'];
const result={startedAt:new Date().toISOString(),node:process.version,platform:process.platform,
  baseline:'2772b43e0ac7becaa4aa4bf1df1e6dbc0371cada',liveUserChrome:'UNVERIFIED',stages:[]};
try {result.head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();} catch {result.head=null;}
result.files=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
output('VERIFICATION_ENV '+JSON.stringify(result)+'\n');
const regression=['tests/delivery-terminal-reconciliation.test.js','tests/delivery-terminal-http.test.js','tests/delivery-recovery-audit.test.js',
  'tests/extension-delivery-review.test.js','tests/web-delivery-recovery.test.js','tests/web-extension-storage.new.test.js',
  'tests/web-document-binding.test.js','tests/content-lifecycle.test.js','tests/web-selector-registry.new.test.js',
  'tests/agent-diagnostics-complete.test.js','tests/agent-diagnostics-http.test.js','tests/diagnostic-safety.test.js'];
const stages=[['lint',['scripts/lint.js']],['architecture',['scripts/architecture-check.js']],
  ['typecheck',['node_modules/typescript/bin/tsc','--pretty','false']],
  ['recovery-regression',['scripts/run-tests.mjs',...regression]],
  ['chromium-fixtures',['scripts/run-tests.mjs','scripts/delivery-terminal-browser-suite.mjs','scripts/content-lifecycle-browser-suite.mjs']]];
try {
  if(process.argv.includes('--full')) {
    if(!process.env.npm_execpath) throw new Error('Use npm run verify:delivery-recovery -- --full');
    stages.unshift(['full-check',[process.env.npm_execpath,'run','check']]);
  }
  for(const [name,args] of stages) {
    output('\nSTAGE '+name+'\n');
    const closed=await runOwnedNode(args,{cwd:root,timeoutMs:20*60*1000,onStdout:output,onStderr:output});
    const status=closed.code===0 && !closed.signal && !closed.forced ? 'PASS' : 'FAIL';
    result.stages.push({name,status,code:closed.code,signal:closed.signal,forced:closed.forced});
    output('STAGE_RESULT '+JSON.stringify(result.stages.at(-1))+'\n');
  }
  result.status=result.stages.every(stage=>stage.status==='PASS') ? 'PASS' : 'FAIL';
} catch(error) {result.status='FAIL';result.error=error.message;}
result.finishedAt=new Date().toISOString();output('\nVERIFICATION_RESULT '+JSON.stringify(result)+'\n');
process.exitCode=result.status==='PASS' ? 0 : 1;
