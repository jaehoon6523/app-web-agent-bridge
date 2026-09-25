import { canonicalJson, sha256CanonicalJson, sha256Text } from "./canonical-json.js";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function recordHash(value) {
  return sha256CanonicalJson(cloneJson(value));
}

function evidenceRefs(run, candidateId) {
  return (run.evidence ?? [])
    .filter((item) => item?.candidateId === candidateId)
    .map((item) => ({
      evidenceId: requireString(item.evidenceId, "evidenceId"),
      kind: requireString(item.kind, "evidence kind"),
      producer: typeof item.producer === "string" ? item.producer : null,
      contentHash: requireString(item.contentRef?.sha256, "evidence content hash"),
      recordHash: recordHash(item),
    }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

function findingRefs(run) {
  return (run.findings ?? [])
    .map((item) => ({
      findingId: requireString(item.findingId, "findingId"),
      requirementId: requireString(item.requirementId, "finding requirementId"),
      problem: requireString(item.problem, "finding problem"),
      resolutionCriteria: requireString(item.resolutionCriteria, "finding resolutionCriteria"),
      required: item.required === true,
      detectedCandidateId: typeof item.detectedCandidateId === "string" ? item.detectedCandidateId : null,
    }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function verificationRefs(run) {
  return (run.verifications ?? [])
    .map((item) => ({
      verificationId: requireString(item.verificationId, "verificationId"),
      definitionHash: recordHash(item),
    }))
    .sort((a, b) => a.verificationId.localeCompare(b.verificationId));
}

function decisionRefs(run, candidateId) {
  return (run.userDecisions ?? []).filter((item) => item.candidateId === candidateId)
    .map((item) => ({ decisionId:requireString(item.decisionId, "decisionId"),
      contentHash:recordHash({ responses:item.responses, candidateId:item.candidateId, requirementsRef:item.requirementsRef }) }))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
}

export function createAuditManifest(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) throw new TypeError("AuditManifest requires a run.");
  const candidate = run.candidate;
  if (!candidate) throw new TypeError("AuditManifest requires a candidate.");
  const candidateId = requireString(candidate.candidateId, "candidateId");
  const authority = {
    schemaVersion: 1,
    runId: requireString(run.runId, "runId"),
    objectiveHash: sha256Text(String(run.objective ?? "")),
    candidate: {
      candidateId,
      baseCommit: requireString(candidate.baseCommit, "candidate baseCommit"),
      candidateTree: requireString(candidate.candidateTree, "candidateTree"),
      patchHash: requireString(candidate.patchHash, "candidate patchHash"),
    },
    requirementsRef: cloneJson(run.requirementsRef),
    evidenceRefs: evidenceRefs(run, candidateId),
    ...(decisionRefs(run, candidateId).length ? { decisionRefs:decisionRefs(run, candidateId) } : {}),
    priorFindingRefs: findingRefs(run),
    verificationRefs: verificationRefs(run),
  };
  const auditManifestHash = sha256CanonicalJson(authority);
  return Object.freeze({
    auditManifestId: `audit_manifest_${auditManifestHash.slice(7, 27)}`,
    auditManifestHash,
    ...authority,
  });
}

export function auditManifestMatchesRun(manifest, run) {
  if (!manifest || !run?.candidate) return false;
  const { auditManifestId: _id, auditManifestHash, ...authority } = manifest;
  if (sha256CanonicalJson(authority) !== auditManifestHash) return false;
  const stableCurrent = {
    runId: run.runId,
    objectiveHash: sha256Text(String(run.objective ?? "")),
    candidate: {
      candidateId: run.candidate.candidateId,
      baseCommit: run.candidate.baseCommit,
      candidateTree: run.candidate.candidateTree,
      patchHash: run.candidate.patchHash,
    },
    requirementsRef: cloneJson(run.requirementsRef),
    evidenceRefs: evidenceRefs(run, run.candidate.candidateId),
    ...(decisionRefs(run, run.candidate.candidateId).length ? { decisionRefs:decisionRefs(run, run.candidate.candidateId) } : {}),
    verificationRefs: verificationRefs(run),
  };
  const stableManifest = {
    runId: manifest.runId,
    objectiveHash: manifest.objectiveHash,
    candidate: manifest.candidate,
    requirementsRef: manifest.requirementsRef,
    evidenceRefs: manifest.evidenceRefs,
    ...(manifest.decisionRefs?.length ? { decisionRefs:manifest.decisionRefs } : {}),
    verificationRefs: manifest.verificationRefs,
  };
  if (canonicalJson(stableCurrent) !== canonicalJson(stableManifest)) return false;
  const currentFindings = new Map(findingRefs(run).map((item) => [item.findingId, item]));
  return (manifest.priorFindingRefs ?? []).every((item) =>
    currentFindings.has(item.findingId)
      && canonicalJson(currentFindings.get(item.findingId)) === canonicalJson(item));
}
