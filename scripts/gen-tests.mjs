#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const [, , specPath, setupsPath, outPath] = process.argv;
if (!specPath || !setupsPath || !outPath) {
  console.error("Usage: node scripts/gen-tests.mjs <spec.json> <setups.js> <out.test.js>");
  process.exit(1);
}

const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
const setupsFilename = basename(setupsPath);
const outFile = resolve(outPath);
let finalOutPath = outFile;
if (spec.status === "DISCOVERY") {
  if (!outFile.endsWith(".discovery.js")) {
    finalOutPath = outFile.replace(/(?:\.(?:gen\.)?test)?\.js$/, "") + ".discovery.js";
  }
  console.log("Discovery mode: output -> " + finalOutPath);
}

const header = `// AUTO-GENERATED — 직접 수정 금지
// spec: ${basename(specPath)}

import test from "node:test";
import assert from "node:assert/strict";
import { setups } from "./${setupsFilename}";

const SPEC = ${JSON.stringify(spec, null, 2)};

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
`;

let body = "\n// ── generated tests ──\n";
for (const t of spec.transitions) {
  const testId = `T-${spec.boundaryId}-${t.transitionId}`;
  const setupId = t.setupId ?? t.transitionId;
  const isDiscovery = t.expected.discovery && (t.expected.errorMessage === undefined || t.expected.errorMessage === null);
  if (isDiscovery) {
    body += `
test(${JSON.stringify(testId)}, async (t) => {
  const spec = specOf(${JSON.stringify(t.transitionId)});
  return withHeartbeat(t, ${JSON.stringify(testId)}, async () => {
    let observed = null;
    try {
      ({ observed } = await setups[${JSON.stringify(setupId)}](t, spec));
    } catch (err) {
      emitReceipt(t, { testId: ${JSON.stringify(testId)}, transitionId: spec.transitionId, observed, expected: spec.expected, result: "FAIL", note: err.message });
      throw err;
    }
    emitReceipt(t, { testId: ${JSON.stringify(testId)}, transitionId: spec.transitionId, observed, expected: spec.expected, result: "SPEC_TODO", note: "observed = " + JSON.stringify(observed) });
    assert.fail("SPEC_UPDATE_NEEDED [" + spec.transitionId + "]: observed = " + JSON.stringify(observed));
  });
});
`;
  } else {
    body += `
test(${JSON.stringify(testId)}, async (t) => {
  const spec = specOf(${JSON.stringify(t.transitionId)});
  return checkTransition(t, spec, ${JSON.stringify(testId)}, async () => await setups[${JSON.stringify(setupId)}](t, spec));
});
`;
  }
}
const footer = "\n" + (spec.retiredTransitions ?? []).map(rt => `// RETIRED: ${rt.transitionId} — ${rt.reason}`).join("\n") + "\n";
writeFileSync(finalOutPath, (header + body + footer).trimEnd() + "\n");
console.log("Generated:", finalOutPath);
console.log("Transitions:", spec.transitions.length, "(retired:", (spec.retiredTransitions ?? []).length, ")");
