const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const controllerUrl = document.querySelector("#controllerUrl");
const sharedSecret = document.querySelector("#sharedSecret");
const save = document.querySelector("#save");
const reconnect = document.querySelector("#reconnect");
const legacyRecovery = document.querySelector("#legacyRecovery");
const clearLegacy = document.querySelector("#clearLegacy");

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function render(response) {
  if (!response?.ok) {
    status.textContent = "error";
    status.className = "badge bad";
    detail.textContent = response?.error || "Extension service worker is unavailable.";
    return;
  }
  const state = response.state || {};
  legacyRecovery.hidden = state.legacyTestDelivery !== true;
  status.textContent = state.connected
    ? (state.busy ? "busy" : "authenticated")
    : state.transportConnected
      ? "authenticating"
      : state.connecting
        ? "connecting"
        : "offline";
  status.className = `badge ${state.connected ? "ok" : "bad"}`;
  const bindingDetail = state.tabId
      ? `ChatGPT tab ${state.tabId} · ${state.bindingStatus}`
      : `Web session: ${state.bindingStatus || "NEEDS_REBIND"}`;
  const identityDetail = state.extensionIdentity
    ? ` · identity: ${state.extensionIdentity}`
    : "";
  detail.textContent = `${state.lastError || bindingDetail}${identityDetail}`;
  const identity = state.extensionIdentity || "확인되지 않음";
  const hasBoundTab = Number.isInteger(state.tabId) && state.bindingStatus === "BOUND";
  const bindingHealthy = state.connected === true && hasBoundTab && Boolean(state.extensionIdentity);
  status.textContent = bindingHealthy ? "BOUND" : status.textContent;
  status.className = `badge ${bindingHealthy ? "ok" : "bad"}`;
  detail.className = bindingHealthy ? "detail-ok" : "detail-error";
  const bindingSummary = Number.isInteger(state.tabId)
    ? `ChatGPT tab ${state.tabId} · ${state.bindingStatus || "NEEDS_REBIND"} · identity: ${identity}`
    : `ChatGPT tab 확인되지 않음 · ${state.bindingStatus || "NEEDS_REBIND"} · identity: ${identity}`;
  const reason = state.bindingRecovery?.message || state.bindingError || state.lastError
    || (state.bindingStatus !== "BOUND" ? `비활성화 이유: 현재 바인딩 상태가 ${state.bindingStatus || "NEEDS_REBIND"}입니다. 정확한 ChatGPT 탭을 다시 바인딩하세요.` : null)
    || (!state.connected ? "비활성화 이유: 컨트롤러 인증 또는 연결이 완료되지 않았습니다." : null)
    || (!state.extensionIdentity ? "비활성화 이유: 확장 identity가 아직 확인되지 않았습니다." : null);
  detail.textContent = reason ? `${bindingSummary}\n${reason}` : bindingSummary;
  if (state.connected && state.startTab?.ready) {
    status.textContent = "새 대화 시작 가능";
    status.className = "badge ok";
    detail.className = "detail-ok";
    detail.textContent = `ChatGPT tab ${state.startTab.tabId} · 새 대화 입력창 확인됨\n${state.bindingRecovery?.message || "https://chatgpt.com/에서 준비 대화를 시작할 수 있습니다."}`;
  }
  if (response.config) {
    controllerUrl.value = response.config.controllerUrl || "";
    sharedSecret.value = response.config.sharedSecret || "";
    sharedSecret.placeholder = response.config.hasSharedSecret
      ? "Stored — leave blank to keep"
      : "Required";
  }
}

async function refresh() {
  try {
    render(await send({ type: "bridge.getState" }));
  } catch (error) {
    render({ ok: false, error: error.message });
  }
}

save.addEventListener("click", async () => {
  detail.textContent = "";
  render(await send({
    type: "bridge.saveConfig",
    payload: {
      controllerUrl: controllerUrl.value,
      sharedSecret: sharedSecret.value,
    },
  }));
  await refresh();
});

clearLegacy.addEventListener("click", async () => {
  clearLegacy.disabled = true;
  const result = await send({ type: "bridge.clearLegacyTestDelivery" });
  if (result?.ok) await send({ type: "bridge.reconnect" });
  detail.textContent = result?.ok ? "오래된 전송을 삭제했습니다. 새 작업을 시작하세요." : (result?.error || "삭제하지 못했습니다.");
  await refresh();
  clearLegacy.disabled = false;
});

reconnect.addEventListener("click", async () => {
  await send({ type: "bridge.reconnect" });
  setTimeout(refresh, 300);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge.state") void refresh();
});

void refresh();
