(() => {
  const registry = globalThis.ChatGptBridgeSelectors;
  if (!registry?.groups) throw new Error("Selector registry was not initialized");
  registry.groups.message = Object.freeze([
    "[data-message-author-role]",
    "article [data-message-author-role]",
  ]);
  registry.groups.messageContainer = Object.freeze([
    "[data-message-id]",
    "[data-turn-id][data-testid^='conversation-turn-']",
    "article[data-testid^='conversation-turn-']",
    "article",
  ]);
  registry.groups.messageContent = Object.freeze([
    "[data-testid='collapsible-user-message-content']",
    "[data-message-content]",
    ".markdown",
    "[class*='markdown']",
  ]);
})();
