import assert from "node:assert/strict";
import test from "node:test";

import { webConversationProviderForUrl } from "../src/runtime/web/provider-registry.js";
import { setupAudit } from "./helpers/audit-fixtures.js";

function claudeReviewerAdapter(chatGpt) {
  return {
    ...chatGpt,
    activeTurnId:null,
    activeBinding:null,
    runtimeIdentity:{
      ...chatGpt.runtimeIdentity,
      provider:"CLAUDE_WEB",
      providerEvidence:"ADAPTER_IMPLEMENTATION",
    },
    async resume({ binding }) {
      const conversationId = binding.conversationId ?? `claude-${binding.sessionId}`;
      this.activeBinding = {
        ...binding,
        tabId:71,
        windowId:7,
        documentId:`doc-${binding.sessionId}`,
        frameId:0,
        conversationUrl:binding.conversationUrl ?? `https://claude.ai/chat/${conversationId}`,
        conversationId,
        bindingStatus:"BOUND",
      };
      return this.activeBinding;
    },
  };
}

function setupMixedAudit(t, judgeProvider, criticProvider) {
  return setupAudit(t, {
    reviewVerdicts:["SATISFIED"],
    configure(project) {
      project.reviewers = {
        JUDGE:{ provider:judgeProvider },
        CRITIC:{ provider:criticProvider },
      };
    },
    reviewerWebProviderFactory(chatGpt) {
      return {
        CHATGPT_WEB:chatGpt,
        CLAUDE_WEB:claudeReviewerAdapter(chatGpt),
      };
    },
  });
}

function assertMixedProviderResult(run, expectedProviders) {
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  const independence = run.reviews.at(-1).reviewerIndependence;
  assert.equal(independence.roleSeparation, "VERIFIED");
  assert.equal(independence.sessionSeparation, "VERIFIED");
  assert.equal(independence.conversationSeparation, "VERIFIED");
  assert.equal(independence.providerSeparation, "VERIFIED");
  assert.deepEqual(
    independence.bindings.map((binding) => [binding.role, binding.provider]),
    [["JUDGE", expectedProviders.JUDGE], ["CRITIC", expectedProviders.CRITIC]],
  );
  assert.notEqual(independence.bindings[0].sessionId, independence.bindings[1].sessionId);
  assert.notEqual(independence.bindings[0].conversationId, independence.bindings[1].conversationId);

  const bindings = Object.fromEntries(
    run.conversationBindings.map((binding) => [binding.role, binding]),
  );
  for (const role of ["JUDGE", "CRITIC"]) {
    assert.equal(bindings[role].provider, expectedProviders[role]);
    assert.equal(
      webConversationProviderForUrl(bindings[role].conversationUrl)?.provider,
      expectedProviders[role],
    );
  }
}

test("mixed-provider audit routes Judge to ChatGPT and Critic to Claude through AWAITING_APPLY", async (t) => {
  const f = setupMixedAudit(t, "CHATGPT_WEB", "CLAUDE_WEB");
  const run = await f.run();

  assertMixedProviderResult(run, {
    JUDGE:"CHATGPT_WEB",
    CRITIC:"CLAUDE_WEB",
  });
  assert.equal(
    run.conversationBindings.find((binding) => binding.role === "JUDGE").conversationUrl,
    "https://chatgpt.com/c/test",
  );
  assert.match(
    run.conversationBindings.find((binding) => binding.role === "CRITIC").conversationUrl,
    /^https:\/\/claude\.ai\/chat\//u,
  );
});

test("mixed-provider audit routes Judge to Claude and Critic to ChatGPT through AWAITING_APPLY", async (t) => {
  const f = setupMixedAudit(t, "CLAUDE_WEB", "CHATGPT_WEB");
  const run = await f.run();

  assertMixedProviderResult(run, {
    JUDGE:"CLAUDE_WEB",
    CRITIC:"CHATGPT_WEB",
  });
  assert.match(
    run.conversationBindings.find((binding) => binding.role === "JUDGE").conversationUrl,
    /^https:\/\/claude\.ai\/chat\//u,
  );
  assert.equal(
    run.conversationBindings.find((binding) => binding.role === "CRITIC").conversationUrl,
    "https://chatgpt.com/c/critic",
  );
});
