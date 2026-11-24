import test from "node:test";
import assert from "node:assert/strict";
import { requirements, reviewContext } from "./helpers/audit-fixtures.js";
import { validateRequirements, requirementsRef } from "../src/domain/audit-contract.js";
import { evaluateCodeReview, validateAuditResponse } from "../src/domain/code-review.js";
import { buildCodeReviewPrompt } from "../src/orchestration/code-change-prompts.js";

import { DOMAIN_SALTS, DEFAULT_DOMAIN_CASES, seedEnv, targetCaseEnv, targetDomainEnv,
  caseSeed, random, choose, shuffle, subset, caseIndexes, enabledDomain, descriptor, failureContext } from "./helpers/audit-fuzz-inputs.js";
import { registerAuditFuzzPipeline } from "./helpers/audit-fuzz-pipeline.js";

const ALL_KINDS = ["PATCH", "CODE_SNAPSHOT", "EXECUTION", "ARTIFACT"];
function requireFailure(value, action) {
  assert.throws(action, undefined, failureContext(value));
}

function generatedContext(rng, index) {
  const seedRequirements = structuredClone(requirements);
  const kinds = subset(rng, ALL_KINDS);
  const hasExecution = kinds.some((kind) => kind === "EXECUTION" || kind === "ARTIFACT");
  const verificationId = `verify-${index}`;
  seedRequirements.requirementsId = `generated-${index}`;
  seedRequirements.items[0].verificationMethod = {
    kinds,
    description:`mutated from fixture requirement ${index}`,
    ...(hasExecution ? { checks:[{
      verificationId, expectedExitCode:0,
      requiredResultFiles:kinds.includes("ARTIFACT") ? ["result.txt"] : [],
    }] } : {}),
  };
  const validated = validateRequirements(seedRequirements);
  const candidateId = `candidate-${index}-${rng().toString(16)}`;
  const context = {
    ...reviewContext(), runId:`run-${index}`, requestId:`request-${index}`, candidateId,
    requirements:validated, requirementsRef:requirementsRef(validated), evidence:[],
  };
  if (kinds.includes("PATCH")) context.evidence.push({
    evidenceId:`patch-${index}`, candidateId, kind:"PATCH", producer:"CONTROLLER", valid:true, result:{},
  });
  if (kinds.includes("CODE_SNAPSHOT")) context.evidence.push({
    evidenceId:`code-${index}`, candidateId, kind:"CODE_SNAPSHOT", producer:"CONTROLLER", valid:true, result:{ path:"file.txt" },
  });
  if (hasExecution) {
    const executionId = `execution-${index}`;
    const execution = {
      evidenceId:`execution-evidence-${index}`, candidateId, kind:"EXECUTION", producer:"CONTROLLER", valid:true,
      result:{ executionId, verificationId, exitCode:0, timedOut:false, aborted:false, error:null,
        candidateUnchanged:true, terminationConfirmed:true },
    };
    context.evidence.push(execution);
    if (kinds.includes("ARTIFACT")) context.evidence.push({
      evidenceId:`artifact-${index}`, candidateId, kind:"ARTIFACT", producer:"CONTROLLER", valid:true,
      executionEvidenceId:execution.evidenceId,
      result:{ executionId, verificationId, path:"result.txt" },
    });
  }
  const report = {
    type:"REVIEW_REPORT", runId:context.runId, requestId:context.requestId, candidateId,
    requirementsRef:context.requirementsRef,
    assessments:[{ requirementId:"R1", verdict:"SATISFIED",
      evidenceRefs:context.evidence.map((evidence) => evidence.evidenceId),
      reason:"Generated candidate-bound evidence satisfies the mutated fixture contract" }],
    findingDecisions:[], newFindings:[], summary:"generated review",
  };
  return { kinds, context, report };
}

