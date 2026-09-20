(function exposeManualFollowupSelector(root) {
  function selectExplicitManualFollowup(messages, originalAssistantMessageId) {
    if (!Array.isArray(messages) || typeof originalAssistantMessageId !== "string" || !originalAssistantMessageId) {
      return Object.freeze({ status: "UNAVAILABLE" });
    }
    const originals = messages.filter((message) =>
      message?.role === "assistant" && message.id === originalAssistantMessageId);
    if (originals.length !== 1) return Object.freeze({ status: "UNAVAILABLE" });

    const original = originals[0];
    const trailing = messages
      .filter((message) => ["user", "assistant"].includes(message?.role)
        && Number.isFinite(message?.index) && message.index > original.index)
      .sort((a, b) => a.index - b.index);
    if (trailing.length === 0) return Object.freeze({ status: "NONE" });
    if (trailing.length === 1 && trailing[0].role === "user" && trailing[0].id) {
      return Object.freeze({ status: "WAITING", userMessageId: trailing[0].id });
    }
    if (trailing.length !== 2 || trailing[0].role !== "user" || trailing[1].role !== "assistant"
      || !trailing[0].id || !trailing[1].id) {
      return Object.freeze({ status: "AMBIGUOUS" });
    }
    return Object.freeze({
      status: "MATCHED",
      userMessageId: trailing[0].id,
      assistantMessageId: trailing[1].id,
    });
  }

  root.ChatGptBridgeManualFollowup = Object.freeze({
    selectExplicitManualFollowup,
  });
})(globalThis);
