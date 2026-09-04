const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const controllerUrl = document.querySelector("#controllerUrl");
const sharedSecret = document.querySelector("#sharedSecret");
const save = document.querySelector("#save");
const reconnect = document.querySelector("#reconnect");

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

reconnect.addEventListener("click", async () => {
  await send({ type: "bridge.reconnect" });
  setTimeout(refresh, 300);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge.state") void refresh();
});

void refresh();
