import {
  CHATGPT_WEB_TARGET_PROVIDER,
  defaultWebTargetProviderRegistry,
} from "./provider-target.js";

export { CHATGPT_WEB_TARGET_PROVIDER, createWebTargetProviderRegistry } from "./provider-target.js";

export function canonicalChatGptUrl(value) {
  return defaultWebTargetProviderRegistry.canonicalize(value, CHATGPT_WEB_TARGET_PROVIDER.provider);
}

export function conversationIdFromUrl(value) {
  return defaultWebTargetProviderRegistry.conversationIdFromUrl(value, CHATGPT_WEB_TARGET_PROVIDER.provider);
}

export function matchExactConversationTabs(tabs, { conversationUrl, conversationId }) {
  const expectedUrl = canonicalChatGptUrl(conversationUrl);
  if (!expectedUrl || !conversationId || !Array.isArray(tabs)) {
    return Object.freeze({ status: "NEEDS_REBIND", tab: null });
  }
  const matches = tabs.filter((tab) => (
    canonicalChatGptUrl(tab?.url) === expectedUrl
    && conversationIdFromUrl(tab?.url) === conversationId
  ));
  if (matches.length === 0) return Object.freeze({ status: "NEEDS_REBIND", tab: null });
  if (matches.length > 1) return Object.freeze({ status: "AMBIGUOUS", tab: null });
  return Object.freeze({ status: "BOUND", tab: matches[0] });
}

export function validateLocalControllerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Controller URL is invalid");
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new TypeError("Controller URL must use ws:// or wss://");
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new TypeError("Controller URL must target the local machine");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Controller URL must not contain credentials, query parameters, or fragments");
  }
  return url.href;
}
