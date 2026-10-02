import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { DashboardController } from "../src/orchestration/dashboard-controller.js";
import { DEFAULT_DASHBOARD_RUNTIME_READ_TIMEOUT_MS, MAX_DASHBOARD_RUNTIME_READ_TIMEOUT_MS } from "../src/domain/dashboard-read-policy.js";

test("dashboard runtime read policy has a documented default and accepts an environment override", () => {
  assert.equal(DEFAULT_DASHBOARD_RUNTIME_READ_TIMEOUT_MS, 2000);
  assert.equal(loadConfig({env:{}}).dashboard.runtimeReadTimeoutMs, 2000);
  assert.equal(loadConfig({env:{DASHBOARD_RUNTIME_READ_TIMEOUT_MS:"4000"}}).dashboard.runtimeReadTimeoutMs, 4000);
  assert.equal(loadConfig({env:{DASHBOARD_RUNTIME_READ_TIMEOUT_MS:"750"}}).dashboard.runtimeReadTimeoutMs, 750);
});

test("invalid read deadlines fail configuration and controller construction", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, MAX_DASHBOARD_RUNTIME_READ_TIMEOUT_MS + 1, 5000, 10000, 20000, 2147483647]) {
    assert.throws(() => loadConfig({env:{DASHBOARD_RUNTIME_READ_TIMEOUT_MS:String(value)}}), /DASHBOARD_RUNTIME_READ_TIMEOUT_MS/u);
    assert.throws(() => new DashboardController({getRuntime:async()=>({}), runtimeReadTimeoutMs:value}), RangeError);
  }
});

test("an injected read deadline accepts initialization that finishes before its budget", async () => {
  let timer;
  const live = {store:{listRuns:()=>[]},composition:{}};
  const controller = new DashboardController({
    runtimeReadTimeoutMs:1000, preflight:()=>({}),
    getRuntime:()=>new Promise(resolve=>{timer=setTimeout(()=>resolve(live),25);}),
  });
  try { assert.equal((await controller.snapshot()).runtimeAvailability.ready,true); }
  finally { clearTimeout(timer); }
});


test("configuration rejects sub-operational budgets while controller injection permits short tests", () => {
  for (const value of [1, 25, 99]) {
    assert.throws(() => loadConfig({env:{DASHBOARD_RUNTIME_READ_TIMEOUT_MS:String(value)}}), /DASHBOARD_RUNTIME_READ_TIMEOUT_MS/u);
    assert.doesNotThrow(() => new DashboardController({getRuntime:async()=>({}),runtimeReadTimeoutMs:value}));
  }
  assert.equal(loadConfig({env:{DASHBOARD_RUNTIME_READ_TIMEOUT_MS:"100"}}).dashboard.runtimeReadTimeoutMs,100);
});
