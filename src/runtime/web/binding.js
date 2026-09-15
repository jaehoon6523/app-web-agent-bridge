import { WebBindingStatus, WebProtocolError, isPlainObject } from "./protocol.js";

export const WEB_SESSION_BINDING_FIELDS = Object.freeze([
  "sessionId",
  "runId",
  "tabId",
  "windowId",
  "documentId",
  "frameId",
  "conversationUrl",
  "conversationId",
  "title",
  "lastObservedUserMessageId",
  "lastObservedAssistantMessageId",
  "bindingStatus",
]);

const CHATGPT_HOSTS = new Set(["chatgpt.com"]);

function requireExactKeys(value, keys, label) {
  if (!isPlainObject(value)) {
    throw new WebProtocolError(`${label} must be a plain object`, "INVALID_WEB_SESSION_BINDING");
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new WebProtocolError(
        `${label} contains unsupported property ${JSON.stringify(key)}`,
        "INVALID_WEB_SESSION_BINDING",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new WebProtocolError(
        `${label} is missing ${JSON.stringify(key)}`,
        "INVALID_WEB_SESSION_BINDING",
      );
    }
  }
}

function requireString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new WebProtocolError(`${label} must be a non-empty string${nullable ? " or null" : ""}`, "INVALID_WEB_SESSION_BINDING");
  }
}

function requireInteger(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebProtocolError(`${label} must be a non-negative integer${nullable ? " or null" : ""}`, "INVALID_WEB_SESSION_BINDING");
  }
}

export function canonicalConversationUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname)) return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const normalizedPath = url.pathname.length > 1
    ? url.pathname.replace(/\/+$/, "")
    : url.pathname;
  return `${url.origin}${normalizedPath}`;
}

export function extractConversationId(value) {
  const canonical = canonicalConversationUrl(value);
  if (!canonical) return null;
  const pathname = new URL(canonical).pathname;
  const segments = pathname.split("/").filter(Boolean);
  const markerIndex = Math.max(segments.lastIndexOf("c"), segments.lastIndexOf("uc"));
  if (markerIndex < 0 || markerIndex + 1 >= segments.length) return null;
  const id = decodeURIComponent(segments[markerIndex + 1]);
  // ChatGPT can expose WEB:* briefly while a new conversation is being created.
  return id.length > 0 && !/^WEB:/iu.test(id) ? id : null;
}

export function validateWebSessionBinding(value) {
  requireExactKeys(value, WEB_SESSION_BINDING_FIELDS, "WebSessionBinding");
  requireString(value.sessionId, "WebSessionBinding.sessionId");
  requireString(value.runId, "WebSessionBinding.runId");
  requireInteger(value.tabId, "WebSessionBinding.tabId", { nullable: true });
  requireInteger(value.windowId, "WebSessionBinding.windowId", { nullable: true });
  requireString(value.documentId, "WebSessionBinding.documentId", { nullable: true });
  requireInteger(value.frameId, "WebSessionBinding.frameId", { nullable: true });
  if (["BOUND", "ROOT_READY"].includes(value.bindingStatus) && (!value.documentId || value.frameId !== 0)) {
    throw new WebProtocolError("A ready binding requires the current top-frame document", "INVALID_WEB_SESSION_BINDING");
  }
  requireString(value.conversationUrl, "WebSessionBinding.conversationUrl", { nullable: true });
  requireString(value.conversationId, "WebSessionBinding.conversationId", { nullable: true });
  requireString(value.title, "WebSessionBinding.title", { nullable: true });
  requireString(value.lastObservedUserMessageId, "WebSessionBinding.lastObservedUserMessageId", { nullable: true });
  requireString(value.lastObservedAssistantMessageId, "WebSessionBinding.lastObservedAssistantMessageId", { nullable: true });
  if (!Object.hasOwn(WebBindingStatus, value.bindingStatus)) {
    throw new WebProtocolError("WebSessionBinding.bindingStatus is invalid", "INVALID_WEB_SESSION_BINDING");
  }
  if (value.conversationUrl !== null) {
    const canonical = canonicalConversationUrl(value.conversationUrl);
    if (canonical === null || canonical !== value.conversationUrl) {
      throw new WebProtocolError(
        "WebSessionBinding.conversationUrl must be a canonical ChatGPT conversation URL",
        "INVALID_WEB_SESSION_BINDING",
      );
    }
    const urlId = extractConversationId(canonical);
    if (value.conversationId !== null && urlId !== value.conversationId) {
      throw new WebProtocolError(
        "WebSessionBinding conversation ID does not match its URL",
        "INVALID_WEB_SESSION_BINDING",
      );
    }
  }
  if (value.bindingStatus === "ROOT_READY" && (value.conversationUrl !== "https://chatgpt.com/" || value.conversationId !== null || value.tabId === null || value.windowId === null)) {
    throw new WebProtocolError("ROOT_READY requires a selected ChatGPT start tab", "INVALID_WEB_SESSION_BINDING");
  }
  if (value.bindingStatus === WebBindingStatus.BOUND) {
    if (
      value.tabId === null
      || value.windowId === null
      || value.conversationUrl === null
      || value.conversationId === null
    ) {
      throw new WebProtocolError(
        "A BOUND WebSessionBinding requires tab, window, conversation URL, and conversation ID",
        "INVALID_WEB_SESSION_BINDING",
      );
    }
  }
  return value;
}

