(function exposeResponseText(root) {
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
    if (containerText.includes("CONTROLLER_PACKET_BEGIN") && containerText.length > best.length) {
      selectorTelemetry.set("messageContent", "messageContainer:packet");
      return containerText;
    }
    if (bestSelector) selectorTelemetry.set("messageContent", bestSelector);
    return best || containerText;
  }

  root.ChatGptBridgeResponseText = Object.freeze({ elementText });
})(globalThis);
