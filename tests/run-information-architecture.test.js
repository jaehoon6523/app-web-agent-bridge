import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");

test("run dashboard separates primary, contextual, recovery, secondary and technical actions without cloning controls", async () => {
  const [html, app] = await Promise.all([
    readFile(path.join(root, "public", "index.html"), "utf8"),
    readFile(path.join(root, "public", "app.js"), "utf8"),
  ]);

  for (const id of ["runPrimaryTier","runContextTier","runRecoveryTier","runSecondaryTier","runTechnicalTier"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "gu")) ?? []).length, 1, id);
  }
  for (const id of ["applyCode","continueProject","submitDecision","retryRun","reviewDiscussionRecovery"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "gu")) ?? []).length, 1, id);
  }

  const discussionStart = html.indexOf('id="reviewDiscussionPanel"');
  const recoveryTier = html.indexOf('id="runRecoveryTier"');
  const discussionRecovery = html.indexOf('id="reviewDiscussionRecovery"');
  assert.ok(discussionStart >= 0 && recoveryTier > discussionStart);
  assert.ok(discussionRecovery > recoveryTier, "review discussion recovery must not remain nested in the discussion panel");

  assert.match(app, /primaryActionIds = Object\.freeze\(\["submitDecision", "applyCode", "continueProject", "retryRun"\]\)/u);
  assert.match(app, /run\?\.phase === "AWAITING_APPLY" \? "applyCode"/u);
  assert.match(app, /run\?\.phase === "APPLIED".*"continueProject"/su);
  assert.match(app, /!\$\("retryRun"\)\.disabled \? "retryRun"/u);
  assert.match(app, /runRecoveryTier.*reviewDiscussionRecovery.*reviewBindingRecoveryPanel.*recoveryPanel/su);

  const syncStart = app.indexOf("function syncRunInformationArchitecture");
  const syncEnd = app.indexOf("function selectProject", syncStart);
  const syncSource = app.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncSource, /cloneNode|addEventListener|fetch\(|localStorage|sessionStorage/u);
});
