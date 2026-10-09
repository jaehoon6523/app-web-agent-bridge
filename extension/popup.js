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
const inspectDelivery = document.querySelector("#inspectDelivery");
const openDelivery = document.querySelector("#openDelivery");
const openController = document.querySelector("#openController");
const discardOrphan = document.querySelector("#discardOrphan");
const reason = document.querySelector("#discardReason");
const scopeSelect = document.querySelector("#deliveryScope"), scopedRecovery = document.querySelector("#scopedRecovery");
const selectDelivery = document.querySelector("#selectDelivery");
const inspectTabs = document.querySelector("#inspectTabs"), diagnosticTab = document.querySelector("#diagnosticTab");
const openDiagnosticTab = document.querySelector("#openDiagnosticTab"), tabDiagnosticDetail = document.querySelector("#tabDiagnosticDetail");
const confirmations = ["unresolvedConfirmed", "noResendConfirmed", "serverMissingConfirmed", "pageUnconfirmed"].map(id => document.querySelector("#" + id));
let inspection = null, refreshing = null;
let tabDiagnostics = [], currentTabId = null, currentExtensionVersion = null;
function send(message) { return chrome.runtime.sendMessage(message); }

function render(response) {
  if (!response?.ok) {
    status.textContent = "error"; status.className = "badge bad";
    detail.textContent = response?.error || "Extension service worker is unavailable.";
    return;
  }
  const state = response.state || {};
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
  detail.textContent = lines.join("\n");
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

function renderTabDiagnostic() {
  if (!diagnosticTab || !tabDiagnosticDetail || !openDiagnosticTab) return;
  const tab = tabDiagnostics.find(item => String(item.tabId) === diagnosticTab.value);
  openDiagnosticTab.disabled = !tab;
  if (!tab) return;
  const lines = [`tab ${tab.tabId}${tab.tabId === currentTabId ? " · 전송 소유 탭" : " · 별도 탭"}`, tab.url,
    `입력창: ${tab.composerPresent === true ? "있음" : tab.composerPresent === false ? "없음" : "확인 불가"}`,
    `상태: ${!tab.reachable ? "콘텐츠 응답 없음" : tab.busy || tab.generating ? "작업 또는 생성 중" : tab.ready ? "준비 확인됨" : "준비되지 않음"}`,
    `콘텐츠 ${tab.runtimeVersion ?? "확인되지 않음"} · 확장 ${currentExtensionVersion ?? "확인되지 않음"}`];
  if (tab.runtimeVersion && currentExtensionVersion && tab.runtimeVersion !== currentExtensionVersion) {
    lines.push("콘텐츠 버전이 다릅니다. 전송·생성 상태를 확인한 뒤 해당 탭을 새로고침하고 다시 진단하세요.");
  }
  if (tab.inspectionError) lines.push(`현재 진단: ${tab.inspectionError.code ?? "ERROR"}: ${tab.inspectionError.message ?? ""}`);
  if (tab.pageUrl && tab.pageUrl !== tab.url) lines.push("진단 중 문서 주소가 변경됐습니다. 상태를 다시 확인하세요.");
  lines.push("이 결과는 진단 시점의 상태입니다. 탭 열기는 바인딩 변경·전송·폐기를 수행하지 않습니다.");
  tabDiagnosticDetail.textContent = lines.join("\n");
}

function updateDiscard() {
  const page = inspection?.page;
  const unknownPage = !page?.reachable || page.busy !== false || page.generating !== false;
  discardOrphan.disabled = !(inspection?.server?.status === "MISSING" && !inspection.extensionBusy
    && !page?.busy && !page?.generating && confirmations.slice(0, 3).every(item => item.checked)
    && (!unknownPage || confirmations[3].checked) && reason.value.trim().length >= 3);
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
    tabDiagnosticDetail.textContent = response?.ok ? "열려 있는 ChatGPT 탭이 없습니다." : response?.error || "탭 진단에 실패했습니다.";
    renderTabDiagnostic();
  } catch (error) {
    tabDiagnostics = []; openDiagnosticTab.disabled = true; tabDiagnosticDetail.textContent = error.message;
  } finally { inspectTabs.disabled = false; }
});
diagnosticTab?.addEventListener("change", renderTabDiagnostic);
openDiagnosticTab?.addEventListener("click", async () => {
  const selected = tabDiagnostics.find(tab => String(tab.tabId) === diagnosticTab.value);
  if (!selected) return;
  try {
    const result = await send({ type: "bridge.openInspectedTab", payload: { tabId: selected.tabId, url: selected.url } });
    if (!result?.ok) tabDiagnosticDetail.textContent = result?.error || "탭을 열지 못했습니다.";
  } catch (error) { tabDiagnosticDetail.textContent = error.message; }
});
inspectDelivery.addEventListener("click", async () => {
  inspectDelivery.disabled = true;
  const response = await send({ type: "bridge.inspectDelivery" });
  inspection = response?.ok ? response.result : null;
  const phases = { ACK_PENDING: "응답 검증·저장 완료 · ACK 확인 대기", RESPONSE_OBSERVED: "응답 관측됨 · 서버 저장 여부 확인 필요", IN_FLIGHT: "활성 작업 있음", UNRESOLVED: "전송 결과 미확정", IDLE: "활성 전송 없음" };
  const servers = { MATCHED: "해당 전송 기록 있음 · 컨트롤러에서 복구 또는 폐기", MISSING: "대응 전송 기록 없음 · 확인 후 확장 기록 폐기 가능", MISMATCH: "전송 소유권 불일치 · 기록 보존", UNAVAILABLE: "서버 기록 확인 불가 · 기록 보존" };
  recoveryDetail.textContent = inspection ? `${phases[inspection.phase]}\n서버: ${servers[inspection.server?.status] ?? "확인 필요"}\n${JSON.stringify(inspection.owner, null, 2)}` : response?.error || "상태를 확인하지 못했습니다.";
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
  const result = await send({ type: "bridge.discardOrphanDelivery", payload: { ...inspection.owner,
    unresolvedResultConfirmed: confirmations[0].checked, noAutomaticResendConfirmed: confirmations[1].checked,
    serverMissingConfirmed: confirmations[2].checked, pageStateUnconfirmedConfirmed: confirmations[3].checked,
    reason: reason.value.trim() } });
  if (result?.ok) inspection = null;
  await refresh();
  recoveryDetail.textContent = result?.ok ? "확장에만 남은 전송을 폐기했습니다. 대상을 다시 준비하세요." : result?.error;
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "bridge.state") render({ ok: true, state: message.payload });
});
void refresh();
