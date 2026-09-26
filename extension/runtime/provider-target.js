function canonicalChatGptUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
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
  return id.length > 0 && !/^WEB:/iu.test(id) ? id : null;
}

export const CHATGPT_WEB_TARGET_PROVIDER = Object.freeze({
  provider:"CHATGPT_WEB",
  rootUrl:"https://chatgpt.com/",
  urlPatterns:Object.freeze(["https://chatgpt.com/*"]),
  canonicalize:canonicalChatGptUrl,
  conversationIdFromUrl:chatGptConversationId,
});

export function createWebTargetProviderRegistry(initialProviders = [CHATGPT_WEB_TARGET_PROVIDER]) {
  const providers = new Map();

  function register(spec) {
    if (!spec || typeof spec.provider !== "string" || !spec.provider
      || typeof spec.rootUrl !== "string" || !spec.rootUrl
      || !Array.isArray(spec.urlPatterns) || spec.urlPatterns.length === 0
      || typeof spec.canonicalize !== "function"
      || typeof spec.conversationIdFromUrl !== "function") {
      throw new TypeError("Invalid Web target provider spec.");
    }
    if (providers.has(spec.provider)) {
      throw new TypeError(`Web target provider ${spec.provider} is already registered.`);
    }
    if (spec.canonicalize(spec.rootUrl) !== spec.rootUrl
      || spec.conversationIdFromUrl(spec.rootUrl) !== null) {
      throw new TypeError(`${spec.provider} rootUrl is invalid.`);
    }
    for (const existing of providers.values()) {
      if (existing.canonicalize(spec.rootUrl) || spec.canonicalize(existing.rootUrl)) {
        throw new TypeError(`Web target provider URL space overlaps ${existing.provider}.`);
      }
    }
    const frozen = Object.freeze({
      provider:spec.provider,
      rootUrl:spec.rootUrl,
      urlPatterns:Object.freeze([...spec.urlPatterns]),
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
    if (matches.length > 1) throw new TypeError("Web target URL matches more than one provider.");
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

  for (const spec of initialProviders) register(spec);
  return Object.freeze({ register, provider, providerForUrl, canonicalize, conversationIdFromUrl,
    list:() => Object.freeze([...providers.values()]) });
}

export const defaultWebTargetProviderRegistry = createWebTargetProviderRegistry();

export function resolveWebTargetProvider({
  provider = null,
  conversationUrl = null,
  registry = defaultWebTargetProviderRegistry,
} = {}) {
  const byId = provider === null ? null
    : typeof provider === "string" && provider ? registry.provider(provider) : null;
  if (provider !== null && !byId) return null;
  const byUrl = conversationUrl === null ? null : registry.providerForUrl(conversationUrl);
  if (conversationUrl !== null && !byUrl) return null;
  if (byId && byUrl && byId.provider !== byUrl.provider) return null;
  return byId ?? byUrl ?? registry.provider(CHATGPT_WEB_TARGET_PROVIDER.provider);
}
