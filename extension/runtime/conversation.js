const CHATGPT_HOSTS = new Set(["chatgpt.com"]);

export function canonicalChatGptUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname)) return null;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.origin}${path}`;
}

export function conversationIdFromUrl(value) {
  const canonical = canonicalChatGptUrl(value);
  if (!canonical) return null;
  const segments = new URL(canonical).pathname.split("/").filter(Boolean);
  const markerIndex = Math.max(segments.lastIndexOf("c"), segments.lastIndexOf("uc"));
  return markerIndex >= 0 && markerIndex + 1 < segments.length
    ? decodeURIComponent(segments[markerIndex + 1])
    : null;
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
