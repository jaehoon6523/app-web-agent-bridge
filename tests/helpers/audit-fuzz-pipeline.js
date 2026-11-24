import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit } from "./audit-fixtures.js";
import { GENERATOR_VERSION, DEFAULT_FLOW_CASES, DOMAIN_SALTS, seedEnv, targetCaseEnv, targetDomainEnv,
  caseSeed, random, choose, caseIndexes, enabledDomain, descriptor, failureContext } from "./audit-fuzz-inputs.js";

export function registerAuditFuzzPipeline(shard) {
  test("seeded mutations and explicit external review scripts cross Git capture, Controller state and persisted history", async (t) => {
    const seed = seedEnv();
    const target = targetCaseEnv();
    const targetDomain = targetDomainEnv();
    const domain = "pipeline";
    if (!enabledDomain(domain, targetDomain)) return;
    const salt = DOMAIN_SALTS[domain];

    for (const index of caseIndexes("AUDIT_FLOW_CASES", DEFAULT_FLOW_CASES, 50, target)) {
      if (target === null && index % 2 !== shard) continue;
      const rng = random(caseSeed(seed, index, salt));
      const passAt = 1 + (rng() % 4);
      const noise = choose(rng, [
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "[looks-like](markdown)",
        "한글🙂",
        "C:\\\\Users\\\\fixture\\\\file.js",
      ]);
      const reviewVerdicts = passAt <= 3
        ? [...Array(passAt - 1).fill("UNSATISFIED"), "SATISFIED"]
        : Array(3).fill("UNSATISFIED");
      const expectedDecisions = reviewVerdicts.map((verdict) => verdict === "SATISFIED" ? "PASS" : "REWORK");
      const scenario = {
        mutation(number) {
          return { content:`case-${index}-candidate-${number}\n${noise}\n` };
        },
        externalReview:{ verdicts:reviewVerdicts },
        expected:{
          changedFiles:["file.txt"],
          decisions:expectedDecisions,
          terminalStage:passAt <= 3 ? "AWAITING_APPLY" : "INCONCLUSIVE",
        },
      };

      await t.test(`generator=${GENERATOR_VERSION} seed=${seed} flow-case=${index}`, async (st) => {
        const f = setupAudit(st, {
          reviewVerdicts:scenario.externalReview.verdicts,
          worker({ workspace, number }) {
            const mutation = scenario.mutation(number);
            fs.writeFileSync(path.join(workspace.root, "file.txt"), mutation.content);
          },
        });
        const run = await f.run();
        const snapshot = f.service.snapshot(run.runId, {});

        const failure = (mutation, extra = {}) => failureContext(descriptor(seed, index, domain, mutation, {
          requiredKinds:["PATCH"],
          reviewVerdicts,
          changedFiles:scenario.expected.changedFiles,
          noise,
          ...extra,
        }));
        assert.equal(run.stage, scenario.expected.terminalStage, failure("TERMINAL_STAGE"));
        assert.deepEqual(run.reviews.map((review) => review.decision), scenario.expected.decisions,
          failure("REVIEW_HISTORY"));
        assert.equal(run.application, null, failure("APPLICATION_MUST_BE_NULL"));
        assert.equal(snapshot.outcome.applicationStatus, "NOT_APPLIED", failure("PROJECTED_APPLICATION_MUST_BE_NULL"));
        assert.equal(run.events.some((event) =>
          event.type === "STAGE_CHANGED" && ["APPLYING", "APPLIED"].includes(event.payload?.stage)), false,
        failure("NO_APPLY_STAGE_BEFORE_EXPLICIT_APPLY"));
        assert.equal(run.reviews.length, run.candidates.length, failure("ONE_REVIEW_PER_CANDIDATE"));

        for (let position = 0; position < run.candidates.length; position += 1) {
          const candidate = run.candidates[position];
          const review = run.reviews[position];
          assert.deepEqual(candidate.changedFiles, scenario.expected.changedFiles,
            failure("CHANGED_FILES", { position }));
          assert.equal(review.candidateId, candidate.candidateId,
            failure("REVIEW_CANDIDATE_BINDING", { position }));
          assert.ok(f.prompts[position].candidateDiff.includes(`case-${index}-candidate-${position + 1}`),
            failure("MUTATION_TO_CAPTURE", { position }));
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
          assert.equal(snapshot.commandCapabilities.includes("code.apply"), true,
            failure("PASS_EXPOSES_APPLY_ONLY_AFTER_AUDIT"));
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
          assert.equal(snapshot.commandCapabilities.includes("code.apply"), false,
            failure("INCONCLUSIVE_MUST_NOT_EXPOSE_APPLY"));
          assert.equal(run.events.some((event) =>
            event.type === "STAGE_CHANGED" && event.payload?.stage === "AWAITING_APPLY"), false,
          failure("INCONCLUSIVE_NEVER_REACHED_AWAITING_APPLY"));
          const finding = run.findings[0];
          assert.ok(finding, failure("INCONCLUSIVE_FINDING_PERSISTED"));
          assert.ok(["OPEN", "FIX_SUBMITTED"].includes(finding.status), failure("INCONCLUSIVE_FINDING_NOT_RESOLVED"));
          assert.equal(finding.verifiedCandidateId, null, failure("INCONCLUSIVE_FINDING_NOT_VERIFIED"));
        }
      });
    }
  });
}
