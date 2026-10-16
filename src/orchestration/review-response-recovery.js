import { canonicalJson } from "../domain/canonical-json.js";
import { createAuditManifest } from "../domain/audit-manifest.js";
import { requirementsRef } from "../domain/audit-contract.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { validateAuditResponse } from "../domain/code-review.js";
import { assertionsToReviewReport, validateReviewAssertions } from "../domain/review-coordination.js";
import { redactForEvidence } from "../security/redaction.js";

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (message) => { throw Object.assign(new Error(message), { code:"REVIEW_RECOVERY_REFUSED" }); };
function only(items, predicate, name) {
  const found = (items ?? []).filter(predicate);
  if (found.length !== 1) fail(`Expected exactly one ${name}.`);
  return found[0];
}
function contextFor(run, requestId) {
  return { runId:run.runId, requestId, candidateId:run.candidate.candidateId,
    requirementsRef:run.requirementsRef, requirements:run.requirements, evidence:run.evidence, findings:run.findings };
}
function requestIdentity(request) {
  return [request.requestId, request.role, request.phase, request.candidateId, request.auditManifestId,
    request.auditManifestHash, request.requirementsRef, request.patchHash, request.promptRef?.sha256 ?? null];
}
function receiptIdentity(receipt) {
  return [receipt.deliveryId, receipt.sessionId, receipt.conversationUrl, receipt.role,
    receipt.responseRef?.sha256 ?? null, receipt.packetRef?.sha256 ?? null, receipt.validation, receipt.at];
}
function bindingIdentity(binding) {
  return [binding.bindingId, binding.runId, binding.sessionId, binding.role, binding.provider ?? null,
    binding.actor ?? null, binding.conversationUrl, binding.conversationId];
}
function read(service, ref) { return service.artifactStore.read(ref?.sha256).toString("utf8"); }

// This is also the normal post-ACK write. All three collections commit together.
export function persistReviewResponse(service, runId, context, role, auditManifest, phase, response) {
  const run = service.get(runId), requestId = context.requestId;
  if (run.candidate.candidateId !== context.candidateId || run.candidate.patchHash !== run.capture.artifact.sha256) {
    fail("Review candidate changed after submission.");
  }
  const request = only(run.requests, item => item.requestId === requestId, "review request");
  const binding = only(run.conversationBindings, item => item.role === role, "reviewer binding");
  const put = (value, mimeType) => service.artifactStore.put(value, { mimeType, redacted:true });
  const responseRef = put(redactForEvidence(response.rawText ?? `${response.body}\n${response.packetText}`), "text/plain");
  const contentRef = put(redactForEvidence(response.body ?? ""), "text/plain");
  const packetRef = put(canonicalJson(redactForEvidence(response.packet)), "application/json");
  const matches = (run.reviewArtifacts ?? []).filter(item => item.requestId === requestId);
  if (matches.length > 1) fail("Duplicate review artifacts for one request.");
  const expected = { requestId, candidateId:context.candidateId, auditManifestId:auditManifest.auditManifestId,
    auditManifestHash:auditManifest.auditManifestHash, bindingId:binding.bindingId, role, phase,
    kind:phase === "ROUND0" ? "INITIAL_REVIEW" : "CROSS_REVIEW", contentRef, packetRef, responseRef };
  const existing = matches[0];
  if (existing && !same(Object.fromEntries(Object.keys(expected).map(key => [key, existing[key]])), expected)) {
    fail("Stored review artifact differs from the original response.");
  }
  const artifact = existing ?? { ...expected, reviewArtifactId:`review_artifact_${requestId}`,
    visibility:"PRIVATE", createdAt:request.createdAt };
  if ((request.reviewArtifactId && request.reviewArtifactId !== artifact.reviewArtifactId)
    || (request.responseRef && request.responseRef.sha256 !== responseRef.sha256)) fail("Review request evidence differs.");
  const messages = run.messages.filter(item => item.messageId === requestId);
  const expectedMessage = { messageId:requestId, fromActor:binding.actor ?? "WEB_REVIEWER_AGENT", role, phase,
    candidateId:context.candidateId, auditManifestHash:auditManifest.auditManifestHash,
    content:(response.body ?? "").trim() || "(설명 없이 제어 패킷만 제출됨)" };
  if (messages.length > 1 || (messages.length === 1
    && !same(Object.fromEntries(Object.keys(expectedMessage).map(key => [key, messages[0][key]])), expectedMessage))) {
    fail("Stored review message differs from the original response.");
  }
  const nextRequest = { ...request, status:request.status === "PROCESSED" ? "PROCESSED" : "RECEIVED",
    responseRef, reviewArtifactId:artifact.reviewArtifactId };
  if (!existing || !messages.length || !same(nextRequest, request)) service.update(runId, {
    reviewArtifacts:existing ? run.reviewArtifacts : [...(run.reviewArtifacts ?? []), artifact],
    requests:run.requests.map(item => item.requestId === requestId ? nextRequest : item),
    messages:messages.length ? run.messages : [...run.messages, { ...expectedMessage, createdAt:request.createdAt }],
  });
  return artifact;
}

