import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verificationSource} from './verification-source.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.resolve(process.env.BRIDGE_P1_REPEAT_OUTPUT || path.join(root,'.agent-controller','p1-repeat'));
const intervalMinutes=30;
const intervalMs=intervalMinutes*60*1000;
if(!process.env.npm_execpath) throw Error('Run with npm run verify:p1:repeat');
const source=verificationSource(root);
const firstStartedAt=Date.now();
fs.mkdirSync(directory,{recursive:true});
const events=path.join(directory,'schedule.jsonl');
const record=(event,attributes={})=>fs.appendFileSync(events,JSON.stringify({at:new Date().toISOString(),event,...attributes})+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.min(ms,60_000)));
const sameSource=()=>{const current=verificationSource(root);return current.head===source.head && current.sourceSha256===source.sourceSha256;};
const resources=()=>{const disk=fs.statfsSync(directory);return {freeMemoryBytes:os.freemem(),freeDiskBytes:Number(disk.bavail)*Number(disk.bsize)};};

fs.writeFileSync(path.join(directory,'plan.json'),JSON.stringify({source:{head:source.head,sourceSha256:source.sourceSha256},
  intervalMinutes,rounds:5,firstStartedAt:new Date(firstStartedAt).toISOString()},null,2)+'\n');
record('SCHEDULED',{sourceSha256:source.sourceSha256});
let completedRounds=0;
let failedRounds=0;
for(let round=1;round<=5;round++) {
  const due=firstStartedAt+(round-1)*intervalMs;
  while(Date.now()<due) await sleep(due-Date.now());
  if(!sameSource()) {record('STOP_SOURCE_CHANGED',{round});process.exitCode=1;break;}
  const resourceDeadline=Date.now()+12*60*60*1000;
  let available=resources();
  while((available.freeMemoryBytes<1024**3 || available.freeDiskBytes<2*1024**3) && Date.now()<resourceDeadline) {
    record('WAIT_RESOURCES',{round,...available});
    await sleep(60_000);
    if(!sameSource()) break;
    available=resources();
  }
  if(!sameSource()) {record('STOP_SOURCE_CHANGED',{round});process.exitCode=1;break;}
  if(available.freeMemoryBytes<1024**3 || available.freeDiskBytes<2*1024**3) {
    record('STOP_RESOURCES',{round,...available});process.exitCode=1;break;
  }
  const output=path.join(directory,String(round).padStart(2,'0'));
  fs.mkdirSync(output,{recursive:true});
  const stdout=fs.openSync(path.join(output,'launcher.stdout.log'),'w');
  const stderr=fs.openSync(path.join(output,'launcher.stderr.log'),'w');
  const child=spawn(process.execPath,['--experimental-sqlite','scripts/verify-all.mjs','--scope=p1','--discovery-concurrency=2'],
    {cwd:root,env:{...process.env,BRIDGE_VERIFICATION_OUTPUT:output},stdio:['ignore',stdout,stderr],windowsHide:true});
  fs.closeSync(stdout);fs.closeSync(stderr);
  record('RUN_STARTED',{round,pid:child.pid,output,sourceSha256:source.sourceSha256,plannedAt:new Date(due).toISOString(),...available});
  const closed=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.code ?? error.message}));
    child.once('close',(code,signal)=>resolve({code,signal}));});
  let result;
  try {result=JSON.parse(fs.readFileSync(path.join(output,'latest-verification.json'),'utf8'));}
  catch {result=null;}
  record('RUN_CLOSED',{round,...closed,runId:result?.runId,status:result?.status,
    candidateUnchanged:result?.candidateUnchanged,sourceSha256:result?.source?.sourceSha256});
  if(!sameSource()) {record('STOP_SOURCE_CHANGED',{round});process.exitCode=1;break;}
  if(closed.error || closed.signal || !Number.isInteger(closed.code)) {
    record('STOP_EXECUTION',{round,...closed});process.exitCode=1;break;
  }
  if(!result || !['PASS','FAIL'].includes(result.status) || typeof result.candidateUnchanged!=='boolean'
    || typeof result.source?.head!=='string' || typeof result.source?.sourceSha256!=='string') {
    record('STOP_INVALID_RESULT',{round});process.exitCode=1;break;
  }
  if(!result.candidateUnchanged || result.source.head!==source.head || result.source.sourceSha256!==source.sourceSha256) {
    record('STOP_SOURCE_CHANGED',{round});process.exitCode=1;break;
  }
  if(result.status==='PASS' && closed.code!==0) {record('STOP_EXECUTION',{round,...closed});process.exitCode=1;break;}
  if(result.status==='FAIL' || closed.code!==0) {
    record('RUN_FAILED',{round});failedRounds++;process.exitCode=1;continue;
  }
  completedRounds++;
}
if(completedRounds===5 && failedRounds===0 && sameSource()) {
  const output=path.join(directory,'official');fs.mkdirSync(output,{recursive:true});
  const stdout=fs.openSync(path.join(output,'launcher.stdout.log'),'w');
  const stderr=fs.openSync(path.join(output,'launcher.stderr.log'),'w');
  const child=spawn(process.execPath,[process.env.npm_execpath,'run','verify:all'],
    {cwd:root,env:{...process.env,BRIDGE_VERIFICATION_OUTPUT:output},stdio:['ignore',stdout,stderr],windowsHide:true});
  fs.closeSync(stdout);fs.closeSync(stderr);
  record('OFFICIAL_STARTED',{pid:child.pid,output,sourceSha256:source.sourceSha256});
  const closed=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.code ?? error.message}));
    child.once('close',(code,signal)=>resolve({code,signal}));});
  let result;try{result=JSON.parse(fs.readFileSync(path.join(output,'latest-verification.json'),'utf8'));}catch{result=null;}
  const valid=closed.code===0 && !closed.signal && result?.status==='PASS' && result.candidateUnchanged===true
    && result.source.head===source.head && result.source.sourceSha256===source.sourceSha256 && sameSource();
  record('OFFICIAL_CLOSED',{...closed,status:result?.status,sourceSha256:result?.source?.sourceSha256,valid});
  if(!valid)process.exitCode=1;
}
record('SCHEDULER_FINISHED',{exitCode:process.exitCode ?? 0});
