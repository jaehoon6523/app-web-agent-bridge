import { sha256CanonicalJson } from "./canonical-json.js";

export function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}
export function exactObject(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || required.some((k) => !Object.hasOwn(value, k))
    || Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))) {
    throw new TypeError(`Expected only ${[...required, ...optional].join(", ")}; required fields must be present.`);
  }
}
export function uniqueItems(items, key, label) {
  if (!Array.isArray(items)) throw new TypeError(`${label} must be an array.`);
  const ids = items.map((item) => nonempty(item?.[key], `${label}.${key}`));
  if (new Set(ids).size !== ids.length) throw new TypeError(`Duplicate ${label} ID.`);
}
export function requirementsRef(requirements) {
  return { requirementsId: requirements.requirementsId, revision: requirements.revision, hash: sha256CanonicalJson(requirements) };
}
export function validateRequirements(value) {
  exactObject(value, ["requirementsId", "revision", "authority", "items", "sourceRoles", "unresolvedQuestions"]);
  nonempty(value.requirementsId, "requirementsId"); nonempty(value.revision, "revision");
  uniqueItems(value.items, "requirementId", "requirements");
  if (!value.items.length || !value.items.some((r) => r.required)) throw new TypeError("At least one required requirement is needed.");
  if (!Array.isArray(value.sourceRoles) || !Array.isArray(value.unresolvedQuestions)) throw new TypeError("Source roles and unresolved questions must be arrays.");
  if (value.authority !== "REQUIREMENTS_JSON") throw new TypeError("Explicit REQUIREMENTS_JSON authority required; source documents are reference only.");
  uniqueItems(value.sourceRoles, "source", "source roles");
  for (const source of value.sourceRoles) {
    exactObject(source, ["source", "role", "content"]);
    if (source.role !== "REFERENCE") throw new TypeError("Source role must be REFERENCE; move acceptance rules into requirements items.");
    nonempty(source.content, "source snapshot content");
  }
  if (value.unresolvedQuestions.some((q) => typeof q !== "string" || !q.trim())) throw new TypeError("Unresolved questions must be nonempty strings.");
  for (const item of value.items) {
    exactObject(item, ["requirementId", "statement", "acceptanceCriteria", "required", "verificationMethod", "sourceRefs"]);
    nonempty(item.statement, "statement"); nonempty(item.acceptanceCriteria, "acceptanceCriteria");
    if (typeof item.required !== "boolean" || !Array.isArray(item.sourceRefs)) throw new TypeError("Invalid requirement flags or sources.");
    if (new Set(item.sourceRefs).size !== item.sourceRefs.length || item.sourceRefs.some((ref) => !value.sourceRoles.some((s) => s.source === ref))) throw new TypeError("Every source reference must name a registered snapshot.");
    exactObject(item.verificationMethod, ["kinds", "description"], ["checks"]);
    nonempty(item.verificationMethod.description, "verificationMethod.description");
    if (!Array.isArray(item.verificationMethod.kinds) || !item.verificationMethod.kinds.length
      || item.verificationMethod.kinds.some((k) => !["CODE_SNAPSHOT", "PATCH", "EXECUTION", "ARTIFACT"].includes(k))) {
      throw new TypeError("Verification must name controller evidence kinds; agent claims are insufficient.");
    }
    const checks = item.verificationMethod.checks ?? [];
    uniqueItems(checks, "verificationId", "verification checks");
    if (item.verificationMethod.kinds.some((k) => ["EXECUTION", "ARTIFACT"].includes(k)) && !checks.length) throw new TypeError("Execution/artifact verification requires explicit checks.");
    for (const check of checks) {
      exactObject(check, ["verificationId", "expectedExitCode", "requiredResultFiles"]);
      if (!Number.isSafeInteger(check.expectedExitCode) || check.expectedExitCode < 0 || check.expectedExitCode > 255) throw new TypeError("Verification expectedExitCode must be 0..255.");
      if (!Array.isArray(check.requiredResultFiles) || new Set(check.requiredResultFiles).size !== check.requiredResultFiles.length || check.requiredResultFiles.some((f) => typeof f !== "string" || !f.trim())) throw new TypeError("Verification result files must be unique names.");
    }
    if (item.verificationMethod.kinds.includes("ARTIFACT") && !checks.some((c) => c.requiredResultFiles.length)) throw new TypeError("Artifact verification must bind at least one result file.");
  }
  return structuredClone(value);
}
export function validateAuditPolicy(policy) {
  exactObject(policy, ["maxIterations", "maxEvidenceRounds", "maxFormatRepairs", "totalTimeoutMs", "turnTimeoutMs"]);
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value > 2_147_483_647 || value < (["maxFormatRepairs", "maxEvidenceRounds"].includes(key) ? 0 : 1)) {
      throw new TypeError(`${key} must be an explicit non-negative/positive integer.`);
    }
  }
  return structuredClone(policy);
}
