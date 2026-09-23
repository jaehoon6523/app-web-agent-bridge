import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ArtifactStore } from "../../src/evidence/artifact-store.js";
import { CodeChangeService } from "../../src/orchestration/code-change-service.js";
import { DashboardController } from "../../src/orchestration/dashboard-controller.js";
import { requirementsRef } from "../../src/domain/audit-contract.js";

export const requirements = { requirementsId:"fixture-requirements", revision:"1", authority:"REQUIREMENTS_JSON", sourceRoles:[{ source:"test", role:"REFERENCE", content:"Fixture source: file.txt contains revision 2" }], unresolvedQuestions:[],
  items:[{ requirementId:"R1", statement:"The file has the required contents", acceptanceCriteria:"file.txt contains revision 2", required:true,
    verificationMethod:{ kinds:["PATCH"], description:"Inspect the captured patch" }, sourceRefs:["test"] }] };
export const policy = { maxIterations:3, maxEvidenceRounds:3, maxFormatRepairs:2, totalTimeoutMs:60000, turnTimeoutMs:5000 };
export function project(targetRoot) { return { projectId:"test-project", targetRoot, requirements:structuredClone(requirements), policy:{...policy}, verifications:[] }; }
export function reviewContext() { return { runId:"run-1", requestId:"review-1", candidateId:"candidate-1", requirementsRef:requirementsRef(requirements), requirements:structuredClone(requirements), findings:[], evidence:[{ evidenceId:"patch-1", candidateId:"candidate-1", kind:"PATCH", producer:"CONTROLLER", valid:true }] }; }
export function reportFor(context, verdict = "SATISFIED") {
  const refs = context.evidence.filter((e) => e.candidateId === context.candidateId && e.kind === "PATCH").map((e) => e.evidenceId);
  return { type:"REVIEW_REPORT", runId:context.runId, requestId:context.requestId, candidateId:context.candidateId, requirementsRef:context.requirementsRef,
    assessments:context.requirements.items.map((r) => ({ requirementId:r.requirementId, verdict, evidenceRefs:refs, reason:"Inspected fixture contents", ...(verdict === "UNDETERMINED" ? {missingInformation:"Need actual evidence"} : {}) })),
    findingDecisions:context.findings.filter((f) => f.status !== "WITHDRAWN").map((f) => ({ findingId:f.findingId, status:verdict === "SATISFIED" ? "RESOLVED" : "OPEN", evidenceRefs:refs, reason:"Resolution criteria checked on this candidate" })),
    newFindings:verdict === "UNSATISFIED" && !context.findings.length ? [{requirementId:"R1", problem:"Required contents missing", resolutionCriteria:"file.txt contains revision 2", evidenceRefs:refs, required:true}] : [], summary:"Fixture review", score:100 };
}

export function strictReportFor(context, verdict = "SATISFIED") {
  if (verdict !== "SATISFIED") return reportFor(context, verdict);
  const candidateEvidence = context.evidence.filter((evidence) =>
    evidence.candidateId === context.candidateId && evidence.valid !== false && evidence.producer !== "AGENT");
  for (const requirement of context.requirements.items) {
    const missingKinds = requirement.verificationMethod.kinds.filter((kind) =>
      !candidateEvidence.some((evidence) => evidence.kind === kind));
    if (missingKinds.length > 0) {
      throw new Error(`STRICT_REPORT_EVIDENCE_MISSING:${requirement.requirementId}:${missingKinds.join(",")}`);
    }
  }
  const refs = candidateEvidence.map((evidence) => evidence.evidenceId);
  const report = reportFor(context, verdict);
  return {
    ...report,
    assessments: report.assessments.map((assessment) => ({ ...assessment, evidenceRefs:refs })),
    findingDecisions: report.findingDecisions.map((decision) => ({ ...decision, evidenceRefs:refs })),
  };
}

// Test-only external provider stimulus. It never derives semantic verdicts from candidate bytes.
const DEFAULT_REVIEW_VERDICTS = Object.freeze(["UNSATISFIED", "SATISFIED"]);

function fixtureReviewVerdicts(hooks) {
  if (hooks.review || hooks.webSession) return null;
  const verdicts = hooks.reviewVerdicts ?? DEFAULT_REVIEW_VERDICTS;
  if (!Array.isArray(verdicts) || verdicts.length === 0
    || verdicts.some((verdict) => !["SATISFIED", "UNSATISFIED", "UNDETERMINED"].includes(verdict))) {
    throw new TypeError("reviewVerdicts must be a non-empty array of REVIEW_REPORT verdicts.");
  }
  return verdicts;
}

