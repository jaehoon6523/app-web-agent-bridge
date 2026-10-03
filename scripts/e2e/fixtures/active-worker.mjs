// External Codex app-server protocol peer. No model/authentication substitute.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const output=process.argv[2], threadId='controlled-thread-'+process.pid;
let workspace, current, brief, terminal=false, steers=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const save=()=>fs.writeFileSync(output,JSON.stringify({pid:process.pid,sessionId:threadId,turnId:current,workspaceRoot:workspace,requirementIds:brief.requirements.items.map(r=>r.requirementId),steers}));
const rl = readline.createInterface({input:process.stdin});
let closing = false, completionTimer;
function shutdown() {
 if (closing) return;
 closing = true;
 clearTimeout(completionTimer);
 rl.close();
 process.stdin.pause();
 process.exitCode = 0;
}
rl.on('close', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
rl.on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);
 if(method==='initialize')return send({id,result:{userAgent:'controlled-active-worker'}});
 if(method==='initialized')return;
 if(method==='thread/start'){workspace=params.cwd;return send({id,result:{thread:{id:threadId,sessionId:threadId}}});}
 if(method==='turn/start'){
  current='controlled-turn-'+process.pid;const text=params.input.filter(x=>x.type==='text').map(x=>x.text).join('\n');brief=JSON.parse(text.slice(text.indexOf('\n')+1));save();
  return send({id,result:{turn:{id:current,status:'inProgress',items:[]}}});
 }
 if(method==='turn/steer'){
  if(params.threadId!==threadId || params.expectedTurnId!==current)return send({id,error:{code:-1,message:'Stale fixture turn'}});
  steers.push(params);save();send({id,result:{turnId:current}});
  if(steers.length===2){fs.writeFileSync(path.join(workspace,'clock.txt'),'Controlled worker candidate: hours minutes seconds\n');
   const report={summary:'Controlled active Worker completed',requirementClaims:brief.requirements.items.map(r=>({requirementId:r.requirementId,claim:'Controlled clock candidate'})),findingResponses:[],unverified:['Real model']};
   const item={type:'agentMessage',id:'output-'+current,phase:'final_answer',text:JSON.stringify(report)};
   completionTimer=setTimeout(()=>{terminal=true;send({method:'item/completed',params:{threadId,turnId:current,item}});send({method:'turn/completed',params:{threadId,turn:{id:current,status:'completed',items:[item],error:null}}});},150);
  }return;
 }
 if(method==='thread/read')return send({id,result:{thread:{id:threadId,status:{type:terminal?'idle':'active',activeFlags:[]},turns:current?[{id:current,status:terminal?'completed':'inProgress',items:[]}]:[]}}});
 if(method==='turn/interrupt')return send({id,result:{}});
 if(id!==undefined)send({id,error:{code:-32601,message:'Unsupported '+method}});
});
