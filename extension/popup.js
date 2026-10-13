const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const controllerUrl = document.querySelector("#controllerUrl");
const sharedSecret = document.querySelector("#sharedSecret");
const save = document.querySelector("#save");
const reconnect = document.querySelector("#reconnect");
const legacyRecovery = document.querySelector("#legacyRecovery");
const clearLegacy = document.querySelector("#clearLegacy");
const deliveryRecovery = document.querySelector("#deliveryRecovery");
const recoveryDetail = document.querySelector("#recoveryDetail");
const recoveryOutcome = document.querySelector("#recoveryOutcome");
const recoveryActionState = document.querySelector("#recoveryActionState");
const openRecovery = document.querySelector("#openRecovery");
const pageUnconfirmedLabel = document.querySelector("#pageUnconfirmedLabel");
const inspectDelivery = document.querySelector("#inspectDelivery");
const openDelivery = document.querySelector("#openDelivery");
const openController = document.querySelector("#openController");
const openPairing = document.querySelector("#openPairing");
const discardOrphan = document.querySelector("#discardOrphan");
const reason = document.querySelector("#discardReason");
const scopeSelect = document.querySelector("#deliveryScope"), scopedRecovery = document.querySelector("#scopedRecovery");
const selectDelivery = document.querySelector("#selectDelivery");
const inspectTabs = document.querySelector("#inspectTabs"), diagnosticTab = document.querySelector("#diagnosticTab");
const openDiagnosticTab = document.querySelector("#openDiagnosticTab");
let tabDiagnosticText = "", connectionDiagnosticText = "";
const confirmations = ["ownershipConfirmed", "pageUnconfirmed"].map(id => document.querySelector("#" + id));
let inspection = null, refreshing = null;
let authenticated = false;
const choosePreparationTab = document.querySelector("#choosePreparationTab");
let outcomeDeliveryId = null;
let displayedDeliveryId = null;
let tabDiagnostics = [], currentTabId = null, currentExtensionVersion = null;
function send(message) { return chrome.runtime.sendMessage(message); }

const openResizableWindow = document.querySelector("#openResizableWindow");
const popupWindowStatus = document.querySelector("#popupWindowStatus");

