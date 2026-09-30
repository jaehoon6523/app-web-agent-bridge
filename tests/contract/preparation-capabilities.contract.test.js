import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PreparationService, filterPreparationCapabilitiesForRuntimeContext } from "../../src/orchestration/preparation-service.js";

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

test("contract: unresolved preparation discard is not advertised while extension is unavailable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-preparation-capability-"));
  let available = true;
  const service = new PreparationService({
    filename:path.join(root, "preparations.sqlite"),
    web:{ onEvent:() => () => {} },
    available:() => available,
    assertStart:async () => {},
    approve:async () => {},
    findRun:async () => null,
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive:true, force:true });
  });
  service.data.currentId = "prep-capability";
  service.data.contexts["prep-capability"] = {
    preparationId:"prep-capability",
    lifecycle:"ACTIVE",
    state:"RECOVERY_REQUIRED",
    agreement:{ status:"DISCUSSING" },
    webSession:{ activeDeliveryId:"delivery-1" },
    deliveries:[{ deliveryId:"delivery-1", state:"DISPATCHING" }],
    error:{ code:"DELIVERY_RECOVERY_UNCONFIRMED" },
  };
  assert.ok(service.capabilities().includes("preparation.discard"));
  available = false;
  assert.ok(!service.capabilities().includes("preparation.discard"));
});


test("contract: preparation cancel advertises only executable local or Web recovery paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-preparation-cancel-capability-"));
  let available = true;
  const service = new PreparationService({
    filename:path.join(root, "preparations.sqlite"),
    web:{ onEvent:() => () => {} },
    available:() => available,
    assertStart:async () => {},
    approve:async () => {},
    findRun:async () => null,
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive:true, force:true });
  });
  service.data.currentId = "prep-cancel-capability";
  service.data.contexts["prep-cancel-capability"] = {
    preparationId:"prep-cancel-capability",
    lifecycle:"ACTIVE",
    state:"RECOVERY_REQUIRED",
    agreement:{ status:"DISCUSSING" },
    webSession:{ activeDeliveryId:"delivery-1" },
    deliveries:[{ deliveryId:"delivery-1", state:"RESPONSE_STARTED", response:"partial" }],
    diagnostics:{ canRecover:true },
    error:null,
  };
  assert.ok(service.capabilities().includes("preparation.cancel"));
  available = false;
  assert.ok(!service.capabilities().includes("preparation.cancel"));
  service.data.contexts["prep-cancel-capability"].webSession.activeDeliveryId = null;
  service.data.contexts["prep-cancel-capability"].diagnostics = null;
  assert.ok(service.capabilities().includes("preparation.cancel"),
    "local cancellation without an active delivery must not require the extension");
});
