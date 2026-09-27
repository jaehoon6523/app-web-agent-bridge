(function exposeWebPageProviderRegistry(root) {
  const REQUIRED_METHODS = Object.freeze([
    "matches",
    "assertContract",
    "identifyPage",
    "detectAuthentication",
    "detectComposer",
    "readConversationIdentity",
    "readMessages",
    "findSendControl",
    "submitPrompt",
    "detectGeneration",
    "cancelGeneration",
    "extractAssistantResponse",
    "inspectPageState",
    "evidence",
    "resetEvidence",
    "mutationRoot",
    "canonicalizeUrl",
    "conversationIdFromUrl",
  ]);
  const providers = new Map();

  function validate(spec) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)
      || typeof spec.provider !== "string" || !spec.provider
      || typeof spec.rootUrl !== "string" || !spec.rootUrl) {
      throw new TypeError("Invalid Web page provider spec.");
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof spec[method] !== "function") {
        throw new TypeError(`Web page provider ${spec.provider} is missing ${method}().`);
      }
    }
    if (!spec.matches(spec.rootUrl)
      || spec.canonicalizeUrl(spec.rootUrl) !== spec.rootUrl
      || spec.conversationIdFromUrl(spec.rootUrl) !== null) {
      throw new TypeError(`Web page provider ${spec.provider} rootUrl is invalid.`);
    }
  }

  function register(spec) {
    validate(spec);
    if (providers.has(spec.provider)) {
      throw new TypeError(`Web page provider ${spec.provider} is already registered.`);
    }
    const frozen = Object.freeze({ ...spec });
    providers.set(frozen.provider, frozen);
    return frozen;
  }

  function resolve(url) {
    const matches = [...providers.values()].filter((provider) => provider.matches(url));
    if (matches.length > 1) {
      throw new TypeError("Web page URL matches more than one provider.");
    }
    return matches[0] ?? null;
  }

  root.WebBridgePageProviders = Object.freeze({
    register,
    resolve,
    provider:(providerId) => providers.get(providerId) ?? null,
    list:() => Object.freeze([...providers.values()]),
  });
})(globalThis);
