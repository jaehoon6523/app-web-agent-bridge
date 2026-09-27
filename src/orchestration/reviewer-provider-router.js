import {
  REVIEWER_ROLES,
  SUPPORTED_WEB_REVIEWER_PROVIDERS,
} from "./reviewer-settings.js";

function reviewerError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requireRole(role) {
  if (!REVIEWER_ROLES.includes(role)) {
    throw new TypeError("Reviewer role must be JUDGE or CRITIC.");
  }
  return role;
}

function requireProvider(provider, supportedProviders) {
  if (typeof provider !== "string" || !provider) {
    throw new TypeError("Reviewer provider must be a non-empty string.");
  }
  if (!supportedProviders.has(provider)) {
    throw reviewerError(
      `Reviewer provider ${provider} is not available in this runtime.`,
      "REVIEWER_PROVIDER_UNAVAILABLE",
    );
  }
  return provider;
}

export function createReviewerProviderRouter({
  adapterForProvider,
  supportedProviders = SUPPORTED_WEB_REVIEWER_PROVIDERS,
} = {}) {
  if (typeof adapterForProvider !== "function") {
    throw new TypeError("adapterForProvider(provider, role) is required.");
  }
  const supported = new Set(supportedProviders);
  if (supported.size === 0 || [...supported].some((provider) => typeof provider !== "string" || !provider)) {
    throw new TypeError("supportedProviders must contain provider IDs.");
  }

  function resolve(role, provider) {
    requireRole(role);
    requireProvider(provider, supported);
    const adapter = adapterForProvider(provider, role) ?? null;
    if (!adapter) {
      throw reviewerError(
        `${role} reviewer provider ${provider} has no available Web adapter.`,
        "REVIEWER_PROVIDER_UNAVAILABLE",
      );
    }
    const actualProvider = adapter.runtimeIdentity?.provider ?? null;
    if (actualProvider !== provider) {
      throw reviewerError(
        `${role} reviewer expected ${provider}, but the adapter reports ${actualProvider ?? "unknown"}.`,
        "REVIEWER_PROVIDER_MISMATCH",
      );
    }
    return adapter;
  }

  return Object.freeze({
    resolve,
    supports:(provider) => supported.has(provider),
    supportedProviders:Object.freeze([...supported]),
  });
}
