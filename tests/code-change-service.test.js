import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit, assertionsFor } from "./helpers/audit-fixtures.js";

test("VAL-01/13/16: implement, find, fix, re-audit, persist, and separately apply exactly the reviewed candidate",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["UNSATISFIED","SATISFIED"]}),run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),2);
  assert.ok(f.acknowledgements.length>=4,"every reviewer/plan delivery must be acknowledged");
  const independence=run.reviews.at(-1).reviewerIndependence;
  assert.equal(independence.roleSeparation,"VERIFIED");
  assert.equal(independence.sessionSeparation,"VERIFIED");
  assert.equal(independence.conversationSeparation,"VERIFIED");
  assert.equal(independence.providerSeparation,"NOT_ENFORCED");
  assert.equal(independence.modelIdentity,"UNOBSERVED");
  assert.equal(independence.accountIsolation,"UNVERIFIED");
  assert.equal(independence.round0PeerArtifacts,"NONE");
  assert.equal(independence.crossReviewPeerArtifacts,"PUBLISHED_ONLY");
  assert.equal(independence.bindings.length,2);
  assert.notEqual(independence.bindings[0].sessionId,independence.bindings[1].sessionId);
  assert.notEqual(independence.bindings[0].conversationId,independence.bindings[1].conversationId);
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

test("apply authority rejects a PASS whose recorded reviewer independence contract is weakened",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["SATISFIED"]});
  let run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY");
  const review=run.reviews.at(-1);
  const weakened={...review,reviewerIndependence:{...review.reviewerIndependence,conversationSeparation:"FAILED"}};
  run=f.service.update(run.runId,{reviews:[...run.reviews.slice(0,-1),weakened]});
  const caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(!caps.includes("code.apply"));
  assert.ok(caps.includes("code.review.retry"),"same frozen candidate can be re-audited to regain authority");
  await assert.rejects(f.dashboard.execute({type:"code.apply",payload:f.applyPayload(run)}),
    /valid independently reviewed candidate/u);
});

test("VAL-14/21: restart reconciles APPLYING and never redispatches active work",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["UNSATISFIED","SATISFIED"]}),run=await f.run();
  await f.dashboard.execute({type:"code.apply",payload:f.applyPayload(run)});f.service.update(run.runId,{stage:"APPLYING"});
  await f.reopen();assert.equal(f.service.get(run.runId).stage,"APPLIED");assert.equal(f.starts(),2);
  f.service.update(run.runId,{stage:"WORKER_RUNNING"});await f.reopen();assert.equal(f.service.get(run.runId).stage,"RECOVERY_REQUIRED");assert.equal(f.starts(),2);
});
test("VAL-07: additional code and evidence retrieval stays on the same candidate",async(t)=>{
  const f=setupAudit(t,{review(data,n){const c=data.context;if(n===1)return{type:"EVIDENCE_REQUEST",runId:c.runId,requestId:c.requestId,candidateId:c.candidateId,requirementsRef:c.requirementsRef,requests:[{requestItemId:"code",kind:"CODE",path:"file.txt",purpose:"Check surrounding code"}]};return assertionsFor(c);}});
  const run=await f.run();assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),1);
  assert.equal(run.candidates.length,1);
  assert.ok(f.prompts[1].evidence.some((e)=>e.kind==="CODE_SNAPSHOT"),"manifest restart must expose the supplemented evidence");
  assert.ok(run.evidence.some((e)=>e.kind==="CODE_SNAPSHOT"));
});
test("VAL-04: malformed report is repaired without starting another worker",async(t)=>{
  const f=setupAudit(t,{review(data,n){return n===1?{...assertionsFor(data.context),assessments:[]}:assertionsFor(data.context);}});
  const run=await f.run();assert.equal(run.stage,"AWAITING_APPLY",run.error);assert.equal(f.starts(),1);assert.equal(f.prompts[1].feedback.kind,"REPORT_REPAIR");
});
test("VAL-12: iteration and evidence limits retain unresolved work, never success",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["UNSATISFIED"],configure(p){p.policy.maxIterations=1;}});const run=await f.run();
  assert.equal(run.stage,"INCONCLUSIVE");assert.equal(run.terminationReason,"ITERATION_LIMIT");assert.equal(run.findings[0].status,"OPEN");
  assert.equal(f.service.snapshot(run.runId,{}).run.phase,"INCONCLUSIVE");
});
test("VAL-10: command receipts survive restart and conflicting request IDs fail",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["UNSATISFIED","SATISFIED"]}), run=await f.run();const command={type:"code.apply",requestId:"apply-once",payload:f.applyPayload(run)};
  const first=await f.dashboard.executeDurable(command);await f.reopen();
  assert.deepEqual(await f.dashboard.executeDurable(command),first);
  await assert.rejects(f.dashboard.executeDurable({...command,type:"run.stop"}),/different command/);
});

