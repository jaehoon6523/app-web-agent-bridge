// AUTO-GENERATED — 직접 수정 금지
// spec: B-APPLY-INPUT.transitions.json

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { setups } = require("C:\\Users\\cjh\\_gemini\\test\\new_neo\\app-web-agent-bridge\\tests\\generated\\apply\\B-APPLY-INPUT.setups.mjs");

const SPEC = {
  "schemaVersion": 3,
  "boundaryId": "B-APPLY-INPUT",
  "boundaryRevision": 3,
  "evidenceType": "partial-integration",
  "entryPoint": "service.command",
  "transitions": [
    {
      "transitionId": "A-STAGE",
      "expected": {
        "throws": true,
        "errorMessage": "Command unavailable for this code change.",
        "stageAfter": "REVIEW_RUNNING",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "A-JOB",
      "expected": {
        "throws": true,
        "errorMessage": "Command unavailable for this code change.",
        "stageAfter": "AWAITING_APPLY",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "A-STOP",
      "expected": {
        "throws": true,
        "errorMessage": "Command unavailable for this code change.",
        "stageAfter": "unchanged",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "B-SCHEMA",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify a valid independently reviewed candidate.",
        "stageAfter": "AWAITING_APPLY",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "B-AUDIT",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify a valid independently reviewed candidate.",
        "stageAfter": "AWAITING_APPLY",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "C-CANDIDATE",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify the reviewed candidate.",
        "stageAfter": "unchanged",
        "applicationAfter": "absent"
      }
    },
    {
      "transitionId": "C-REVIEW",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify the reviewed candidate."
      }
    },
    {
      "transitionId": "C-ARTIFACT",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify the reviewed candidate."
      }
    },
    {
      "transitionId": "C-BASE",
      "expected": {
        "throws": true,
        "errorMessage": "Approval does not identify the reviewed candidate."
      }
    },
    {
      "transitionId": "C-VERSION",
      "expected": {
        "throws": true,
        "errorCode": "RUN_VERSION_CONFLICT",
        "errorMessage": "Run changed; refresh."
      }
    },
    {
      "transitionId": "D-PASS",
      "expected": {
        "throws": false,
        "stageAfter": "APPLIED",
        "applicationAfter": {
          "status": "APPLIED",
          "hasFields": [
            "applicationId",
            "candidateId",
            "reviewId",
            "baseCommit",
            "createdAt"
          ]
        }
      }
    },
    {
      "transitionId": "E-IDEMPOTENT",
      "expected": {
        "throws": true,
        "errorMessage": "Command unavailable for this code change.",
        "stageAfter": "APPLIED",
        "applicationAfter": "unchanged"
      }
    }
  ],
  "retiredTransitions": [
    {
      "transitionId": "B-REVIEW",
      "reason": "command()로 도달 불가."
    },
    {
      "transitionId": "B-TREE",
      "reason": "public API 조작으로 assert 실패 유도 불가."
    },
    {
      "transitionId": "B-MANIFEST",
      "reason": "B-TREE와 동일."
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

test("T-B-APPLY-INPUT-A-STAGE", async (t) => {
  const spec = specOf("A-STAGE");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-A-STAGE", async () => await setups["A-STAGE"](t, spec));
});

test("T-B-APPLY-INPUT-A-JOB", async (t) => {
  const spec = specOf("A-JOB");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-A-JOB", async () => await setups["A-JOB"](t, spec));
});

test("T-B-APPLY-INPUT-A-STOP", async (t) => {
  const spec = specOf("A-STOP");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-A-STOP", async () => await setups["A-STOP"](t, spec));
});

test("T-B-APPLY-INPUT-B-SCHEMA", async (t) => {
  const spec = specOf("B-SCHEMA");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-B-SCHEMA", async () => await setups["B-SCHEMA"](t, spec));
});

test("T-B-APPLY-INPUT-B-AUDIT", async (t) => {
  const spec = specOf("B-AUDIT");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-B-AUDIT", async () => await setups["B-AUDIT"](t, spec));
});

test("T-B-APPLY-INPUT-C-CANDIDATE", async (t) => {
  const spec = specOf("C-CANDIDATE");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-C-CANDIDATE", async () => await setups["C-CANDIDATE"](t, spec));
});

test("T-B-APPLY-INPUT-C-REVIEW", async (t) => {
  const spec = specOf("C-REVIEW");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-C-REVIEW", async () => await setups["C-REVIEW"](t, spec));
});

test("T-B-APPLY-INPUT-C-ARTIFACT", async (t) => {
  const spec = specOf("C-ARTIFACT");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-C-ARTIFACT", async () => await setups["C-ARTIFACT"](t, spec));
});

test("T-B-APPLY-INPUT-C-BASE", async (t) => {
  const spec = specOf("C-BASE");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-C-BASE", async () => await setups["C-BASE"](t, spec));
});

test("T-B-APPLY-INPUT-C-VERSION", async (t) => {
  const spec = specOf("C-VERSION");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-C-VERSION", async () => await setups["C-VERSION"](t, spec));
});

test("T-B-APPLY-INPUT-D-PASS", async (t) => {
  const spec = specOf("D-PASS");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-D-PASS", async () => await setups["D-PASS"](t, spec));
});

test("T-B-APPLY-INPUT-E-IDEMPOTENT", async (t) => {
  const spec = specOf("E-IDEMPOTENT");
  return checkTransition(t, spec, "T-B-APPLY-INPUT-E-IDEMPOTENT", async () => await setups["E-IDEMPOTENT"](t, spec));
});

// RETIRED: B-REVIEW — command()로 도달 불가.
// RETIRED: B-TREE — public API 조작으로 assert 실패 유도 불가.
// RETIRED: B-MANIFEST — B-TREE와 동일.
