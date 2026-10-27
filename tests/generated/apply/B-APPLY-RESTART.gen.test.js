// AUTO-GENERATED — 직접 수정 금지
// spec: B-APPLY-RESTART.discovery.json

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { setups } = require("C:\\Users\\cjh\\_gemini\\test\\new_neo\\app-web-agent-bridge\\tests\\generated\\apply\\B-APPLY-RESTART.setups.mjs");

const SPEC = {
  "schemaVersion": 1,
  "boundaryId": "B-APPLY-RESTART",
  "boundaryRevision": 1,
  "evidenceType": "partial-integration",
  "transitions": [
    {
      "transitionId": "RESTART-AFTER-APPLYING",
      "expected": {
        "throws": false,
        "stageAfter": "APPLIED",
        "applicationAfter": {
          "status": "APPLIED"
        }
      }
    },
    {
      "transitionId": "RESTART-WORKER-RUNNING",
      "expected": {
        "throws": false,
        "stageAfter": "RECOVERY_REQUIRED",
        "errorMessage": "Server restarted during execution. No automatic resubmission or patch application."
      }
    },
    {
      "transitionId": "RESTART-AWAITING-APPLY",
      "expected": {
        "throws": false,
        "stageAfter": "AWAITING_APPLY"
      }
    },
    {
      "transitionId": "RESTART-APPLIED",
      "expected": {
        "throws": false,
        "stageAfter": "APPLIED",
        "applicationAfter": {
          "status": "APPLIED"
        }
      }
    }
  ],
  "retiredTransitions": [
    {
      "transitionId": "RESTART-TREE-DRIFT",
      "reason": "recover() reads actual Git tree, not stored application.result.tree. Stored record mutation has no effect."
    }
  ]
};

function specOf(tid) {
  const found = SPEC.transitions.find(t => t.transitionId === tid);
  if (!found) throw new Error("Transition not found: " + tid);
  return found;
}
async function withHeartbeat(t, testId, fn) {
  const start = Date.now();
  const iv = setInterval(() => { t.diagnostic("__HEARTBEAT__:" + JSON.stringify({ testId, elapsedMs: Date.now() - start })); }, 2000);
  try { return await fn(); } finally { clearInterval(iv); }
}
function emitReceipt(t, { testId, transitionId, observed, expected, result, note }) {
  t.diagnostic("__RECEIPT__:" + JSON.stringify({ testId, boundaryId: SPEC.boundaryId, transitionId, evidenceType: SPEC.evidenceType, observation: observed, expectation: expected, result, note: note ?? null }));
}
async function checkTransition(t, spec, testId, runFn) {
  return withHeartbeat(t, testId, async () => {
    const { observed } = await runFn(t, spec);
    const expected = spec.expected;
    try {
      if (expected.throws !== undefined) assert.equal(observed.threw, expected.throws);
      if (expected.errorCode) assert.equal(observed.errorCode, expected.errorCode);
      if (expected.errorMessage) assert.equal(observed.errorMessage, expected.errorMessage);
      if (expected.stageAfter && expected.stageAfter !== "unchanged") assert.equal(observed.actualStageAfter, String(expected.stageAfter).split(" ")[0]);
      if (expected.stageAfter === "unchanged") assert.equal(observed.stageUnchanged, true);
      if (expected.applicationAfter === "absent") assert.equal(observed.actualApplicationAfter ?? null, null);
      if (expected.applicationAfter === "unchanged") assert.equal(observed.applicationUnchanged, true);
      if (expected.applicationAfter?.status) assert.equal(observed.actualApplicationAfter?.status, expected.applicationAfter.status);
      if (expected.applicationAfter?.hasFields) for (const fld of expected.applicationAfter.hasFields) assert.ok(observed.actualApplicationAfter?.[fld] !== undefined, "application." + fld + " 누락");
      emitReceipt(t, { testId, transitionId: spec.transitionId, observed, expected, result: "PASS" });
    } catch (err) {
      emitReceipt(t, { testId, transitionId: spec.transitionId, observed, expected, result: "FAIL", note: err.message });
      throw err;
    }
  });
}

// ── generated tests ──

test("T-B-APPLY-RESTART-RESTART-AFTER-APPLYING", async (t) => {
  const spec = specOf("RESTART-AFTER-APPLYING");
  return checkTransition(t, spec, "T-B-APPLY-RESTART-RESTART-AFTER-APPLYING", async () => await setups["RESTART-AFTER-APPLYING"](t, spec));
});

test("T-B-APPLY-RESTART-RESTART-WORKER-RUNNING", async (t) => {
  const spec = specOf("RESTART-WORKER-RUNNING");
  return checkTransition(t, spec, "T-B-APPLY-RESTART-RESTART-WORKER-RUNNING", async () => await setups["RESTART-WORKER-RUNNING"](t, spec));
});

test("T-B-APPLY-RESTART-RESTART-AWAITING-APPLY", async (t) => {
  const spec = specOf("RESTART-AWAITING-APPLY");
  return checkTransition(t, spec, "T-B-APPLY-RESTART-RESTART-AWAITING-APPLY", async () => await setups["RESTART-AWAITING-APPLY"](t, spec));
});

test("T-B-APPLY-RESTART-RESTART-APPLIED", async (t) => {
  const spec = specOf("RESTART-APPLIED");
  return checkTransition(t, spec, "T-B-APPLY-RESTART-RESTART-APPLIED", async () => await setups["RESTART-APPLIED"](t, spec));
});

// RETIRED: RESTART-TREE-DRIFT — recover() reads actual Git tree, not stored application.result.tree. Stored record mutation has no effect.
