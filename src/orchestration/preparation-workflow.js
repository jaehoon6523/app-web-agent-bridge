const RESULT_STATES = new Set(["AWAITING_APPLY", "APPLIED", "COMPLETE", "CANCELLED", "INCONCLUSIVE", "FAILED"]);
export function workflowForRun(run) {
  const phase = run.phase ?? run.stage;
  const result = phase;
  const state = RESULT_STATES.has(result) ? result : ({
    CREATED: "RUN_CREATED", CANDIDATE_CAPTURE: "VERIFYING", REPORT_REPAIR: "REVIEW_RUNNING",
    EVIDENCE_SUPPLEMENT: "REVIEW_RUNNING",
  }[phase] ?? (["RUN_CREATED", "PROVISIONING", "WORKER_RUNNING", "VERIFYING", "REVIEW_RUNNING", "REWORK", "APPLYING", "STOPPING", "HOLD", "RECOVERY_REQUIRED"].includes(phase) ? phase : "RECOVERY_REQUIRED"));
  return { stage: RESULT_STATES.has(state) ? "RESULT" : "WORK", state, runId: run.runId, runVersion: run.version };
}

/** Applies only runtime/run-view constraints to already-derived preparation capabilities. */
export function filterPreparationCapabilitiesForRuntimeContext({
  capabilities,
  runtimeAvailable,
  showingRun,
  canStart,
  canApprove = true,
}) {
  if (!Array.isArray(capabilities)) throw new TypeError("capabilities must be an array.");
  return capabilities.filter((capability) => {
    if (capability === "preparation.start") return !showingRun && canStart && runtimeAvailable;
    if (capability === "preparation.approve") return !showingRun && canApprove && runtimeAvailable;
    return !showingRun;
  });
}
