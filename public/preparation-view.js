export function renderInitialRequest(workflow, preparation, $, text, document, canCancel) {
  const initial = workflow.stage === "START" && preparation?.lifecycle === "ACTIVE";
  const pending = initial && ["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(preparation.state);
  const tabSelection = initial && preparation.error?.code === "WEB_TAB_SELECTION_REQUIRED";
  const failed = initial && !pending && !tabSelection && Boolean(preparation.error);
  const recovery = document.querySelector(".session-recovery");
  const tabChoice = preparation?.error?.code === "WEB_TAB_SELECTION_REQUIRED"
    ? document.querySelector(".preparation-tab-choice") : null;
  $("startRecovery").replaceChildren();
  // Initial requests stay on START until a response is accepted. Keep their
  // tab controls in the visible panel, including after a polling refresh.
  if (tabChoice) {
    if (initial) $("startRecovery").append(tabChoice);
    else $("proposalSummary").prepend(tabChoice);
  }
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
  text("startProgressTitle", tabSelection ? "사용할 ChatGPT 탭을 선택하세요" : preparation?.state === "INITIALIZING" ? "ChatGPT 대화에 연결하고 있습니다"
    : pending ? "ChatGPT 응답을 기다리고 있습니다" : failed ? "ChatGPT 요청에 실패했습니다" : "요청 상태 확인이 필요합니다");
  const activeDelivery = preparation?.deliveries?.find(item => item.deliveryId === preparation.webSession?.activeDeliveryId);
  const evidence = {
    SUBMITTED: "요청 전송이 확인됐습니다. ChatGPT 응답을 기다립니다.",
    RESPONSE_STARTED: "ChatGPT가 응답을 작성하고 있습니다.",
    RESPONSE_COMPLETED: "응답을 받았습니다. 서버 처리와 수신 확인 상태를 확인하고 있습니다.",
    ACKNOWLEDGED: "응답 수신 확인이 완료됐습니다. 준비 상태를 확인하고 있습니다.",
  };
  text("startProgressDetail", tabSelection ? "아직 메시지를 전송하지 않았습니다. 아래 후보에서 사용할 탭을 선택하세요."
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

export function renderPreparationResponse(recovery, displayedDelivery, node) {
  const packet = displayedDelivery.response?.packet;
  if (displayedDelivery.validation?.format === "PLAIN_TEXT_DISCUSSION") {
    recovery.append(node("p", "내용 해석: 평문 대화 응답 확인 · 추가 합의 필요", "recovery-guidance ok"));
  } else if (packet?.type === "REQUIREMENTS_PROPOSAL") {
    const questionCount = (packet.questions ?? []).length;
    const requirementCount = (packet.items ?? []).length;
    recovery.append(node("p", `내용 해석: 요구사항 ${requirementCount}개와 확인 질문 ${questionCount}개를 인지함`, "recovery-guidance ok"));
    recovery.append(node("p", `packet 양식: 정상 · REQUIREMENTS_PROPOSAL / 확인 질문 ${questionCount}개`, "diagnostic-row health ok"));
    recovery.append(node("p", questionCount === 0
      ? "요구사항 상태: 요구사항 합의 완료 · 승인 가능"
      : "요구사항 상태: 추가 합의 필요 · 확인 질문에 답변 필요",
    questionCount === 0 ? "diagnostic-row health ok" : "diagnostic-row health warn"));
  } else if (packet) {
    recovery.append(node("p", `내용 해석: packet은 확인됨 · ${packet.type ?? "알 수 없는 유형"}`, "diagnostic-row health warn"));
    recovery.append(node("p", "packet 양식: 현재 준비 단계에서 기대한 REQUIREMENTS_PROPOSAL이 아님", "diagnostic-row health error"));
  } else if (displayedDelivery.response && !packet) {
    recovery.append(node("p", "내용 해석: 확인 불가 · 응답 packet을 해석하지 못함", "recovery-guidance error"));
    const formatError = displayedDelivery.validation?.formatError;
    recovery.append(node("p", formatError
      ? `packet 양식: ${formatError.code} · ${formatError.message}`
      : "packet 양식: 부족하거나 파싱되지 않음", "diagnostic-row health error"));
  }
}

export function readPreparationOptions($) {
  return {
    autoApproveOnReady: $("autoApprovePreparation").checked,
    acceptPlainTextDiscussion: $("acceptPlainTextDiscussion").checked,
  };
}

function isSavedConversationUrl(url) {
  return /^https:\/\/chatgpt\.com\/c\/[^/?#\s]+\/?$/u.test(url);
}

export function renderWorkspaceHeading($, text, preparation, checks, showingPreparation, mappings) {
  const pending = preparation?.lifecycle === "ACTIVE";
  text("startHeading", pending ? "준비 요청"
    : checks?.extensionAuthenticated === false ? "확장 프로그램 연결이 필요합니다" : "새 작업");
  const sheet = $("preparationConversationSheet");
  if (sheet.open && (!showingPreparation || sheet.dataset.preparationId !== preparation?.preparationId)) sheet.close();
  const saved = showingPreparation && mappings?.find(item => item.targetRoot === preparation?.targetRoot
    && item.conversationId && isSavedConversationUrl(item.conversationUrl));
  $("preparationSavedConversation").hidden = !saved;
  const link = $("preparationSavedConversationLink");
  if (saved) link.href = saved.conversationUrl;
  else link.removeAttribute("href");
  link.textContent = saved?.conversationUrl ?? "";
}

export function renderPreparationConversation($, text, preparation) {
  text("preparationObjective", preparation.objective);
  text("preparationProjectPath", preparation.targetRoot);
  $("projectRoot").value = preparation.targetRoot;
  $("planningObjective").value = preparation.objective;
  const url = preparation.webSession?.conversationUrl ?? preparation.conversationUrl ?? "";
  $("planningUrl").value = url;
  const link = $("openPlanningConversation");
  link.hidden = !isSavedConversationUrl(url);
  if (link.hidden) link.removeAttribute("href");
  else link.href = url;
  $("copyPlanningConversation").hidden = link.hidden;
  text("planningCopyStatus", "");
}

export function bindPreparationConversation($, text, getPreparation) {
  $("openPreparationConversation").addEventListener("click", () => {
    const preparationId = getPreparation()?.preparationId;
    if ($("projectPanel").hidden || !preparationId) return;
    const sheet = $("preparationConversationSheet");
    sheet.dataset.preparationId = preparationId;
    sheet.showModal();
  });
  $("copyPlanningConversation").addEventListener("click", async () => {
    if ($("openPlanningConversation").hidden) return;
    const url = $("planningUrl").value;
    const preparationId = getPreparation()?.preparationId;
    let message = "대화 URL을 복사했습니다.";
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      message = "복사할 수 없습니다. 대화 URL 입력란에서 직접 복사하세요.";
    }
    if (getPreparation()?.preparationId === preparationId && $("planningUrl").value === url) text("planningCopyStatus", message);
  });
}
