import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verificationSource} from './verification-source.mjs';
import {acquireLatestRun} from './latest-run.mjs';
import {runOwnedNode} from './e2e/platform/process.mjs';
import {verificationPlan} from './verification-plan.mjs';
import {executeVerification} from './verification-engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const scope=process.argv.find(arg=>arg.startsWith('--scope='))?.slice(8) || 'full';
const plan=verificationPlan({scope});
if(process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify({scope,node:process.version,platform:process.platform,stages:plan},null,2)+'\n');
} else {
  const directory=path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root,'.agent-controller'));
  const runId=randomUUID(), lease=acquireLatestRun(directory,'verification',runId), abort=new AbortController();
  const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  process.stdout.on('error',()=>{});
  try {
    const source=verificationSource(root);
    const result=await executeVerification({root,directory,plan,source,runId,signal:abort.signal,
      readSource:()=>verificationSource(root),output:chunk=>{if(!process.stdout.destroyed)process.stdout.write(chunk);},
      run:async(stage,{write,stageRunId,signal,stageDirectory})=>{
        const npmCli=process.env.npm_execpath;
        if(!npmCli) throw Error('Run with npm run verify:all');
        const browserPath=path.join(directory,'latest-browser-preparation.json');
        const executable=stage.browser && stage.phase!=='PREPARATION' && fs.existsSync(browserPath)
          ?JSON.parse(fs.readFileSync(browserPath,'utf8')).executable:process.env.UI_BROWSER_EXECUTABLE;
        const env={...process.env,BRIDGE_VERIFICATION_RUN_ID:stageRunId,
          BRIDGE_VERIFICATION_OUTPUT:stage.receiptKind==='spec'?stageDirectory:directory,
          ...(executable?{UI_BROWSER_EXECUTABLE:executable}:{})};
        delete env.NODE_TEST_CONTEXT;
        return runOwnedNode(stage.nodeArgs || [npmCli,...(stage.args || ['run',stage.command])],
          {cwd:root,env,timeoutMs:stage.timeoutMs,signal,onStdout:write,onStderr:write});
      }});
    process.exitCode=result.status==='PASS'?0:result.status==='PARTIAL'?2:1;
  } finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);lease.release();}
}
