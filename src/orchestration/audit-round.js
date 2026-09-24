import { randomUUID } from "node:crypto";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { evaluateCodeReview, validateAuditResponse } from "../domain/code-review.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { createAuditManifest } from "../domain/audit-manifest.js";
import { aggregateReviewReports, assertionsToReviewReport, createAgreedWorkOrder, createPlanBasis, freezePlan, reviewReportsDisagree,
  validatePlanProposal, validatePlanResponse, validateReviewAssertions } from "../domain/review-coordination.js";
import { evidenceRecord, excerpt, executeVerification } from "../evidence/candidate-evidence.js";
import { redactForEvidence } from "../security/redaction.js";
import { createWebSessionBinding } from "../runtime/web/binding.js";
import { buildCodeReviewPrompt, buildPlanProposalPrompt, buildPlanReviewPrompt } from "./code-change-prompts.js";

const REVIEW_ROLES = Object.freeze(["JUDGE", "CRITIC"]);
const MAX_PLAN_ROUNDS = 2;
const BINDING_WAIT_CODES = new Set(["NEEDS_REBIND","AMBIGUOUS","AUTH_REQUIRED","EXPLICIT_REBIND_REQUIRED","WEB_SESSION_BINDING_MISMATCH","WEB_DOCUMENT_CHANGED","ROOT_NOT_READY","EXTENSION_NOT_AUTHENTICATED","WEB_RESPONSE_TIMEOUT"]);

/**
 * @param {unknown} error
 * @returns {Error & {code?: string, role?: string, bindingCode?: string, missingInformation?: unknown[]}}
 */
function coordinationError(error) {
  return /** @type {Error & {code?: string, role?: string, bindingCode?: string, missingInformation?: unknown[]}} */ (
    error instanceof Error ? error : new Error(String(error))
  );
}

function roleSessionId(runId, role) {
  return role === "JUDGE" ? `web_${runId}` : `web_${runId}_${role.toLowerCase()}`;
}

function initialBinding(run, role, at) {
  const judge = role === "JUDGE";
  return {
    bindingId:`binding_${run.runId}_${role.toLowerCase()}`, runId:run.runId, actor:"CHATGPT_WEB_AGENT", role,
    required:true, provider:"CHATGPT_WEB", sessionId:roleSessionId(run.runId, role),
    conversationUrl:judge ? run.conversationUrl : null, conversationId:judge ? run.conversationId : null,
    tabId:null, windowId:null, documentId:null, frameId:null, activeDeliveryId:null,
    historyAnchor:{ lastObservedUserMessageId:null, lastObservedAssistantMessageId:null },
    bindingStatus:"NEEDS_REBIND", createdAt:at, updatedAt:at,
  };
}

function ensureBindings(run, at) {
  const bindings = [...(run.conversationBindings ?? [])];
  for (const role of REVIEW_ROLES) if (!bindings.some((item) => item.role === role)) bindings.push(initialBinding(run, role, at));
  const judge = bindings.find((item) => item.role === "JUDGE");
  const critic = bindings.find((item) => item.role === "CRITIC");
  if (!judge || !critic) throw new Error("Required reviewer bindings are unavailable.");
  if (judge.conversationId && critic.conversationId && judge.conversationId === critic.conversationId) {
    throw new Error("Judge and Critic must use different ChatGPT conversations.");
  }
  return bindings;
}

