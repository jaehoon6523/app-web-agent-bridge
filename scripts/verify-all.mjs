import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verificationSource} from './verification-source.mjs';
import {acquireLatestRun} from './latest-run.mjs';
import {runOwnedNode} from './e2e/platform/process.mjs';
import {verificationPlan} from './verification-plan.mjs';
import {executeVerification} from './verification-engine.mjs';
import {startResourceSamples,startWindowsMemorySamples} from './e2e/diagnostics.mjs';
import {configureVerificationTemp} from './verification-temp.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const scope=process.argv.find(arg=>arg.startsWith('--scope='))?.slice(8) || 'full';
const maxDiscoveryConcurrency=Number(process.argv.find(arg=>arg.startsWith('--discovery-concurrency='))?.slice(24) || 1);
if(![1,2,4].includes(maxDiscoveryConcurrency)) throw Error('Discovery concurrency must be 1, 2 or 4');
const basePlan=verificationPlan({scope:scope==='p1'?'full':scope});
const p1Stages=new Set(['discovery-serial','discovery','discovery-2','discovery-3','discovery-4']);
const focusArg=process.argv.find(arg=>arg.startsWith('--p1-files='));
if(focusArg && scope!=='p1') throw Error('P1 files require --scope=p1');
const focused=focusArg?.slice('--p1-files='.length).split(',');
let plan=scope==='p1'?basePlan.filter(stage=>p1Stages.has(stage.id)).map(stage=>({...stage,needs:[],evidencePaths:[]})):basePlan;
if(focused) {
  if(!focused.length || new Set(focused).size!==focused.length || focused.some(file=>!plan.some(stage=>stage.expectedFiles.includes(file))))
    throw Error('INVALID_P1_FILES');
  plan=plan.map(stage=>{
    const files=stage.expectedFiles.filter(file=>focused.includes(file));
    return {...stage,expectedFiles:files,nodeArgs:['scripts/run-tests.mjs',...files]};
  }).filter(stage=>stage.expectedFiles.length);
}
if(process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify({scope,node:process.version,platform:process.platform,stages:plan},null,2)+'\n');
} else {
  const tempRoot=configureVerificationTemp(root);
  const directory=path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root,'.agent-controller'));
  const runId=randomUUID(), lease=acquireLatestRun(directory,'verification',runId), abort=new AbortController();
  const diagnostics=path.join(directory,'verification-runs',runId,'resource-diagnostics');
  fs.mkdirSync(diagnostics,{recursive:true});
  fs.writeFileSync(path.join(diagnostics,'environment.json'),JSON.stringify({tempRoot,parentPid:process.pid,node:process.version,
    platform:process.platform},null,2)+'\n');
  const stopSamples=startResourceSamples(diagnostics),stopWindowsMemory=startWindowsMemorySamples(diagnostics);
  const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  process.stdout.on('error',()=>{});
  try {
    const source=verificationSource(root);
    const result=await executeVerification({root,directory,plan,source,runId,signal:abort.signal,maxDiscoveryConcurrency,
      readSource:()=>verificationSource(root),output:chunk=>{if(!process.stdout.destroyed)process.stdout.write(chunk);},
      run:async(stage,{write,stageRunId,signal,stageDirectory})=>{
        const npmCli=process.env.npm_execpath;
        if(!npmCli && !stage.nodeArgs) throw Error('Run with npm run verify:all');
        const browserPath=path.join(directory,'latest-browser-preparation.json');
        const executable=stage.browser && stage.phase!=='PREPARATION' && fs.existsSync(browserPath)
          ?JSON.parse(fs.readFileSync(browserPath,'utf8')).executable:process.env.UI_BROWSER_EXECUTABLE;
        const env={...process.env,BRIDGE_VERIFICATION_RUN_ID:stageRunId,
          BRIDGE_VERIFICATION_OUTPUT:stage.receiptKind==='spec'?stageDirectory:directory,
          ...(stage.isolatedGateOutput?{BRIDGE_TEST_GATE_OUTPUT:stageDirectory}:{}),
          ...(executable?{UI_BROWSER_EXECUTABLE:executable}:{})};
        if(!stage.isolatedGateOutput) delete env.BRIDGE_TEST_GATE_OUTPUT;
        env.NODE_OPTIONS=`${env.NODE_OPTIONS || ''} --report-on-fatalerror --report-exclude-env --report-exclude-network --report-directory="${stageDirectory.replaceAll('\\','/')}"`;
        delete env.NODE_TEST_CONTEXT;
        return runOwnedNode(stage.nodeArgs || [npmCli,...(stage.args || ['run',stage.command])],
          {cwd:root,env,timeoutMs:stage.timeoutMs,signal,onStdout:write,onStderr:write,
            onSpawn:child=>{
              try { fs.appendFileSync(path.join(diagnostics,'stages.jsonl'),
                JSON.stringify({at:new Date().toISOString(),stage:stage.id,pid:child.pid,parentPid:process.pid})+'\n'); }
              catch(error) { process.stderr.write(`[Verification diagnostics] ${error.message}\n`); }
            }});
      }});
    process.exitCode=result.status==='PASS'?0:result.status==='PARTIAL'?2:1;
  } finally {
    stopSamples();stopWindowsMemory();
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);lease.release();
  }
}
