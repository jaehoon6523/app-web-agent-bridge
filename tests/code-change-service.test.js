import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit, reportFor } from "./helpers/audit-fixtures.js";

test("VAL-01/13/16: implement, find, fix, re-audit, persist, and separately apply exactly the reviewed candidate",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),2);
  assert.ok(f.acknowledgements.length>=4,"every reviewer/plan delivery must be acknowledged");
  assert.equal(run.findings[0].status,"RESOLVED");assert.equal(f.briefs[1].unresolvedFindings[0].findingId,run.findings[0].findingId);
  assert.ok(run.evidence.some((e)=>e.candidateId===run.candidate.candidateId
    && e.kind==="CODE_SNAPSHOT"&&e.result?.path==="file.txt"));
  assert.equal(fs.readFileSync(path.join(f.target,"file.txt"),"utf8"),"base\n");
  await f.reopen(); const current=f.service.get(run.runId);const payload=f.applyPayload(current);
  await assert.rejects(f.dashboard.execute({type:"code.apply",payload:{...payload,candidateId:"wrong"}}),/candidate/);
  const applied=await f.dashboard.execute({type:"code.apply",payload});assert.equal(applied.stage,"APPLIED");
  assert.equal(fs.readFileSync(path.join(f.target,"file.txt"),"utf8"),"revision 2\n");
  await assert.rejects(f.dashboard.execute({type:"code.apply",payload}),/changed/);
});
test("VAL-14/21: restart reconciles APPLYING and never redispatches active work",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  await f.dashboard.execute({type:"code.apply",payload:f.applyPayload(run)});f.service.update(run.runId,{stage:"APPLYING"});
  await f.reopen();assert.equal(f.service.get(run.runId).stage,"APPLIED");assert.equal(f.starts(),2);
  f.service.update(run.runId,{stage:"WORKER_RUNNING"});await f.reopen();assert.equal(f.service.get(run.runId).stage,"RECOVERY_REQUIRED");assert.equal(f.starts(),2);
});
test("VAL-07: additional code and evidence retrieval stays on the same candidate",async(t)=>{
  const f=setupAudit(t,{review(data,n){const c=data.context;if(n===1)return{type:"EVIDENCE_REQUEST",runId:c.runId,requestId:c.requestId,candidateId:c.candidateId,requirementsRef:c.requirementsRef,requests:[{requestItemId:"code",kind:"CODE",path:"file.txt",purpose:"Check surrounding code"}]};return reportFor(c);}});
  const run=await f.run();assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),1);
  assert.equal(run.candidates.length,1);
  assert.ok(f.prompts[1].evidence.some((e)=>e.kind==="CODE_SNAPSHOT"),"manifest restart must expose the supplemented evidence");
  assert.ok(run.evidence.some((e)=>e.kind==="CODE_SNAPSHOT"));
});
test("VAL-04: malformed report is repaired without starting another worker",async(t)=>{
  const f=setupAudit(t,{review(data,n){return n===1?{...reportFor(data.context),assessments:[]}:reportFor(data.context);}});
  const run=await f.run();assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),1);assert.equal(f.prompts[1].feedback.kind,"REPORT_REPAIR");
});
test("VAL-12: iteration and evidence limits retain unresolved work, never success",async(t)=>{
  const f=setupAudit(t,{configure(p){p.policy.maxIterations=1;}});const run=await f.run();
  assert.equal(run.stage,"INCONCLUSIVE");assert.equal(run.terminationReason,"ITERATION_LIMIT");assert.equal(run.findings[0].status,"OPEN");
  assert.equal(f.service.snapshot(run.runId,{}).run.phase,"INCONCLUSIVE");
});
test("VAL-10: command receipts survive restart and conflicting request IDs fail",async(t)=>{
  const f=setupAudit(t), run=await f.run();const command={type:"code.apply",requestId:"apply-once",payload:f.applyPayload(run)};
  const first=await f.dashboard.executeDurable(command);await f.reopen();
  assert.deepEqual(await f.dashboard.executeDurable(command),first);
  await assert.rejects(f.dashboard.executeDurable({...command,type:"run.stop"}),/different command/);
});

test("REPORT_REPAIR_LIMIT resumes the same candidate after restart and continues the normal loop",async(t)=>{
  const f=setupAudit(t,{
    configure(project){project.policy.maxFormatRepairs=0;},
    review(data,n){return n===1?{...reportFor(data.context),assessments:[]}:reportFor(data.context);}
  });
  const held=await f.run();
  assert.equal(held.stage,"HOLD",held.error);
  assert.equal(held.terminationReason,"REPORT_REPAIR_LIMIT");
  assert.equal(f.starts(),1);
  assert.equal(held.candidates.length,1);
  assert.ok(held.evidence.some((e)=>e.kind==="CODE_SNAPSHOT"));
  f.service.update(held.runId,{evidence:held.evidence.filter((e)=>e.kind!=="CODE_SNAPSHOT")});
  const candidateId=held.candidate.candidateId,patchHash=held.candidate.patchHash;

  await f.reopen();
  const current=f.service.get(held.runId);
  assert.ok(f.service.snapshot(current.runId,{}).commandCapabilities.includes("code.review.retry"));

  const accepted=await f.dashboard.executeDurable({
    type:"code.review.retry",requestId:"review-retry-once",
    payload:{runId:current.runId,expectedVersion:current.version}
  });
  assert.equal(accepted.status,"REVIEW_RETRY_ACCEPTED");
  assert.equal(accepted.candidateId,candidateId);
  await f.service.jobs.get(current.runId);

  const resumed=f.service.get(current.runId);
  assert.equal(resumed.stage,"AWAITING_APPLY",resumed.error);
  assert.equal(f.starts(),1,"format-only retry must not rerun Worker");
  assert.equal(resumed.candidates.length,1);
  assert.equal(resumed.candidate.candidateId,candidateId);
  assert.equal(resumed.candidate.patchHash,patchHash);
  assert.ok(resumed.evidence.some((e)=>e.candidateId===candidateId
    && e.kind==="CODE_SNAPSHOT"&&e.result?.path==="file.txt"));
  assert.equal(resumed.recoveryAttempts.at(-1).kind,"AUDIT_REPORT_RETRY");
});
