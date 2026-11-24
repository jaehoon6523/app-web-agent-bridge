export function renderInitialRequest(workflow, preparation, $, text, document, canCancel, recovery) {
  const initial = workflow.stage === "START" && preparation?.lifecycle === "ACTIVE";
  const pending = initial && ["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(preparation.state);
  const tabSelection = initial && preparation.error?.code === "WEB_TAB_SELECTION_REQUIRED";
  const failed = initial && !pending && !tabSelection && Boolean(preparation.error);
  const tabChoice = preparation?.error?.code === "WEB_TAB_SELECTION_REQUIRED"
    ? document.querySelector(".preparation-tab-choice") : null;
  // Initial requests stay on START until a response is accepted. Keep their
  // tab controls in the visible panel, including after a polling refresh.
  if (tabChoice) {
    const host = initial ? $("startRecovery") : $("proposalSummary");
    if (tabChoice.parentElement !== host) {
      if (initial) host.append(tabChoice);
      else host.prepend(tabChoice);
    }
  }
  if (recovery) {
    const recoveryHost = initial ? $("startRecovery") : ($("preparationDiagnosticsBody") ?? $("proposalSummary"));
    if (recovery.parentElement !== recoveryHost) recoveryHost.append(recovery);
    const session = preparation?.webSession;
    let link = recovery.querySelector("a[data-delivery-recovery]");
    if (session?.activeDeliveryId && session.conversationUrl) {
      if (!link) { link = document.createElement("a"); link.dataset.deliveryRecovery = "";
        link.textContent = "전송 기록 대조·폐기 화면"; recovery.append(link); }
      link.href = "/delivery-recovery.html?" + new URLSearchParams({ currentDeliveryId: session.activeDeliveryId,
        sessionId: session.sessionId, runId: preparation.preparationId, conversationUrl: session.conversationUrl });
    } else link?.remove();
  }
  $("startRecovery").hidden = !initial || pending;
  $("startProgress").hidden = !initial;
  $("startProgress").classList.toggle("is-waiting", pending);
  $("startProgress").classList.toggle("error", failed);
  $("startProgress").setAttribute("role", failed ? "alert" : "status");
  $("startProgress").setAttribute("aria-busy", String(pending));
  text("startProgressTitle", tabSelection ? "사용할 ChatGPT 탭을 선택하세요" : preparation?.state === "INITIALIZING" ? "ChatGPT 대화에 연결하고 있습니다"
    : pending ? "ChatGPT 응답을 기다리고 있습니다" : failed ? "ChatGPT 요청에 실패했습니다" : "요청 상태 확인이 필요합니다");
  const activeDelivery = preparation?.deliveries?.find(item => item.deliveryId === preparation.webSession?.activeDeliveryId);
  const evidence = {
    SUBMITTED: "요청 전송이 확인됐습니다. ChatGPT 응답을 기다립니다.",
    RESPONSE_STARTED: "ChatGPT가 응답을 작성하고 있습니다.",
    RESPONSE_COMPLETED: "응답을 받았습니다. 서버 처리와 수신 확인 상태를 확인하고 있습니다.",
    ACKNOWLEDGED: "응답 수신 확인이 완료됐습니다. 준비 상태를 확인하고 있습니다.",
  };
  text("startProgressDetail", activeDelivery?.cancelRequestedAt ? "종료 요청을 저장했습니다. 이 전송의 수신 확인이 끝나면 협의가 자동으로 종료됩니다."
    : tabSelection ? "아직 메시지를 전송하지 않았습니다. 아래 후보에서 사용할 탭을 선택하세요."
    : pending ? evidence[activeDelivery?.state] ?? "응답 확인 후 준비 화면으로 이동합니다."
      : failed ? `${preparation.error.code}: ${preparation.error.message}` : "요청 상태를 확인할 수 없습니다. 기술 진단을 확인하세요.");
  const activeTabCount = preparation?.error?.details?.activeTabCount;
  if (!pending && Number.isInteger(activeTabCount)) text("startProgressDetail", `${$("startProgressDetail").textContent} · 감지된 ChatGPT 활성 탭: ${activeTabCount}개`);
  for (const id of ["objective", "startRoot", "conversationUrl"]) {
    $(id).readOnly = initial;
    if (initial) $(id).value = id === "objective" ? preparation.objective : id === "startRoot" ? preparation.targetRoot : (preparation.webSession?.conversationUrl ?? preparation.conversationUrl);
  }
  $("cancelInitialPreparation").hidden = !initial;
  $("cancelInitialPreparation").disabled = !canCancel;
}

export function renderPreparationOutcome($, preparation, { visible, connected, extensionConnected, canReconcile, canClose, canApprove, canReply, canStart, closeLabel }) {
  const panel = $("preparationOutcome");
  const deliveries = preparation?.deliveries ?? [];
  const delivery = deliveries.find(item => item.deliveryId === preparation?.webSession?.activeDeliveryId) ?? deliveries.at(-1);
  const closed = preparation?.lifecycle === "ABANDONED";
  const saved = ["ACK_PENDING", "COMPLETE"].includes(delivery?.processingState);
  const pending = delivery?.processingState === "ACK_PENDING";
  const acknowledged = delivery?.state === "ACKNOWLEDGED" && delivery.processingState === "COMPLETE";
  const closing = !closed && pending && Boolean(delivery?.cancelRequestedAt);
  panel.hidden = !visible || !(saved || delivery?.response?.rawText?.trim()) || !(closed || preparation.lifecycle === "ACTIVE");
  const reconcile = $("reconcilePreparationOutcome");
  const reconcileAvailable = connected && extensionConnected && canReconcile;
  const showReconcile = !panel.hidden && pending && !closed && !closing
    && (reconcileAvailable || (!reconcile.hidden && reconcile.dataset.deliveryId === delivery.deliveryId));
  const reconcileFocused = document.activeElement === reconcile;
  reconcile.hidden = !showReconcile;
  reconcile.dataset.deliveryId = showReconcile ? delivery.deliveryId : "";
  reconcile.setAttribute("aria-disabled", String(!reconcileAvailable));
  if (panel.hidden) return;

  const cleanup = preparation.tabCleanup?.deliveryId === delivery.deliveryId ? preparation.tabCleanup : null;
  const tabClosed = cleanup?.status === "CLOSED";
  const title = closed ? "협의 종료" : closing ? "협의 종료 보류"
    : acknowledged ? "수신 확인 완료" : pending ? "수신 확인 대기" : "응답 확인 필요";
  let reason = "";
  let next = "";
  if (!connected) {
    reason = "마지막으로 확인한 상태입니다. 최신 상태를 확인하지 못했습니다.";
    next = "상태 다시 확인";
  } else if (closed) {
    reason = tabClosed ? "협의 기록이 보존됐고 Bridge가 만든 탭이 닫혔습니다."
      : cleanup?.reason === "TAB_NOT_BRIDGE_OWNED" ? "Bridge 소유 탭이 아니어서 자동 닫기를 건너뛰었습니다."
        : "협의 기록은 보존됐습니다. 탭이 닫혔는지는 확인되지 않았습니다.";
    next = canStart ? "필요하면 새 작업을 시작하세요." : "현재 프로젝트와 작업 기록을 확인할 수 있습니다.";
  } else if (pending) {
    const code = preparation.error?.code;
    reason = !extensionConnected ? "확장 연결이 확인되지 않아 이 전송의 수신을 확인할 수 없습니다."
      : ["DELIVERY_ACK_MISMATCH", "DELIVERY_RECOVERY_MISMATCH"].includes(code) ? "서버와 확장에서 같은 전송의 수신 증거를 확인하지 못했습니다."
        : "서버에 응답을 저장했습니다. 이 전송의 수신 확인이 아직 끝나지 않았습니다.";
    next = !extensionConnected ? "확장 연결을 확인한 뒤 상태를 다시 확인하세요."
      : closing ? "수신 확인이 끝나면 보류된 종료가 처리됩니다."
        : canReconcile ? "아래에서 이 전송의 수신 확인을 다시 처리할 수 있습니다."
          : canClose ? `기다리거나 ‘${closeLabel}’로 종료를 요청할 수 있습니다.`
            : "수신 확인을 기다리세요.";
  } else if (acknowledged) {
    reason = "이 전송의 응답 저장과 수신을 확인했습니다.";
    next = canApprove ? "요구사항을 검토하고 승인할 수 있습니다."
      : canReply ? "필요한 답변이나 수정 요청을 보내세요."
        : canClose ? `필요하면 ‘${closeLabel}’로 협의를 종료하세요.`
          : "현재 조작이 가능해질 때까지 상태를 확인하세요.";
  } else {
    reason = saved ? "응답은 저장됐습니다. 수신 확인 근거는 아직 확정되지 않았습니다."
      : "응답 원문을 확인했습니다. 저장 완료와 수신 확인은 아직 확정되지 않았습니다.";
    next = "‘대화 상태와 복구’에서 확인 가능한 상세를 보세요.";
  }

  for (const [id, value] of Object.entries({
    preparationOutcomeTitle: title,
    preparationResponseState: saved ? "저장됨" : "원문 확인 · 저장 미확정",
    preparationAckState: acknowledged ? "확인 완료" : pending && !closed ? "대기" : "미확인",
    preparationClosureState: closed ? "종료됨" : closing ? "요청 보류" : "진행 중",
    preparationTabState: tabClosed ? "닫힘 확인" : cleanup?.reason === "TAB_NOT_BRIDGE_OWNED" ? "자동 닫기 대상 아님"
      : closed ? "미확인" : "종료 전",
    preparationOutcomeReason: reason,
    preparationOutcomeNext: next,
  })) {
    if ($(id).textContent !== value) $(id).textContent = value;
  }
  if (reconcileFocused && !showReconcile) $("preparationOutcomeTitle").focus();
}
