const CLOSED_PHASES = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);

export function runActionVisibility(run) {
  const phase = run?.phase ?? null;
  const closed = CLOSED_PHASES.has(phase);
  return Object.freeze({
    stop:Boolean(run) && !closed && !["APPLYING", "RECOVERY_REQUIRED"].includes(phase),
    retry:["RECOVERY_REQUIRED", "HOLD"].includes(phase),
    apply:phase === "AWAITING_APPLY",
    continue:phase === "APPLIED" && !run?.archivedAt,
    export:Boolean(run),
    delete:closed,
    archive:closed,
  });
}

/**
 * @param {{ $: (id: string) => any, text: (id: string, value: any) => void }} input
 */
export function createRunActionLayout({ $, text }) {
  const primaryActionIds = Object.freeze(["submitDecision", "applyCode", "continueProject", "retryRun"]);
  const projectedActionIds = Object.freeze({
    stopRun:"stop",
    retryRun:"retry",
    applyCode:"apply",
    continueProject:"continue",
    exportEvidence:"export",
    deleteRun:"delete",
    archiveRun:"archive",
  });
  const primaryActionHomes = new Map();
  for (const id of primaryActionIds) {
    const element = $(id);
    if (element?.parentElement) primaryActionHomes.set(id, {
      parent:element.parentElement,
      nextSibling:element.nextSibling,
    });
  }

  function restorePrimaryActions() {
    const slot = $("runPrimaryActionSlot");
    for (const id of primaryActionIds) {
      const element = $(id), home = primaryActionHomes.get(id);
      if (!element || !home || element.parentElement !== slot) continue;
      if (home.nextSibling?.parentElement === home.parent) home.parent.insertBefore(element, home.nextSibling);
      else home.parent.append(element);
      element.classList.remove("primary");
    }
    slot?.querySelectorAll(".action-reason").forEach((item) => item.remove());
  }

  function projectActionVisibility(run) {
    const visibility = runActionVisibility(run);
    for (const [id, key] of Object.entries(projectedActionIds)) {
      const element = $(id);
      if (!element) continue;
      element.hidden = !visibility[key];
      if (!visibility[key]) {
        element.classList.remove("primary");
        const reason = $(`${id}ActionReason`);
        if (reason) reason.hidden = true;
      }
    }
    return visibility;
  }

  /** @param {any} run */
  return function syncRunInformationArchitecture(run) {
    restorePrimaryActions();
    const visibility = projectActionVisibility(run);
    const decisionVisible = !$("decisionPanel").hidden;
    const primaryId = decisionVisible ? "submitDecision"
      : visibility.apply ? "applyCode"
      : visibility.continue ? "continueProject"
      : visibility.retry && !$("retryRun").disabled ? "retryRun"
      : null;
    const primary = primaryId ? $(primaryId) : null;
    $("runPrimaryTier").hidden = !primary;
    if (primary) {
      const inlineReason = $(`${primaryId}ActionReason`);
      if (inlineReason) inlineReason.hidden = true;
      $("runPrimaryActionSlot").append(primary);
      primary.classList.add("primary");
      const reason = primaryId === "submitDecision"
        ? ($("decisionStatus")?.textContent?.trim() || "감사자의 확인 질문에 답변하면 현재 변경사항의 독립 검토를 재개합니다.")
        : primaryId === "continueProject"
          ? (primary.title || "적용된 작업을 기준으로 같은 폴더에서 새 요구사항 정리를 시작합니다.")
          : primary.title;
      text("runPrimaryActionReason", reason ?? "");
    } else {
      text("runPrimaryActionReason", "");
    }
    $("runContextTier").hidden = $("workerInterventionPanel").hidden
      && $("decisionPanel").hidden && $("reviewDiscussionPanel").hidden;
    $("runRecoveryTier").hidden = $("reviewDiscussionRecovery").hidden
      && $("reviewBindingRecoveryPanel").hidden && $("recoveryPanel").hidden;
  };
}
