function capabilitySet(commandCapabilities) {
  return new Set(Array.isArray(commandCapabilities) ? commandCapabilities : []);
}

export function reviewerProviderMatches(bindingProvider, runtimeProvider) {
  return typeof bindingProvider === "string" && bindingProvider.length > 0
    && typeof runtimeProvider === "string" && runtimeProvider.length > 0
    && bindingProvider === runtimeProvider;
}

function reviewerAvailable(reviewerRuntimes, role) {
  return ["JUDGE", "CRITIC"].includes(role)
    && reviewerRuntimes?.[role]?.availability === "AVAILABLE";
}

export function projectRunCommandActions({
  stateAvailable,
  runPresent,
  commandCapabilities = [],
  workerTurnAvailable = false,
  archived = false,
} = {}) {
  const caps = capabilitySet(commandCapabilities);
  const ready = stateAvailable === true && runPresent === true;
  return Object.freeze({
    stopRun:ready && caps.has("run.stop"),
    applyCode:ready && caps.has("code.apply"),
    exportEvidence:ready && caps.has("evidence.export"),
    openEvidence:ready && caps.has("evidence.get"),
    deleteRun:ready && caps.has("run.delete"),
    archiveRun:ready && caps.has(archived ? "run.unarchive" : "run.archive"),
    operatorNote:ready && caps.has("run.note.add"),
    reconcileRun:ready && caps.has("run.reconcile"),
    abandonRun:ready && caps.has("run.abandon"),
    retryWorker:ready && caps.has("run.retry"),
    interveneWorker:ready && workerTurnAvailable === true && caps.has("code.worker.intervene"),
  });
}

export function projectReviewerActions({
  stateAvailable,
  runPresent,
  extensionAuthenticated,
  commandCapabilities = [],
  reviewerRuntimes = null,
  role = null,
  exactBindingAvailable = false,
  exactDiscardDeliveryAvailable = false,
} = {}) {
  const caps = capabilitySet(commandCapabilities);
  const ready = stateAvailable === true && runPresent === true && extensionAuthenticated === true;
  const selectedAvailable = role ? reviewerAvailable(reviewerRuntimes, role) : false;
  const allAvailable = reviewerAvailable(reviewerRuntimes, "JUDGE")
    && reviewerAvailable(reviewerRuntimes, "CRITIC");
  return Object.freeze({
    discuss:ready && selectedAvailable && exactBindingAvailable === true && caps.has("code.review.discuss"),
    discardDiscussion:ready && selectedAvailable && exactDiscardDeliveryAvailable === true
      && caps.has("code.review.discuss.discard"),
    rebind:ready && selectedAvailable && caps.has("code.review.rebind"),
    retryReview:ready && allAvailable && caps.has("code.review.retry"),
    decisionReply:ready && allAvailable && caps.has("code.decision.reply"),
  });
}

export function projectPreparationActions({
  serverReachable,
  dashboardAuthenticated,
  stateAvailable,
  extensionAuthenticated,
  commandCapabilities = [],
} = {}) {
  const caps = capabilitySet(commandCapabilities);
  const localReady = serverReachable === true && dashboardAuthenticated === true;
  const readable = stateAvailable === true;
  const webReady = readable && extensionAuthenticated === true;
  return Object.freeze({
    chooseFolder:localReady,
    cancel:readable && caps.has("preparation.cancel"),
    reply:webReady && caps.has("preparation.reply"),
    approve:webReady && caps.has("preparation.approve"),
    discard:webReady && caps.has("preparation.discard"),
  });
}
