export function retryableWorkerTimeout(run) {
  const lastTurn = run?.workerTurns?.at(-1);
  const timeoutError = "External turn timed out; execution state requires recovery.";
  return run?.schemaVersion === 3
    && run.stage === "RECOVERY_REQUIRED"
    && run.terminationReason === "EXECUTION_UNCERTAIN"
    && lastTurn?.status === "failed"
    && lastTurn?.metadata?.error === timeoutError
    && run.candidate == null && run.capture == null && run.application == null
    && (run.candidates?.length ?? 0) === 0
    && (run.reviews?.length ?? 0) === 0;
}

export function hasReviewerIndependenceAuthority(review) {
  const contract = review?.reviewerIndependence;
  if (contract?.contractVersion !== 1
    || contract.roleSeparation !== "VERIFIED"
    || contract.sessionSeparation !== "VERIFIED"
    || contract.conversationSeparation !== "VERIFIED"
    || !["VERIFIED","NOT_ENFORCED"].includes(contract.providerSeparation)
    || contract.modelIdentity !== "UNOBSERVED"
    || contract.accountIsolation !== "UNVERIFIED"
    || contract.round0PeerArtifacts !== "NONE"
    || contract.crossReviewPeerArtifacts !== "PUBLISHED_ONLY"
    || !Array.isArray(contract.bindings) || contract.bindings.length !== 2) return false;
  const judge = contract.bindings.find((item) => item.role === "JUDGE");
  const critic = contract.bindings.find((item) => item.role === "CRITIC");
  return Boolean(judge && critic
    && typeof judge.bindingId === "string" && judge.bindingId
    && typeof critic.bindingId === "string" && critic.bindingId
    && judge.bindingId !== critic.bindingId
    && typeof judge.sessionId === "string" && judge.sessionId
    && typeof critic.sessionId === "string" && critic.sessionId
    && judge.sessionId !== critic.sessionId
    && typeof judge.conversationId === "string" && judge.conversationId
    && typeof critic.conversationId === "string" && critic.conversationId
    && ((judge.provider ?? null) !== (critic.provider ?? null)
      || judge.conversationId !== critic.conversationId));
}

export function hasMultiReviewAuthority(run) {
  const review = run?.reviews?.at(-1);
  return Boolean(review?.decision === "PASS"
    && review.auditManifestHash
    && Array.isArray(review.reviewerRoles)
    && review.reviewerRoles.length === 2
    && review.reviewerRoles.includes("JUDGE")
    && review.reviewerRoles.includes("CRITIC")
    && hasReviewerIndependenceAuthority(review)
    && (run.auditManifests ?? []).some((item) => item.auditManifestHash === review.auditManifestHash
      && item.candidateId === run.candidate?.candidateId));
}

export function retryableAuditReview(run) {
  const retryableHold = run?.stage === "HOLD"
    && ["REPORT_REPAIR_LIMIT","WEB_BINDING_REQUIRED","PLAN_REPAIR_LIMIT","PLAN_CONSENSUS_NOT_REACHED","USER_DECISION_REQUIRED"].includes(run.terminationReason)
    && run.auditResult === "HOLD";
  const reviewerTabSelectionPending = run?.terminationReason === "WEB_BINDING_REQUIRED"
    && (run?.coordination?.bindingCandidates?.length ?? 0) > 0;
  if (reviewerTabSelectionPending) return false;
  const legacyUpgrade = run?.stage === "AWAITING_APPLY" && !hasMultiReviewAuthority(run);
  return Boolean(run?.schemaVersion === 3 && (retryableHold || legacyUpgrade)
    && run.application == null
    && run.stopRequested !== true
    && run.candidate?.candidateId
    && run.capture?.artifact?.sha256
    && run.candidate.patchHash === run.capture.artifact.sha256
    && run.candidate.candidateTree === run.capture.candidateTree
    && run.candidate.baseCommit === run.baseCommit
    && run.capture.baseCommit === run.baseCommit);
}

function latestWorkerRuntimeEvent(run) {
  const events = run?.events ?? [];
  const workerStage = [...events].reverse().find((event) =>
    event.type === "STAGE_CHANGED" && event.payload?.stage === "WORKER_RUNNING");
  const stageAt = workerStage?.createdAt ?? null;
  return [...events].reverse().find((event) =>
    event.type === "WORKER_RUNTIME_EVENT"
      && (!stageAt || String(event.createdAt) >= String(stageAt))) ?? null;
}

export function projectWorkerRuntime(run, preflight, inspection = null) {
  const configured = preflight?.checks?.codeWorkerExecutableConfigured === true;
  const latest = latestWorkerRuntimeEvent(run);
  const runtimeType = latest?.payload?.runtimeType ?? null;
  const phase = run?.stage ?? null;
  let processState = configured ? "IDLE" : "UNCONFIGURED";
  let sessionState = run?.workerThread ? "READY" : "NOT_STARTED";
  let turnState = run?.workerTurnId ? "ACTIVE" : "NOT_STARTED";
  let activity = null;

  if (phase === "WORKER_RUNNING") {
    processState = run?.workerThread ? "RUNNING" : "STARTING";
    if (runtimeType === "SESSION_READY") sessionState = "READY";
    if (runtimeType === "TURN_STARTED") turnState = "ACTIVE";
    if (runtimeType === "TOOL_STARTED") activity = "TOOL_RUNNING";
    if (runtimeType === "TOOL_COMPLETED") activity = "TOOL_COMPLETED";
    if (runtimeType === "APPROVAL_REQUESTED") activity = "APPROVAL_WAIT";
    if (runtimeType === "TURN_FAILED") turnState = "FAILED";
    if (runtimeType === "TURN_INTERRUPTED") turnState = "INTERRUPTED";
    if (runtimeType === "SESSION_DISCONNECTED") processState = "DISCONNECTED";
  } else if (phase === "CANDIDATE_CAPTURE") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "CANDIDATE_CAPTURE";
  } else if (phase === "VERIFYING") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "VERIFYING";
  } else if (["REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT"].includes(phase)) {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "WEB_AUDIT";
  } else if (phase === "AWAITING_APPLY") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "AWAITING_APPLY";
  } else if (phase === "APPLIED") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "APPLIED";
  } else if (phase === "RECOVERY_REQUIRED") {
    processState = "RECOVERY_REQUIRED"; activity = "RECOVERY_REQUIRED";
  }

  return Object.freeze({
    configured,
    provider: run?.worker?.provider ?? null,
    model: run?.worker?.model ?? null,
    processState,
    sessionState,
    turnState,
    activity,
    toolType: latest?.payload?.toolType ?? null,
    runtimeType,
    diff: inspection?.diff ?? null,
    inspectionError: inspection?.error ?? null,
    threadId: latest?.payload?.threadId ?? run?.workerThread?.threadId ?? run?.workerThread ?? null,
    turnId: latest?.payload?.turnId ?? run?.workerTurnId ?? null,
    lastActivityAt: inspection?.inspectedAt ?? latest?.createdAt ?? run?.updatedAt ?? null,
  });
}
