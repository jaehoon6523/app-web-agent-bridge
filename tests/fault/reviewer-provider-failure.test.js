import assert from "node:assert/strict";
import test from "node:test";
import { createReviewerWebRuntime } from "../../src/orchestration/reviewer-web-runtime.js";

function adapter(provider) {
  return Object.freeze({
    activeTurnId:null,
    runtimeIdentity:Object.freeze({
      actor:"CHATGPT_WEB_AGENT",
      provider,
      providerEvidence:"ADAPTER_IMPLEMENTATION",
      model:null,
      modelEvidence:"UNOBSERVED",
    }),
  });
}

test("fault: one unavailable reviewer provider does not poison an unrelated available provider", () => {
  const chatGpt = adapter("CHATGPT_WEB");
  const runtime = createReviewerWebRuntime({
    webSession:chatGpt,
    reviewerWebProviders:{ CHATGPT_WEB:chatGpt },
    configuredProvider:(role) => role === "JUDGE" ? "CLAUDE_WEB" : "CHATGPT_WEB",
  });

  assert.throws(
    () => runtime.adapter("JUDGE"),
    (error) => error?.code === "REVIEWER_PROVIDER_UNAVAILABLE",
  );

  assert.equal(runtime.adapter("CRITIC"), chatGpt);
  assert.deepEqual(runtime.adapters(), [chatGpt]);
});

test("fault: provider mismatch fails the requested reviewer without rewriting provider identity", () => {
  const chatGpt = adapter("CHATGPT_WEB");
  const runtime = createReviewerWebRuntime({
    webSession:chatGpt,
    reviewerWebProviders:{ CLAUDE_WEB:chatGpt },
    configuredProvider:() => "CLAUDE_WEB",
  });

  assert.throws(
    () => runtime.adapter("JUDGE"),
    (error) => error?.code === "REVIEWER_PROVIDER_MISMATCH",
  );
  assert.equal(chatGpt.runtimeIdentity.provider, "CHATGPT_WEB");
});
