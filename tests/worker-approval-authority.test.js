import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createWorkerApprovalAuthority } from "../src/orchestration/worker-approval-authority.js";

test("worker approval authority accepts workspace-bound command and file changes", () => {
  const root = path.resolve("fixture-worktree");
  const authority = createWorkerApprovalAuthority(root);

  assert.equal(authority.decide({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/commandExecution/requestApproval",
    cwd: root,
    availableDecisions: ["accept", "cancel"],
  }), "accept");

  authority.observe({
    type: "TOOL_STARTED",
    toolType: "fileChange",
    itemId: "file-1",
    changes: [{ path: path.join(root, "src", "index.js") }],
  });

  assert.equal(authority.decide({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/fileChange/requestApproval",
    itemId: "file-1",
    availableDecisions: ["accept", "decline", "cancel"],
  }), "accept");
});

test("worker approval authority fails closed for uncorrelated, escaped, and network approvals", () => {
  const root = path.resolve("fixture-worktree");
  const authority = createWorkerApprovalAuthority(root);

  assert.equal(authority.decide({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/fileChange/requestApproval",
    itemId: "missing",
    availableDecisions: ["accept", "cancel"],
  }), "cancel");

  authority.observe({
    type: "TOOL_STARTED",
    toolType: "fileChange",
    itemId: "escaped",
    changes: [{ path: path.resolve(root, "..", "outside.txt") }],
  });

  assert.equal(authority.decide({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/fileChange/requestApproval",
    itemId: "escaped",
    availableDecisions: ["accept", "decline"],
  }), "decline");

  assert.equal(authority.decide({
    type: "APPROVAL_REQUESTED",
    sourceMethod: "item/commandExecution/requestApproval",
    cwd: root,
    networkApprovalContext: { host: "example.com" },
    availableDecisions: ["accept", "cancel"],
  }), "cancel");
});