export function validateReviewResponse(response, context, role, artifactId) {
  if (response.packet.type === "INVALID_RESPONSE") throw new Error(response.packet.error);
  if (response.packet.type === "EVIDENCE_REQUEST") {
    validateAuditResponse(response.packet, context);
    return null;
  }
  validateReviewAssertions(response.packet, context);
  const report = assertionsToReviewReport(response.packet, context, role, artifactId);
  validateAuditResponse(report, context);
  return report;
}

export function persistProcessedReview(service, runId, requestId, report) {
  const run = service.get(runId);
  const request = only(run.requests, item => item.requestId === requestId, "processed review request");
  const reportRef = service.artifactStore.put(canonicalJson(redactForEvidence(report)), { mimeType:"application/json", redacted:true });
  if (request.reportRef && request.reportRef.sha256 !== reportRef.sha256) fail("Processed review report differs.");
  if (request.status !== "PROCESSED" || !request.reportRef) service.update(runId, {
    requests:run.requests.map(item => item.requestId === requestId ? { ...item, status:"PROCESSED", reportRef } : item),
  });
}

function restoreResponse(service, run, request, history) {
  const receipt = only(run.webDeliveryReceipts, item => item.deliveryId === request.requestId, "delivery receipt");
  if (receipt.state !== "ACKNOWLEDGED") fail("The exact delivery ACK is not confirmed.");
  const records = history.filter(item => (item.webDeliveryReceipts ?? []).some(r => r.deliveryId === receipt.deliveryId));
  const original = records[0];
  if (!original || original.runId !== run.runId) fail("Original delivery context is unavailable.");
  const initialReceipt = only(original.webDeliveryReceipts, item => item.deliveryId === receipt.deliveryId, "original receipt");
  if (initialReceipt.state !== "ACK_PENDING") fail("The pre-ACK persistence boundary is unavailable.");
  const originalRequest = only(original.requests, item => item.requestId === request.requestId, "original request");
  const originalBinding = only(original.conversationBindings, item => item.role === request.role, "original binding");
  const binding = only(run.conversationBindings, item => item.role === request.role, "current binding");
  if (originalBinding.activeDeliveryId !== receipt.deliveryId || originalBinding.sessionId !== receipt.sessionId
    || originalBinding.runId !== run.runId || originalBinding.conversationUrl !== receipt.conversationUrl
    || receipt.role !== request.role || !same(bindingIdentity(originalBinding), bindingIdentity(binding))
    || binding.activeDeliveryId !== null || !binding.conversationId
    || !["JUDGE", "CRITIC"].includes(request.role) || !["ROUND0", "ROUND1"].includes(request.phase)
    || !same(requestIdentity(originalRequest), requestIdentity(request))) fail("Review request/session/role identity differs.");
  let acknowledged = false;
  for (const record of records) {
    const saved = only(record.webDeliveryReceipts, item => item.deliveryId === receipt.deliveryId, "historical receipt");
    if (!same(receiptIdentity(saved), receiptIdentity(receipt))) fail("Conflicting response evidence for one delivery ID.");
    if (saved.state === "ACKNOWLEDGED" && !acknowledged) {
      const owner = only(record.conversationBindings, item => item.role === request.role, "settled binding");
      if (owner.activeDeliveryId !== null || !same(bindingIdentity(owner), bindingIdentity(originalBinding))) {
        fail("ACK and ownership settlement were not persisted together.");
      }
      acknowledged = true;
    } else if (saved.state !== (acknowledged ? "ACKNOWLEDGED" : "ACK_PENDING")) fail("Delivery state regressed.");
  }
  if (!acknowledged) fail("Durable ACK settlement is unavailable.");
  const context = { ...contextFor(run, request.requestId), auditManifestHash:request.auditManifestHash };
  if (!same(contextFor(original, request.requestId), contextFor(run, request.requestId))
    || !same(requirementsRef(run.requirements), run.requirementsRef)
    || !same(request.requirementsRef, run.requirementsRef)
    || request.candidateId !== run.candidate.candidateId || request.patchHash !== run.candidate.patchHash
    || run.capture.artifact.sha256 !== request.patchHash || run.capture.candidateTree !== run.candidate.candidateTree
    || run.capture.baseCommit !== run.baseCommit || run.candidate.baseCommit !== run.baseCommit) {
    fail("Original review context or candidate differs.");
  }
  const manifest = createAuditManifest(run);
  const manifestRecord = only(run.auditManifests, item => item.auditManifestHash === request.auditManifestHash, "AuditManifest");
  if (manifest.auditManifestHash !== request.auditManifestHash || manifest.auditManifestId !== request.auditManifestId
    || !same(JSON.parse(read(service, manifestRecord.contentRef)), manifest)) fail("AuditManifest differs.");
  read(service, request.promptRef);
  read(service, run.capture.artifact);
  for (const evidence of run.evidence.filter(item => item.candidateId === request.candidateId)) read(service, evidence.contentRef);
  const rawText = read(service, receipt.responseRef), packet = JSON.parse(read(service, receipt.packetRef));
  const parsed = parseFinalControllerPacketJsonEnvelope(rawText);
  if (!same(redactForEvidence(parsed.parsed), packet)) fail("Response text and packet evidence differ.");
  return { context, manifest, response:{ rawText, body:parsed.body, packetText:parsed.packetText, packet } };
}

