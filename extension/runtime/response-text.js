(function exposeResponseText(root) {
  function isBarePreparationProposal(text) {
    if (!text.startsWith("{")) return false;
    try { return JSON.parse(text).type === "REQUIREMENTS_PROPOSAL"; }
    catch { return false; }
  }

  function elementText(element, selectors, selectorTelemetry) {
    let best = "";
    let bestSelector = null;
    for (const selector of selectors) {
      const matches = element.matches?.(selector) ? [element] : element.querySelectorAll?.(selector) ?? [];
      for (const preferred of matches) {
        if (!(preferred instanceof HTMLElement)) continue;
        const candidate = (preferred.innerText || preferred.textContent || "").trim();
        if (candidate.length > best.length) {
          best = candidate;
          bestSelector = selector;
        }
      }
    }
    const containerText = (element.innerText || element.textContent || "").trim();
    if (containerText.length > best.length && (containerText.includes("CONTROLLER_PACKET_BEGIN")
      || /^답변시작\r?$/mu.test(containerText) || isBarePreparationProposal(containerText))) {
      selectorTelemetry.set("messageContent", "messageContainer:packet");
      return containerText;
    }
    if (bestSelector) selectorTelemetry.set("messageContent", bestSelector);
    return best || containerText;
  }

  root.ChatGptBridgeResponseText = Object.freeze({ elementText });
})(globalThis);
