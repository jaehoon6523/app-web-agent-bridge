import assert from "node:assert/strict";
import test from "node:test";
import { bindingPresentation, showDashboardPageError, updateDashboardDiagnostics } from "../../public/dashboard-status-view.js";

test("binding presentation distinguishes bootstrap, exact binding and recovery", () => {
  const observed = { connected:true, webAuthenticated:true, workflowStage:"START" };
  assert.equal(bindingPresentation(observed).state, "unknown");
  assert.match(bindingPresentation(observed).detail, /준비 시작 시 연결/u);
  for (const bindingStatus of ["AMBIGUOUS", "NEEDS_REBIND", "DISCONNECTED"]) {
    const result = bindingPresentation({ ...observed, binding:{ bindingStatus } });
    assert.equal(result.state, "warn");
    assert.doesNotMatch(result.detail, /연결됨/u);
  }
  assert.equal(bindingPresentation({ ...observed, binding:{ bindingStatus:"BOUND" } }).state, "ok");
  assert.equal(bindingPresentation({ ...observed, connected:false, binding:{ bindingStatus:"BOUND" } }).state, "unknown");
});

test("diagnostics preserve runtime failure separately from successful HTTP state observation", () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const ids = ["dashboardAddress", "dashboardPhase", "dashboardErrorCode", "dashboardRuntimeDetail", "dashboardLastConfirmed", "connectionDiagnostics"];
  const elements = Object.fromEntries(ids.map(id => [id, { textContent:"", open:false }]));
  globalThis.document = { getElementById:id => elements[id] };
  globalThis.window = { location:{ origin:"http://127.0.0.1:8787" } };
  try {
    updateDashboardDiagnostics({ phase:"READY", connectionState:{ lastError:null }, lastConfirmed:null,
      snapshot:{ runtimeAvailability:{ ready:false, code:"LIVE_RUNTIME_READ_TIMEOUT", message:"Initialization pending." } } });
    assert.equal(elements.dashboardPhase.textContent, "최신 상태 확인 완료");
    assert.match(elements.dashboardRuntimeDetail.textContent, /LIVE_RUNTIME_READ_TIMEOUT/u);
    assert.equal(elements.connectionDiagnostics.open, true);
    assert.equal(elements.dashboardErrorCode.textContent, "없음");
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; }
});

test("fatal page failure blocks stale mutation buttons and offers reload", () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window, previousError = console.error;
  const elements = Object.fromEntries(["dashboardPageError", "dashboardPhase", "dashboardErrorCode", "refreshDashboard", "planRun", "applyCode"]
    .map(id => [id, { id, hidden:true, disabled:false, textContent:"" }]));
  let reloads = 0;
  globalThis.document = { getElementById:id => elements[id], querySelectorAll:() => [elements.refreshDashboard, elements.planRun, elements.applyCode] };
  globalThis.window = { location:{ reload:() => reloads++ } };
  console.error = () => {};
  try {
    showDashboardPageError(new Error("render failed"));
    assert.equal(elements.dashboardPageError.hidden, false);
    assert.equal(elements.planRun.disabled, true);
    assert.equal(elements.applyCode.disabled, true);
    assert.equal(elements.refreshDashboard.disabled, false);
    elements.refreshDashboard.onclick();
    assert.equal(reloads, 1);
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; console.error = previousError; }
});
