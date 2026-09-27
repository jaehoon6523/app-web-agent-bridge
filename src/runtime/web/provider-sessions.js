import { ChatGptWebSessionAdapter, WebSessionAdapter } from "./session-adapter.js";

export function createReviewerWebProviderSessions({
  transport,
  chatGptSession = null,
  responseTimeoutMs = 300_000,
} = {}) {
  const chatGpt = chatGptSession ?? new ChatGptWebSessionAdapter({
    transport,
    responseTimeoutMs,
  });
  if (chatGpt.runtimeIdentity?.provider !== "CHATGPT_WEB") {
    throw Object.assign(
      new Error("The shared preparation session must be a CHATGPT_WEB adapter."),
      { code:"REVIEWER_PROVIDER_MISMATCH" },
    );
  }
  return Object.freeze({
    CHATGPT_WEB:chatGpt,
    CLAUDE_WEB:new WebSessionAdapter({
      transport,
      provider:"CLAUDE_WEB",
      responseTimeoutMs,
    }),
  });
}
