import { randomUUID } from "node:crypto";
import { parseFinalControllerPacketJsonEnvelope } from "./controller-packet-envelope.js";
import { canonicalJson } from "./canonical-json.js";
import { exactObject, nonempty, uniqueItems } from "./audit-contract.js";

export function parseCodeReviewResponse(rawText, context) {
  const parsed = parseFinalControllerPacketJsonEnvelope(rawText);
  validateAuditResponse(parsed.parsed, context);
  return Object.freeze({ body: parsed.body, packetText: parsed.packetText, packet: parsed.parsed });
}
function bound(response, context) {
  if (response.runId !== context.runId || response.requestId !== context.requestId
    || response.candidateId !== context.candidateId
    || canonicalJson(response.requirementsRef) !== canonicalJson(context.requirementsRef)) {
    throw new TypeError("Audit run, request, candidate or requirements version mismatch.");
  }
}
function references(refs, context, requireSome = true) {
  if (!Array.isArray(refs) || (requireSome && !refs.length) || new Set(refs).size !== refs.length) throw new TypeError("Evidence references are missing or duplicated.");
  return refs.map((id) => {
    const evidence = context.evidence.find((e) => e.evidenceId === id);
    if (!evidence || evidence.candidateId !== context.candidateId || evidence.valid === false) throw new TypeError("Evidence is outside this candidate or invalid.");
    return evidence;
  });
}
function verifyRequiredExecutions(requirement, evidence, context) {
  const checks = requirement.verificationMethod.checks ?? [];
  if (requirement.verificationMethod.kinds.some((k) => ["EXECUTION", "ARTIFACT"].includes(k)) && !checks.length) {
    throw new TypeError("SATISFIED requires explicit verification execution checks.");
  }
  for (const check of checks) {
    const latest = context.evidence.filter((e) => e.candidateId === context.candidateId && e.kind === "EXECUTION"
      && e.result?.verificationId === check.verificationId).at(-1);
    const r = latest?.result;
    if (!latest || !evidence.includes(latest) || latest.producer !== "CONTROLLER" || latest.valid !== true
      || !r.executionId || r.exitCode !== check.expectedExitCode || r.timedOut !== false || r.aborted !== false
      || r.error !== null || r.candidateUnchanged !== true || r.terminationConfirmed !== true) {
      throw new TypeError(`SATISFIED lacks a successful latest verification execution: ${check.verificationId}`);
    }
    for (const filename of check.requiredResultFiles) {
      if (!evidence.some((e) => e.kind === "ARTIFACT" && e.producer === "CONTROLLER" && e.valid === true
        && e.executionEvidenceId === latest.evidenceId && e.result?.executionId === r.executionId
        && e.result?.verificationId === check.verificationId && e.result?.path === filename)) {
        throw new TypeError(`SATISFIED lacks the required verification result: ${filename}`);
      }
    }
  }
}
export function validateAuditResponse(response, context) {
  const shared = ["type", "runId", "requestId", "candidateId", "requirementsRef"];
  if (response?.type === "EVIDENCE_REQUEST") {
    exactObject(response, [...shared, "requests"]); bound(response, context);
    uniqueItems(response.requests, "requestItemId", "evidence requests");
    if (!response.requests.length || response.requests.length > 20) throw new TypeError("Evidence requests must contain 1..20 items.");
    for (const req of response.requests) {
      exactObject(req, ["requestItemId", "kind", "purpose"], ["path", "startLine", "endLine", "evidenceId", "verificationId", "question"]);
      nonempty(req.purpose, "request purpose");
      if (!["CODE", "EVIDENCE", "VERIFY", "PROPOSAL", "QUESTION"].includes(req.kind)) throw new TypeError("Unknown evidence request kind.");
    }
    return response;
  }
  exactObject(response, [...shared, "assessments", "findingDecisions", "newFindings", "summary"], ["score", "suggestions"]);
  if (response.type !== "REVIEW_REPORT") throw new TypeError("Expected REVIEW_REPORT or EVIDENCE_REQUEST.");
  bound(response, context); nonempty(response.summary, "summary");
  if (response.score !== undefined && !Number.isFinite(response.score)) throw new TypeError("Optional score must be finite.");
  uniqueItems(response.assessments, "requirementId", "assessments");
  const requirements = context.requirements.items;
  if (response.assessments.length !== requirements.length) throw new TypeError("Every requirement needs an assessment.");
  for (const assessment of response.assessments) {
    exactObject(assessment, ["requirementId", "verdict", "evidenceRefs", "reason"], ["missingInformation"]);
    const req = requirements.find((r) => r.requirementId === assessment.requirementId);
    if (!req || !["SATISFIED", "UNSATISFIED", "UNDETERMINED"].includes(assessment.verdict)) throw new TypeError("Unknown requirement or verdict.");
    nonempty(assessment.reason, "assessment reason");
    const evidence = references(assessment.evidenceRefs, context, assessment.verdict !== "UNDETERMINED");
    if (assessment.verdict === "UNDETERMINED") nonempty(assessment.missingInformation, "missingInformation");
    if (assessment.verdict === "SATISFIED" && req.verificationMethod.kinds.some((kind) => !evidence.some((e) => e.kind === kind && e.producer !== "AGENT"))) {
      throw new TypeError("SATISFIED lacks the required verification evidence kinds.");
    }
    if (assessment.verdict === "SATISFIED") verifyRequiredExecutions(req, evidence, context);
  }
  uniqueItems(response.findingDecisions, "findingId", "finding decisions");
  for (const decision of response.findingDecisions) {
    exactObject(decision, ["findingId", "status", "evidenceRefs", "reason"]);
    if (!context.findings.some((f) => f.findingId === decision.findingId)) throw new TypeError("Unknown finding ID.");
    if (!["OPEN", "FIX_SUBMITTED", "RESOLVED", "WITHDRAWN"].includes(decision.status)) throw new TypeError("Invalid finding decision.");
    nonempty(decision.reason, "finding decision reason"); references(decision.evidenceRefs, context);
  }
  if (!Array.isArray(response.newFindings)) throw new TypeError("newFindings must be an array.");
  for (const finding of response.newFindings) {
    exactObject(finding, ["requirementId", "problem", "evidenceRefs", "resolutionCriteria", "required"]);
    if (!requirements.some((r) => r.requirementId === finding.requirementId) || typeof finding.required !== "boolean") throw new TypeError("Invalid finding requirement.");
    nonempty(finding.problem, "finding problem"); nonempty(finding.resolutionCriteria, "resolution criteria");
    references(finding.evidenceRefs, context);
  }
  if (response.suggestions !== undefined) {
    if (!Array.isArray(response.suggestions)) throw new TypeError("suggestions must be an array.");
    for (const suggestion of response.suggestions) {
      exactObject(suggestion, ["requirementId", "description", "evidenceRefs"]);
      if (!requirements.some((r) => r.requirementId === suggestion.requirementId)) throw new TypeError("Unknown suggestion requirement.");
      nonempty(suggestion.description, "suggestion description"); references(suggestion.evidenceRefs, context);
    }
  }
  return response;
}
export function evaluateCodeReview(report, context) {
  validateAuditResponse(report, context);
  if (report.type !== "REVIEW_REPORT") throw new TypeError("An evidence request is not a review verdict.");
  const reviewId = context.reviewId ?? `review_${randomUUID()}`;
  const at = new Date().toISOString();
  const findings = structuredClone(context.findings);
  for (const decision of report.findingDecisions) {
    const finding = findings.find((f) => f.findingId === decision.findingId);
    finding.status = decision.status;
    finding.verifiedCandidateId = ["RESOLVED", "WITHDRAWN"].includes(decision.status) ? context.candidateId : null;
    finding.history.push({ ...decision, candidateId: context.candidateId, reviewId, at });
  }
  for (const item of report.newFindings) {
    findings.push({ ...structuredClone(item), findingId: `finding_${randomUUID()}`, runId: context.runId,
      detectedCandidateId: context.candidateId, status: "OPEN", verifiedCandidateId: null,
      history: [{ status: "OPEN", candidateId: context.candidateId, reviewId, at, reason: item.problem }] });
  }
  // Findings describe acceptance violations. Optional improvements belong in suggestions.
  // A reviewer cannot downgrade a required requirement's violation, including historical records.
  for (const finding of findings) {
    finding.required = finding.required || context.requirements.items.some((r) => r.requirementId === finding.requirementId && r.required);
  }
  const required = report.assessments.filter((a) => context.requirements.items.find((r) => r.requirementId === a.requirementId).required);
  const unresolved = findings.some((f) => f.required && ["OPEN", "FIX_SUBMITTED"].includes(f.status));
  const recheck = findings.some((f) => f.required && f.status === "RESOLVED" && f.verifiedCandidateId !== context.candidateId);
  const decision = required.some((a) => a.verdict === "UNSATISFIED") || unresolved ? "REWORK"
    : required.some((a) => a.verdict === "UNDETERMINED") || recheck || context.requirements.unresolvedQuestions.length ? "HOLD" : "PASS";
  return { decision, reviewId, report: structuredClone(report), findings };
}