// Startup performs local evidence processing only. It never sends, ACKs, aggregates,
// issues apply authority, executes evidence supplements or runs a rework plan.
export function recoverAcknowledgedReviews(service, runId) {
  let run = service.get(runId);
  const target = run.requests?.find(item => item.requestId === run.reviewTurnId);
  if (!target || !["ROUND0", "ROUND1"].includes(target.phase)) return run;
  const receipts = (run.webDeliveryReceipts ?? []).filter(item => item.deliveryId === target.requestId);
  if (!receipts.some(item => item.state === "ACKNOWLEDGED")) return run;
  const requestIds = [], failures = [];
  try {
    if ((run.conversationBindings ?? []).some(item => item.activeDeliveryId)) fail("An unresolved delivery still owns the run.");
    if (run.application != null || run.stopRequested === true) fail("The run is stopped or already has application state.");
    if (run.coordination?.auditManifestHash !== target.auditManifestHash
      || run.coordination?.phase !== target.phase || run.coordination?.activeRole !== target.role) fail("Current review phase differs.");
    const history = service.store.history(runId);
    // Earlier completed roles/phases are also reused by an explicit continuation.
    const requests = run.requests.filter(item => item.requestId === target.requestId
      || (item.status === "PROCESSED" && item.candidateId === target.candidateId
        && item.auditManifestHash === target.auditManifestHash && ["ROUND0", "ROUND1"].includes(item.phase)));
    for (const request of requests) {
      const restored = restoreResponse(service, service.get(runId), request, history);
      const artifact = persistReviewResponse(service, runId, restored.context, request.role,
        restored.manifest, request.phase, restored.response);
      const report = validateReviewResponse(restored.response, restored.context, request.role, artifact.reviewArtifactId);
      if (!report) fail("Stored EVIDENCE_REQUEST needs an explicit evidence continuation; it is not a review report.");
      persistProcessedReview(service, runId, request.requestId, report);
      requestIds.push(request.requestId);
    }
  } catch (error) {
    failures.push({ requestId:target.requestId, code:error.code ?? "REVIEW_RECOVERY_REFUSED", reason:error.message });
  }
  run = service.get(runId);
  const reviewRecovery = { status:failures.length ? "REFUSED" : "READY", candidateId:target.candidateId,
    auditManifestHash:target.auditManifestHash, targetRequestId:target.requestId, requestIds, failures };
  return same(run.reviewRecovery ?? null, reviewRecovery) ? run : service.update(runId, { reviewRecovery });
}

export function canResumeAcknowledgedReview(run) {
  return Boolean(run?.schemaVersion === 3 && run.stage === "RECOVERY_REQUIRED"
    && run.reviewRecovery?.status === "READY" && run.reviewRecovery.targetRequestId === run.reviewTurnId
    && run.reviewRecovery.requestIds.includes(run.reviewTurnId)
    && run.reviewRecovery.candidateId === run.candidate?.candidateId
    && run.reviewRecovery.auditManifestHash === run.coordination?.auditManifestHash
    && run.application == null && run.stopRequested !== true
    && !run.conversationBindings.some(item => item.activeDeliveryId));
}

export function restoredReviewForRole(service, runId, role, manifest, phase) {
  const run = service.get(runId), recovery = run.reviewRecovery;
  if (recovery?.status !== "RESUMING") return null;
  if (recovery.candidateId !== run.candidate.candidateId || recovery.auditManifestHash !== manifest.auditManifestHash) {
    fail("Recovered review continuation changed candidate or manifest.");
  }
  const request = [...run.requests].reverse().find(item => recovery.requestIds.includes(item.requestId)
    && item.role === role && item.phase === phase);
  if (!request) {
    if (run.requests.some(item => item.role === role && item.phase === phase
      && item.candidateId === run.candidate.candidateId && item.auditManifestHash === manifest.auditManifestHash
      && (run.webDeliveryReceipts ?? []).some(receipt => receipt.deliveryId === item.requestId && receipt.state === "ACKNOWLEDGED"))) {
      fail("An acknowledged review was omitted from the recovery set; retransmission is refused.");
    }
    return null;
  }
  const restored = restoreResponse(service, run, request, service.store.history(runId));
  const artifact = persistReviewResponse(service, runId, restored.context, role, manifest, phase, restored.response);
  const report = validateReviewResponse(restored.response, restored.context, role, artifact.reviewArtifactId);
  if (!report || !request.reportRef || !same(JSON.parse(read(service, request.reportRef)), report)) {
    fail("Recovered review report is missing or differs.");
  }
  return { artifact, report };
}
