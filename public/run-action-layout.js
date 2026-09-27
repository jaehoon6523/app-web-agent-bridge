/**
 * @param {{ $: (id: string) => any, text: (id: string, value: any) => void }} input
 */
export function createRunActionLayout({ $, text }) {
  const primaryActionIds = Object.freeze(["submitDecision", "applyCode", "continueProject", "retryRun"]);
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

  /** @param {any} run */
  return function syncRunInformationArchitecture(run) {
    restorePrimaryActions();
    const decisionVisible = !$("decisionPanel").hidden;
    const primaryId = decisionVisible ? "submitDecision"
      : run?.phase === "AWAITING_APPLY" ? "applyCode"
      : run?.phase === "APPLIED" && !$("continueProject").hidden ? "continueProject"
      : !$("retryRun").disabled ? "retryRun"
      : null;
    const primary = primaryId ? $(primaryId) : null;
    $("runPrimaryTier").hidden = !primary;
    if (primary) {
      $("runPrimaryActionSlot").append(primary);
      primary.classList.add("primary");
      const reason = primaryId === "submitDecision"
        ? ($("decisionStatus")?.textContent?.trim() || "감사자의 확인 질문에 답변하면 같은 후보의 독립 검토를 재개합니다.")
        : primaryId === "continueProject"
          ? "적용된 작업을 기준으로 같은 폴더에서 새 준비 작업을 시작합니다."
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