test("active code Worker accepts bounded natural-language intervention and rejects requirement changes",async(t)=>{
  let releaseTurn;
  const gate=new Promise((resolve)=>{releaseTurn=resolve;});
  const steers=[];
  const f=setupAudit(t,{reviewVerdicts:["SATISFIED"],createWorker:async({workspace,persistThreadId,persistCapture})=>({
    async start(){await persistThreadId({threadId:"worker-live"});},
    async inspect(){return{};},
    async interrupt(){},
    async close(){},
    async steer(input){steers.push(input);return{accepted:true};},
    async submitTurn({text}){
      const brief=JSON.parse(text.slice(text.indexOf("\n")+1));
      return{turnId:"worker-turn-live",completion:gate.then(async()=>{
        fs.writeFileSync(path.join(workspace.root,"file.txt"),"revision 2\n");
        const capture=workspace.capture({allowUnchanged:true});
        await persistCapture({capture,turnId:"worker-turn-live"});
        const report={summary:"Implementation claim",
          requirementClaims:brief.requirements.items.map((r)=>({requirementId:r.requirementId,claim:"Implemented"})),
          findingResponses:brief.unresolvedFindings.map((finding)=>({findingId:finding.findingId,explanation:"Submitted fix"})),
          unverified:[]};
        return{turnId:"worker-turn-live",threadId:"worker-live",sessionId:"worker-live",status:"completed",text:JSON.stringify(report),capture};
      })};
    },
  })});
  const started=await f.start();
  for(let i=0;i<100&&!f.service.get(started.runId)?.workerTurnId;i++) await new Promise((resolve)=>setTimeout(resolve,1));
  let current=f.service.get(started.runId);
  assert.equal(current.stage,"WORKER_RUNNING");
  assert.equal(current.workerTurnId,"worker-turn-live");
  assert.ok(f.service.snapshot(current.runId,{}).commandCapabilities.includes("code.worker.intervene"));

  await assert.rejects(f.dashboard.executeDurable({type:"code.worker.intervene",requestId:"scope-change",
    payload:{runId:current.runId,expectedVersion:current.version,turnId:current.workerTurnId,kind:"REQUIREMENTS_CHANGE",text:"Add another feature"}}),
  /new preparation/);
  current=f.service.get(started.runId);
  const accepted=await f.dashboard.executeDurable({type:"code.worker.intervene",requestId:"guidance",
    payload:{runId:current.runId,expectedVersion:current.version,turnId:current.workerTurnId,kind:"GUIDANCE",text:"Reuse the existing helper if it already fits."}});
  assert.equal(accepted.status,"DELIVERED");
  assert.equal(steers.length,1);
  assert.equal(steers[0].turnId,"worker-turn-live");
  assert.match(steers[0].text,/does not modify approved requirements or acceptance criteria/u);
  assert.match(steers[0].text,/Reuse the existing helper if it already fits\./u);
  current=f.service.get(started.runId);
  assert.equal(current.userInterventions.at(-1).status,"DELIVERED");
  assert.equal(current.userInterventions.at(-1).kind,"GUIDANCE");

  releaseTurn();
  await f.service.jobs.get(started.runId);
  assert.equal(f.service.get(started.runId).stage,"AWAITING_APPLY");
});

