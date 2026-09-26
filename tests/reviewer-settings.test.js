import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAuditProject } from "../src/orchestration/audit-project.js";
import {
  defaultReviewerConfiguration,
  validateReviewerConfiguration,
} from "../src/orchestration/reviewer-settings.js";
import { project } from "./helpers/audit-fixtures.js";

test("reviewer configuration defaults legacy projects to the currently supported Web reviewer", () => {
  assert.deepEqual(defaultReviewerConfiguration(), {
    JUDGE:{ provider:"CHATGPT_WEB" },
    CRITIC:{ provider:"CHATGPT_WEB" },
  });
  assert.deepEqual(validateReviewerConfiguration(undefined), {
    JUDGE:{ provider:"CHATGPT_WEB" },
    CRITIC:{ provider:"CHATGPT_WEB" },
  });
});

test("reviewer configuration rejects unsupported providers until a runtime actually supports them", () => {
  assert.throws(() => validateReviewerConfiguration({
    JUDGE:{ provider:"CHATGPT_WEB" },
    CRITIC:{ provider:"CLAUDE_WEB" },
  }), /CLAUDE_WEB.*not available/u);
});

test("audit project accepts legacy files without reviewers and normalizes an explicit reviewer contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-settings-"));
  try {
    const legacy = project(root);
    const normalizedLegacy = validateAuditProject(legacy);
    assert.deepEqual(normalizedLegacy.reviewers, {
      JUDGE:{ provider:"CHATGPT_WEB" },
      CRITIC:{ provider:"CHATGPT_WEB" },
    });
    const explicit = validateAuditProject({
      ...legacy,
      reviewers:{
        JUDGE:{ provider:"CHATGPT_WEB" },
        CRITIC:{ provider:"CHATGPT_WEB" },
      },
    });
    assert.deepEqual(explicit.reviewers, normalizedLegacy.reviewers);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
