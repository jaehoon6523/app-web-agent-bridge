import { randomUUID } from "node:crypto";
import { sha256CanonicalJson } from "./canonical-json.js";

const VERDICTS = new Set(["SATISFIED", "UNSATISFIED", "UNDETERMINED"]);
const FINDING_STATUSES = new Set(["OPEN", "FIX_SUBMITTED", "RESOLVED", "WITHDRAWN"]);

function plain(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}
function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new TypeError(`${name} must be a string array.`);
  return value;
}
function exact(value, allowed, required, name) {
  plain(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported property ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}.`);
}
function sameIdentity(packet, context) {
  for (const [key, expected] of [["runId", context.runId], ["requestId", context.requestId], ["candidateId", context.candidateId], ["auditManifestHash", context.auditManifestHash]]) {
    if (packet[key] !== expected) throw new TypeError(`${key} does not match the review request.`);
  }
}

export function validateReviewAssertions(packet, context) {
  exact(packet,
    ["type","runId","requestId","candidateId","auditManifestHash","assessments","findingDecisions","newFindings"],
    ["type","runId","requestId","candidateId","auditManifestHash","assessments","findingDecisions","newFindings"],
    "REVIEW_ASSERTIONS");
  if (packet.type !== "REVIEW_ASSERTIONS") throw new TypeError("Expected REVIEW_ASSERTIONS.");
  sameIdentity(packet, context);
  if (!Array.isArray(packet.assessments) || packet.assessments.length !== context.requirements.items.length) {
    throw new TypeError("Every requirement needs one review assertion.");
  }
  const seen = new Set();
  for (const assessment of packet.assessments) {
    exact(assessment, ["requirementId","verdict","evidenceRefs","missingInformation"],
      ["requirementId","verdict","evidenceRefs"], "review assessment");
    if (seen.has(assessment.requirementId) || !context.requirements.items.some((item) => item.requirementId === assessment.requirementId)) {
      throw new TypeError("Review assertions contain an unknown or duplicate requirement.");
    }
    seen.add(assessment.requirementId);
    if (!VERDICTS.has(assessment.verdict)) throw new TypeError("Review assertion verdict is invalid.");
    stringArray(assessment.evidenceRefs, "assessment evidenceRefs");
    if (assessment.verdict === "UNDETERMINED") text(assessment.missingInformation, "missingInformation");
  }
  if (!Array.isArray(packet.findingDecisions)) throw new TypeError("findingDecisions must be an array.");
  const expectedFindingIds = (context.findings ?? []).filter((item) => item.status !== "WITHDRAWN").map((item) => item.findingId).sort();
  const receivedFindingIds = packet.findingDecisions.map((item) => item?.findingId).sort();
  if (JSON.stringify(expectedFindingIds) !== JSON.stringify(receivedFindingIds)) {
    throw new TypeError("Every active finding needs exactly one finding decision.");
  }
  for (const decision of packet.findingDecisions) {
    exact(decision, ["findingId","status","evidenceRefs"], ["findingId","status","evidenceRefs"], "finding decision");
    text(decision.findingId, "findingId"); stringArray(decision.evidenceRefs, "finding evidenceRefs");
    if (!FINDING_STATUSES.has(decision.status)) throw new TypeError("finding status is invalid.");
  }
  if (!Array.isArray(packet.newFindings)) throw new TypeError("newFindings must be an array.");
  for (const finding of packet.newFindings) {
    exact(finding, ["requirementId","problem","resolutionCriteria","evidenceRefs","required"],
      ["requirementId","problem","resolutionCriteria","evidenceRefs","required"], "new finding");
    text(finding.requirementId, "finding requirementId"); text(finding.problem, "finding problem");
    text(finding.resolutionCriteria, "finding resolutionCriteria"); stringArray(finding.evidenceRefs, "finding evidenceRefs");
    if (typeof finding.required !== "boolean") throw new TypeError("finding required must be boolean.");
  }
  return packet;
}

export function assertionsToReviewReport(packet, context, role, artifactId) {
  validateReviewAssertions(packet, context);
  return {
    type:"REVIEW_REPORT", runId:context.runId, requestId:context.requestId, candidateId:context.candidateId,
    requirementsRef:context.requirementsRef,
    assessments:packet.assessments.map((item) => ({
      requirementId:item.requirementId, verdict:item.verdict, evidenceRefs:item.evidenceRefs,
      reason:`${role} reasoning is stored in ${artifactId}.`,
      ...(item.verdict === "UNDETERMINED" ? { missingInformation:item.missingInformation } : {}),
    })),
    findingDecisions:packet.findingDecisions.map((item) => ({
      ...item, reason:`${role} finding decision reasoning is stored in ${artifactId}.`,
    })),
    newFindings:packet.newFindings,
    summary:`${role} review assertions; reasoning artifact ${artifactId}.`,
  };
}

function strongestVerdict(values) {
  if (values.includes("UNSATISFIED")) return "UNSATISFIED";
  if (values.includes("UNDETERMINED")) return "UNDETERMINED";
  return "SATISFIED";
}

function reviewFingerprint(report) {
  return sha256CanonicalJson({
    assessments:[...report.assessments]
      .map((item) => ({ requirementId:item.requirementId, verdict:item.verdict }))
      .sort((a,b) => a.requirementId.localeCompare(b.requirementId)),
    findingDecisions:[...report.findingDecisions]
      .map((item) => ({ findingId:item.findingId, status:item.status }))
      .sort((a,b) => a.findingId.localeCompare(b.findingId)),
    newFindings:[...report.newFindings]
      .map((item) => ({
        requirementId:item.requirementId, problem:item.problem,
        resolutionCriteria:item.resolutionCriteria, required:item.required,
      }))
      .sort((a,b) => sha256CanonicalJson(a).localeCompare(sha256CanonicalJson(b))),
  });
}

export function reviewReportsDisagree(reports) {
  if (reports.length < 2) return false;
  const first = reviewFingerprint(reports[0]);
  return reports.slice(1).some((report) => reviewFingerprint(report) !== first);
}

export function aggregateReviewReports(reports, context) {
  if (!Array.isArray(reports) || reports.length < 2) throw new TypeError("At least two reviewer reports are required.");
  const assessments = context.requirements.items.map((requirement) => {
    const sources = reports.map((report) => report.assessments.find((item) => item.requirementId === requirement.requirementId));
    const verdict = strongestVerdict(sources.map((item) => item.verdict));
    const evidenceRefs = [...new Set(sources.flatMap((item) => item.evidenceRefs))];
    return {
      requirementId:requirement.requirementId, verdict, evidenceRefs,
      reason:`Aggregated deterministic verdict from ${reports.length} required role reports.`,
      ...(verdict === "UNDETERMINED" ? {
        missingInformation:sources.filter((item) => item.verdict === "UNDETERMINED")
          .map((item) => item.missingInformation).filter(Boolean).join("\n") || "Reviewer evidence remains incomplete.",
      } : {}),
    };
  });
  const findingDecisions = (context.findings ?? []).filter((finding) => finding.status !== "WITHDRAWN").map((finding) => {
    const decisions = reports.map((report) => report.findingDecisions.find((item) => item.findingId === finding.findingId)).filter(Boolean);
    const resolved = decisions.length === reports.length && decisions.every((item) => item.status === "RESOLVED");
    return {
      findingId:finding.findingId,
      status:resolved ? "RESOLVED" : "OPEN",
      evidenceRefs:[...new Set(decisions.flatMap((item) => item.evidenceRefs))],
      reason:"Existing finding is resolved only when every required reviewer explicitly resolves it.",
    };
  });
  const uniqueNew = new Map();
  for (const report of reports) for (const finding of report.newFindings) {
    const key = sha256CanonicalJson({
      requirementId:finding.requirementId, problem:finding.problem, resolutionCriteria:finding.resolutionCriteria,
    });
    const existing = uniqueNew.get(key);
    uniqueNew.set(key, existing ? { ...existing,
      evidenceRefs:[...new Set([...existing.evidenceRefs, ...finding.evidenceRefs])],
      required:existing.required || finding.required,
    } : structuredClone(finding));
  }
  return {
    type:"REVIEW_REPORT", runId:context.runId, requestId:context.requestId, candidateId:context.candidateId,
    requirementsRef:context.requirementsRef, assessments, findingDecisions, newFindings:[...uniqueNew.values()],
    summary:"Controller aggregate of JUDGE and CRITIC assertions.",
  };
}

export function createPlanBasis({ auditManifestHash, candidateId, findings, publishedArtifacts, workerPosition }) {
  const findingSet = [...findings].map((item) => ({
    findingId:item.findingId, requirementId:item.requirementId, status:item.status,
    problem:item.problem, resolutionCriteria:item.resolutionCriteria, required:item.required === true,
  })).sort((a,b) => a.findingId.localeCompare(b.findingId));
  const artifactSet = [...publishedArtifacts].map((item) => ({
    reviewArtifactId:item.reviewArtifactId, role:item.role, kind:item.kind,
    contentHash:item.contentHash ?? item.contentRef?.sha256 ?? null,
    packetHash:item.packetHash ?? item.packetRef?.sha256 ?? null,
  })).sort((a,b) => a.reviewArtifactId.localeCompare(b.reviewArtifactId));
  const basis = {
    auditManifestHash:text(auditManifestHash,"auditManifestHash"),
    candidateId:text(candidateId,"candidateId"),
    findingSetHash:sha256CanonicalJson(findingSet),
    publishedArtifactHashes:artifactSet,
    workerPositionHash:workerPosition?.contentHash ?? null,
  };
  return Object.freeze({ ...basis, planBasisHash:sha256CanonicalJson(basis) });
}

export function validatePlanProposal(packet, expected) {
  exact(packet, ["type","runId","candidateId","auditManifestHash","planBasisHash","planId","workItems","constraints"],
    ["type","runId","candidateId","auditManifestHash","planBasisHash","planId","workItems","constraints"], "PLAN_PROPOSAL");
  if (packet.type !== "PLAN_PROPOSAL") throw new TypeError("Expected PLAN_PROPOSAL.");
  for (const key of ["runId","candidateId","auditManifestHash","planBasisHash","planId"]) {
    if (packet[key] !== expected[key]) throw new TypeError(`${key} does not match plan request.`);
  }
  if (!Array.isArray(packet.workItems) || packet.workItems.length === 0) throw new TypeError("PLAN_PROPOSAL requires workItems.");
  if (new Set(packet.workItems.map((item) => item?.workItemId)).size !== packet.workItems.length) {
    throw new TypeError("PLAN_PROPOSAL workItemId values must be unique.");
  }
  packet.workItems.forEach((item) => {
    exact(item, ["workItemId","objective","acceptanceCriteria"], ["workItemId","objective","acceptanceCriteria"], "work item");
    text(item.workItemId,"workItemId"); text(item.objective,"work item objective"); text(item.acceptanceCriteria,"work item acceptanceCriteria");
  });
  stringArray(packet.constraints, "plan constraints");
  return packet;
}

export function freezePlan(packet) {
  const plan = structuredClone(packet);
  return Object.freeze({ ...plan, planHash:sha256CanonicalJson(plan) });
}

export function validatePlanResponse(packet, expected) {
  exact(packet, ["type","runId","candidateId","planId","planHash","planBasisHash","decision"],
    ["type","runId","candidateId","planId","planHash","planBasisHash","decision"], "PLAN_RESPONSE");
  if (packet.type !== "PLAN_RESPONSE") throw new TypeError("Expected PLAN_RESPONSE.");
  for (const key of ["runId","candidateId","planId","planHash","planBasisHash"]) {
    if (packet[key] !== expected[key]) throw new TypeError(`${key} does not match frozen plan.`);
  }
  if (!["ACCEPT","REJECT"].includes(packet.decision)) throw new TypeError("PLAN_RESPONSE decision must be ACCEPT or REJECT.");
  return packet;
}

export function createAgreedWorkOrder({ runId, baseCandidateId, auditManifestHash, planBasisHash, plan,
  acceptedByBindingId, acceptedControlEventId }) {
  const authority = {
    type:"AGREED_WORK_ORDER",
    workOrderId:`work_${randomUUID()}`,
    runId:text(runId,"runId"),
    baseCandidateId:text(baseCandidateId,"baseCandidateId"),
    auditManifestHash:text(auditManifestHash,"auditManifestHash"),
    planBasisHash:text(planBasisHash,"planBasisHash"),
    planId:text(plan.planId,"planId"),
    planHash:text(plan.planHash,"planHash"),
    workItems:structuredClone(plan.workItems),
    constraints:structuredClone(plan.constraints),
    acceptedByBindingId:text(acceptedByBindingId,"acceptedByBindingId"),
    acceptedControlEventId:text(acceptedControlEventId,"acceptedControlEventId"),
    createdAt:new Date().toISOString(),
  };
  return Object.freeze({ ...authority, workOrderHash:sha256CanonicalJson(authority) });
}

export function validateAgreedWorkOrder(order, expected) {
  exact(order,
    ["type","workOrderId","runId","baseCandidateId","auditManifestHash","planBasisHash","planId","planHash",
      "workItems","constraints","acceptedByBindingId","acceptedControlEventId","createdAt","workOrderHash"],
    ["type","workOrderId","runId","baseCandidateId","auditManifestHash","planBasisHash","planId","planHash",
      "workItems","constraints","acceptedByBindingId","acceptedControlEventId","createdAt","workOrderHash"],
    "AGREED_WORK_ORDER");
  if (order.type !== "AGREED_WORK_ORDER") throw new TypeError("Expected AGREED_WORK_ORDER.");
  if (order.runId !== expected.runId || order.baseCandidateId !== expected.baseCandidateId) {
    throw new TypeError("AGREED_WORK_ORDER does not match the current rework candidate.");
  }
  const { workOrderHash, ...authority } = order;
  if (sha256CanonicalJson(authority) !== workOrderHash) throw new TypeError("AGREED_WORK_ORDER hash mismatch.");
  return order;
}
