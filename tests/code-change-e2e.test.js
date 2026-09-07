import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit, reportFor } from "./helpers/audit-fixtures.js";

test("VAL-06/08: actual verification collects failure/output and invalidates mutations",async(t)=>{
  const f=setupAudit(t,{configure(p){p.verifications=[{verificationId:"check",executable:process.execPath,args:["-e","console.log('actual-output'); process.exit(3)"],cwd:".",timeoutMs:5000,purpose:"Failure evidence",environmentId:"local-node",resultFiles:[]}];},review(data){return reportFor(data.context,"UNDETERMINED");}});
  const run=await f.run();assert.equal(run.stage,"HOLD",run.error);const e=run.evidence.find((e)=>e.kind==="EXECUTION");assert.equal(e.result.exitCode,3);
  assert.match(f.service.artifactStore.read(e.contentRef.sha256).toString(),/actual-output/);assert.equal(e.valid,true);
});
test("validation that changes candidate is never attributed to the original candidate",async(t)=>{
  const f=setupAudit(t,{configure(p){p.verifications=[{verificationId:"mutate",executable:process.execPath,args:["-e","require('fs').writeFileSync('file.txt','weakened')"],cwd:".",timeoutMs:5000,purpose:"Mutation boundary",environmentId:"local-node",resultFiles:[]}];}});
  const run=await f.run();assert.equal(run.stage,"RECOVERY_REQUIRED",run.error);assert.equal(f.reviews(),0);assert.equal(run.evidence.find((e)=>e.kind==="EXECUTION").valid,false);
});
test("VAL-15: stop racing a late reviewer blocks approval and additional workers",async(t)=>{
  let release, entered;const reached=new Promise((r)=>{entered=r;});const wait=new Promise((r)=>{release=r;});
  const f=setupAudit(t,{async review(data){entered();await wait;return reportFor(data.context);}});
  const start=await f.start();await reached;const running=f.service.get(start.runId);
  await f.dashboard.execute({type:"run.stop",payload:{runId:start.runId,expectedVersion:running.version}});release();await f.service.jobs.get(start.runId);
  const stopped=f.service.get(start.runId);assert.equal(stopped.stage,"CANCELLED");assert.equal(stopped.reviews.length,0);assert.equal(f.starts(),1);
  assert.equal(fs.readFileSync(path.join(f.target,"file.txt"),"utf8"),"base\n");
});
test("VAL-03: no changes can be audited but never self-declared complete",async(t)=>{
  const f=setupAudit(t,{worker(){},review(data){return reportFor(data.context,"UNDETERMINED");}});
  const run=await f.run();assert.equal(run.stage,"HOLD",run.error);assert.equal(run.candidate.unchanged,true);assert.equal(run.auditResult,"HOLD");
});
test("start returns the accepted ID while Web provisioning is still pending",async(t)=>{
  let release;const wait=new Promise((r)=>{release=r;});const f=setupAudit(t,{resume(){return wait;}});
  const started=await f.start();assert.ok(started.runId);assert.equal(f.starts(),0);assert.ok(f.service.get(started.runId));release();await f.service.jobs.get(started.runId);
});
