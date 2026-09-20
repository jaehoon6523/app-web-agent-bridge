import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requirements, reviewContext, setupAudit } from "./helpers/audit-fixtures.js";
import { validateRequirements, requirementsRef } from "../src/domain/audit-contract.js";
import { evaluateCodeReview, validateAuditResponse } from "../src/domain/code-review.js";
import { buildCodeReviewPrompt } from "../src/orchestration/code-change-prompts.js";

const ALL_KINDS = ["PATCH", "CODE_SNAPSHOT", "EXECUTION", "ARTIFACT"];
const GENERATOR_VERSION = "audit-reality-v1";
const DEFAULT_SEED = 0x5eedc0de;
const DEFAULT_DOMAIN_CASES = 200;
const DEFAULT_FLOW_CASES = 12;

function integerEnv(name, fallback, max, allowZero = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > max) throw new TypeError(`${name} must be ${minimum}..${max}`);
  return parsed;
}
function seedEnv() {
  return integerEnv("AUDIT_FUZZ_SEED", DEFAULT_SEED, 0xffff_ffff, true);
}
function targetCaseEnv() {
  const value = process.env.AUDIT_FUZZ_CASE;
  return value === undefined || value === "" ? null : integerEnv("AUDIT_FUZZ_CASE", 0, 4999, true);
}
function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
function caseSeed(seed, index, salt = 0) {
  return mix32((seed >>> 0) ^ Math.imul((index + 1) >>> 0, 0x9e3779b1) ^ (salt >>> 0));
}
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state;
  };
}
function choose(rng, values) { return values[rng() % values.length]; }
function shuffle(rng, values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rng() % (index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
function subset(rng, values) {
  const selected = values.filter(() => (rng() & 1) === 1);
  return selected.length ? selected : [choose(rng, values)];
}
function selectedCase(index, target) { return target === null || index === target; }
function caseCount(name, fallback, max, target) {
  const configured = integerEnv(name, fallback, max);
  return target !== null && target < max ? Math.max(configured, target + 1) : configured;
}
function descriptor(seed, index, domain, salt, mutation, details = {}) {
  return {
    generatorVersion:GENERATOR_VERSION,
    seed,
    case:index,
    domain,
    caseSeed:caseSeed(seed, index, salt),
    mutation,
    ...details,
  };
}
function failureContext(value) {
  return `AUDIT_REALITY_FAILURE ${JSON.stringify(value)}`;
}
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
  const cases = caseCount("AUDIT_FUZZ_CASES", DEFAULT_DOMAIN_CASES, 5000, target);
  const salt = 0x01;

  for (let index = 0; index < cases; index += 1) {
    if (!selectedCase(index, target)) continue;
    const rng = random(caseSeed(seed, index, salt));
    const { kinds, context, report } = generatedContext(rng, index);
    const failure = (mutation) => descriptor(seed, index, "evidence-binding", salt, mutation, {
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
  const cases = caseCount("AUDIT_FUZZ_CASES", DEFAULT_DOMAIN_CASES, 5000, target);
  const salt = 0xa11ce;
  const literals = [
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "[https://example.test](https://example.test)",
    "C:\\\\Users\\\\User\\\\project\\\\file.js",
    "한글🙂 / JSON \\\"quote\\\" / braces {x} / CRLF\\r\\nnext",
  ];
  for (let index = 0; index < cases; index += 1) {
    if (!selectedCase(index, target)) continue;
    const rng = random(caseSeed(seed, index, salt));
    const literal = `${choose(rng, literals)} :: ${rng().toString(16)} :: ${choose(rng, literals)}`;
    const data = {
      context:{ runId:`run-${index}` }, candidateDiff:literal, candidateDiffHash:`hash-${index}`,
      candidate:{ candidateId:`candidate-${index}`, patchHash:`hash-${index}` },
      evidence:[], registeredVerifications:[], feedback:null,
    };
    const prompt = buildCodeReviewPrompt(data);
    const decoded = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    assert.equal(decoded.candidateDiff, literal, failureContext(descriptor(seed, index, "prompt-literal", salt,
      "LITERAL_ROUNDTRIP", { requiredKinds:[], candidateId:data.candidate.candidateId, literal })));
  }
});

test("seeded scenario truth crosses real Git capture, Controller review loop and persisted history", async (t) => {
  const seed = seedEnv();
  const target = targetCaseEnv();
  const cases = caseCount("AUDIT_FLOW_CASES", DEFAULT_FLOW_CASES, 50, target);
  const salt = 0xc0ffee;

  for (let index = 0; index < cases; index += 1) {
    if (!selectedCase(index, target)) continue;
    const rng = random(caseSeed(seed, index, salt));
    const goodAt = 1 + (rng() % 4);
    const noise = choose(rng, [
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "[looks-like](markdown)",
      "한글🙂",
      "C:\\\\Users\\\\fixture\\\\file.js",
    ]);
    const scenario = {
      expected:{
        changedFiles:["file.txt"],
        decisions:goodAt <= 3
          ? [...Array(goodAt - 1).fill("REWORK"), "PASS"]
          : Array(3).fill("REWORK"),
        terminalStage:goodAt <= 3 ? "AWAITING_APPLY" : "INCONCLUSIVE",
      },
      mutation(number) {
        const satisfied = number >= goodAt;
        return {
          content:satisfied ? `revision 2\n${noise}\n` : `wrong-${index}-${number}\n${noise}\n`,
        };
      },
    };

    await t.test(`generator=${GENERATOR_VERSION} seed=${seed} flow-case=${index}`, async (st) => {
      const f = setupAudit(st, {
        worker({ workspace, number }) {
          const mutation = scenario.mutation(number);
          fs.writeFileSync(path.join(workspace.root, "file.txt"), mutation.content);
        },
      });
      const run = await f.run();

      const failure = (mutation, extra = {}) => failureContext(descriptor(seed, index, "pipeline", salt, mutation, {
        requiredKinds:["PATCH"], candidateId:run.candidate?.candidateId ?? null, goodAt, ...extra,
      }));
      assert.equal(run.stage, scenario.expected.terminalStage, failure("TERMINAL_STAGE"));
      assert.deepEqual(run.reviews.map((review) => review.decision), scenario.expected.decisions,
        failure("REVIEW_HISTORY"));
      assert.equal(run.application, null, failure("APPLICATION_MUST_BE_NULL"));
      assert.equal(run.reviews.length, run.candidates.length, failure("ONE_REVIEW_PER_CANDIDATE"));
      for (let position = 0; position < run.candidates.length; position += 1) {
        const candidate = run.candidates[position];
        const review = run.reviews[position];
        assert.deepEqual(candidate.changedFiles, scenario.expected.changedFiles,
          failure("CHANGED_FILES", { position }));
        assert.equal(review.candidateId, candidate.candidateId,
          failure("REVIEW_CANDIDATE_BINDING", { position }));
        if (review.decision === "REWORK" && position + 1 < run.candidates.length) {
          assert.notEqual(candidate.candidateId, run.candidates[position + 1].candidateId,
            failure("REWORK_MUST_CREATE_NEW_CANDIDATE", { position }));
        }
      }
      assert.ok(f.prompts.every((prompt) => prompt.candidateDiff.includes(noise)),
        failure("LITERAL_TO_REVIEWER"));

      if (scenario.expected.terminalStage === "AWAITING_APPLY") {
        assert.equal(run.auditResult, "PASS", failure("PASS_AUDIT_RESULT"));
        assert.equal(run.reviews.at(-1).candidateId, run.candidate.candidateId,
          failure("PASS_CURRENT_CANDIDATE_BINDING"));
        if (scenario.expected.decisions.includes("REWORK")) {
          const finding = run.findings[0];
          assert.ok(finding, failure("REWORK_FINDING_PERSISTED"));
          assert.equal(finding.status, "RESOLVED", failure("FINAL_FINDING_RESOLVED"));
          assert.equal(finding.verifiedCandidateId, run.candidate.candidateId,
            failure("FINAL_FINDING_BOUND_TO_PASS_CANDIDATE"));
          assert.equal(finding.history[0].status, "OPEN", failure("FIRST_FINDING_STARTED_OPEN"));
          assert.equal(finding.history.at(-1).candidateId, run.candidate.candidateId,
            failure("FINDING_HISTORY_FINAL_CANDIDATE"));
        }
      } else {
        assert.equal(run.auditResult, "REWORK", failure("INCONCLUSIVE_AUDIT_RESULT"));
        assert.equal(run.terminationReason, "ITERATION_LIMIT", failure("ITERATION_LIMIT"));
        const finding = run.findings[0];
        assert.ok(finding, failure("INCONCLUSIVE_FINDING_PERSISTED"));
        assert.ok(["OPEN", "FIX_SUBMITTED"].includes(finding.status), failure("INCONCLUSIVE_FINDING_NOT_RESOLVED"));
        assert.equal(finding.verifiedCandidateId, null, failure("INCONCLUSIVE_FINDING_NOT_VERIFIED"));
      }
    });
  }
});
