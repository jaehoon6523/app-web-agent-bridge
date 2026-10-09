export function renderInitialRequest(workflow, preparation, $, text, document, canCancel) {
  const initial = workflow.stage === "START" && preparation?.lifecycle === "ACTIVE";
  const pending = initial && ["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(preparation.state);
  const failed = initial && !pending && Boolean(preparation.error);
  const recovery = document.querySelector(".session-recovery");
  $("startRecovery").replaceChildren();
  if (recovery) {
    const recoveryHost = initial ? $("startRecovery") : ($("preparationDiagnosticsBody") ?? $("proposalSummary"));
    recoveryHost.append(recovery);
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
  text("startProgressTitle", preparation?.state === "INITIALIZING" ? "ChatGPT 대화에 연결하고 있습니다"
    : pending ? "ChatGPT 응답을 기다리고 있습니다" : failed ? "ChatGPT 요청에 실패했습니다" : "요청 상태 확인이 필요합니다");
  text("startProgressDetail", pending ? "응답 확인 후 준비 화면으로 이동합니다."
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