export function setupAudit(t, hooks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-audit-")), target = path.join(directory,"target"); fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C",target,...args], {windowsHide:true});
  git("init","--quiet"); git("config","core.autocrlf","false"); fs.writeFileSync(path.join(target,"file.txt"),"base\n"); git("add",".");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","-c","core.hooksPath=","commit","--quiet","-m","base");
  let starts=0, reviews=0, turns=0, service;
  const briefs=[], prompts=[], reviewPrompts=[], acknowledgements=[];
  const reviewVerdicts = fixtureReviewVerdicts(hooks);
  const configured = project(target); hooks.configure?.(configured);
  const options = { filename:path.join(directory,"controller.sqlite"), artifactStore:new ArtifactStore(path.join(directory,"artifacts")), codex:{}, project:configured,
    createWorker:hooks.createWorker ?? (async ({workspace,persistThreadId,persistCapture}) => {
      const number=++starts;
      return { async start(){await persistThreadId({threadId:`worker-${number}`});}, async close(){}, async submitTurn({text}) {
        const brief=JSON.parse(text.slice(text.indexOf("\n")+1)); briefs.push(brief);
        if (hooks.worker) await hooks.worker({workspace,number,brief});
        else fs.writeFileSync(path.join(workspace.root,"file.txt"),`revision ${number}\n`);
        const capture=workspace.capture({allowUnchanged:true});
        await persistCapture({capture,turnId:`worker-turn-${number}`});
        const report={summary:"Implementation claim",requirementClaims:brief.requirements.items.map((r)=>({requirementId:r.requirementId,claim:"Implemented"})),findingResponses:brief.unresolvedFindings.map((f)=>({findingId:f.findingId,explanation:"Submitted fix"})),unverified:[]};
        return {turnId:`worker-turn-${number}`,completion:Promise.resolve({text:JSON.stringify(report),capture})};
      }};
    }),
    webSession:hooks.webSession ?? {activeTurnId:null,activeBinding:null,async resume(input){if(hooks.resume) await hooks.resume(input);const b=input.binding;this.activeBinding=b.conversationId?{...b,tabId:1,windowId:1,documentId:`doc-${b.sessionId}`,frameId:0,bindingStatus:"BOUND"}:{...b,tabId:2,windowId:1,documentId:`doc-${b.sessionId}`,frameId:0,conversationUrl:"https://chatgpt.com/",conversationId:null,bindingStatus:"ROOT_READY"};return this.activeBinding;},async acknowledgeDelivery({turnId}){acknowledgements.push(turnId);return {currentDeliveryId:null,sessionId:this.activeBinding.sessionId,runId:this.activeBinding.runId,conversationUrl:this.activeBinding.conversationUrl};},async interrupt(){ if(hooks.interrupt) await hooks.interrupt(); },
      async submitTurn({runId,turnId,text,parseResponse}) {
        this.activeTurnId=turnId; const firstBreak=text.indexOf("\n"),secondBreak=text.indexOf("\n",firstBreak+1);
        const data=JSON.parse(text.slice(firstBreak+1,secondBreak)); const turnNumber=++turns;
        const reviewNumber=data.context?.auditManifestHash?++reviews:null;
        if(reviewNumber!==null){reviewPrompts.push(data);if(data.role==="JUDGE"&&data.phase==="ROUND0")prompts.push(data);}
        const number=reviewNumber??turnNumber;
        if(this.activeBinding?.conversationId===null)this.activeBinding={...this.activeBinding,conversationUrl:"https://chatgpt.com/c/critic",conversationId:"critic",bindingStatus:"BOUND"};
        let report;
        if(data.plan&&data.planHash){
          report=hooks.planReview?await hooks.planReview(data,number,service):{type:"PLAN_RESPONSE",runId:data.runId,candidateId:data.candidateId,planId:data.planId,planHash:data.planHash,planBasisHash:data.planBasisHash,decision:"ACCEPT"};
        } else if(data.planId&&data.auditManifestHash&&!data.context){
          report=hooks.planProposal?await hooks.planProposal(data,number,service):{type:"PLAN_PROPOSAL",runId:data.runId,candidateId:data.candidateId,auditManifestHash:data.auditManifestHash,planBasisHash:data.planBasisHash,planId:data.planId,
            workItems:[{workItemId:"wi-1",objective:"Resolve all blocking findings without weakening acceptance.",acceptanceCriteria:"All blocking findings satisfy their recorded resolution criteria."}],constraints:["Preserve requirements and tests."]};
        } else if(data.context?.auditManifestHash){
          const scriptedVerdict=reviewVerdicts?.[(data.candidate?.iteration??1)-1];
          if(!hooks.review&&scriptedVerdict===undefined)throw new Error(`AUDIT_FIXTURE_REVIEW_SCRIPT_EXHAUSTED:${data.candidate?.iteration??1}`);
          const verdict=scriptedVerdict;
          report=hooks.review?await hooks.review(data,number,service):{type:"REVIEW_ASSERTIONS",runId:data.context.runId,requestId:data.context.requestId,candidateId:data.context.candidateId,auditManifestHash:data.context.auditManifestHash,
            assessments:data.context.requirements.items.map((r)=>({requirementId:r.requirementId,verdict,evidenceRefs:data.context.evidence.filter((e)=>e.candidateId===data.context.candidateId&&e.kind==="PATCH").map((e)=>e.evidenceId)})),
            findingDecisions:data.context.findings.filter((f)=>f.status!=="WITHDRAWN").map((f)=>({findingId:f.findingId,status:verdict==="SATISFIED"?"RESOLVED":"OPEN",evidenceRefs:data.context.evidence.filter((e)=>e.candidateId===data.context.candidateId&&e.kind==="PATCH").map((e)=>e.evidenceId)})),
            newFindings:verdict==="UNSATISFIED"&&!data.context.findings.length?[{requirementId:"R1",problem:"Required contents missing",resolutionCriteria:"file.txt contains revision 2",evidenceRefs:data.context.evidence.filter((e)=>e.kind==="PATCH").map((e)=>e.evidenceId),required:true}]:[]};
          if(report?.type==="REVIEW_REPORT")report={type:"REVIEW_ASSERTIONS",runId:data.context.runId,requestId:data.context.requestId,candidateId:data.context.candidateId,auditManifestHash:data.context.auditManifestHash,
            assessments:report.assessments.map(({requirementId,verdict,evidenceRefs,missingInformation})=>({requirementId,verdict,evidenceRefs,...(missingInformation?{missingInformation}:{})})),
            findingDecisions:report.findingDecisions.map(({findingId,status,evidenceRefs})=>({findingId,status,evidenceRefs})),newFindings:report.newFindings};
        } else report=hooks.review?await hooks.review(data,number,service):strictReportFor(data.context);
        const reasoning=hooks.reviewBody?await hooks.reviewBody(data,number,service):"";
        this.activeTurnId=null;
        const raw=`${reasoning?`${reasoning}\n`:""}<controller_packet>\n${JSON.stringify(report)}\n</controller_packet>`;
        return {turnId,completion:Promise.resolve({turnId,...parseResponse(raw),binding:{...this.activeBinding,runId}})};
      }} };
  service=new CodeChangeService(options);
  const live={codeChanges:service,store:{listRuns:()=>[],getRun:()=>null}};
  const dashboard=new DashboardController({getRuntime:async()=>live,preflight:()=>({readyForProvisioning:true}),webSession:options.webSession,transport:null});
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {target,directory,options,briefs,prompts,reviewPrompts,acknowledgements,dashboard,git,starts:()=>starts,reviews:()=>prompts.length,get service(){return service;},
    async start(){return dashboard.execute({type:"run.start",payload:{mode:"CODE_CHANGE",expectedVersion:0,objective:"Implement required file contents",conversationUrl:"https://chatgpt.com/c/test"}});},
    async run(){const r=await this.start();await service.jobs.get(r.runId);return service.get(r.runId);},
    async reopen(){await service.close();service=new CodeChangeService(options);live.codeChanges=service;},
    applyPayload(run){return {runId:run.runId,expectedVersion:run.version,candidateId:run.candidate.candidateId,reviewId:run.reviews.at(-1).reviewId,artifactHash:run.capture.artifact.sha256,baseCommit:run.baseCommit};}
  };
}
