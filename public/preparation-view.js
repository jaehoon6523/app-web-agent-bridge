export function renderInitialRequest(workflow, preparation, $, text, document, canCancel) {
  const initial = workflow.stage === "START" && preparation?.lifecycle === "ACTIVE";
  const pending = initial && ["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(preparation.state);
  const recovery = document.querySelector(".session-recovery");
  $("startRecovery").replaceChildren();
  if (recovery) {
    const recoveryHost = initial ? $("startRecovery") : ($("preparationDiagnosticsBody") ?? $("proposalSummary"));
    recoveryHost.append(recovery);
  }
  $("startRecovery").hidden = !initial || pending;
  $("startProgress").hidden = !initial;
  $("startProgress").classList.toggle("is-waiting", pending);
  $("startProgress").setAttribute("aria-busy", String(pending));
  text("startProgressTitle", preparation?.state === "INITIALIZING" ? "ChatGPT 대화에 연결하고 있습니다"
    : pending ? "ChatGPT 응답을 기다리고 있습니다" : "요청 상태 확인이 필요합니다");
  text("startProgressDetail", pending ? "응답 확인이 끝나면 준비 화면으로 이동합니다."
    : preparation?.error?.message ?? "전송 상태를 확인한 뒤 계속할 수 있습니다.");
  const activeTabCount = preparation?.error?.details?.activeTabCount;
  if (!pending && Number.isInteger(activeTabCount)) text("startProgressDetail", `${$("startProgressDetail").textContent} · 감지된 ChatGPT 활성 탭: ${activeTabCount}개`);
  for (const id of ["objective", "startRoot", "conversationUrl"]) {
    $(id).readOnly = initial;
    if (initial) $(id).value = id === "objective" ? preparation.objective : id === "startRoot" ? preparation.targetRoot : (preparation.webSession?.conversationUrl ?? preparation.conversationUrl);
  }
  $("cancelInitialPreparation").hidden = !initial;
  $("cancelInitialPreparation").disabled = !canCancel;
}
