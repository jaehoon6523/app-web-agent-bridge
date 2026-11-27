import assert from "node:assert/strict";
import test from "node:test";
import { patchFileExcerpt } from "../src/evidence/candidate-evidence.js";
import { CodeChangeService } from "../src/orchestration/code-change-service.js";

test("file lookup finds the first hunk beyond the initial page by either Git path", () => {
  const patch = [
    "diff --git a/other b/other", "--- a/other", "+++ b/other", "@@ -1,210 +0,0 @@",
    ...Array(210).fill("--- a/deleted.txt"),
    "diff --git a/deleted.txt b/deleted.txt", "--- a/deleted.txt", "+++ /dev/null",
    "@@ -1 +0,0 @@", "-deleted",
    "diff --git a/old name b/new name", "rename from old name", "rename to new name",
    "--- a/old name\t", "+++ b/new name\t", "@@ -1 +1 @@", "-old", "+new",
    'diff --git "a/\\303\\251" "b/\\303\\251"', '--- "a/\\303\\251"', '+++ "b/\\303\\251"',
    "@@ -1 +1 @@", "-before", "+after",
    "diff --git a/image b/image", "GIT binary patch",
  ].join("\n");
  const deleted = patchFileExcerpt(patch, "deleted.txt");
  assert.equal(deleted.startLine, 218);
  assert.match(deleted.content, /^@@ -1 \+0,0 @@\n-deleted/u);
  assert.equal(deleted.content, "@@ -1 +0,0 @@\n-deleted");
  assert.equal(deleted.omittedAfter, false);
  assert.equal(patchFileExcerpt(patch, "other").endLine, 203);
  const later = patchFileExcerpt(patch, "other", 204);
  assert.equal(later.startLine, 204);
  assert.equal(later.endLine, 214);
  assert.equal(later.omittedAfter, false);
  assert.equal(patchFileExcerpt(patch, "other", 215), null);
  assert.match(patchFileExcerpt(patch, "new name").content, /^@@ -1 \+1 @@\n-old/u);
  assert.deepEqual(patchFileExcerpt(patch, "old name"), patchFileExcerpt(patch, "new name"));
  assert.match(patchFileExcerpt(patch, "é").content, /^@@ -1 \+1 @@\n-before/u);
  assert.equal(patchFileExcerpt(patch, "image"), null);
  assert.equal(patchFileExcerpt(patch, "missing"), null);
});

test("file lookup uses only valid patch evidence for the current candidate", async () => {
  const evidence = { evidenceId:"patch", candidateId:"current", kind:"PATCH", contentRef:{sha256:"hash"} };
  const run = { version:1, candidate:{candidateId:"current", changedFiles:["file"]},
    evidence:[evidence, {...evidence, evidenceId:"old", candidateId:"previous"}] };
  const service = { get:() => run, artifactStore:{read:() =>
    Buffer.from("diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new")} };
  const lookup = (evidenceId, patchPath) => CodeChangeService.prototype.command.call(service, "evidence.get",
    {runId:"run", expectedVersion:1, evidenceId, patchPath});
  const result = await lookup("patch", "file");
  assert.equal(result.candidateId, "current");
  assert.equal(result.patchLocationFound, true);
  assert.equal(result.startLine, 4);
  await assert.rejects(lookup("old", "file"), /current candidate/u);
  await assert.rejects(lookup("patch", "unlisted"), /current candidate/u);
});
