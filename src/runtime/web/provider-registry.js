function canonicalChatGptUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.origin}${path}`;
}

function chatGptConversationId(value) {
  const canonical = canonicalChatGptUrl(value);
  if (!canonical) return null;
  const segments = new URL(canonical).pathname.split("/").filter(Boolean);
  const markerIndex = Math.max(segments.lastIndexOf("c"), segments.lastIndexOf("uc"));
  if (markerIndex < 0 || markerIndex + 1 >= segments.length) return null;
  const id = decodeURIComponent(segments[markerIndex + 1]);
  // ChatGPT can expose WEB:* briefly while a new conversation is being created.
  return id.length > 0 && !/^WEB:/iu.test(id) ? id : null;
}

export const CHATGPT_WEB_PROVIDER = Object.freeze({
  provider:"CHATGPT_WEB",
  rootUrl:"https://chatgpt.com/",
  canonicalize:canonicalChatGptUrl,
  conversationIdFromUrl:chatGptConversationId,
});

function validateProviderSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("Web conversation provider spec must be an object.");
  }
  if (typeof spec.provider !== "string" || !spec.provider) {
    throw new TypeError("Web conversation provider must have a non-empty provider ID.");
  }
  if (typeof spec.rootUrl !== "string" || !spec.rootUrl) {
    throw new TypeError(`${spec.provider} must define a rootUrl.`);
  }
  if (typeof spec.canonicalize !== "function" || typeof spec.conversationIdFromUrl !== "function") {
    throw new TypeError(`${spec.provider} must define canonicalize and conversationIdFromUrl functions.`);
  }
  if (spec.canonicalize(spec.rootUrl) !== spec.rootUrl) {
    throw new TypeError(`${spec.provider} rootUrl must already be canonical.`);
  }
  if (spec.conversationIdFromUrl(spec.rootUrl) !== null) {
    throw new TypeError(`${spec.provider} rootUrl must not resolve to a conversation ID.`);
  }
}

export function createWebConversationProviderRegistry(initialProviders = [CHATGPT_WEB_PROVIDER]) {
  const providers = new Map();

  function register(spec) {
    validateProviderSpec(spec);
    if (providers.has(spec.provider)) {
      throw new TypeError(`Web conversation provider ${spec.provider} is already registered.`);
    }
    for (const existing of providers.values()) {
      if (existing.canonicalize(spec.rootUrl) || spec.canonicalize(existing.rootUrl)) {
        throw new TypeError(`Web conversation provider URL space overlaps ${existing.provider}.`);
      }
    }
    const frozen = Object.freeze({
      provider:spec.provider,
      rootUrl:spec.rootUrl,
      canonicalize:spec.canonicalize,
      conversationIdFromUrl:spec.conversationIdFromUrl,
    });
    providers.set(frozen.provider, frozen);
    return frozen;
  }

  function provider(providerId) {
    return providers.get(providerId) ?? null;
  }

  function providerForUrl(value) {
    const matches = [...providers.values()].filter((spec) => spec.canonicalize(value) !== null);
    if (matches.length > 1) {
      throw new TypeError("Web conversation URL matches more than one provider.");
    }
    return matches[0] ?? null;
  }

  function canonicalize(value, providerId = null) {
    const spec = providerId ? provider(providerId) : providerForUrl(value);
    return spec?.canonicalize(value) ?? null;
  }

  function conversationIdFromUrl(value, providerId = null) {
    const spec = providerId ? provider(providerId) : providerForUrl(value);
    return spec?.conversationIdFromUrl(value) ?? null;
  }

  function isRootUrl(value, providerId = null) {
    const spec = providerId ? provider(providerId) : providerForUrl(value);
    return Boolean(spec && spec.canonicalize(value) === spec.rootUrl
      && spec.conversationIdFromUrl(value) === null);
  }

  for (const spec of initialProviders) register(spec);

  return Object.freeze({
    register,
    provider,
    providerForUrl,
    canonicalize,
    conversationIdFromUrl,
    isRootUrl,
    list:() => Object.freeze([...providers.values()]),
  });
}

export const defaultWebConversationProviderRegistry = createWebConversationProviderRegistry();
export const registerWebConversationProvider = (spec) => defaultWebConversationProviderRegistry.register(spec);
export const webConversationProvider = (providerId) => defaultWebConversationProviderRegistry.provider(providerId);
export const webConversationProviderForUrl = (value) => defaultWebConversationProviderRegistry.providerForUrl(value);
export const canonicalWebConversationUrl = (value, providerId = null) =>
  defaultWebConversationProviderRegistry.canonicalize(value, providerId);
export const extractWebConversationId = (value, providerId = null) =>
  defaultWebConversationProviderRegistry.conversationIdFromUrl(value, providerId);
export const isWebProviderRootUrl = (value, providerId = null) =>
  defaultWebConversationProviderRegistry.isRootUrl(value, providerId);