function render(response) {
  if (!response?.ok) {
    authenticated = false;
    if (choosePreparationTab) choosePreparationTab.disabled = true;
    status.textContent = "error"; status.className = "badge bad";
    detail.textContent = response?.error || "Extension service worker is unavailable.";
    return;
  }
  const state = response.state || {};
  authenticated = state.connected === true;
  const connectionSummary = document.querySelector("#connectionSummary");
  if (connectionSummary) connectionSummary.textContent = authenticated ? "컨트롤러 연결됨 · 탭 준비 상태는 별도로 확인합니다." : "컨트롤러 연결이 필요합니다. 연결 설정 또는 확장 연결 승인을 확인하세요.";
  openPairing.hidden = !String(state.lastError ?? "").includes("AUTH_IDENTITY_MISMATCH");
  displayedDeliveryId = state.currentDeliveryId ?? null;
  if (outcomeDeliveryId && state.currentDeliveryId && state.currentDeliveryId !== outcomeDeliveryId) {
    recoveryOutcome.textContent = "";
    outcomeDeliveryId = null;
  }
  currentTabId = state.tabId; currentExtensionVersion = state.extensionVersion;
  legacyRecovery.hidden = state.legacyTestDelivery !== true;
  const pending = Boolean(state.currentDeliveryId || state.pendingDeliveryCount > 0);
  const blocked = pending || state.busy || state.bindingStatus === "AMBIGUOUS";
  const healthy = state.connected && !blocked && ["BOUND", "ROOT_READY"].includes(state.bindingStatus);
  status.textContent = pending ? "전송 확인 필요" : state.busy ? "작업 중"
    : state.bindingStatus === "AMBIGUOUS" ? "AMBIGUOUS" : healthy ? state.bindingStatus : state.connected ? "연결됨" : "연결 확인 필요";
  status.className = `badge ${healthy ? "ok" : "bad"}`;
  detail.className = healthy ? "detail-ok" : "detail-error";
  const phases = { RESPONSE_OBSERVED: "응답 관측됨 · 서버 검증·저장 및 ACK 확인 필요", IN_FLIGHT: "전송 작업 진행 중", UNRESOLVED: "전송 결과 미확정", IDLE: "활성 전송 없음" };
  const lines = [
    `연결: ${state.connected ? "인증 완료" : state.transportConnected ? "인증 대기" : state.connecting ? "연결 중" : "끊김"}`,
    `ChatGPT tab ${state.tabId ?? "확인되지 않음"} · ${state.bindingStatus || "NEEDS_REBIND"}`,
    `identity: ${state.extensionIdentity || "확인되지 않음"}`,
    `전송: ${phases[state.deliveryPhase] ?? (pending ? "전송 결과 미확정" : "활성 전송 없음")}${state.currentDeliveryId ? " · " + state.currentDeliveryId : ""}`,
    `새 탭: ${state.startTab?.ready ? `tab ${state.startTab.tabId} 입력창 확인됨${blocked ? " · 이전 상태 확인 필요" : ""}` : "준비 확인되지 않음"}`,
  ];
  if (state.scopedDeliveries?.length) lines.push("다른 세션의 미확인 전송: " + state.scopedDeliveries.map(item => item.deliveryId).join(", "));
  if (scopeSelect) {
    scopedRecovery.hidden = selectDelivery.hidden = !state.scopedDeliveries?.length;
    selectDelivery.disabled = Boolean(state.busy);
    const selected = scopeSelect.value;
    scopeSelect.replaceChildren(...(state.scopedDeliveries ?? []).map(item => {
      const option = document.createElement("option"); option.value = JSON.stringify(item);
      option.textContent = item.sessionId + " · " + item.deliveryId; return option;
    }));
    if ([...scopeSelect.options].some(option => option.value === selected)) scopeSelect.value = selected;
  }
  if (state.bindingError) {
    lines.push("저장된 실패 원인: " + state.bindingError);
    lines.push("실패 진단의 tabId는 위 전송 소유 탭과 다를 수 있습니다. 현재 상태는 탭 진단에서 다시 확인하세요.");
  }
  if (state.bindingRecovery?.message) lines.push("복구 안내: " + state.bindingRecovery.message);
  if (state.lastError) lines.push("연결 진단: " + state.lastError);
  if (state.extensionVersion) lines.push(`확장 ${state.extensionVersion} · 콘텐츠 ${state.contentVersion ?? "확인되지 않음"}`);
  connectionDiagnosticText = lines.join("\n");
  detail.textContent = `${state.bindingRecovery?.message ? state.bindingRecovery.message + "\n" : ""}${state.connected ? "인증 완료" : "연결 확인 필요"} · 확장 ${state.extensionVersion ?? "확인 전"}. 상세 정보는 진단 로그로 내보내세요.`;
  deliveryRecovery.hidden = !pending;
  inspectDelivery.disabled = !state.currentDeliveryId;
  if (inspection && (inspection.owner?.currentDeliveryId !== state.currentDeliveryId
    || state.deliveryOwner && Object.keys(state.deliveryOwner).some(key => state.deliveryOwner[key] !== inspection.owner?.[key]))) {
    inspection = null; confirmations.forEach(item => { item.checked = false; });
    recoveryDetail.textContent = "전송 대상이 변경됐습니다. 상태를 다시 확인하세요.";
  }
  openDelivery.disabled = !inspection?.owner?.currentDeliveryId;
  renderTabDiagnostic();
  updateDiscard();
  if (response.config) {
    controllerUrl.value = response.config.controllerUrl || "";
    sharedSecret.value = "";
    sharedSecret.placeholder = response.config.hasSharedSecret ? "Stored — leave blank to keep" : "Required";
  }
}

function pageDiagnosticLines(page) {
  const lines = [`페이지 상태: ${page.pageStatus ?? "확인 불가"}`,
    `문서 ID(콘텐츠 토큰): ${page.documentId ?? "확인 불가"} · frame: ${page.frameId ?? "확인 불가"}`];
  if (page.transport) lines.push(`수신: ${page.transport.status} · 탭 조회: ${page.transport.tabStatus ?? "확인 전"} · 로딩: ${page.transport.loadingStatus ?? "확인 불가"}`);
  if (page.pageState) lines.push("페이지 관측: " + JSON.stringify(page.pageState));
  if (page.diagnostics) lines.push("선택자 통계: " + JSON.stringify(page.diagnostics, null, 2));
  if (page.inspectionError) lines.push(`현재 검사 오류: ${page.inspectionError.code ?? "ERROR"}: ${page.inspectionError.message ?? ""}`);
  return lines;
}

