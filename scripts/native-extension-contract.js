// Explicit native boundaries required by the full verification gate.
export const nativeExtensionSteps = Object.freeze([
  'injection', 'diagnostic-export', 'window-resize', 'pending-reinjection',
  'worker-restart', 'navigation', 'extension-reload',
]);

export function nativeExtensionComplete(receipt) {
  return receipt?.nativeExtension === true && receipt.status === 'PASS' && receipt.completed === true
    && Array.isArray(receipt.steps) && receipt.steps.length === nativeExtensionSteps.length
    && new Set(receipt.steps.map(step => step.id)).size === nativeExtensionSteps.length
    && nativeExtensionSteps.every(id => receipt.steps.some(step => step.id === id && step.pass === true));
}

// Standalone callback for the real extension worker and the content-contract regression.
export async function sendNativePrompt({tabId,binding,text}) {
  const reply = await globalThis.chrome.tabs.sendMessage(tabId, {
    type:'agent.prompt',requestId:binding.currentDeliveryId,payload:{
      text,controllerMessageId:binding.currentDeliveryId,runId:binding.lastBoundRunId,
      expectedDocumentId:binding.documentId,expectedFrameId:binding.frameId,
      expectedConversationUrl:binding.conversationUrl,expectedConversationId:binding.conversationId,
      timeoutMs:60_000,stableMs:1000,
    },
  });
  if (!reply?.ok) throw new Error(`${reply?.code ?? 'NATIVE_PROMPT_REJECTED'}: ${reply?.error ?? reply?.message ?? 'Content script rejected the native prompt.'}`);
  return reply;
}

export const nativeFixtureHtml = `<!doctype html>
    <title>Native extension lifecycle fixture</title><main id="messages"></main>
    <textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
    <script>document.querySelector('button').onclick = () => {
      const article = document.createElement('article'); article.setAttribute('data-message-author-role', 'user'); article.id = 'u1';
      const body = document.createElement('div'); body.setAttribute('data-message-content', '');
      // Controlled markers must retain line boundaries in the rendered message.
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = document.querySelector('textarea').value;
      article.append(body); document.querySelector('main').append(article); document.querySelector('textarea').value = '';
      window.fixtureClicks = (window.fixtureClicks || 0) + 1;
    };</script>`;
