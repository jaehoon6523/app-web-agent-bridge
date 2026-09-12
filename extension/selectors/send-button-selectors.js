(() => {
  const registry = globalThis.ChatGptBridgeSelectors;
  if (!registry?.groups) throw new Error("Selector registry was not initialized");
  registry.groups.sendButton = Object.freeze([
    "button[data-testid='send-button']",
    "button[aria-label='Send prompt']",
    "button[aria-label='Send message']",
    "button[aria-label='보내기']",
    "form button[type='submit']",
  ]);

  // Not consumed by resolveSendButtonState() below yet — reserved so a future
  // change can distinguish "empty composer, dictation UI showing" from
  // "empty composer, no controls rendered at all" if that ever matters.
  registry.groups.dictationButton = Object.freeze([
    "button[aria-label='받아쓰기 시작']",
    "button[aria-label='Voice 시작']",
    "button[aria-label='Start voice input']",
    "button[aria-label*='Voice']",
  ]);

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function firstVisibleSendButton() {
    return registry.resolveFirst(
      "sendButton",
      (selector) => document.querySelectorAll(selector),
      isVisible,
    );
  }

  // Returns { state: "ENABLED" | "DISABLED" | "CONFIRMED_EMPTY_COMPOSER" | "UNKNOWN", selector? }
  registry.resolveSendButtonState = function resolveSendButtonState({ isComposerEmpty } = {}) {
    const match = firstVisibleSendButton();
    if (match) {
      const el = match.element;
      const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
      return { state: disabled ? "DISABLED" : "ENABLED", selector: match.selector };
    }
    if (typeof isComposerEmpty === "function" && isComposerEmpty()) {
      return { state: "CONFIRMED_EMPTY_COMPOSER" };
    }
    console.warn(
      "[Bridge] sendButton selector matched nothing while the composer is not confirmed empty — " +
      "selectors may be stale (UI_CONTRACT drift).",
    );
    return { state: "UNKNOWN" };
  };
})();