function renderTabDiagnostic() {
  if (!diagnosticTab || !openDiagnosticTab) return;
  const tab = tabDiagnostics.find(item => String(item.tabId) === diagnosticTab.value);
  openDiagnosticTab.disabled = !tab;
  const ready = tab?.reachable === true && tab.ready === true && tab.composerPresent === true
    && tab.busy === false && tab.generating === false && tab.runtimeVersion === currentExtensionVersion
    && /^https:\/\/chatgpt\.com\/$/.test(tab.url ?? "")
    && (!tab.pageUrl || tab.pageUrl === tab.url) && (!tab.observedTabUrl || tab.observedTabUrl === tab.url);
  if (choosePreparationTab) choosePreparationTab.disabled = !ready || !authenticated;
  const summary = document.querySelector("#tabSummary"), next = document.querySelector("#tabNextReason");
  if (summary) summary.textContent = !tab ? "진단할 탭을 선택하세요." : `탭 ${tab.tabId} · ${ready ? "시작 화면 · 입력창 준비됨" : tab.busy || tab.generating ? "작업 또는 생성 중" : "준비 상태 재확인 필요"}${tab.inspectedAt ? "\n진단: " + tab.inspectedAt : ""}`;
  if (next) next.textContent = !authenticated ? "컨트롤러 연결 후 사용할 수 있습니다." : !ready ? "사용 가능한 시작 화면인지 다시 진단하세요." : "이 버튼은 화면만 이동하며 전송하지 않습니다. 컨트롤러에 탭 선택 대기 작업이 있을 때 현재 후보를 직접 선택하세요.";
  if (!tab) { tabDiagnosticText = "확인된 탭 진단 없음"; return; }
  const lines = [`tab ${tab.tabId}${tab.tabId === currentTabId ? " · 전송 소유 탭" : " · 별도 탭"}`, tab.url,
    `입력창: ${tab.composerPresent === true ? "있음" : tab.composerPresent === false ? "없음" : "확인 불가"}`,
    `상태: ${!tab.reachable ? "콘텐츠 응답 없음" : tab.busy || tab.generating ? "작업 또는 생성 중" : tab.ready ? "준비 확인됨" : "준비되지 않음"}`,
    `콘텐츠 ${tab.runtimeVersion ?? "확인되지 않음"} · 확장 ${currentExtensionVersion ?? "확인되지 않음"}`];
  lines.push(...pageDiagnosticLines(tab));
  if (tab.inspectedAt) lines.push("진단 시각: " + tab.inspectedAt);
  if (tab.runtimeVersion && currentExtensionVersion && tab.runtimeVersion !== currentExtensionVersion) {
    lines.push("콘텐츠 버전이 다릅니다. 전송·생성 상태를 확인한 뒤 해당 탭을 새로고침하고 다시 진단하세요.");
  }
  if (tab.pageUrl && tab.pageUrl !== tab.url) lines.push("진단 중 문서 주소가 변경됐습니다. 상태를 다시 확인하세요.");
  if (tab.observedTabUrl && tab.observedTabUrl !== tab.url) lines.push("탭 조회 중 주소가 변경됐습니다: " + tab.observedTabUrl);
  lines.push("이 결과는 진단 시점의 상태입니다. 탭 열기는 바인딩 변경·전송·폐기를 수행하지 않습니다.");
  tabDiagnosticText = lines.join("\n");
  if (tab.runtimeVersion && tab.runtimeVersion !== currentExtensionVersion && next) next.textContent = "콘텐츠 버전이 다릅니다. 진행 중 작업을 확인한 뒤 탭을 새로고침하세요.";
}

