(() => {
  const registry = globalThis.ChatGptBridgeSelectors;
  if (!registry?.groups) throw new Error("Selector registry was not initialized");
  registry.groups.composer = Object.freeze([
    "#prompt-textarea",
    "#prompt-textarea[contenteditable='true'][role='textbox']",
    "[data-testid='composer'] [contenteditable='true']",
    "[contenteditable='true'][data-lexical-editor='true']",
    "form textarea",
  ]);
})();
