import assert from "node:assert/strict";
import test from "node:test";
import { createReviewerWebRuntime } from "../../src/orchestration/reviewer-web-runtime.js";
import { setupAudit } from "../helpers/audit-fixtures.js";

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

test("fault: expected Judge provider loss degrades only read projection and preserves established apply authority", async (t) => {
  const fixture = setupAudit(t, { reviewVerdicts:["SATISFIED"] });
  const run = await fixture.run();
  assert.equal(run.stage, "AWAITING_APPLY");
  const originalReviewerWeb = fixture.service.reviewerWeb;
  fixture.service.reviewerWeb = (role, expectedProvider = null) => {
    if (role === "JUDGE") throw Object.assign(new Error("Judge provider is unavailable."), { code:"REVIEWER_PROVIDER_UNAVAILABLE" });
    return originalReviewerWeb(role, expectedProvider);
  };
  const snapshot = await fixture.dashboard.snapshot(run.runId);
  assert.equal(snapshot.run.phase, "AWAITING_APPLY");
  assert.equal(snapshot.reviewerRuntimes.JUDGE.availability, "UNAVAILABLE");
  assert.equal(snapshot.reviewerRuntimes.JUDGE.errorCode, "REVIEWER_PROVIDER_UNAVAILABLE");
  assert.equal(snapshot.reviewerRuntimes.CRITIC.availability, "AVAILABLE");
  assert.ok(snapshot.evidence.length > 0);
  assert.ok(snapshot.commandCapabilities.includes("code.apply"));
  let current = fixture.service.get(run.runId);
  await assert.rejects(fixture.dashboard.executeDurable({ type:"code.review.discuss", requestId:"judge-discuss-provider-down",
    payload:{runId:current.runId,expectedVersion:current.version,role:"JUDGE",text:"Explain the completed review."} }),
    (error) => error?.code === "REVIEWER_PROVIDER_UNAVAILABLE");
  current = fixture.service.get(run.runId);
  const critic = await fixture.dashboard.executeDurable({ type:"code.review.discuss", requestId:"critic-discuss-provider-up",
    payload:{runId:current.runId,expectedVersion:current.version,role:"CRITIC",text:"Confirm the completed review context."} });
  assert.equal(critic.status, "DELIVERED");
});

test("fault: reviewer mismatch is role-local on read while unexpected exceptions still fail projection", async (t) => {
  const fixture = setupAudit(t, { reviewVerdicts:["SATISFIED"] });
  const run = await fixture.run();
  const originalReviewerWeb = fixture.service.reviewerWeb;
  fixture.service.reviewerWeb = (role, expectedProvider = null) => {
    if (role === "JUDGE") throw Object.assign(new Error("Judge adapter reports the wrong provider."), { code:"REVIEWER_PROVIDER_MISMATCH" });
    return originalReviewerWeb(role, expectedProvider);
  };
  const mismatch = await fixture.dashboard.snapshot(run.runId);
  assert.equal(mismatch.reviewerRuntimes.JUDGE.availability, "MISMATCH");
  assert.equal(mismatch.reviewerRuntimes.CRITIC.availability, "AVAILABLE");
  assert.ok(mismatch.commandCapabilities.includes("code.apply"));
  fixture.service.reviewerWeb = (role, expectedProvider = null) => {
    if (role === "JUDGE") throw new Error("unexpected reviewer projection failure");
    return originalReviewerWeb(role, expectedProvider);
  };
  await assert.rejects(fixture.dashboard.snapshot(run.runId), /unexpected reviewer projection failure/u);
});
