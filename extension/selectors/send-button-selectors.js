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
})();

