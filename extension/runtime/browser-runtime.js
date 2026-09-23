import { canonicalChatGptUrl } from "./conversation.js";

class BrowserRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentScriptFiles(chromeApi) {
  const entry = chromeApi.runtime.getManifest().content_scripts?.find((item) =>
    Array.isArray(item.matches) && item.matches.includes("https://chatgpt.com/*"),
  );
  if (!Array.isArray(entry?.js) || entry.js.length === 0) {
    throw new BrowserRuntimeError(
      "CONTENT_SCRIPT_CONFIG_INVALID",
      "ChatGPT content script configuration is missing.",
    );
  }
  return entry.js;
}

export function createBrowserRuntime(chromeApi) {
  async function focusTab(tab) {
    await chromeApi.windows.update(tab.windowId, { focused: true });
    await chromeApi.tabs.update(tab.id, { active: true });
  }

  async function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false) {
    const deadline = Date.now() + timeoutMs;
    let contentScriptResponded = false;
    let injectionAttempted = false;
    while (Date.now() < deadline) {
      try {
        const response = await chromeApi.tabs.sendMessage(tabId, { type: "agent.ping" });
        if (response?.ok) contentScriptResponded = true;
        if (response?.ok && (!requireComposer || response.ready)) return response;
        if (response?.pageStatus && !["READY", "UI_CONTRACT_CHANGED"].includes(response.pageStatus)) {
          throw new BrowserRuntimeError(response.pageStatus, response.message || response.pageStatus);
        }
      } catch (error) {
        if (error instanceof BrowserRuntimeError) throw error;
        if (!injectionAttempted) {
          injectionAttempted = true;
          const tab = await chromeApi.tabs.get(tabId).catch(() => null);
          if (canonicalChatGptUrl(tab?.url)) {
            await chromeApi.scripting.executeScript({
              target: { tabId, frameIds: [0] },
              files: contentScriptFiles(chromeApi),
            }).catch(() => null);
          }
        }
      }
      await sleep(350);
    }
    throw new BrowserRuntimeError(
      contentScriptResponded && requireComposer ? "UI_CONTRACT_CHANGED" : "CONTENT_SCRIPT_UNAVAILABLE",
      contentScriptResponded && requireComposer
        ? "ChatGPT composer is unavailable in the bound conversation."
        : "ChatGPT content script is unavailable in the bound conversation.",
    );
  }

  return { focusTab, waitForContentScript };
}
