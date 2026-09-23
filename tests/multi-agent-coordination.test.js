import test from "node:test";
import assert from "node:assert/strict";
import { validateAgreedWorkOrder } from "../src/domain/review-coordination.js";
import { setupAudit } from "./helpers/audit-fixtures.js";

test("Judge and Critic use distinct persistent conversations against the same AuditManifest", async (t) => {
  const f=setupAudit(t);
  const run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY",run.error);
  assert.equal(run.conversationBindings.length,2);
  const judge=run.conversationBindings.find((item)=>item.role==="JUDGE");
  const critic=run.conversationBindings.find((item)=>item.role==="CRITIC");
  assert.ok(judge);assert.ok(critic);
  assert.notEqual(judge.conversationId,critic.conversationId);
  assert.equal(judge.activeDeliveryId,null);assert.equal(critic.activeDeliveryId,null);
  const hashes=new Set(run.requests.filter((item)=>item.phase==="ROUND0").map((item)=>item.auditManifestHash));
  assert.equal(hashes.size,2); // one frozen manifest per candidate iteration
  for (const candidate of run.candidates) {
    const candidateHashes=new Set(run.requests.filter((item)=>item.phase==="ROUND0"&&item.candidateId===candidate.candidateId)
      .map((item)=>item.auditManifestHash));
    assert.equal(candidateHashes.size,1);
  }
});

test("Round 0 is peer-isolated and Round 1 receives actual published review text", async (t) => {
  const f=setupAudit(t,{reviewBody(data){return `${data.role} says concrete review text for ${data.phase}`;}});
  const run=await f.run();
  const round0=f.reviewPrompts.filter((item)=>item.phase==="ROUND0");
  assert.ok(round0.length>=2);
  assert.ok(round0.every((item)=>Array.isArray(item.sharedArtifacts)&&item.sharedArtifacts.length===0));
  const round1=f.reviewPrompts.filter((item)=>item.phase==="ROUND1");
  assert.ok(round1.length>=2);
  assert.ok(round1.every((item)=>item.sharedArtifacts.length>=2));
  assert.ok(round1.every((item)=>item.sharedArtifacts.every((artifact)=>
    typeof artifact.content==="string"&&artifact.content.includes("concrete review text")&&artifact.contentHash)));
  assert.ok(run.reviewArtifacts.some((item)=>item.visibility==="SHARED"));
});

test("finding-only disagreement also triggers cross review", async (t) => {
  const f=setupAudit(t,{review(data){
    const refs=data.context.evidence.filter((e)=>e.kind==="PATCH").map((e)=>e.evidenceId);
    const criticFinding=data.phase==="ROUND0"&&data.role==="CRITIC";
    return {type:"REVIEW_ASSERTIONS",runId:data.context.runId,requestId:data.context.requestId,
      candidateId:data.context.candidateId,auditManifestHash:data.context.auditManifestHash,
      assessments:data.context.requirements.items.map((r)=>({requirementId:r.requirementId,verdict:"SATISFIED",evidenceRefs:refs})),
      findingDecisions:data.context.findings.filter((finding)=>finding.status!=="WITHDRAWN")
        .map((finding)=>({findingId:finding.findingId,status:"RESOLVED",evidenceRefs:refs})),
      newFindings:criticFinding?[{requirementId:"R1",problem:"critic-only problem",resolutionCriteria:"fix critic-only problem",evidenceRefs:refs,required:true}]:[]};
  }});
  await f.run();
  assert.ok(f.reviewPrompts.some((item)=>item.phase==="ROUND1"));
});

test("Critic binding failure holds only review coordination and preserves candidate", async (t) => {
  const f=setupAudit(t,{resume({binding}){
    if (binding.sessionId.endsWith("_critic")) throw Object.assign(new Error("critic tab missing"),{code:"NEEDS_REBIND"});
  }});
  const run=await f.run();
  assert.equal(run.stage,"HOLD");
  assert.equal(run.terminationReason,"WEB_BINDING_REQUIRED");
  assert.equal(run.coordination.phase,"WAITING_FOR_ROLE_BINDING");
  assert.equal(run.coordination.activeRole,"CRITIC");
  assert.ok(run.candidate?.candidateId);
  assert.notEqual(run.stage,"RECOVERY_REQUIRED");
});