function updateDiscard() {
  const panel = document.querySelector("#orphanDiscardPanel");
  if (panel) panel.hidden = inspection?.server?.status !== "MISSING";
  if (openRecovery) openRecovery.hidden = inspection?.server?.status !== "MATCHED";
  if (recoveryActionState) recoveryActionState.textContent = "조치 상태: " + (
    !inspection ? "확인 전"
      : inspection.extensionBusy || inspection.page?.generating || inspection.page?.busy
        || inspection.otherActive || inspection.server?.otherActive ? "다른 작업 또는 생성 중 · 정리 불가"
        : inspection.hasCompletedDelivery || inspection.phase === "RESPONSE_OBSERVED" ? "확장에 완료 응답 있음 · 기록 보존 및 서버 저장 확인 필요"
          : inspection.phase === "ACK_PENDING" ? "저장된 응답 ACK 확인 필요"
          : inspection.server?.status === "MISSING" ? "확장 소유권 정리 가능 · 명시적 확인 필요"
            : inspection.server?.status === "MATCHED" ? "컨트롤러에서 이 전송 확인"
              : "정리 불가 · 서버 기록 확인 필요");
  const page = inspection?.page;
  const unknownPage = !page?.reachable || page.busy !== false || page.generating !== false;
  if (pageUnconfirmedLabel) pageUnconfirmedLabel.hidden = inspection?.server?.status !== "MISSING" || !unknownPage;
  discardOrphan.disabled = !(inspection?.server?.status === "MISSING" && !inspection.extensionBusy
    && !inspection.server?.otherActive && !inspection.otherActive
    && !inspection.hasCompletedDelivery && !["RESPONSE_OBSERVED", "ACK_PENDING"].includes(inspection.phase)
    && !page?.busy && !page?.generating && confirmations[0].checked
    && (!unknownPage || confirmations[1].checked) && reason.value.trim().length >= 3);
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = send({ type: "bridge.getState" }).then(render)
    .catch(error => render({ ok: false, error: error.message })).finally(() => { refreshing = null; });
  return refreshing;
}