function bindingForRole(run, role) {
  const matches = (run.conversationBindings ?? []).filter((item) => item.role === role);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${role} conversation binding.`);
  return matches[0];
}

function webBinding(record) {
  return createWebSessionBinding({
    sessionId:record.sessionId, runId:record.runId, tabId:record.tabId, windowId:record.windowId,
    documentId:record.documentId, frameId:record.frameId, conversationUrl:record.conversationUrl,
    conversationId:record.conversationId, title:null,
    lastObservedUserMessageId:record.historyAnchor?.lastObservedUserMessageId ?? null,
    lastObservedAssistantMessageId:record.historyAnchor?.lastObservedAssistantMessageId ?? null,
    bindingStatus:record.bindingStatus,
  });
}

function recordFromReturned(current, returned, at, activeDeliveryId = null) {
  return { ...current, tabId:returned.tabId, windowId:returned.windowId, documentId:returned.documentId,
    frameId:returned.frameId, conversationUrl:returned.conversationUrl, conversationId:returned.conversationId,
    bindingStatus:returned.bindingStatus, activeDeliveryId,
    historyAnchor:{ lastObservedUserMessageId:returned.lastObservedUserMessageId,
      lastObservedAssistantMessageId:returned.lastObservedAssistantMessageId }, updatedAt:at };
}

function replaceBinding(bindings, next) {
  return bindings.map((item) => item.bindingId === next.bindingId ? next : item);
}

async function activateRole(service, runId, role) {
  let run = service.get(runId);
  const record = bindingForRole(run, role);
  let returned;
  try {
    returned = await service.wait(runId, service.web.resume({
      binding:webBinding(record),
      createNewConversation:role === "CRITIC" && record.conversationId === null,
    }));
  } catch (error) {
    const typedError = coordinationError(error);
    if (!typedError.code || !BINDING_WAIT_CODES.has(typedError.code)) throw error;
    const bindingStatus = ["AMBIGUOUS","AUTH_REQUIRED"].includes(typedError.code) ? typedError.code : "NEEDS_REBIND";
    const failed = { ...record, bindingStatus, activeDeliveryId:null, updatedAt:new Date().toISOString() };
    run = service.update(runId, { conversationBindings:replaceBinding(run.conversationBindings, failed) });
    throw Object.assign(new Error(`${role} conversation requires rebind before review can continue.`), {
      code:"WEB_BINDING_REQUIRED",
      role,
      bindingCode:typedError.code,
    });
  }
  const next = recordFromReturned(record, returned, new Date().toISOString(), null);
  run = service.update(runId, { conversationBindings:replaceBinding(run.conversationBindings, next) });
  return bindingForRole(run, role);
}

function parseControl(raw) {
  try {
    const parsed = parseFinalControllerPacketJsonEnvelope(raw);
    return { body:parsed.body, packetText:parsed.packetText, packet:parsed.parsed };
  } catch (error) {
    return { body:raw, packetText:raw, packet:{ type:"INVALID_RESPONSE", error:error.message } };
  }
}

function publishArtifact(run, artifactId) {
  return (run.reviewArtifacts ?? []).map((item) =>
    item.reviewArtifactId === artifactId ? { ...item, visibility:"SHARED" } : item);
}

function materializeSharedArtifacts(service, artifacts) {
  return artifacts.map((artifact) => {
    service.artifactStore.verify(artifact.contentRef.sha256);
    const content = service.artifactStore.read(artifact.contentRef.sha256).toString("utf8");
    let controlPacket = null, packetHash = null;
    if (artifact.packetRef?.sha256) {
      service.artifactStore.verify(artifact.packetRef.sha256);
      packetHash = artifact.packetRef.sha256;
      controlPacket = JSON.parse(service.artifactStore.read(artifact.packetRef.sha256).toString("utf8"));
    }
    return { reviewArtifactId:artifact.reviewArtifactId, role:artifact.role, kind:artifact.kind,
      contentHash:artifact.contentRef.sha256, packetHash, content, controlPacket };
  });
}

function workerPosition(service, run) {
  const evidence = [...(run.evidence ?? [])].reverse().find((item) =>
    item.candidateId === run.candidate?.candidateId && item.kind === "AGENT_CLAIM");
  if (!evidence) return null;
  service.artifactStore.verify(evidence.contentRef.sha256);
  return { evidenceId:evidence.evidenceId, kind:evidence.kind, contentHash:evidence.contentRef.sha256,
    content:service.artifactStore.read(evidence.contentRef.sha256).toString("utf8") };
}

async function submitRoleTurn(service, runId, role, requestId, prompt, parseResponse = parseControl) {
  let run = service.get(runId);
  let binding = await activateRole(service, runId, role);
  const active = { ...binding, activeDeliveryId:requestId, updatedAt:new Date().toISOString() };
  service.update(runId, { conversationBindings:replaceBinding(service.get(runId).conversationBindings, active) });
  let handle;
  try {
    handle = await service.web.submitTurn({ runId, turnId:requestId, controllerMessageId:requestId, text:prompt,
      timeoutMs:run.policy.turnTimeoutMs, parseResponse });
  } catch (error) {
    run = service.get(runId); binding = bindingForRole(run, role);
    if (binding.activeDeliveryId === requestId) {
      const reverted = { ...binding, activeDeliveryId:null, updatedAt:new Date().toISOString() };
      service.update(runId, { conversationBindings:replaceBinding(run.conversationBindings, reverted) });
    }
    throw error;
  }
  const response = await service.wait(runId, handle.completion);
  if (response.turnId !== requestId || response.binding?.runId !== runId) throw new Error(`${role} review turn identity changed.`);
  if (response.binding?.conversationId === null) throw new Error(`${role} did not establish an exact conversation.`);
  run = service.get(runId);
  const current = bindingForRole(run, role);
  const returned = recordFromReturned(current, response.binding, new Date().toISOString(), requestId);
  const bindings = replaceBinding(run.conversationBindings, returned);
  const judge = bindings.find((item) => item.role === "JUDGE"), critic = bindings.find((item) => item.role === "CRITIC");
  if (judge?.conversationId && critic?.conversationId && judge.conversationId === critic.conversationId) {
    throw new Error("Judge and Critic resolved to the same ChatGPT conversation.");
  }
  service.update(runId, { conversationBindings:bindings });
  const acknowledgement = await service.wait(runId, service.web.acknowledgeDelivery({ turnId:requestId }));
  if (acknowledgement?.currentDeliveryId !== null
    || acknowledgement?.sessionId !== returned.sessionId
    || acknowledgement?.runId !== runId
    || acknowledgement?.conversationUrl !== returned.conversationUrl) {
    throw Object.assign(new Error("Delivery acknowledgement did not confirm the exact reviewer binding."), {
      code:"ACK_UNCONFIRMED",
    });
  }
  run = service.get(runId); binding = bindingForRole(run, role);
  const settled = { ...binding, activeDeliveryId:null, updatedAt:new Date().toISOString(),
    historyAnchor:{ lastObservedUserMessageId:response.binding.lastObservedUserMessageId,
      lastObservedAssistantMessageId:response.binding.lastObservedAssistantMessageId } };
  service.update(runId, { conversationBindings:replaceBinding(run.conversationBindings, settled) });
  return response;
}

async function reviewRole(service, runId, workspace, role, auditManifest, phase, sharedArtifacts = []) {
  let repairs = 0, feedback = null;
  while (true) {
    service.assertActive(runId);
    let run = service.get(runId);
    const requestId = `audit_${role.toLowerCase()}_${randomUUID()}`;
    const context = { ...auditContext(run, requestId), auditManifestHash:auditManifest.auditManifestHash };
    const candidateDiffHash = run.capture?.artifact?.sha256 ?? null;
    if (!candidateDiffHash || candidateDiffHash !== run.candidate?.patchHash) throw new Error("Candidate diff artifact does not match candidate patch hash.");
    service.artifactStore.verify(candidateDiffHash);
    const candidateDiff = service.artifactStore.read(candidateDiffHash).toString("utf8");
    const evidence = run.evidence.filter((item) => item.candidateId === context.candidateId).map((item) => {
      try { return { ...item, excerpt:excerpt(service.artifactStore.read(item.contentRef.sha256).toString("utf8"), 1, 80) }; }
      catch (error) { return { ...item, unavailable:error.message }; }
    });
    const data = { role, phase, context, auditManifest, objective:run.objective, candidate:run.candidate,
      candidateDiff, candidateDiffHash, evidence, sharedArtifacts,
      registeredVerifications:run.verifications.map(({ verificationId,purpose }) => ({ verificationId,purpose })), feedback };
    const prompt = buildCodeReviewPrompt(redactForEvidence(data));
    const promptRef = service.artifactStore.put(prompt, { mimeType:"text/plain", redacted:true });
    run = service.update(runId, { stage:repairs ? "REPORT_REPAIR" : "REVIEW_RUNNING", reviewTurnId:requestId,
      coordination:{ phase, activeRole:role, auditManifestHash:auditManifest.auditManifestHash },
      requests:[...run.requests, { requestId, role, phase, candidateId:context.candidateId,
        auditManifestId:auditManifest.auditManifestId, auditManifestHash:auditManifest.auditManifestHash,
        requirementsRef:context.requirementsRef, patchHash:candidateDiffHash, status:"INTENT", promptRef,
        createdAt:new Date().toISOString() }] });
    const response = await submitRoleTurn(service, runId, role, requestId, prompt);
    service.assertActive(runId);
    run = service.get(runId);
    if (run.candidate.candidateId !== context.candidateId || run.candidate.patchHash !== candidateDiffHash) throw new Error("Review candidate changed after submission.");
    const responseRef = service.artifactStore.put(redactForEvidence(response.rawText ?? `${response.body}\n${response.packetText}`), { mimeType:"text/plain", redacted:true });
    const reasoningRef = service.artifactStore.put(redactForEvidence(response.body ?? ""), { mimeType:"text/plain", redacted:true });
    const packetRef = service.artifactStore.put(canonicalJson(redactForEvidence(response.packet)), { mimeType:"application/json", redacted:true });
    const artifact = { reviewArtifactId:`review_artifact_${randomUUID()}`, requestId, candidateId:context.candidateId,
      auditManifestId:auditManifest.auditManifestId, auditManifestHash:auditManifest.auditManifestHash,
      bindingId:bindingForRole(run, role).bindingId, role, phase, kind:phase === "ROUND0" ? "INITIAL_REVIEW" : "CROSS_REVIEW",
      visibility:"PRIVATE", contentRef:reasoningRef, packetRef, responseRef, createdAt:new Date().toISOString() };
    service.update(runId, { reviewArtifacts:[...(run.reviewArtifacts ?? []), artifact],
      requests:run.requests.map((item) => item.requestId === requestId ? { ...item, status:"RECEIVED",
        responseRef, reviewArtifactId:artifact.reviewArtifactId } : item),
      messages:[...run.messages, { messageId:requestId, fromActor:"CHATGPT_WEB_AGENT", role,
        content:(response.body ?? "").trim() || "(설명 없이 제어 패킷만 제출됨)", createdAt:new Date().toISOString() }] });
    let report;
    try {
      if (response.packet.type === "INVALID_RESPONSE") {
        throw new Error(response.packet.error);
      }
      if (response.packet.type === "EVIDENCE_REQUEST") {
        validateAuditResponse(response.packet, auditContext(run, requestId));
      } else {
        validateReviewAssertions(response.packet, context);
        report = assertionsToReviewReport(response.packet, context, role, artifact.reviewArtifactId);
        validateAuditResponse(report, auditContext(run, requestId));
      }
    } catch (error) {
      feedback = { kind:"REPORT_REPAIR", error:error.message,
        instruction:"Keep the same candidate and auditManifestHash. Return corrected reasoning and final control packet.",
        candidateId:context.candidateId, auditManifestHash:auditManifest.auditManifestHash, candidateDiffHash,
        previousResponse:response.rawText || response.packetText || response.body || JSON.stringify(response.packet) };
      if (repairs++ >= run.policy.maxFormatRepairs) throw Object.assign(new Error(error.message), { code:"REPORT_REPAIR_LIMIT" });
      continue;
    }
    if (report) {
      run = service.get(runId);
      service.update(runId, { requests:run.requests.map((item) => item.requestId === requestId ? { ...item, status:"PROCESSED" } : item) });
      return { report, artifact };
    }
    run = service.get(runId);
    const nextEvidenceRound = (run.evidenceRounds ?? 0) + 1;
    if (nextEvidenceRound > run.policy.maxEvidenceRounds) {
      throw Object.assign(new Error("Evidence supplement limit reached."), { code:"EVIDENCE_LIMIT", missingInformation:response.packet.requests });
    }
    service.update(runId, { stage:"EVIDENCE_SUPPLEMENT", evidenceRounds:nextEvidenceRound });
    feedback = { kind:"EVIDENCE_RESULTS", results:await supplement(service, runId, workspace, response.packet) };
    service.update(runId, { supplementResults:[...service.get(runId).supplementResults, { requestId, role, ...feedback }] });
    if (feedback.results.some((item) => item.status === "NEEDS_USER_DECISION")) throw Object.assign(new Error("Reviewer requires a user decision."), { code:"USER_DECISION_REQUIRED", missingInformation:feedback.results });
    const refreshedManifest = createAuditManifest(service.get(runId));
    if (refreshedManifest.auditManifestHash !== auditManifest.auditManifestHash) {
      throw Object.assign(new Error("Evidence changed; restart independent Round 0 on a new AuditManifest."), { code:"AUDIT_MANIFEST_INVALIDATED" });
    }
  }
}

async function planPacket(service, runId, role, prefix, promptFactory, validate) {
  let feedback = null;
  const maxRepairs = service.get(runId).policy.maxFormatRepairs;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const turnId = `${prefix}_${randomUUID()}`;
    const prompt = promptFactory(feedback);
    const response = await submitRoleTurn(service, runId, role, turnId, prompt);
    const reasoningRef = service.artifactStore.put(redactForEvidence(response.body ?? ""), { mimeType:"text/plain", redacted:true });
    const packetRef = service.artifactStore.put(canonicalJson(redactForEvidence(response.packet)), { mimeType:"application/json", redacted:true });
    const controlEvent = { controlEventId:`coord_${randomUUID()}`, type:response.packet?.type ?? "INVALID_RESPONSE",
      role, bindingId:bindingForRole(service.get(runId), role).bindingId,
      turnId, packetRef, reasoningRef, createdAt:new Date().toISOString() };
    const run = service.get(runId);
    service.update(runId, { coordinationEvents:[...(run.coordinationEvents ?? []), controlEvent] });
    try {
      validate(response.packet);
      return { response, reasoningRef, packetRef, controlEvent };
    } catch (error) {
      feedback = { kind:"PLAN_REPAIR", error:error.message, previousPacket:response.packet,
        instruction:"Preserve every supplied identity field and return only a schema-corrected final packet." };
      if (attempt >= maxRepairs) {
        throw Object.assign(new Error(error.message), { code:"PLAN_REPAIR_LIMIT" });
      }
    }
  }
  throw Object.assign(new Error("Plan packet repair limit reached."), { code:"PLAN_REPAIR_LIMIT" });
}

async function planRework(service, runId, auditManifest, artifacts, findings) {
  let previousCritique = null;
  for (let round = 1; round <= MAX_PLAN_ROUNDS; round++) {
    let run = service.get(runId);
    const planId = `plan_${randomUUID()}`;
    const publishedArtifacts = materializeSharedArtifacts(service, artifacts);
    const basisArtifacts = previousCritique
      ? [...publishedArtifacts, { reviewArtifactId:previousCritique.reviewArtifactId, role:"CRITIC",
          kind:"PLAN_CRITIQUE", contentHash:previousCritique.contentHash, packetHash:previousCritique.packetHash,
          content:previousCritique.content, controlPacket:previousCritique.controlPacket }]
      : publishedArtifacts;
    const position = workerPosition(service, run);
    const planBasis = createPlanBasis({ auditManifestHash:auditManifest.auditManifestHash,
      candidateId:run.candidate.candidateId, findings, publishedArtifacts:basisArtifacts, workerPosition:position });
    const expected = { runId, candidateId:run.candidate.candidateId, auditManifestHash:auditManifest.auditManifestHash,
      planBasisHash:planBasis.planBasisHash, planId };
    const proposal = await planPacket(service, runId, "JUDGE", "plan_judge",
      (feedback) => buildPlanProposalPrompt(redactForEvidence({ ...expected, round, findings, planBasis,
        publishedArtifacts:basisArtifacts, workerPosition:position, previousCritique, feedback })),
      (packet) => validatePlanProposal(packet, expected));
    const frozen = freezePlan(proposal.response.packet);
    const proposalArtifact = { planArtifactId:`plan_artifact_${randomUUID()}`, planId, planHash:frozen.planHash,
      planBasisHash:planBasis.planBasisHash, candidateId:run.candidate.candidateId,
      auditManifestHash:auditManifest.auditManifestHash, authorRole:"JUDGE", visibility:"SHARED",
      contentRef:proposal.reasoningRef, packetRef:proposal.packetRef, plan:frozen, createdAt:new Date().toISOString() };
    run = service.update(runId, { plans:[...(service.get(runId).plans ?? []), proposalArtifact],
      coordination:{ phase:"PLAN_REVIEW", activeRole:"CRITIC", activePlanId:planId,
        auditManifestHash:auditManifest.auditManifestHash, planBasisHash:planBasis.planBasisHash } });
    const responseExpected = { runId, candidateId:run.candidate.candidateId, planId,
      planHash:frozen.planHash, planBasisHash:planBasis.planBasisHash };
    const critique = await planPacket(service, runId, "CRITIC", "plan_critic",
      (feedback) => buildPlanReviewPrompt(redactForEvidence({ ...responseExpected, plan:frozen, planBasis,
        findings, publishedArtifacts:basisArtifacts, feedback })),
      (packet) => validatePlanResponse(packet, responseExpected));
    const critiqueArtifact = { reviewArtifactId:`review_artifact_${randomUUID()}`, requestId:critique.controlEvent.turnId,
      candidateId:run.candidate.candidateId, auditManifestId:auditManifest.auditManifestId,
      auditManifestHash:auditManifest.auditManifestHash, bindingId:bindingForRole(service.get(runId),"CRITIC").bindingId,
      role:"CRITIC", phase:"PLAN_REVIEW", kind:"PLAN_CRITIQUE", visibility:"SHARED",
      contentRef:critique.reasoningRef, packetRef:critique.packetRef, responseRef:critique.packetRef, createdAt:new Date().toISOString() };
    run = service.update(runId, { reviewArtifacts:[...(service.get(runId).reviewArtifacts ?? []), critiqueArtifact] });
    previousCritique = { reviewArtifactId:critiqueArtifact.reviewArtifactId, contentHash:critiqueArtifact.contentRef.sha256,
      packetHash:critique.packetRef.sha256, controlPacket:critique.response.packet,
      content:service.artifactStore.read(critiqueArtifact.contentRef.sha256).toString("utf8") };
    if (critique.response.packet.decision === "ACCEPT") {
      const workOrder = createAgreedWorkOrder({ runId, baseCandidateId:run.candidate.candidateId,
        auditManifestHash:auditManifest.auditManifestHash, planBasisHash:planBasis.planBasisHash, plan:frozen,
        acceptedByBindingId:bindingForRole(run,"CRITIC").bindingId,
        acceptedControlEventId:critique.controlEvent.controlEventId });
      return service.update(runId, { agreedWorkOrders:[...(run.agreedWorkOrders ?? []), workOrder],
        coordination:{ phase:"READY_TO_EXECUTE", activeRole:null, activePlanId:planId,
          agreedWorkOrderId:workOrder.workOrderId, auditManifestHash:auditManifest.auditManifestHash,
          planBasisHash:planBasis.planBasisHash } }).agreedWorkOrders.at(-1);
    }
  }
  throw Object.assign(new Error("Critic did not explicitly accept a frozen rework plan."), { code:"PLAN_CONSENSUS_NOT_REACHED" });
}


export function auditContext(run, requestId) {
  return { runId: run.runId, requestId, candidateId: run.candidate.candidateId, requirementsRef: run.requirementsRef,
    requirements: run.requirements, evidence: run.evidence, findings: run.findings };
}

export async function performVerification(service, runId, workspace, verification) {
  service.assertActive(runId);
  let run = service.get(runId);
  const intent = { requestId: `verification_${randomUUID()}`, verificationId: verification.verificationId, candidateId: run.candidate.candidateId, status: "INTENT", at: new Date().toISOString() };
  service.update(runId, { verificationIntents: [...run.verificationIntents, intent] });
  const result = await executeVerification({ workspace, capture: run.capture, candidateId: run.candidate.candidateId,
    verification, artifactStore: service.artifactStore, signal: service.controls.get(runId)?.signal });
  run = service.get(runId);
  service.update(runId, { evidence: [...run.evidence, result.evidence, ...result.artifacts],
    verificationIntents: run.verificationIntents.map((i) => i.requestId === intent.requestId ? { ...i, status: "COMPLETED", evidenceId: result.evidence.evidenceId } : i),
    events: [...run.events, { eventId: `event_${randomUUID()}`, type: "VERIFICATION_FINISHED", createdAt: result.record.finishedAt,
      payload: { verificationId: verification.verificationId, evidenceId: result.evidence.evidenceId, result: result.evidence.result } }] });
  service.assertActive(runId);
  if (!result.record.candidateUnchanged) throw new Error("Verification changed the candidate or could not establish candidate identity; recovery required.");
  return result;
}

async function supplement(service, runId, workspace, packet) {
  const results = [];
  for (const request of packet.requests) {
    service.assertActive(runId);
    const run = service.get(runId);
    try {
      let content;
      if (request.kind === "CODE") {
        content = workspace.readCode(run.capture, request.path);
        const evidence = evidenceRecord(service.artifactStore, run.candidate.candidateId, "CODE_SNAPSHOT", content, { path: request.path });
        service.update(runId, { evidence: [...run.evidence, evidence] });
        results.push({ requestItemId: request.requestItemId, evidenceId: evidence.evidenceId,
          ...excerpt(redactForEvidence(content), request.startLine, request.endLine) });
      } else if (request.kind === "EVIDENCE") {
        const evidence = run.evidence.find((e) => e.evidenceId === request.evidenceId && e.candidateId === run.candidate.candidateId);
        if (!evidence) throw new Error("Evidence does not belong to this candidate.");
        content = service.artifactStore.read(evidence.contentRef.sha256).toString("utf8");
        results.push({ requestItemId: request.requestItemId, evidenceId: evidence.evidenceId, ...excerpt(content, request.startLine, request.endLine) });
      } else if (request.kind === "VERIFY") {
        const verification = run.verifications.find((v) => v.verificationId === request.verificationId);
        if (!verification) throw new Error("Verification ID is not registered; request was not executed.");
        const result = await performVerification(service, runId, workspace, verification);
        results.push({ requestItemId: request.requestItemId, evidenceId: result.evidence.evidenceId, result: result.evidence.result,
          ...excerpt(service.artifactStore.read(result.evidence.contentRef.sha256).toString("utf8")) });
      } else {
        results.push({ requestItemId: request.requestItemId, status: "NEEDS_USER_DECISION", reason: request.question ?? request.purpose });
      }
    } catch (error) {
      service.assertActive(runId);
      results.push({ requestItemId: request.requestItemId, status: "UNAVAILABLE", reason: error.message });
      if (/candidate.*changed|changed.*candidate/iu.test(error.message)) throw error;
    }
  }
  return results;
}

export async function auditCandidate(service, runId, workspace) {
  service.assertActive(runId);
  let run = service.get(runId);
  const now = new Date().toISOString();
  const bindings = ensureBindings(run, now);
  if (canonicalJson(bindings) !== canonicalJson(run.conversationBindings ?? [])) run = service.update(runId, { conversationBindings:bindings });
  let auditManifest = createAuditManifest(run);
  const manifestRef = service.artifactStore.put(canonicalJson(auditManifest), { mimeType:"application/json", redacted:true });
  const manifestRecord = { auditManifestId:auditManifest.auditManifestId, auditManifestHash:auditManifest.auditManifestHash,
    candidateId:run.candidate.candidateId, contentRef:manifestRef, createdAt:now };
  if (!(run.auditManifests ?? []).some((item) => item.auditManifestHash === auditManifest.auditManifestHash)) {
    run = service.update(runId, { auditManifests:[...(run.auditManifests ?? []), manifestRecord] });
  }
  try {
    const round0 = [];
    for (const role of REVIEW_ROLES) round0.push(await reviewRole(service, runId, workspace, role, auditManifest, "ROUND0", []));
    run = service.get(runId);
    let reports = round0.map((item) => item.report);
    let artifacts = round0.map((item) => item.artifact);
    const aggregateContext = auditContext(run, `aggregate_${randomUUID()}`);
    let aggregate = aggregateReviewReports(reports.map((report) => ({ ...report, requestId:aggregateContext.requestId })), aggregateContext);
    if (reviewReportsDisagree(reports) || aggregate.assessments.some((item) => item.verdict !== "SATISFIED")) {
      for (const artifact of artifacts) run = service.update(runId, { reviewArtifacts:publishArtifact(service.get(runId), artifact.reviewArtifactId) });
      const sharedArtifacts = materializeSharedArtifacts(service, artifacts);
      const cross = [];
      for (const role of REVIEW_ROLES) cross.push(await reviewRole(service, runId, workspace, role, auditManifest, "ROUND1", sharedArtifacts));
      reports = cross.map((item) => item.report);
      artifacts = cross.map((item) => item.artifact);
      run = service.get(runId);
      const crossContext = auditContext(run, `aggregate_${randomUUID()}`);
      aggregate = aggregateReviewReports(reports.map((report) => ({ ...report, requestId:crossContext.requestId })), crossContext);
    }
    run = service.get(runId);
    const context = auditContext(run, aggregate.requestId);
    validateAuditResponse(aggregate, context);
    const result = evaluateCodeReview(aggregate, context);
    if (result.decision === "REWORK" && run.iteration < run.policy.maxIterations) {
      for (const artifact of artifacts) run = service.update(runId, { reviewArtifacts:publishArtifact(service.get(runId), artifact.reviewArtifactId) });
      const shared = (service.get(runId).reviewArtifacts ?? []).filter((item) =>
        item.candidateId === run.candidate.candidateId && item.visibility === "SHARED").map((item) => ({
          reviewArtifactId:item.reviewArtifactId, role:item.role, kind:item.kind, contentRef:item.contentRef, packetRef:item.packetRef,
        }));
      await planRework(service, runId, auditManifest, shared, result.findings.filter((item) => ["OPEN","FIX_SUBMITTED"].includes(item.status)));
    }
    run = service.get(runId);
    service.update(runId, { findings:result.findings, auditResult:result.decision,
      reviews:[...run.reviews, { ...result, candidateId:context.candidateId, requirementsRef:context.requirementsRef,
        requestId:context.requestId, auditManifestId:auditManifest.auditManifestId,
        auditManifestHash:auditManifest.auditManifestHash, reviewerRoles:[...REVIEW_ROLES] }],
      captures:[...run.captures, { capture:run.capture, review:result.report, reviewId:result.reviewId, decision:result.decision }],
      coordination:{ phase:result.decision === "PASS" ? "ACCEPTED" : result.decision === "REWORK" ? "READY_TO_EXECUTE" : "BLOCKED",
        activeRole:null, auditManifestHash:auditManifest.auditManifestHash,
        agreedWorkOrderId:service.get(runId).agreedWorkOrders?.at(-1)?.workOrderId ?? null },
      stage:result.decision === "PASS" ? "AWAITING_APPLY" : result.decision === "HOLD" ? "HOLD"
        : run.iteration >= run.policy.maxIterations ? "INCONCLUSIVE" : "REWORK",
      terminationReason:result.decision === "REWORK" && run.iteration >= run.policy.maxIterations ? "ITERATION_LIMIT" : null });
  } catch (error) {
    const typedError = coordinationError(error);
    if (typedError.code === "AUDIT_MANIFEST_INVALIDATED") {
      service.update(runId, { coordination:{ phase:"ROUND0_RESTART", activeRole:null, auditManifestHash:null } });
      return auditCandidate(service, runId, workspace);
    }
    if (typedError.code === "WEB_BINDING_REQUIRED") {
      service.update(runId, { stage:"HOLD", auditResult:"HOLD", terminationReason:"WEB_BINDING_REQUIRED", error:typedError.message,
        coordination:{ phase:"WAITING_FOR_ROLE_BINDING", activeRole:typedError.role ?? null,
          bindingCode:typedError.bindingCode ?? null, auditManifestHash:auditManifest.auditManifestHash } });
      return;
    }
    const reason = typedError.code
      && ["REPORT_REPAIR_LIMIT","EVIDENCE_LIMIT","USER_DECISION_REQUIRED","PLAN_REPAIR_LIMIT","PLAN_CONSENSUS_NOT_REACHED"].includes(typedError.code)
      ? typedError.code : null;
    if (reason) {
      service.update(runId, { stage:"HOLD", auditResult:"HOLD", terminationReason:reason, error:typedError.message,
        missingInformation:typedError.missingInformation ?? [],
        coordination:{ phase:"BLOCKED", activeRole:null, auditManifestHash:auditManifest.auditManifestHash } });
      return;
    }
    throw error;
  }
}
