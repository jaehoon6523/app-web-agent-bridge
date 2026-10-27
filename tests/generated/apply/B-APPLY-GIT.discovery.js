// AUTO-GENERATED — 직접 수정 금지
// spec: B-APPLY-GIT.discovery.json

import test from "node:test";
import assert from "node:assert/strict";
import { setups } from "./B-APPLY-GIT.setups.mjs";

const SPEC = {
  "schemaVersion": 1,
  "boundaryId": "B-APPLY-GIT",
  "boundaryRevision": 0,
  "status": "DISCOVERY",
  "boundaryDefinition": "GitChangeWorkspace.apply({capture, targetRoot}) — 실제 대상 Git에 patch 적용. 상태 판정은 targetApplicationState가 담당.",
  "evidenceType": "partial-integration",
  "entryPoint": "GitChangeWorkspace.apply",
  "transitions": [
    {
      "transitionId": "GIT-APPLY-NORMAL",
      "setupId": "GIT-APPLY-NORMAL",
      "expected": {
        "discovery": true
      }
    },
    {
      "transitionId": "GIT-APPLY-BASE-DRIFT",
      "setupId": "GIT-APPLY-BASE-DRIFT",
      "expected": {
        "discovery": true
      }
    },
    {
      "transitionId": "GIT-APPLY-DIRTY-TARGET",
      "setupId": "GIT-APPLY-DIRTY-TARGET",
      "expected": {
        "discovery": true
      }
    },
    {
      "transitionId": "GIT-STATE-APPLIED",
      "setupId": "GIT-STATE-APPLIED",
      "expected": {
        "discovery": true
      }
    },
    {
      "transitionId": "GIT-STATE-NOT-APPLIED",
      "setupId": "GIT-STATE-NOT-APPLIED",
      "expected": {
        "discovery": true
      }
    },
    {
      "transitionId": "GIT-STATE-AMBIGUOUS",
      "setupId": "GIT-STATE-AMBIGUOUS",
      "expected": {
        "discovery": true
      }
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
  t.diagnostic("__RECEIPT__:" + JSON.stringify({ receiptSchemaVersion: 1, testId, boundaryId: SPEC.boundaryId, boundaryRevision: SPEC.boundaryRevision, transitionId, evidenceType: SPEC.evidenceType, observation: observed, expectation: expected, result, note: note ?? null }));
}
async function checkTransition(t, spec, testId, runFn) {
  return withHeartbeat(t, testId, async () => {
    let observed = null;
    const expected = spec.expected;
    try {
      ({ observed } = await runFn(t, spec));
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

test("T-B-APPLY-GIT-GIT-APPLY-NORMAL", async (t) => {
  const spec = specOf("GIT-APPLY-NORMAL");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-APPLY-NORMAL", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-APPLY-NORMAL"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-NORMAL", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-NORMAL", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});

test("T-B-APPLY-GIT-GIT-APPLY-BASE-DRIFT", async (t) => {
  const spec = specOf("GIT-APPLY-BASE-DRIFT");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-APPLY-BASE-DRIFT", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-APPLY-BASE-DRIFT"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-BASE-DRIFT", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-BASE-DRIFT", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});

test("T-B-APPLY-GIT-GIT-APPLY-DIRTY-TARGET", async (t) => {
  const spec = specOf("GIT-APPLY-DIRTY-TARGET");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-APPLY-DIRTY-TARGET", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-APPLY-DIRTY-TARGET"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-DIRTY-TARGET", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-APPLY-DIRTY-TARGET", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});

test("T-B-APPLY-GIT-GIT-STATE-APPLIED", async (t) => {
  const spec = specOf("GIT-STATE-APPLIED");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-STATE-APPLIED", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-STATE-APPLIED"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-APPLIED", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-APPLIED", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});

test("T-B-APPLY-GIT-GIT-STATE-NOT-APPLIED", async (t) => {
  const spec = specOf("GIT-STATE-NOT-APPLIED");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-STATE-NOT-APPLIED", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-STATE-NOT-APPLIED"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-NOT-APPLIED", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-NOT-APPLIED", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});

test("T-B-APPLY-GIT-GIT-STATE-AMBIGUOUS", async (t) => {
  const spec = specOf("GIT-STATE-AMBIGUOUS");
  return withHeartbeat(t, "T-B-APPLY-GIT-GIT-STATE-AMBIGUOUS", async () => {
    let observed = null;
    try {
      ({ observed } = await setups["GIT-STATE-AMBIGUOUS"](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-AMBIGUOUS", transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: "T-B-APPLY-GIT-GIT-STATE-AMBIGUOUS", transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});
