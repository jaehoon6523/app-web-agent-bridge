import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateCodeReview } from "../src/domain/code-review.js";
import { validateRequirements, requirementsRef } from "../src/domain/audit-contract.js";
import { validateAuditProject } from "../src/orchestration/audit-project.js";
import { executeVerification } from "../src/evidence/candidate-evidence.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { setupAudit, reviewContext, reportFor } from "./helpers/audit-fixtures.js";

function executionContext() {
  const c = reviewContext();
  c.requirements.items[0].verificationMethod = { kinds:["EXECUTION"], description:"Actual check", checks:[{verificationId:"login", expectedExitCode:0, requiredResultFiles:[]}] };
  c.evidence.push({evidenceId:"exec",candidateId:c.candidateId,kind:"EXECUTION",producer:"CONTROLLER",valid:true,
    result:{verificationId:"login",executionId:"exec-1",exitCode:0,timedOut:false,aborted:false,error:null,candidateUnchanged:true,terminationConfirmed:true}});
  c.requirementsRef = requirementsRef(c.requirements);
  const report = reportFor(c); report.assessments[0].evidenceRefs = ["exec"];
  return {c, report};
}
test("required checks reject unrelated, failed, uncertain and superseded executions", () => {
  const {c,report} = executionContext();
  assert.equal(evaluateCodeReview(report,c).decision,"PASS");
  for (const change of [{verificationId:"other"},{exitCode:1},{timedOut:true},{aborted:true},{terminationConfirmed:false},{error:"spawn failed"}]) {
    const altered = structuredClone(c); Object.assign(altered.evidence[1].result,change);
    assert.throws(()=>evaluateCodeReview(report,altered),/verification|execution/i);
  }
  c.evidence.push({...structuredClone(c.evidence[1]),evidenceId:"retry",result:{...c.evidence[1].result,exitCode:1}});
  assert.throws(()=>evaluateCodeReview(report,c),/verification|execution/i);
});
test("required violations cannot be downgraded by the reviewer", () => {
  const c=reviewContext(),r=reportFor(c);
  r.newFindings=[{requirementId:"R1",problem:"Required behavior absent",resolutionCriteria:"Implement it",evidenceRefs:["patch-1"],required:false}];
  const result=evaluateCodeReview(r,c);
  assert.equal(result.decision,"REWORK"); assert.equal(result.findings[0].required,true);
});
test("reference registration, content and explicit authority are mandatory", () => {
  const c=reviewContext();
  const dangling=structuredClone(c.requirements); dangling.items[0].sourceRefs=["missing"];
  assert.throws(()=>validateRequirements(dangling),/source|reference/i);
  const missing=structuredClone(c.requirements); delete missing.authority;
  assert.throws(()=>validateRequirements(missing));
  const before=requirementsRef(c.requirements); c.requirements.sourceRoles[0].content="Changed reference";
  assert.notDeepEqual(requirementsRef(c.requirements),before);
});
test("project rejects unregistered requirement verification IDs", (t) => {
  const f=setupAudit(t); const project=structuredClone(f.options.project);
  project.requirements.items[0].verificationMethod={kinds:["EXECUTION"],description:"check",checks:[{verificationId:"missing",expectedExitCode:0,requiredResultFiles:[]}]};
  assert.throws(()=>validateAuditProject(project),/registered|verification/i);
});
test("verification cannot collect a pre-existing worktree result; new output has execution provenance", async(t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"audit-results-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,"result.txt"),"OLD PASS");
  const options={workspace:{root,assertCandidate(){}},capture:{},candidateId:"c",artifactStore:new ArtifactStore(path.join(root,"artifacts")),
    verification:{verificationId:"v",executable:process.execPath,args:["-e","process.exit(0)"],cwd:".",timeoutMs:3000,environmentId:"test",resultFiles:["result.txt"]}};
  const old=await executeVerification(options); assert.equal(old.artifacts.length,0);assert.match(old.record.resultFiles[0].error,/ENOENT|missing/i);
  options.verification.args=["-e","require('fs').writeFileSync(require('path').join(process.env.BRIDGE_RESULT_DIR,'result.txt'),'NEW PASS')"];
  const fresh=await executeVerification(options);assert.equal(fresh.artifacts.length,1);
  assert.equal(fresh.artifacts[0].result.executionId,fresh.evidence.result.executionId);
  assert.equal(fresh.artifacts[0].executionEvidenceId,fresh.evidence.evidenceId);
  assert.equal(fs.readFileSync(path.join(root,"result.txt"),"utf8"),"OLD PASS");
});
test("recovery abandonment requires operator confirmation, survives restart and unblocks a new run", async(t) => {
  const f=setupAudit(t,{resume(){throw new Error("Disconnected");}});let run=await f.run();
  assert.equal(run.stage,"RECOVERY_REQUIRED");
  await assert.rejects(f.service.command("run.abandon",{runId:run.runId,expectedVersion:run.version,reason:"Checked"}),/confirm/i);
  const command={type:"run.abandon",requestId:"abandon-1",payload:{runId:run.runId,expectedVersion:run.version,externalTerminationConfirmed:true,targetInspected:true,reason:"CLI stopped and remote generation stopped; target inspected"}};
  const abandoned=await f.dashboard.executeDurable(command);assert.equal(abandoned.stage,"CANCELLED");assert.equal(abandoned.recovery.kind,"OPERATOR_ATTESTATION");
  assert.equal(f.service.busy(),false);await f.reopen();assert.equal(f.service.busy(),false);
  assert.deepEqual(await f.dashboard.executeDurable(command),abandoned);
  const next=await f.start();assert.notEqual(next.runId,run.runId);await f.service.jobs.get(next.runId);
});
test("old contract approval cannot be applied after upgrade",async(t)=>{
  const f=setupAudit(t),run=await f.run();f.service.update(run.runId,{schemaVersion:2});await f.reopen();
  assert.equal(f.service.get(run.runId).stage,"RECOVERY_REQUIRED");
});
test("artifact satisfaction requires the named file from the exact successful execution",()=>{
  const {c,report}=executionContext();c.requirements.items[0].verificationMethod.kinds.push("ARTIFACT");
  c.requirements.items[0].verificationMethod.checks[0].requiredResultFiles=["result.txt"];
  const a={evidenceId:"artifact",candidateId:c.candidateId,kind:"ARTIFACT",producer:"CONTROLLER",valid:true,executionEvidenceId:"exec",result:{verificationId:"login",executionId:"exec-1",path:"result.txt"}};
  c.evidence.push(a);report.assessments[0].evidenceRefs.push("artifact");
  assert.equal(evaluateCodeReview(report,c).decision,"PASS");
  for(const change of [{path:"other.txt"},{executionId:"older"},{verificationId:"other"}]) {
    const changed=structuredClone(c);Object.assign(changed.evidence[2].result,change);
    assert.throws(()=>evaluateCodeReview(report,changed),/verification result/);
  }
});
test("optional improvement suggestions do not become blocking violations",()=>{
  const c=reviewContext(),r=reportFor(c);r.suggestions=[{requirementId:"R1",description:"Consider an optional theme",evidenceRefs:["patch-1"]}];
  const result=evaluateCodeReview(r,c);assert.equal(result.decision,"PASS");assert.equal(result.findings.length,0);
});
test("recovery abandonment preserves dirty target and rejects stale or active commands",async(t)=>{
  const f=setupAudit(t,{resume(){throw new Error("Disconnected");}}),run=await f.run();
  const payload={runId:run.runId,expectedVersion:run.version,externalTerminationConfirmed:true,targetInspected:true,reason:"External work stopped; local changes retained"};
  await assert.rejects(f.service.command("run.abandon",{...payload,expectedVersion:run.version-1}),/changed/);
  f.service.jobs.set(run.runId,Promise.resolve());
  await assert.rejects(f.service.command("run.abandon",payload),/settled local/);f.service.jobs.delete(run.runId);
  fs.writeFileSync(path.join(f.target,"file.txt"),"user edits");
  const result=await f.service.command("run.abandon",payload);
  assert.match(result.recovery.targetObservation.status,/file.txt/);assert.equal(fs.readFileSync(path.join(f.target,"file.txt"),"utf8"),"user edits");
  await assert.rejects(f.start(),/existing changes/);
});
test("actual verification with bound output passes audit and applies; missing output cannot pass",async(t)=>{
  const configure=(p)=>{
    p.requirements.items[0].verificationMethod={kinds:["EXECUTION","ARTIFACT"],description:"Verify candidate and output",checks:[{verificationId:"check",expectedExitCode:0,requiredResultFiles:["result.txt"]}]};
    p.verifications=[{verificationId:"check",executable:process.execPath,args:["-e","const fs=require('fs');if(!fs.readFileSync('file.txt','utf8').includes('revision'))process.exit(1);fs.writeFileSync(require('path').join(process.env.BRIDGE_RESULT_DIR,'result.txt'),'verified')"],cwd:".",timeoutMs:3000,purpose:"file revision",environmentId:"node",resultFiles:["result.txt"]}];
  };
  const review=(data)=>{const report=reportFor(data.context);report.assessments[0].evidenceRefs=data.context.evidence.filter(e=>["EXECUTION","ARTIFACT"].includes(e.kind)).map(e=>e.evidenceId);return report;};
  const f=setupAudit(t,{configure,review}),run=await f.run();assert.equal(run.stage,"AWAITING_APPLY",run.error);
  assert.equal((await f.service.command("code.apply",f.applyPayload(run))).stage,"APPLIED");
  const g=setupAudit(t,{configure(p){configure(p);p.verifications[0].args=["-e","process.exit(0)"];},review});
  const missing=await g.run();assert.equal(missing.stage,"HOLD");assert.equal(missing.terminationReason,"REPORT_REPAIR_LIMIT");
});
