import assert from "node:assert/strict";
import test from "node:test";

import { initialBinding } from "../src/orchestration/audit-round.js";
import { createReviewerWebRuntime } from "../src/orchestration/reviewer-web-runtime.js";

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

test("reviewer Web runtime routes configured roles to provider-bound adapters", () => {
  const chatGpt = adapter("CHATGPT_WEB");
  const claude = adapter("CLAUDE_WEB");
  const configured = { JUDGE:"CLAUDE_WEB", CRITIC:"CHATGPT_WEB" };
  const runtime = createReviewerWebRuntime({
    webSession:chatGpt,
    reviewerWebProviders:{ CHATGPT_WEB:chatGpt, CLAUDE_WEB:claude },
    configuredProvider:(role) => configured[role],
  });

  assert.equal(runtime.adapter("JUDGE"), claude);
  assert.equal(runtime.adapter("CRITIC"), chatGpt);
  assert.equal(runtime.adapter("JUDGE", "CHATGPT_WEB"), chatGpt);
  assert.equal(runtime.adapters().length, 2);
});

test("Judge reuses preparation only for ChatGPT while Claude Judge and Critic bootstrap independently", () => {
  const run = {
    runId:"run-provider-routing",
    conversationUrl:"https://chatgpt.com/c/preparation",
    conversationId:"preparation",
  };
  const at = "2026-09-27T00:00:00.000Z";
  const chatGpt = adapter("CHATGPT_WEB").runtimeIdentity;
  const claude = adapter("CLAUDE_WEB").runtimeIdentity;

  const chatGptJudge = initialBinding(run, "JUDGE", at, chatGpt);
  assert.equal(chatGptJudge.conversationId, "preparation");

  const claudeJudge = initialBinding(run, "JUDGE", at, claude);
  assert.equal(claudeJudge.conversationUrl, null);
  assert.equal(claudeJudge.conversationId, null);

  const critic = initialBinding(run, "CRITIC", at, chatGpt);
  assert.equal(critic.conversationUrl, null);
  assert.equal(critic.conversationId, null);
});
