import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reviewerRoleSummary, reviewerRuntimeTechnicalSummary } from "../public/run-context-view.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");

test("run dashboard separates primary, contextual, recovery, secondary and technical actions without cloning controls", async () => {
  const [html, app, layout, context] = await Promise.all([
    readFile(path.join(root, "public", "index.html"), "utf8"),
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "public", "run-action-layout.js"), "utf8"),
    readFile(path.join(root, "public", "run-context-view.js"), "utf8"),
  ]);

  for (const id of ["runPrimaryTier","runContextTier","runRecoveryTier","runSecondaryTier","runTechnicalTier"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "gu")) ?? []).length, 1, id);
  }
  for (const id of ["applyCode","continueProject","submitDecision","retryRun","reviewDiscussionRecovery"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "gu")) ?? []).length, 1, id);
  }
  for (const id of ["runRoleSummary","runWorkerRole","runJudgeRole","runCriticRole"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "gu")) ?? []).length, 1, id);
  }

  const discussionStart = html.indexOf('id="reviewDiscussionPanel"');
  const recoveryTier = html.indexOf('id="runRecoveryTier"');
  const discussionRecovery = html.indexOf('id="reviewDiscussionRecovery"');
  assert.ok(discussionStart >= 0 && recoveryTier > discussionStart);
  assert.ok(discussionRecovery > recoveryTier, "review discussion recovery must not remain nested in the discussion panel");

  assert.match(app, /createRunActionLayout\(\{ \$, text \}\)/u);
  assert.match(app, /createRunContextView\(\{ \$, text, labels, terminal, folderName, workerIdentity \}\)/u);
  assert.match(layout, /primaryActionIds = Object\.freeze\(\["submitDecision", "applyCode", "continueProject", "retryRun"\]\)/u);
  assert.match(layout, /run\?\.phase === "AWAITING_APPLY" \? "applyCode"/u);
  assert.match(layout, /run\?\.phase === "APPLIED".*"continueProject"/su);
  assert.match(layout, /!\$\("retryRun"\)\.disabled \? "retryRun"/u);
  assert.match(layout, /runRecoveryTier.*reviewDiscussionRecovery.*reviewBindingRecoveryPanel.*recoveryPanel/su);
  assert.doesNotMatch(layout, /cloneNode|addEventListener|fetch\(|localStorage|sessionStorage/u);
  assert.doesNotMatch(context, /fetch\(|localStorage|sessionStorage/u);
});

test("run context presents mixed-provider reviewer roles without technical binding identifiers", () => {
  const run = {
    phase:"REVIEW_RUNNING",
    candidate:{ candidateId:"candidate-1" },
    reviewers:{ JUDGE:{ provider:"CLAUDE_WEB" }, CRITIC:{ provider:"CHATGPT_WEB" } },
    coordination:{ phase:"ROUND0", activeRole:"JUDGE", auditManifestHash:"manifest-1" },
    conversationBindings:[
      { role:"JUDGE", provider:"CLAUDE_WEB", bindingStatus:"BOUND", activeDeliveryId:null },
      { role:"CRITIC", provider:"CHATGPT_WEB", bindingStatus:"BOUND", activeDeliveryId:null },
    ],
    requests:[{
      role:"CRITIC", candidateId:"candidate-1", auditManifestHash:"manifest-1", status:"PROCESSED",
    }],
    reviewArtifacts:[],
    reviews:[],
  };
  const runtimes = {
    JUDGE:{ provider:"CLAUDE_WEB", providerEvidence:"ADAPTER_IMPLEMENTATION", model:null, modelEvidence:"UNOBSERVED" },
    CRITIC:{ provider:"CHATGPT_WEB", providerEvidence:"ADAPTER_IMPLEMENTATION", model:null, modelEvidence:"UNOBSERVED" },
  };
  const judge = reviewerRoleSummary(run, runtimes, "JUDGE");
  const critic = reviewerRoleSummary(run, runtimes, "CRITIC");
  assert.deepEqual(judge, { role:"JUDGE", provider:"Claude Web", status:"감사 중", tone:"ok running" });
  assert.deepEqual(critic, { role:"CRITIC", provider:"ChatGPT Web", status:"이번 감사 완료", tone:"ok" });
  assert.doesNotMatch(JSON.stringify([judge, critic]), /tabId|sessionId|bindingId|providerEvidence/u);

  const mismatch = reviewerRoleSummary({
    ...run,
    conversationBindings:[{ role:"JUDGE", provider:"CLAUDE_WEB" }],
  }, { JUDGE:{ provider:"CHATGPT_WEB" } }, "JUDGE");
  assert.equal(mismatch.status, "provider 불일치 · 확인 필요");
  assert.equal(mismatch.tone, "warn");

  const detail = reviewerRuntimeTechnicalSummary(runtimes);
  assert.match(detail, /Judge: provider CLAUDE_WEB/u);
  assert.match(detail, /Critic: provider CHATGPT_WEB/u);
  assert.match(detail, /provider 근거 ADAPTER_IMPLEMENTATION/u);
});
