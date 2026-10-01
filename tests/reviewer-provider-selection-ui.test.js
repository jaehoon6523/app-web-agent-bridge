import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");

test("reviewer provider selection is explicit, preparation-bound, and keeps preparation on ChatGPT", async () => {
  const [html, app, server] = await Promise.all([
    readFile(path.join(root, "public", "index.html"), "utf8"),
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "src", "server.js"), "utf8"),
  ]);

  assert.match(html, /id="judgeReviewerProvider"/u);
  assert.match(html, /id="criticReviewerProvider"/u);
  assert.match(html, /value="CLAUDE_WEB"/u);
  assert.match(html, /기존 ChatGPT 대화 URL \(선택\)/u);
  assert.match(app, /conversationUrl = \$\("conversationUrl"\)\.value\.trim\(\) \|\| "https:\/\/chatgpt\.com\/"/u);
  assert.match(app, /reviewers:\{\s*JUDGE:\{ provider:\$\("judgeReviewerProvider"\)\.value \},\s*CRITIC:\{ provider:\$\("criticReviewerProvider"\)\.value \}/su);
  assert.match(app, /workflow\.stage !== "START".*reviewerProvidersLocked/su);
  assert.match(app, /snapshot\?\.preflight\?\.project/su);
  assert.match(app, /candidate\.provider === reviewerBinding\.provider/su);
  assert.match(app, /\$\{candidate\.provider\} · tab/su);
  assert.match(server, /context\.reviewers \?\? auditSettings\.project\?\.reviewers/su);
});
