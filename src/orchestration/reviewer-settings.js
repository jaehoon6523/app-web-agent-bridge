import { exactObject } from "../domain/audit-contract.js";

export const REVIEWER_ROLES = Object.freeze(["JUDGE", "CRITIC"]);
export const SUPPORTED_WEB_REVIEWER_PROVIDERS = Object.freeze(["CHATGPT_WEB"]);

const DEFAULT_REVIEWER_CONFIGURATION = Object.freeze({
  JUDGE:Object.freeze({ provider:"CHATGPT_WEB" }),
  CRITIC:Object.freeze({ provider:"CHATGPT_WEB" }),
});

export function defaultReviewerConfiguration() {
  return structuredClone(DEFAULT_REVIEWER_CONFIGURATION);
}

export function validateReviewerConfiguration(value, {
  supportedProviders = SUPPORTED_WEB_REVIEWER_PROVIDERS,
} = {}) {
  const reviewers = value == null ? defaultReviewerConfiguration() : value;
  exactObject(reviewers, REVIEWER_ROLES);
  const supported = new Set(supportedProviders);
  const normalized = {};
  for (const role of REVIEWER_ROLES) {
    exactObject(reviewers[role], ["provider"]);
    const provider = reviewers[role].provider;
    if (typeof provider !== "string" || !provider.trim()) {
      throw new TypeError(`reviewers.${role}.provider must be a non-empty string.`);
    }
    if (!supported.has(provider)) {
      throw new TypeError(`reviewers.${role}.provider ${provider} is not available in this runtime.`);
    }
    normalized[role] = { provider };
  }
  return normalized;
}