test("REPORT_REPAIR_LIMIT resumes the same candidate after restart and continues the normal loop",async(t)=>{
  const f=setupAudit(t,{
    configure(project){project.policy.maxFormatRepairs=0;},
    review(data,n){return n===1?{...assertionsFor(data.context),assessments:[]}:assertionsFor(data.context);}
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

test("settled reviewer discussion stays advisory and is carried into an explicit re-audit",async(t)=>{
  const f=setupAudit(t,{
    configure(project){project.policy.maxFormatRepairs=0;},
    review(data,n){return n===1?{...assertionsFor(data.context),assessments:[]}:assertionsFor(data.context);},
    reviewDiscussion(data){return `Answer about ${data.candidateId} without changing audit state.`;}
  });
  const held=await f.run();
  assert.equal(held.stage,"HOLD");
  assert.equal(held.terminationReason,"REPORT_REPAIR_LIMIT");
  assert.ok(f.service.snapshot(held.runId,{}).commandCapabilities.includes("code.review.discuss"));
  const beforeFindings=structuredClone(held.findings);
  const result=await f.dashboard.executeDurable({type:"code.review.discuss",requestId:"review-chat-1",
    payload:{runId:held.runId,expectedVersion:held.version,role:"JUDGE",text:"Explain the blocking concern in plain language."}});
  assert.equal(result.status,"DELIVERED");
  const discussed=f.service.get(held.runId);
  assert.equal(discussed.stage,"HOLD");
  assert.equal(discussed.auditResult,"HOLD");
  assert.deepEqual(discussed.findings,beforeFindings);
  assert.equal(discussed.reviewDiscussions.at(-1).role,"JUDGE");
  assert.equal(discussed.reviewDiscussions.at(-1).status,"DELIVERED");
  assert.match(discussed.reviewDiscussions.at(-1).response,/without changing audit state/u);
  assert.equal(f.discussionPrompts.length,1);

  const accepted=await f.dashboard.executeDurable({type:"code.review.retry",requestId:"review-after-chat",
    payload:{runId:discussed.runId,expectedVersion:discussed.version}});
  assert.equal(accepted.status,"REVIEW_RETRY_ACCEPTED");
  await f.service.jobs.get(discussed.runId);
  const resumed=f.service.get(discussed.runId);
  assert.equal(resumed.stage,"AWAITING_APPLY",resumed.error);
  assert.ok(f.reviewPrompts.slice(1).some((prompt)=>
    prompt.userReviewDiscussions?.some((item)=>item.discussionId===discussed.reviewDiscussions.at(-1).discussionId
      && item.role==="JUDGE"&&/blocking concern/u.test(item.text))));
});

test("uncertain reviewer discussion is never resent and can be explicitly discarded",async(t)=>{
  const f=setupAudit(t,{
    configure(project){project.policy.maxFormatRepairs=0;},
    review(data,n){return n===1?{...assertionsFor(data.context),assessments:[]}:assertionsFor(data.context);},
    reviewDiscussionCompletionError:true,
  });
  const held=await f.run();
  await assert.rejects(f.dashboard.executeDurable({type:"code.review.discuss",requestId:"review-chat-lost",
    payload:{runId:held.runId,expectedVersion:held.version,role:"JUDGE",text:"Explain this result."}}),
  (error)=>error.code==="REVIEW_DISCUSSION_UNCONFIRMED");
  let current=f.service.get(held.runId);
  const discussion=current.reviewDiscussions.at(-1);
  assert.equal(discussion.status,"UNCONFIRMED");
  let caps=f.service.snapshot(current.runId,{}).commandCapabilities;
  assert.ok(!caps.includes("code.review.discuss"));
  assert.ok(caps.includes("code.review.discuss.discard"));

  const discarded=await f.dashboard.executeDurable({type:"code.review.discuss.discard",requestId:"review-chat-discard",
    payload:{runId:current.runId,expectedVersion:current.version,discussionId:discussion.discussionId,
      unresolvedResultConfirmed:true,noAutomaticResendConfirmed:true,reason:"response outcome could not be verified"}});
  assert.equal(discarded.status,"DISCARDED");
  current=f.service.get(held.runId);
  assert.equal(current.reviewDiscussions.at(-1).status,"DISCARDED");
  assert.equal(f.discussionDiscards.length,1);
  assert.equal(f.discussionDiscards[0].currentDeliveryId,discussion.discussionId);
  assert.equal(current.conversationBindings.find((item)=>item.role==="JUDGE").activeDeliveryId,null);
  assert.equal(current.conversationBindings.find((item)=>item.role==="JUDGE").bindingStatus,"NEEDS_REBIND");
  caps=f.service.snapshot(current.runId,{}).commandCapabilities;
  assert.ok(caps.includes("code.review.discuss"));
});

test("operator note is durable append-only context and does not change review or apply authority",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["SATISFIED"]});
  let run=await f.run();
  assert.equal(run.stage,"AWAITING_APPLY");
  let caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(caps.includes("run.note.add"));
  assert.ok(caps.includes("code.apply"));
  const reviewId=run.reviews.at(-1).reviewId;
  const auditResult=run.auditResult;

  const recorded=await f.dashboard.executeDurable({type:"run.note.add",requestId:"note-1",
    payload:{runId:run.runId,expectedVersion:run.version,kind:"DECISION",
      text:"Keep the reviewed candidate; deploy validation is a separate follow-up."}});
  assert.equal(recorded.status,"RECORDED");
  run=f.service.get(run.runId);
  assert.equal(run.stage,"AWAITING_APPLY");
  assert.equal(run.auditResult,auditResult);
  assert.equal(run.reviews.at(-1).reviewId,reviewId);
  assert.equal(run.operatorNotes.length,1);
  assert.equal(run.operatorNotes[0].kind,"DECISION");
  assert.equal(run.operatorNotes[0].candidateId,run.candidate.candidateId);
  assert.equal(run.operatorNotes[0].phase,"AWAITING_APPLY");
  assert.ok(run.events.some((event)=>event.type==="OPERATOR_NOTE_ADDED"
    && event.payload.noteId===run.operatorNotes[0].noteId));
  caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(caps.includes("code.apply"));
});

test("finished run archive preserves evidence and version history and can be restored",async(t)=>{
  const f=setupAudit(t,{reviewVerdicts:["SATISFIED"]});
  let run=await f.run();
  await f.dashboard.executeDurable({type:"code.apply",requestId:"archive-apply",payload:f.applyPayload(run)});
  run=f.service.get(run.runId);
  const historyBefore=f.service.store.history(run.runId).length;
  assert.ok(f.service.snapshot(run.runId,{}).commandCapabilities.includes("run.archive"));

  const archived=await f.dashboard.executeDurable({type:"run.archive",requestId:"archive-run",
    payload:{runId:run.runId,expectedVersion:run.version}});
  assert.equal(archived.stage,"APPLIED");
  assert.equal(typeof archived.archivedAt,"string");
  assert.ok(f.service.store.history(run.runId).length>historyBefore);
  assert.ok(archived.evidence.length>0);
  let caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(caps.includes("run.unarchive"));
  assert.ok(!caps.includes("run.archive"));

  const restored=await f.dashboard.executeDurable({type:"run.unarchive",requestId:"unarchive-run",
    payload:{runId:archived.runId,expectedVersion:archived.version}});
  assert.equal(restored.archivedAt,null);
  assert.equal(restored.stage,"APPLIED");
  assert.deepEqual(restored.evidence,archived.evidence);
  caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(caps.includes("run.archive"));
});

test("ambiguous reviewer tabs require explicit eligible selection before audit retry",async(t)=>{
  let failFirstJudge=true;
  const rebinds=[];
  const f=setupAudit(t,{
    reviewVerdicts:["SATISFIED"],
    resume(input){
      if(failFirstJudge&&input.binding.conversationId==="test"){
        failFirstJudge=false;
        throw Object.assign(new Error("multiple exact reviewer tabs"),{code:"AMBIGUOUS",details:{candidates:[
          {tabId:41,windowId:1,url:"https://chatgpt.com/c/test"},
          {tabId:42,windowId:2,url:"https://chatgpt.com/c/test"},
          {tabId:99,windowId:3,url:"https://chatgpt.com/c/other"},
        ]}});
      }
    },
  });
  f.service.web.rebind=async({binding,tabId,focus})=>{
    rebinds.push({binding:structuredClone(binding),tabId,focus});
    f.service.web.activeBinding={...binding,tabId,windowId:1,
      documentId:`doc-${binding.sessionId}-${tabId}`,frameId:0,bindingStatus:"BOUND"};
    return f.service.web.activeBinding;
  };
  let run=await f.run();
  assert.equal(run.stage,"HOLD");
  assert.equal(run.terminationReason,"WEB_BINDING_REQUIRED");
  assert.equal(run.coordination.activeRole,"JUDGE");
  assert.deepEqual(run.coordination.bindingCandidates.map((item)=>item.tabId),[41,42]);
  let caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(caps.includes("code.review.rebind"));
  assert.ok(!caps.includes("code.review.retry"));
  await assert.rejects(f.dashboard.executeDurable({type:"code.review.rebind",requestId:"review-rebind-invalid",
    payload:{runId:run.runId,expectedVersion:run.version,role:"JUDGE",selectedTabId:99}}),
  (error)=>error.code==="DELIVERY_RECOVERY_MISMATCH");

  run=f.service.get(run.runId);
  const rebound=await f.dashboard.executeDurable({type:"code.review.rebind",requestId:"review-rebind-41",
    payload:{runId:run.runId,expectedVersion:run.version,role:"JUDGE",selectedTabId:41}});
  assert.equal(rebound.status,"REBOUND");
  run=f.service.get(run.runId);
  assert.equal(run.stage,"HOLD");
  assert.equal(run.coordination.phase,"ROLE_BINDING_RECOVERED");
  assert.equal(run.conversationBindings.find((item)=>item.role==="JUDGE").tabId,41);
  assert.equal(rebinds.length,1);
  caps=f.service.snapshot(run.runId,{}).commandCapabilities;
  assert.ok(!caps.includes("code.review.rebind"));
  assert.ok(caps.includes("code.review.retry"));

  const accepted=await f.dashboard.executeDurable({type:"code.review.retry",requestId:"review-after-rebind",
    payload:{runId:run.runId,expectedVersion:run.version}});
  assert.equal(accepted.status,"REVIEW_RETRY_ACCEPTED");
  await f.service.jobs.get(run.runId);
  assert.equal(f.service.get(run.runId).stage,"AWAITING_APPLY");
});
