import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCodeReview } from "../src/domain/code-review.js";
import { reviewContext, reportFor } from "./helpers/audit-fixtures.js";

test("VAL-02: a high score cannot override required failure or open findings",()=>{
  const context=reviewContext(); const failed=reportFor(context,"UNSATISFIED");
  assert.equal(evaluateCodeReview(failed,context).decision,"REWORK");
  const pass=reportFor(context); pass.newFindings=failed.newFindings;
  assert.equal(evaluateCodeReview(pass,context).decision,"REWORK");
  assert.equal(evaluateCodeReview({...reportFor(context),score:-100},context).decision,"PASS");
});
test("VAL-03/04/06: missing assessments, agent claims and stale evidence cannot pass",()=>{
  const c=reviewContext();
  assert.throws(()=>evaluateCodeReview({...reportFor(c),assessments:[]},c),/Every requirement/);
  const duplicate=reportFor(c);duplicate.assessments.push(duplicate.assessments[0]);assert.throws(()=>evaluateCodeReview(duplicate,c),/Duplicate/);
  assert.throws(()=>evaluateCodeReview({...reportFor(c),candidateId:"other"},c),/mismatch/);
  assert.throws(()=>evaluateCodeReview({...reportFor(c),requirementsRef:{...c.requirementsRef,revision:"2"}},c),/mismatch/);
  c.evidence[0].candidateId="old";assert.throws(()=>evaluateCodeReview({...reportFor(reviewContext())},c),/outside/);
  const execution=reviewContext();execution.requirements.items[0].verificationMethod.kinds=["EXECUTION"];
  execution.evidence[0].kind="AGENT_CLAIM";execution.evidence[0].producer="AGENT";
  assert.throws(()=>evaluateCodeReview(reportFor(reviewContext()),execution),/verification evidence/);
});
test("VAL-05/09: omitted findings persist, submitted fixes need Web resolution, prior resolutions need recheck",()=>{
  const c=reviewContext();const first=evaluateCodeReview(reportFor(c,"UNSATISFIED"),c);
  c.findings=first.findings; const omitted={...reportFor(c),findingDecisions:[]};
  assert.equal(evaluateCodeReview(omitted,c).decision,"REWORK");
  c.findings[0].status="FIX_SUBMITTED";assert.equal(evaluateCodeReview(omitted,c).decision,"REWORK");
  const resolved=evaluateCodeReview(reportFor(c),c);assert.equal(resolved.decision,"PASS");
  c.findings=resolved.findings;c.candidateId="candidate-2";c.evidence[0].candidateId=c.candidateId;
  assert.equal(evaluateCodeReview({...reportFor(c),findingDecisions:[]},c).decision,"HOLD");
  assert.equal(evaluateCodeReview(reportFor(c,"UNSATISFIED"),c).findings[0].status,"OPEN");
  assert.equal(first.findings[0].history.length,1);
});
test("UNDETERMINED is HOLD; mixed failure remains REWORK; authority injection is rejected",()=>{
  const c=reviewContext();assert.equal(evaluateCodeReview(reportFor(c,"UNDETERMINED"),c).decision,"HOLD");
  const first=evaluateCodeReview(reportFor(c,"UNSATISFIED"),c);c.findings=first.findings;
  assert.equal(evaluateCodeReview(reportFor(c,"UNDETERMINED"),c).decision,"REWORK");
  assert.throws(()=>evaluateCodeReview({...reportFor(c),approved:true},c),/only/);
});