test("seeded single-invariant mutations exercise validator threat model", () => {
  const seed = seedEnv();
  const target = targetCaseEnv();
  const targetDomain = targetDomainEnv();
  const domain = "evidence-binding";
  if (!enabledDomain(domain, targetDomain)) return;
  const salt = DOMAIN_SALTS[domain];

  for (const index of caseIndexes("AUDIT_FUZZ_CASES", DEFAULT_DOMAIN_CASES, 5000, target)) {
    const rng = random(caseSeed(seed, index, salt));
    const { kinds, context, report } = generatedContext(rng, index);
    const failure = (mutation) => descriptor(seed, index, domain, mutation, {
      requiredKinds:kinds,
      candidateId:context.candidateId,
    });

    validateAuditResponse(report, context);
    assert.equal(evaluateCodeReview(report, context).decision, "PASS", failureContext(failure("BASELINE")));

    const requiredKind = choose(rng, kinds);
    const requiredEvidence = context.evidence.find((evidence) => evidence.kind === requiredKind);
    const missing = structuredClone(report);
    missing.assessments[0].evidenceRefs = missing.assessments[0].evidenceRefs.filter((id) => id !== requiredEvidence.evidenceId);
    requireFailure(failure(`REMOVE_${requiredKind}`), () => validateAuditResponse(missing, context));

    const foreign = structuredClone(context);
    foreign.evidence.find((evidence) => evidence.evidenceId === requiredEvidence.evidenceId).candidateId =
      `foreign-${context.candidateId}`;
    requireFailure(failure(`${requiredKind}_CANDIDATE_ID`), () => validateAuditResponse(report, foreign));

    const agentOnly = structuredClone(context);
    agentOnly.evidence.find((evidence) => evidence.evidenceId === requiredEvidence.evidenceId).producer = "AGENT";
    requireFailure(failure(`${requiredKind}_AGENT_PRODUCER`), () => validateAuditResponse(report, agentOnly));

    const reorderedContext = { ...context, evidence:shuffle(rng, context.evidence) };
    const reorderedReport = structuredClone(report);
    reorderedReport.assessments[0].evidenceRefs = shuffle(rng, reorderedReport.assessments[0].evidenceRefs);
    validateAuditResponse(reorderedReport, reorderedContext);
    assert.equal(evaluateCodeReview(reorderedReport, reorderedContext).decision, "PASS",
      failureContext(failure("EVIDENCE_REORDER")));
  }
});

test("seeded reviewer prompt preserves production-shaped literals exactly", () => {
  const seed = seedEnv();
  const target = targetCaseEnv();
  const targetDomain = targetDomainEnv();
  const domain = "prompt-literal";
  if (!enabledDomain(domain, targetDomain)) return;
  const salt = DOMAIN_SALTS[domain];
  const literals = [
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "[https://example.test](https://example.test)",
    "C:\\\\Users\\\\User\\\\project\\\\file.js",
    "한글🙂 / JSON \\\"quote\\\" / braces {x} / CRLF\\r\\nnext",
  ];
  for (const index of caseIndexes("AUDIT_FUZZ_CASES", DEFAULT_DOMAIN_CASES, 5000, target)) {
    const rng = random(caseSeed(seed, index, salt));
    const literal = `${choose(rng, literals)} :: ${rng().toString(16)} :: ${choose(rng, literals)}`;
    const data = {
      context:{ runId:`run-${index}` }, candidateDiff:literal, candidateDiffHash:`hash-${index}`,
      candidate:{ candidateId:`candidate-${index}`, patchHash:`hash-${index}` },
      evidence:[], registeredVerifications:[], feedback:null,
    };
    const prompt = buildCodeReviewPrompt(data);
    const firstBreak = prompt.indexOf("\n");
    const secondBreak = prompt.indexOf("\n", firstBreak + 1);
    assert.ok(firstBreak >= 0 && secondBreak > firstBreak, "review prompt must keep JSON on the second line");
    const decoded = JSON.parse(prompt.slice(firstBreak + 1, secondBreak));
    assert.equal(decoded.candidateDiff, literal, failureContext(descriptor(seed, index, domain,
      "LITERAL_ROUNDTRIP", { requiredKinds:[], candidateId:data.candidate.candidateId, literal })));
  }
});

registerAuditFuzzPipeline(0);