export function createWebSessionBinding(value) {
  // Unprepared and persisted legacy bindings may omit document identity.
  if (isPlainObject(value)) value = { documentId: null, frameId: null, ...value };
  validateWebSessionBinding(value);
  return Object.freeze(structuredClone(value));
}

export function updateWebSessionBinding(current, patch) {
  validateWebSessionBinding(current);
  if (!isPlainObject(patch)) {
    throw new WebProtocolError("WebSessionBinding patch must be a plain object", "INVALID_WEB_SESSION_BINDING");
  }
  for (const key of Object.keys(patch)) {
    if (!WEB_SESSION_BINDING_FIELDS.includes(key)) {
      throw new WebProtocolError(`Unsupported WebSessionBinding patch field ${JSON.stringify(key)}`, "INVALID_WEB_SESSION_BINDING");
    }
    if (key === "sessionId" || key === "runId") {
      throw new WebProtocolError(`${key} is immutable`, "WEB_SESSION_IDENTITY_IMMUTABLE");
    }
  }
  return createWebSessionBinding({ ...current, ...structuredClone(patch) });
}

function tabObservation(tab) {
  const conversationUrl = canonicalConversationUrl(tab?.url);
  return {
    tab,
    conversationUrl,
    conversationId: extractConversationId(conversationUrl),
  };
}

export function selectExactConversationTab(tabs, binding) {
  validateWebSessionBinding(binding);
  if (!Array.isArray(tabs)) {
    throw new WebProtocolError("tabs must be an array", "INVALID_TAB_INVENTORY");
  }
  if (!binding.conversationUrl || !binding.conversationId) {
    return Object.freeze({ status: WebBindingStatus.NEEDS_REBIND, binding, tab: null });
  }
  const matches = tabs
    .map(tabObservation)
    .filter((entry) => (
      entry.conversationUrl === binding.conversationUrl
      && entry.conversationId === binding.conversationId
    ));
  if (matches.length === 0) {
    return Object.freeze({ status: WebBindingStatus.NEEDS_REBIND, binding, tab: null });
  }
  if (matches.length > 1) {
    return Object.freeze({ status: WebBindingStatus.AMBIGUOUS, binding, tab: null });
  }
  const { tab, conversationUrl, conversationId } = matches[0];
  if (!Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId)) {
    return Object.freeze({ status: WebBindingStatus.AMBIGUOUS, binding, tab: null });
  }
  const nextBinding = updateWebSessionBinding(binding, {
    tabId: tab.id,
    windowId: tab.windowId,
    conversationUrl,
    conversationId,
    title: typeof tab.title === "string" && tab.title.length > 0 ? tab.title : null,
    bindingStatus: WebBindingStatus.BOUND,
  });
  return Object.freeze({ status: WebBindingStatus.BOUND, binding: nextBinding, tab });
}

export function inspectConversationObservation(binding, observation) {
  validateWebSessionBinding(binding);
  const observedUrl = canonicalConversationUrl(observation?.conversationUrl ?? observation?.url);
  const observedId = observation?.conversationId ?? extractConversationId(observedUrl);
  if (!observedUrl || !observedId) {
    return Object.freeze({ ok: false, code: "CONVERSATION_UNRESOLVED" });
  }
  if (observedUrl !== binding.conversationUrl || observedId !== binding.conversationId) {
    return Object.freeze({
      ok: false,
      code: "MANUAL_INTERVENTION_DETECTED",
      observedConversationUrl: observedUrl,
      observedConversationId: observedId,
    });
  }
  return Object.freeze({ ok: true, code: "CONVERSATION_MATCHED" });
}
