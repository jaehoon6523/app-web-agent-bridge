import fs from "node:fs";
import path from "node:path";
import { validateRequirements, validateAuditPolicy, nonempty, exactObject } from "../domain/audit-contract.js";
import { validateVerifications } from "../evidence/candidate-evidence.js";

export function validateAuditProject(value) {
  exactObject(value, ["projectId", "targetRoot", "requirements", "policy", "verifications"]);
  nonempty(value.projectId, "projectId");
  if (!path.isAbsolute(value.targetRoot)) throw new TypeError("Project targetRoot must be absolute.");
  return { projectId: value.projectId, targetRoot: fs.realpathSync(value.targetRoot),
    requirements: validateRequirements(value.requirements), policy: validateAuditPolicy(value.policy), verifications: validateVerifications(value.verifications) };
}
export function readAuditProject(filename) {
  if (!filename) return { project: null, error: "AUDIT_PROJECT_FILE을 설정하고 대상 저장소·요구사항·검증·한도를 지정하세요." };
  try { return { project: validateAuditProject(JSON.parse(fs.readFileSync(filename, "utf8"))), error: null }; }
  catch (error) { return { project: null, error: `감사 프로젝트 설정을 확인하세요: ${error.message}` }; }
}
