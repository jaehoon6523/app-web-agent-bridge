import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Serialized into the installed extension's existing content-script world.
export async function sendOnlyInPage(text, rootUrl) {
  const provider = globalThis.WebBridgePageProviders?.provider('CHATGPT_WEB');
  const originalDocument = document;
  const assertTarget = () => {
    if (document !== originalDocument || location.href !== rootUrl || window !== window.top) {
      throw new Error('Expected the original top-level regular ChatGPT start page.');
    }
  };
  assertTarget();
  provider?.assertContract();
  if (provider?.detectComposer().empty !== true || provider.detectGeneration()) {
    throw new Error('Expected an empty, idle ChatGPT composer.');
  }
  if (!text.trim() || globalThis.bridgeSendOnlyAttempted) {
    throw new Error('Expected a nonempty prompt and no prior send-only attempt in this document.');
  }
  globalThis.bridgeSendOnlyAttempted = true;
  await provider.submitPrompt(text, AbortSignal.timeout(50_000), { assertCanMutate: assertTarget });
  return { status: 'SEND_CLICK_RETURNED' };
}

export function buildSendOnlyCommand(tabId, text) {
  if (!Number.isSafeInteger(tabId) || tabId < 1 || !text.trim()) {
    throw new Error('Expected a positive Chrome tab ID and a nonempty prompt file.');
  }
  return `(async () => {
    const tabId = ${tabId};
    const rootUrl = "https://chatgpt.com/";
    const tab = await chrome.tabs.get(tabId);
    if (tab.url !== rootUrl || tab.pendingUrl || tab.discarded) throw new Error("Expected a ready regular ChatGPT start tab.");
    const state = await chrome.storage.local.get(["currentDeliveryId", "tabId", "deliveryScopes"]);
    const owners = [state, ...Object.values(state.deliveryScopes ?? {})];
    if (owners.some(owner => owner.currentDeliveryId && (owner.tabId == null || owner.tabId === tabId))) {
      throw new Error("The bridge has an active delivery on this tab or an unresolved tab binding.");
    }
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "ISOLATED",
      func: ${sendOnlyInPage.toString()},
      args: [${JSON.stringify(text)}, rootUrl],
    });
    if (execution?.result?.status !== "SEND_CLICK_RETURNED") throw new Error("Send result unconfirmed. Do not retry.");
    return execution.result;
  })()`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , tabId, promptFile] = process.argv;
  if (!tabId || !promptFile) throw new Error('Usage: node scripts/chatgpt-send-only.mjs <tab-id> <prompt-file>');
  // The generated command is for the extension service worker console.
  process.stdout.write(buildSendOnlyCommand(Number(tabId), await readFile(promptFile, 'utf8')) + '\n');
}