save.addEventListener("click", async () => {
  const result = await send({ type: "bridge.saveConfig", payload: { controllerUrl: controllerUrl.value, sharedSecret: sharedSecret.value } });
  if (!result?.ok) render(result); else await refresh();
});
clearLegacy.addEventListener("click", async () => {
  clearLegacy.disabled = true;
  const result = await send({ type: "bridge.clearLegacyTestDelivery" });
  if (result?.ok) await send({ type: "bridge.reconnect" });
  await refresh();
  if (!result?.ok) detail.textContent += "\n" + result.error;
  clearLegacy.disabled = false;
});
reconnect.addEventListener("click", async () => { await send({ type: "bridge.reconnect" }); await refresh(); });
inspectTabs?.addEventListener("click", async () => {
  inspectTabs.disabled = true;
  try {
    const response = await send({ type: "bridge.inspectTabs" });
    tabDiagnostics = response?.ok && Array.isArray(response.result) ? response.result : [];
    const selected = diagnosticTab.value;
    diagnosticTab.replaceChildren(...tabDiagnostics.map(tab => {
      const option = document.createElement("option"); option.value = String(tab.tabId);
      option.textContent = `tab ${tab.tabId} · ${tab.ready ? "준비 확인됨" : "확인 필요"}`; return option;
    }));
    diagnosticTab.value = tabDiagnostics.some(tab => String(tab.tabId) === selected) ? selected
      : String(tabDiagnostics.find(tab => tab.tabId === currentTabId)?.tabId ?? tabDiagnostics[0]?.tabId ?? "");
    tabDiagnosticText = response?.ok ? "열려 있는 ChatGPT 탭이 없습니다." : response?.error || "탭 진단에 실패했습니다.";
    renderTabDiagnostic();
  } catch (error) {
    tabDiagnostics = []; renderTabDiagnostic(); tabDiagnosticText = error.message; document.querySelector("#tabNextReason").textContent = "탭 확인에 실패했습니다. 다시 확인하거나 진단 로그를 내보내세요.";
  } finally { inspectTabs.disabled = false; }
});
diagnosticTab?.addEventListener("change", renderTabDiagnostic);
openDiagnosticTab?.addEventListener("click", async () => {
  const selected = tabDiagnostics.find(tab => String(tab.tabId) === diagnosticTab.value);
  if (!selected) return;
  try {
    const result = await send({ type: "bridge.openInspectedTab", payload: { tabId: selected.tabId, url: selected.url } });
    if (!result?.ok) { tabDiagnosticText = result?.error || "탭을 열지 못했습니다."; document.querySelector("#tabNextReason").textContent = "탭을 열지 못했습니다. 최신 탭 상태를 다시 확인하세요."; }
  } catch (error) { tabDiagnosticText = error.message; document.querySelector("#tabNextReason").textContent = "탭 확인에 실패했습니다. 다시 확인하거나 진단 로그를 내보내세요."; }
});
inspectDelivery.addEventListener("click", async () => {
  inspectDelivery.disabled = true;
  recoveryOutcome.textContent = "";
  outcomeDeliveryId = null;
  const response = await send({ type: "bridge.inspectDelivery" });
  inspection = response?.ok ? response.result : null;
  confirmations.forEach(item => { item.checked = false; });
  const server = inspection?.server, page = inspection?.page;
  const record = server?.records?.[0];
  const summary = !server || server.status === "UNAVAILABLE" ? "확인 불가"
    : server.status === "MATCHED" && record?.active ? "일치" : "기록 불일치";
  recoveryDetail.textContent = inspection ? [
    `브리지 기록: ${summary}`,
    `대상 전송: ${inspection.owner?.currentDeliveryId ?? "확인 불가"}`,
    `서버 기록: ${server?.status === "MISSING" ? "대응 기록 없음" : server?.status === "MATCHED"
      ? record?.active ? "전송 소유권 활성" : "해당 전송 기록 종료됨" : "확인 불가 또는 식별자 불일치"}`,
    `확장 기록: 이 전송의 소유권 기록이 남아 있습니다.`,
    `ChatGPT 처리 결과: ${inspection.phase === "ACK_PENDING" ? "응답 저장 근거 있음 · 원래 페이지는 별도 확인"
      : inspection.phase === "RESPONSE_OBSERVED" ? "확장에 완료 응답이 남아 있음 · 서버 저장 상태 확인 필요"
        : "미확정 · 실제 생성 종료 확인 불가"}`,
    server?.status === "MATCHED" ? "컨트롤러에서 이 전송의 기록 정리 경로를 확인하세요."
      : server?.status === "MISSING" && inspection.phase === "RESPONSE_OBSERVED"
        ? "확장 응답 기록을 보존합니다. 컨트롤러에서 해당 작업의 저장 상태를 확인하세요."
        : server?.status === "MISSING" ? "확장 소유권만 정리할 수 있습니다. 원래 요청은 재전송하지 않습니다."
      : "대상 상태를 확정할 수 없어 기록을 변경하지 않습니다."
  ].join("\n") : response?.error || "상태를 확인하지 못했습니다.";
  updateDiscard();
  await refresh();
});
openDelivery.addEventListener("click", async () => {
  const result = await send({ type: "bridge.openDelivery", payload: inspection?.owner });
  if (!result?.ok) recoveryDetail.textContent = result.error;
});
openController.addEventListener("click", async () => {
  const result = await send({ type: "bridge.openController" });
  if (!result?.ok) detail.textContent += "\n" + result.error;
});
openPairing?.addEventListener("click", async () => {
  const result = await send({ type: "bridge.openPairing" });
  if (!result?.ok) detail.textContent += "\n" + (result?.error || "연결 승인 화면을 열지 못했습니다.");
});
openRecovery?.addEventListener("click", async () => {
  if (inspection?.server?.status !== "MATCHED") return;
  const selectedOwner = inspection.owner;
  const result = await send({ type: "bridge.openController", payload: selectedOwner });
  if (!result?.ok) recoveryDetail.textContent = result?.error || "전송 대상이 바뀌었습니다. 상태를 다시 확인하세요.";
});
selectDelivery?.addEventListener("click", async () => {
  if (!scopeSelect.value) return;
  const result = await send({ type: "bridge.selectDelivery", payload: JSON.parse(scopeSelect.value) });
  if (!result?.ok) recoveryDetail.textContent = result.error; else await refresh();
});
for (const item of confirmations) item.addEventListener("change", updateDiscard);
reason.addEventListener("input", updateDiscard);
discardOrphan.addEventListener("click", async () => {
  if (discardOrphan.disabled || !inspection) return;
  discardOrphan.disabled = true;
  outcomeDeliveryId = inspection.owner.currentDeliveryId;
  let result;
  try {
    result = await send({ type: "bridge.discardOrphanDelivery", payload: { ...inspection.owner,
      unresolvedResultConfirmed: confirmations[0].checked, noAutomaticResendConfirmed: confirmations[0].checked,
      orphanOwnershipCleanupConfirmed: confirmations[0].checked, pageStateUnconfirmedConfirmed: confirmations[1].checked,
      reason: reason.value.trim() } });
  } catch (error) { result = { ok: false, uncertain: true, error: error.message }; }
  if (result?.ok && result.result?.discarded === true && result.result?.receiptVerified === true) inspection = null;
  await refresh();
  if (displayedDeliveryId && displayedDeliveryId !== outcomeDeliveryId) return;
  recoveryOutcome.textContent = result?.ok && result.result?.discarded === true && result.result?.receiptVerified === true
    ? "확장 소유권 기록 정리 완료 · 저장된 영수증 확인됨. ChatGPT 처리 결과는 미확정입니다."
    : result?.ok ? "정리 응답은 수신했지만 최종 영수증을 확인하지 못했습니다. 상태를 다시 확인하세요."
    : result?.uncertain ? "정리 요청 결과를 확인할 수 없습니다. 상태를 다시 확인하세요."
    : "기록 정리 실행 거절 또는 실패: " + (result?.error ?? "확인 불가");
});
if (new URLSearchParams(globalThis.location?.search ?? "").get("view") === "window") {
  document.body?.classList?.add("window-view");
  if (openResizableWindow) openResizableWindow.hidden = true;
  if (popupWindowStatus) popupWindowStatus.textContent = "창 테두리를 끌어 가로·세로 크기를 조절하세요.";
}
openResizableWindow?.addEventListener("click", async () => {
  if (openResizableWindow.disabled) return;
  openResizableWindow.disabled = true;
  try {
    // This opens a view of the existing state; it does not dispatch a turn.
    await chrome.windows.create({
      url:chrome.runtime.getURL("popup.html?view=window"), type:"popup", focused:true,
      width:Math.min(760, globalThis.screen?.availWidth || 760),
      height:Math.min(860, globalThis.screen?.availHeight || 860),
    });
    if (popupWindowStatus) popupWindowStatus.textContent = "크기 조절 창을 열었습니다.";
  } catch {
    if (popupWindowStatus) popupWindowStatus.textContent = "별도 창을 열지 못했습니다. 다시 시도하세요.";
  } finally { openResizableWindow.disabled = false; }
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "bridge.state") render({ ok: true, state: message.payload });
});
void refresh();

