import fs from "node:fs";
import path from "node:path";
import { validateRequirements, validateAuditPolicy, nonempty, exactObject } from "../domain/audit-contract.js";
import { validateVerifications } from "../evidence/candidate-evidence.js";
import { validateReviewerConfiguration } from "./reviewer-settings.js";

export function validateAuditProject(value) {
  exactObject(value, ["projectId", "targetRoot", "requirements", "policy", "verifications"], ["reviewers"]);
  nonempty(value.projectId, "projectId");
  if (!path.isAbsolute(value.targetRoot)) throw new TypeError("Project targetRoot must be absolute.");
  const requirements = validateRequirements(value.requirements), verifications = validateVerifications(value.verifications);
  for (const requirement of requirements.items) for (const check of requirement.verificationMethod.checks ?? []) {
    const registered = verifications.find((v) => v.verificationId === check.verificationId);
    if (!registered || check.requiredResultFiles.some((f) => !registered.resultFiles.includes(f))) throw new TypeError("Requirement verification or result file is not registered.");
  }
  return { projectId: value.projectId, targetRoot: fs.realpathSync(value.targetRoot),
    requirements, policy: validateAuditPolicy(value.policy), verifications,
    reviewers: validateReviewerConfiguration(value.reviewers) };
}
export function readAuditProject(filename) {
  if (!filename) return { project: null, error: "‘프로젝트 설정’에서 대상 저장소·요구사항·검증·한도를 지정하세요." };
  try { return { project: validateAuditProject(JSON.parse(fs.readFileSync(filename, "utf8"))), error: null }; }
  catch (error) { return { project: null, error: `감사 프로젝트 설정을 확인하세요: ${error.message}` }; }
}
