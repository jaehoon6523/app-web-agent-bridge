(() => {
  globalThis.ChatGptBridgeSelectors = {
    version: "2026-09-12.1",
    groups: Object.create(null),
    resolveFirst(group, queryAll, isEligible = () => true) {
      const selectors = this.groups[group];
      if (!Array.isArray(selectors)) return null;
      for (const selector of selectors) {
        const match = [...queryAll(selector)].find(isEligible);
        if (match) return { element: match, selector };
      }
      return null;
    },
  };
})();
