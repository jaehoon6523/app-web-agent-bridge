import { canonicalJson } from "../domain/canonical-json.js";
import { createAuditManifest } from "../domain/audit-manifest.js";
import { requirementsRef } from "../domain/audit-contract.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { validateAuditResponse } from "../domain/code-review.js";
import { aggregateReviewReports, assertionsToReviewReport, validateReviewAssertions } from "../domain/review-coordination.js";
import { redactForEvidence } from "../security/redaction.js";
import { redactControllerResponseText, publicResponseBody, publicResponsePacket, privateResponseRecord } from "./web-delivery-receipts.js";
import { retryableInterruptedEnvelope } from "./code-change-runtime-policy.js";

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
    receipt.responseRef?.sha256 ?? null, receipt.packetRef?.sha256 ?? null, receipt.privateResponseRef ?? null, receipt.validation, receipt.at];
}
function bindingIdentity(binding) {
  return [binding.bindingId, binding.runId, binding.sessionId, binding.role, binding.provider ?? null,
    binding.actor ?? null, binding.conversationUrl, binding.conversationId];
}
function read(service, ref) { return service.artifactStore.read(ref?.sha256).toString("utf8"); }

// Reads the sealed review boundary. Recovery helpers intentionally persist state and are not used here.
export function readSettledRoleAssessments(service, run, review) {
  const unavailable = () => ({status:"UNAVAILABLE", roles:[]});
  if (!review?.auditManifestHash || review.candidateId !== run.candidate?.candidateId
    || run.coordination?.auditManifestHash !== review.auditManifestHash || run.coordination?.activeRole
    || ["REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT", "REWORK"].includes(run.stage)) return unavailable();
  try {
    const history = service.store.history(run.runId);
    const committed = history.findIndex(record => record.reviews?.at(-1)?.reviewId === review.reviewId);
    const basis = history[committed - 1];
    if (!basis || !same(history[committed].reviews.at(-1), review)
      || basis.candidate?.candidateId !== review.candidateId || basis.candidate.patchHash !== run.candidate.patchHash
      || !same(basis.requirementsRef, review.requirementsRef)) return unavailable();
    const manifest = only(basis.auditManifests, item => item.auditManifestId === review.auditManifestId
      && item.auditManifestHash === review.auditManifestHash && item.candidateId === review.candidateId, "audit manifest");
    if (!same(JSON.parse(read(service, manifest.contentRef)), createAuditManifest(basis))) return unavailable();
    const priorReviewId = basis.reviews?.at(-1)?.reviewId;
    const requestStart = priorReviewId && history.find(record => record.reviews?.at(-1)?.reviewId === priorReviewId);
    const previousIds = new Set((requestStart?.requests ?? []).map(item => item.requestId));
    const eligible = (basis.requests ?? []).filter(item => !previousIds.has(item.requestId)
      && item.status === "PROCESSED" && item.candidateId === review.candidateId && item.patchHash === basis.candidate.patchHash
      && item.auditManifestId === review.auditManifestId && item.auditManifestHash === review.auditManifestHash
      && same(item.requirementsRef, review.requirementsRef));
    const phase = eligible.some(item => item.phase === "ROUND1") ? "ROUND1" : "ROUND0";
    const roles = ["JUDGE", "CRITIC"];
    const reports = roles.map(role => {
      const request = eligible.findLast(item => item.role === role && item.phase === phase);
      if (!request || request.reportRef?.redacted !== true) fail("Role report unavailable.");
      const artifact = only(basis.reviewArtifacts, item => item.requestId === request.requestId && item.role === role
        && item.phase === phase && item.candidateId === request.candidateId && item.auditManifestHash === request.auditManifestHash,
      "role artifact");
      const receipt = only(basis.webDeliveryReceipts, item => item.deliveryId === request.requestId && item.role === role
        && item.state === "ACKNOWLEDGED", "acknowledged role receipt");
      if (request.reviewArtifactId !== artifact.reviewArtifactId || receipt.packetRef?.sha256 !== artifact.packetRef?.sha256
        || receipt.sessionId !== review.reviewerIndependence?.bindings
        ?.find(binding => binding.role === role)?.sessionId) fail("Role receipt differs from the review.");
      const report = JSON.parse(read(service, request.reportRef));
      const context = {...contextFor(basis, request.requestId), auditManifestHash:review.auditManifestHash};
      const checked = validateReviewResponse({packet:JSON.parse(read(service, artifact.packetRef))}, context, role, artifact.reviewArtifactId);
      if (!checked || !same(report, redactForEvidence(checked))) fail("Role report differs from the verified response.");
      return report;
    });
    const aggregate = aggregateReviewReports(reports, contextFor(basis, review.requestId));
    if (!same(redactForEvidence(aggregate), review.report)) return unavailable();
    return {status:"AVAILABLE", roles:roles.map((role, index) => ({role,
      assessments:reports[index].assessments.map(({requirementId, verdict, evidenceRefs}) => ({requirementId, verdict, evidenceRefs}))}))};
  } catch {
    return unavailable();
  }
}

