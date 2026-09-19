import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit, reportFor } from "./helpers/audit-fixtures.js";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";
import { createLiveDiscussionRuntime } from "../src/runtime/live-discussion-runtime.js";

function request(c, requests) { return {type:"EVIDENCE_REQUEST",runId:c.runId,requestId:c.requestId,candidateId:c.candidateId,requirementsRef:c.requirementsRef,requests}; }
test("VAL-08/09: arbitrary commands and escaping code paths return unavailable without execution",async(t)=>{
  const f=setupAudit(t,{review(data,n){return n===1?request(data.context,[
    {requestItemId:"bad-code",kind:"CODE",path:"../outside",purpose:"Boundary check"},
    {requestItemId:"bad-command",kind:"VERIFY",verificationId:"echo unsafe > file",purpose:"Unknown command"}
  ]):reportFor(data.context,"UNDETERMINED");}});
  const run=await f.run();assert.equal(run.stage,"HOLD",run.error);assert.equal(run.verificationIntents.length,0);
  assert.deepEqual(f.prompts[1].feedback.results.map((r)=>r.status),["UNAVAILABLE","UNAVAILABLE"]);assert.equal(f.starts(),1);
});
test("VAL-11: disconnected review remains recovery-required and is not resent on restart",async(t)=>{
  const f=setupAudit(t,{review(){throw new Error("Extension disconnected after submission");},interrupt(){throw new Error("Cannot confirm remote turn");}});
  const run=await f.run();assert.equal(run.stage,"RECOVERY_REQUIRED");assert.equal(run.requests.length,1);assert.equal(run.requests[0].status,"INTENT");
  await f.reopen();assert.equal(f.reviews(),1);assert.equal(f.starts(),1);assert.equal(f.service.get(run.runId).stage,"RECOVERY_REQUIRED");
});
test("VAL-12: evidence exhaustion preserves the request, format exhaustion preserves the error",async(t)=>{
  const f=setupAudit(t,{configure(p){p.policy.maxEvidenceRounds=0;},review(data){return request(data.context,[{requestItemId:"needed",kind:"CODE",path:"file.txt",purpose:"Need source"}]);}});
  const run=await f.run();assert.equal(run.stage,"HOLD");assert.equal(run.terminationReason,"EVIDENCE_LIMIT");assert.equal(run.missingInformation[0].requestItemId,"needed");
  const g=setupAudit(t,{configure(p){p.policy.maxFormatRepairs=0;},review(data){return {...reportFor(data.context),assessments:[]};}});
  const malformed=await g.run();assert.equal(malformed.stage,"HOLD");assert.equal(malformed.terminationReason,"REPORT_REPAIR_LIMIT");assert.equal(g.starts(),1);
});
test("VAL-14: restart distinguishes base, exact applied candidate, and unrelated target state",async(t)=>{
  const f=setupAudit(t), run=await f.run();
  const application={applicationId:"application-test",candidateId:run.candidate.candidateId,reviewId:run.reviews.at(-1).reviewId,baseCommit:run.baseCommit,status:"APPLYING"};
  f.service.update(run.runId,{stage:"APPLYING",application});await f.reopen();assert.equal(f.service.get(run.runId).stage,"AWAITING_APPLY");
  fs.writeFileSync(path.join(f.target,"file.txt"),"unrelated change\n");f.service.update(run.runId,{stage:"APPLYING"});await f.reopen();
  assert.equal(f.service.get(run.runId).stage,"RECOVERY_REQUIRED");assert.equal(f.service.get(run.runId).application.status,"AMBIGUOUS");
});
test("VAL-13: moved target base prevents application and preserves unrelated changes",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  fs.writeFileSync(path.join(f.target,"other.txt"),"user change\n");f.git("add",".");f.git("-c","user.name=Test","-c","user.email=test@example.invalid","-c","core.hooksPath=","commit","--quiet","-m","unrelated");
  await assert.rejects(f.service.command("code.apply",f.applyPayload(run)),/Target HEAD/);
  assert.equal(fs.readFileSync(path.join(f.target,"other.txt"),"utf8"),"user change\n");assert.equal(fs.readFileSync(path.join(f.target,"file.txt"),"utf8"),"base\n");
});
test("captured source bytes are durable and cannot drift with the mutable workspace",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  const workspace=new GitChangeWorkspace({workspaceRoot:run.workspaceRoot,baseCommit:run.baseCommit,targetRoot:run.targetRoot,artifactStore:f.service.artifactStore});
  fs.writeFileSync(path.join(workspace.root,"file.txt"),"later drift\n");assert.equal(workspace.readCode(run.capture,"file.txt"),"revision 2\n");
  assert.throws(()=>workspace.readCode(run.capture,".git/config"),/inside/);
});
test("old score-based PASS cannot acquire current application authority",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  f.service.update(run.runId,{schemaVersion:1,stage:"AWAITING_APPLY"});await f.reopen();const old=f.service.get(run.runId);
  assert.equal(old.stage,"RECOVERY_REQUIRED");assert.equal(old.auditResult,"UNVERIFIED_LEGACY");assert.equal(f.service.snapshot(run.runId,{}).commandCapabilities.includes("code.apply"),false);
});
test("history remains readable without a configured Codex executable",async(t)=>{
  const f=setupAudit(t),run=await f.run();await f.service.close();
  const runtime=await createLiveDiscussionRuntime({runtimeConfig:{demoMode:false,workspace:f.target,codex:{executablePath:null},persistence:{databasePath:f.options.filename,artifactDirectory:f.options.artifactStore.rootDirectory}},webSession:{start(){},resume(){},interrupt(){}}});
  try { assert.equal(runtime.codeChanges.get(run.runId).stage,"AWAITING_APPLY");assert.equal(runtime.manager,undefined); }
  finally { await runtime.close(); }
});
test("total deadline stops pending worker creation without dispatching an implementation",async(t)=>{
  const f=setupAudit(t,{
    configure(p){p.policy.totalTimeoutMs=200;},
    createWorker(){return new Promise(()=>{});},
  });
  const run=await f.run();assert.equal(run.stage,"RECOVERY_REQUIRED");assert.equal(run.terminationReason,"TOTAL_TIME_LIMIT");assert.equal(f.starts(),0);
});
test("requirements cannot change contents under a previously used revision",async(t)=>{
  const f=setupAudit(t),run=await f.run();
  await f.service.command("run.stop",{runId:run.runId,expectedVersion:run.version});
  f.options.project.requirements.items[0].statement="Different requirement";
  await assert.rejects(f.start(),/new revision/);
  assert.equal(f.service.list().length,1);
});