const exportAgentDiagnostics = document.querySelector("#exportAgentDiagnostics");
const agentDiagnosticStatus = document.querySelector("#agentDiagnosticStatus");
exportAgentDiagnostics?.addEventListener("click",async () => {
  if (!confirm("원시 진단에 민감정보가 남을 수 있습니다. 저장한 JSON을 텍스트 편집기에서 검토하고 필요한 값을 지운 뒤 공유하세요. 로컬 파일로 저장할까요?")) return;
  const includeRaw = document.querySelector("#includeRawDiagnostic").checked;
  exportAgentDiagnostics.disabled = true;agentDiagnosticStatus.textContent = "현재 상태를 읽는 중입니다.";
  try {
    let result;
    try { result = await send({type:"bridge.exportDiagnostics"}); } catch { result = null; }
    const incomplete = !result?.ok;
    if (incomplete) result = { report:{ source:"POPUP_OBSERVATION_ONLY", server:{status:"UNAVAILABLE"},
      collection:{status:"UNAVAILABLE",code:"DIAGNOSTIC_EXPORT_FAILED"} } };
    const report = { ...result.report, popupObservation: { exportedAt:new Date().toISOString(),
      selectedTabId:diagnosticTab.value, connectionDetail:connectionDiagnosticText, tabDetail:tabDiagnosticText,
      tabs:tabDiagnostics, deliveryInspection:inspection, note:"팝업 관측값은 마지막 조회 시점의 값이며 최신 에이전트 보고서와 관측 시각이 다를 수 있습니다." } };
    const { prepareDiagnosticLog } = await import("./runtime/diagnostic-redaction.js");
    const blob = new Blob([JSON.stringify(prepareDiagnosticLog({ ...report, exportMode:includeRaw ? "WITH_RAW" : "DIAGNOSTIC_ONLY" }, {includeRaw}),null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;link.download = "runtime-latest.json";link.click();setTimeout(() => URL.revokeObjectURL(url),10000);
    agentDiagnosticStatus.textContent = result.report.server?.status === "UNAVAILABLE"
      ? "로그 다운로드를 요청했습니다. 서버 정보는 수집하지 못했습니다." : "진단 로그 다운로드를 요청했습니다.";
    if (result.report.loggingFailure) agentDiagnosticStatus.textContent += " 서버 로그 저장에 실패해 다운로드한 파일을 보관하세요.";
  } catch (error) {agentDiagnosticStatus.textContent = "로그 내보내기 실패: " + error.message;}
  finally {exportAgentDiagnostics.disabled = false;}
});

choosePreparationTab?.addEventListener("click", async () => {
  if (choosePreparationTab.disabled) return;
  const tab = tabDiagnostics.find(item => String(item.tabId) === diagnosticTab.value);
  choosePreparationTab.disabled = true;
  try {
    const response = await send({ type: "bridge.openPreparationTab", payload: { tabId: tab.tabId } });
    if (!response?.ok) throw new Error(response?.error || "컨트롤러를 열지 못했습니다.");
  } catch (error) { document.querySelector("#tabNextReason").textContent = error.message; }
});
