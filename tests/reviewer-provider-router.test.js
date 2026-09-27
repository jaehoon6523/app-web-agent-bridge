import assert from "node:assert/strict";
import test from "node:test";

import { SessionProvider } from "../src/domain/vocabulary.js";
import { createReviewerProviderRouter } from "../src/orchestration/reviewer-provider-router.js";
import { SUPPORTED_WEB_REVIEWER_PROVIDERS } from "../src/orchestration/reviewer-settings.js";

function adapter(provider) {
  return Object.freeze({
    runtimeIdentity:Object.freeze({
      actor:"CHATGPT_WEB_AGENT",
      provider,
      providerEvidence:"ADAPTER_IMPLEMENTATION",
      model:null,
      modelEvidence:"UNOBSERVED",
    }),
  });
}

test("reviewer provider contract exposes both ChatGPT and Claude", () => {
  assert.equal(SessionProvider.CHATGPT_WEB, "CHATGPT_WEB");
  assert.equal(SessionProvider.CLAUDE_WEB, "CLAUDE_WEB");
  assert.deepEqual(SUPPORTED_WEB_REVIEWER_PROVIDERS, ["CHATGPT_WEB", "CLAUDE_WEB"]);
});

test("reviewer provider router resolves the requested provider for either reviewer role", () => {
  const adapters = new Map([
    ["CHATGPT_WEB", adapter("CHATGPT_WEB")],
    ["CLAUDE_WEB", adapter("CLAUDE_WEB")],
  ]);
  const router = createReviewerProviderRouter({
    adapterForProvider:(provider) => adapters.get(provider) ?? null,
  });

  assert.equal(router.resolve("JUDGE", "CHATGPT_WEB"), adapters.get("CHATGPT_WEB"));
  assert.equal(router.resolve("CRITIC", "CLAUDE_WEB"), adapters.get("CLAUDE_WEB"));
  assert.equal(router.supports("CLAUDE_WEB"), true);
});

test("reviewer provider router fails closed for unavailable or mismatched providers", () => {
  const unavailable = createReviewerProviderRouter({
    adapterForProvider:() => null,
  });
  assert.throws(
    () => unavailable.resolve("CRITIC", "CLAUDE_WEB"),
    (error) => error?.code === "REVIEWER_PROVIDER_UNAVAILABLE",
  );

  const mismatched = createReviewerProviderRouter({
    adapterForProvider:() => adapter("CHATGPT_WEB"),
  });
  assert.throws(
    () => mismatched.resolve("JUDGE", "CLAUDE_WEB"),
    (error) => error?.code === "REVIEWER_PROVIDER_MISMATCH",
  );

  assert.throws(() => mismatched.resolve("OBSERVER", "CHATGPT_WEB"), /JUDGE or CRITIC/u);
  assert.throws(
    () => mismatched.resolve("JUDGE", "UNKNOWN_WEB"),
    (error) => error?.code === "REVIEWER_PROVIDER_UNAVAILABLE",
  );
});
