(() => {
  const registry = globalThis.ChatGptBridgeSelectors;
  if (!registry?.groups) throw new Error("Selector registry was not initialized");
  registry.groups.stopButton = Object.freeze([
    "button[data-testid='stop-button']",
    "button[aria-label='Stop generating']",
    "button[aria-label*='Stop']",
    "button[aria-label*='중지']",
  ]);
})();