test("REWORK is gated by durable Critic acceptance and Worker receives AGREED_WORK_ORDER", async (t) => {
  const f=setupAudit(t);
  const run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY",run.error);
  assert.equal(f.starts(),2);
  assert.ok(run.agreedWorkOrders.length>=1);
  const order=run.agreedWorkOrders[0];
  validateAgreedWorkOrder(order,{runId:run.runId,baseCandidateId:order.baseCandidateId});
  assert.equal(f.briefs[1].agreedWorkOrder.workOrderId,order.workOrderId);
  const event=run.coordinationEvents.find((item)=>item.controlEventId===order.acceptedControlEventId);
  assert.ok(event);
  const packet=JSON.parse(f.options.artifactStore.read(event.packetRef.sha256).toString("utf8"));
  assert.equal(packet.type,"PLAN_RESPONSE");
  assert.equal(packet.decision,"ACCEPT");
  assert.equal(packet.planId,order.planId);
  assert.equal(packet.planHash,order.planHash);
  assert.equal(packet.planBasisHash,order.planBasisHash);
  assert.equal(event.bindingId,order.acceptedByBindingId);
});

test("Critic REJECT issues a new immutable planId before ACCEPT", async (t) => {
  let planReviews=0;
  const f=setupAudit(t,{planReview(data){
    planReviews+=1;
    return {type:"PLAN_RESPONSE",runId:data.runId,candidateId:data.candidateId,planId:data.planId,
      planHash:data.planHash,planBasisHash:data.planBasisHash,decision:planReviews===1?"REJECT":"ACCEPT"};
  }});
  const run=await f.run();
  assert.ok(run.plans.length>=2);
  assert.notEqual(run.plans[0].planId,run.plans[1].planId);
  assert.notEqual(run.plans[0].planHash,run.plans[1].planHash);
});

test("malformed PLAN_RESPONSE is repaired without changing plan identity", async (t) => {
  let responses=0;
  const f=setupAudit(t,{planReview(data){
    responses+=1;
    if (responses===1) return {type:"PLAN_RESPONSE",runId:data.runId,candidateId:data.candidateId,
      planId:data.planId,planHash:data.planHash,decision:"ACCEPT"};
    return {type:"PLAN_RESPONSE",runId:data.runId,candidateId:data.candidateId,
      planId:data.planId,planHash:data.planHash,planBasisHash:data.planBasisHash,decision:"ACCEPT"};
  }});
  const run=await f.run();
  assert.ok(responses>=2);
  const planResponses=run.coordinationEvents.filter((item)=>item.type==="PLAN_RESPONSE");
  assert.ok(planResponses.length>=2);
  assert.equal(run.stage,"AWAITING_APPLY",run.error);
});

test("AGREED_WORK_ORDER hash rejects tampering", async (t) => {
  const f=setupAudit(t),run=await f.run();
  const order=structuredClone(run.agreedWorkOrders[0]);
  order.workItems[0].objective="tampered";
  assert.throws(()=>validateAgreedWorkOrder(order,{runId:run.runId,baseCandidateId:order.baseCandidateId}),/hash mismatch/);
});

test("legacy single-review AWAITING_APPLY is re-auditable but cannot directly apply", async (t) => {
  const f=setupAudit(t),run=await f.run();
  const current=f.service.get(run.runId);
  const legacyReview=structuredClone(current.reviews.at(-1));
  delete legacyReview.reviewerRoles; delete legacyReview.auditManifestHash; delete legacyReview.auditManifestId;
  f.service.update(run.runId,{reviews:[...current.reviews.slice(0,-1),legacyReview],auditManifests:[]});
  const snapshot=f.service.snapshot(run.runId,{checks:{codeWorkerExecutableConfigured:true}});
  assert.ok(snapshot.commandCapabilities.includes("code.review.retry"));
  assert.ok(!snapshot.commandCapabilities.includes("code.apply"));
});

test("final apply authority requires both reviewer roles and current manifest identity", async (t) => {
  const f=setupAudit(t),run=await f.run();
  const current=f.service.get(run.runId);
  const review=structuredClone(current.reviews.at(-1));
  review.auditManifestHash="sha256:"+"0".repeat(64);
  f.service.update(current.runId,{reviews:[...current.reviews.slice(0,-1),review]});
  await assert.rejects(f.dashboard.execute({type:"code.apply",payload:f.applyPayload(f.service.get(run.runId))}),
    /independently reviewed candidate/);
});

test("evidence-driven manifest restarts still consume the run evidence budget", async (t) => {
  const f=setupAudit(t,{configure(project){project.policy.maxEvidenceRounds=1;},review(data){
    const c=data.context;
    return {type:"EVIDENCE_REQUEST",runId:c.runId,requestId:c.requestId,candidateId:c.candidateId,
      requirementsRef:c.requirementsRef,requests:[{requestItemId:`code-${c.requestId}`,kind:"CODE",path:"file.txt",purpose:"request another snapshot"}]};
  }});
  const run=await f.run();
  assert.equal(run.stage,"HOLD");
  assert.equal(run.terminationReason,"EVIDENCE_LIMIT");
  assert.equal(run.evidenceRounds,1);
});
