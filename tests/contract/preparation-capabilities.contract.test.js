import assert from "node:assert/strict";
import test from "node:test";
import { filterPreparationCapabilitiesForRuntimeContext } from "../../src/orchestration/preparation-service.js";

const capabilities = [
  "preparation.start",
  "preparation.cancel",
  "preparation.reply",
  "preparation.approve",
  "web.inspect",
];

test("contract: runtime loss disables only runtime-dependent preparation actions", () => {
  assert.deepEqual(filterPreparationCapabilitiesForRuntimeContext({
    capabilities,
    runtimeAvailable:false,
    showingRun:false,
    canStart:true,
  }), [
    "preparation.cancel",
    "preparation.reply",
    "web.inspect",
  ]);
});

test("contract: an unfinished run blocks preparation.start without broad shutdown", () => {
  assert.deepEqual(filterPreparationCapabilitiesForRuntimeContext({
    capabilities,
    runtimeAvailable:true,
    showingRun:false,
    canStart:false,
  }), [
    "preparation.cancel",
    "preparation.reply",
    "preparation.approve",
    "web.inspect",
  ]);
});

test("contract: preparation actions do not leak while a run view is authoritative", () => {
  assert.deepEqual(filterPreparationCapabilitiesForRuntimeContext({
    capabilities,
    runtimeAvailable:true,
    showingRun:true,
    canStart:true,
  }), []);
});