// This is also the normal post-ACK write. All three collections commit together.
export function persistReviewResponse(service, runId, context, role, auditManifest, phase, response) {
  const run = service.get(runId), requestId = context.requestId;
  if (run.candidate.candidateId !== context.candidateId || run.candidate.patchHash !== run.capture.artifact.sha256) {
    fail("Review candidate changed after submission.");
  }
  const request = only(run.requests, item => item.requestId === requestId, "review request");
  const binding = only(run.conversationBindings, item => item.role === role, "reviewer binding");
  const receipt = only(run.webDeliveryReceipts, item => item.deliveryId === requestId, "review response receipt");
  if (receipt.privateResponseRef && !same(service.artifactStore.readPrivateResponse(receipt.privateResponseRef),
    privateResponseRecord(runId, role, requestId, binding.sessionId, response))) fail("Private response evidence differs.");
  const put = (value, mimeType) => service.artifactStore.put(value, { mimeType, redacted:true });
  const responseRef = put(redactControllerResponseText(response.rawText ?? `${response.body}\n${response.packetText}`), "text/plain");
  const content = publicResponseBody(response);
  const contentRef = put(content, "text/plain");
  const packetRef = put(canonicalJson(publicResponsePacket(response.packet)), "application/json");
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
    content:content.trim() || "(설명 없이 제어 패킷만 제출됨)" };
  // Older messages can contain unredacted presentation text; all identity fields stay exact.
  const storedMessage = messages[0] && {...messages[0],content:redactForEvidence(messages[0].content)};
  if (messages.length > 1 || (messages.length === 1
    && !same(Object.fromEntries(Object.keys(expectedMessage).map(key => [key, storedMessage[key]])), expectedMessage))) {
    fail("Stored review message differs from the original response.");
  }
  const nextRequest = { ...request, status:request.status === "PROCESSED" ? "PROCESSED" : "RECEIVED",
    responseRef, reviewArtifactId:artifact.reviewArtifactId };
  const messageChanged = messages.length === 1 && messages[0].content !== expectedMessage.content;
  if (!existing || !messages.length || messageChanged || !same(nextRequest, request)) service.update(runId, {
    reviewArtifacts:existing ? run.reviewArtifacts : [...(run.reviewArtifacts ?? []), artifact],
    requests:run.requests.map(item => item.requestId === requestId ? nextRequest : item),
    messages:messages.length ? messageChanged
      ? run.messages.map(item => item.messageId === requestId ? {...item,content:expectedMessage.content} : item)
      : run.messages : [...run.messages, { ...expectedMessage, createdAt:request.createdAt }],
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
  const publicText = read(service, receipt.responseRef), packet = JSON.parse(read(service, receipt.packetRef));
  const originalResponse = receipt.privateResponseRef
    ? service.artifactStore.readPrivateResponse(receipt.privateResponseRef) : null;
  if (originalResponse && (originalResponse.version !== 1 || originalResponse.runId !== run.runId
    || originalResponse.deliveryId !== receipt.deliveryId || originalResponse.role !== receipt.role
    || originalResponse.sessionId !== receipt.sessionId || typeof originalResponse.rawText !== "string")) {
    fail("Private response identity differs or exact wire bytes are unavailable.");
  }
  const rawText = originalResponse ? originalResponse.rawText : publicText;
  let parsed;
  try { parsed = parseFinalControllerPacketJsonEnvelope(rawText); }
  catch (error) {
    throw Object.assign(new Error("Stored controller response cannot be parsed; private evidence was retained."),
      {code:error.code ?? "REVIEW_RECOVERY_REFUSED"});
  }
  // Validate the untouched wire and the independently persisted adapter packet.
  if (originalResponse && (!same(parsed.parsed, originalResponse.packet)
    || parsed.body !== originalResponse.body || parsed.packetText !== originalResponse.packetText
    || !same(publicResponsePacket(originalResponse.packet), packet)
    || redactControllerResponseText(rawText) !== publicText)) fail("Response text and packet evidence differ.");
  if (!same(redactForEvidence(parsed.parsed), packet)) fail("Response text and packet evidence differ.");
  return { context, manifest, response:{ rawText, body:parsed.body, packetText:parsed.packetText,
    packet:originalResponse ? originalResponse.packet : packet } };
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

export function criticReviewContinuation(run) {
  const interruptedEnvelope = retryableInterruptedEnvelope(run);
  if ((!interruptedEnvelope && (run?.stage !== "HOLD"
    || !["WEB_BINDING_REQUIRED", "REPORT_REPAIR_LIMIT"].includes(run.terminationReason)))
    || run.conversationBindings?.length !== 2 || run.conversationBindings.some(binding => binding.activeDeliveryId)) return null;
  const critic = run.conversationBindings.find(binding => binding.role === "CRITIC");
  const auditManifestHash = run.coordination?.auditManifestHash;
  const candidateId = run.candidate?.candidateId;
  const requestId = interruptedEnvelope ? run.reviewRecovery.targetRequestId : run.reviewTurnId;
  const request = run.requests.find(item => item.requestId === requestId);
  const receipts = run.webDeliveryReceipts ?? [];
  if (!candidateId || !auditManifestHash || request?.role !== "CRITIC" || request.phase !== "ROUND0"
    || request.candidateId !== candidateId || request.auditManifestHash !== auditManifestHash
    || receipts.some(receipt => receipt.state !== "ACKNOWLEDGED")) return null;
  const judgeReceipts = receipts.filter(receipt => receipt.role === "JUDGE");
  const [receipt] = judgeReceipts;
  if (judgeReceipts.length !== 1
    || !run.requests.some(item => item.requestId === receipt.deliveryId && item.role === "JUDGE"
      && item.phase === "ROUND0" && item.status === "PROCESSED" && item.candidateId === candidateId
      && item.auditManifestHash === auditManifestHash)) return null;
  const unbound = run.terminationReason === "WEB_BINDING_REQUIRED" && run.coordination.activeRole === "CRITIC"
    && request.status === "INTENT" && receipts.length === 1 && critic?.bindingStatus === "NEEDS_REBIND"
    && critic.tabId == null && critic.conversationId == null;
  const malformed = (interruptedEnvelope || (run.terminationReason === "REPORT_REPAIR_LIMIT" && run.coordination.phase === "BLOCKED"
    && run.error === "Controller packet rejected (CONTROLLER_PACKET_MISSING)."
    && run.reviewRecovery?.alternateEnvelope !== true)) && critic?.bindingStatus === "BOUND"
    && receipts.some(item => item.deliveryId === request.requestId && item.role === "CRITIC")
    && receipts.filter(item => item.role === "CRITIC").every(item => item.validation === "REJECTED_FORMAT");
  if (!unbound && !malformed) return null;
  // Restoring the Judge below verifies the response, report, ACK lineage and manifest before any Critic send.
  return { status:"RESUMING", candidateId, auditManifestHash, targetRequestId:request.requestId,
    requestIds:[receipt.deliveryId], failures:[], ...(malformed ? { alternateEnvelope:true } : {}) };
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
    const retryRejectedFormat = recovery.alternateEnvelope === true && role === "CRITIC" && phase === "ROUND0";
    if (run.requests.some(item => item.role === role && item.phase === phase
      && item.candidateId === run.candidate.candidateId && item.auditManifestHash === manifest.auditManifestHash
      && (run.webDeliveryReceipts ?? []).some(receipt => receipt.deliveryId === item.requestId && receipt.state === "ACKNOWLEDGED"
        && !(retryRejectedFormat && receipt.validation === "REJECTED_FORMAT")))) {
      fail("An acknowledged review was omitted from the recovery set; retransmission is refused.");
    }
    return null;
  }
  const restored = restoreResponse(service, run, request, service.store.history(runId));
  const artifact = persistReviewResponse(service, runId, restored.context, role, manifest, phase, restored.response);
  const report = validateReviewResponse(restored.response, restored.context, role, artifact.reviewArtifactId);
  if (!report || !request.reportRef || !same(JSON.parse(read(service, request.reportRef)), redactForEvidence(report))) {
    fail("Recovered review report is missing or differs.");
  }
  return { artifact, report };
}
