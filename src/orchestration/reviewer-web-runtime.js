import { createReviewerProviderRouter } from "./reviewer-provider-router.js";

export function createReviewerWebRuntime({
  webSession,
  reviewerWebSessions = null,
  reviewerWebProviders = null,
  configuredProvider = () => null,
} = {}) {
  if (typeof configuredProvider !== "function") {
    throw new TypeError("configuredProvider(role) must be a function.");
  }
  const sessions = Object.freeze({
    JUDGE:reviewerWebSessions?.JUDGE ?? webSession,
    CRITIC:reviewerWebSessions?.CRITIC ?? webSession,
  });
  const providers = Object.freeze({ ...(reviewerWebProviders ?? {}) });
  const router = createReviewerProviderRouter({
    adapterForProvider:(provider, role) => {
      const roleAdapter = sessions[role] ?? null;
      if (roleAdapter?.runtimeIdentity?.provider === provider) return roleAdapter;
      return providers[provider] ?? null;
    },
  });

  function adapter(role, expectedProvider = null) {
    const provider = expectedProvider
      ?? configuredProvider(role)
      ?? sessions[role]?.runtimeIdentity?.provider
      ?? null;
    if (!provider) {
      throw Object.assign(new Error(`${role} Web reviewer provider is unavailable.`), {
        code:"REVIEWER_PROVIDER_UNAVAILABLE",
      });
    }
    return router.resolve(role, provider);
  }

  function adapters() {
    return [...new Set([
      ...Object.values(sessions),
      ...Object.values(providers),
    ].filter(Boolean))];
  }

  return Object.freeze({ adapter, adapters, sessions, providers });
}
