import assert from "node:assert/strict";
import test from "node:test";
import {
  DashboardSessionState,
  ExtensionState,
  StateReadState,
  TransportState,
  WebBindingState,
  classifyDashboardFailure,
  dashboardStateReady,
  initialDashboardConnectionState,
  markDashboardSessionAuthenticated,
  markStateReadReady,
  projectBrowserState,
  requestFailureCode,
} from "../public/dashboard-connection-state.js";

function authenticated() {
  return markDashboardSessionAuthenticated(initialDashboardConnectionState());
}

test("dashboard session 403 is reachable but rejected, not server-down", () => {
  const state = classifyDashboardFailure(initialDashboardConnectionState(), "SESSION", {
    status:403, code:"LOCAL_BROWSER_REQUIRED", responseReceived:true,
  });
  assert.equal(state.transport, TransportState.REACHABLE);
  assert.equal(state.session, DashboardSessionState.REJECTED);
  assert.equal(dashboardStateReady(state), false);
});

test("state 401 marks auth invalid while preserving server reachability", () => {
  const state = classifyDashboardFailure(authenticated(), "STATE", {
    status:401, code:"DASHBOARD_AUTH_INVALID", responseReceived:true,
  });
  assert.equal(state.transport, TransportState.REACHABLE);
  assert.equal(state.session, DashboardSessionState.AUTH_INVALID);
  assert.equal(state.stateRead, StateReadState.FAILED);
});

test("state 503 is a state-read failure, not server-down", () => {
  const state = classifyDashboardFailure(authenticated(), "STATE", {
    status:503, responseReceived:true,
  });
  assert.equal(state.transport, TransportState.REACHABLE);
  assert.equal(state.session, DashboardSessionState.AUTHENTICATED);
  assert.equal(state.stateRead, StateReadState.FAILED);
});

test("GET/network failure can mark server unreachable without UNKNOWN_RESULT semantics", () => {
  const state = classifyDashboardFailure(authenticated(), "STATE", {
    code:"REQUEST_UNREACHABLE", responseReceived:false,
  });
  assert.equal(state.transport, TransportState.UNREACHABLE);
  assert.equal(state.stateRead, StateReadState.FAILED);
  assert.notEqual(state.lastError.code, "UNKNOWN_RESULT");
});

test("projection failure does not overwrite confirmed server reachability", () => {
  const state = classifyDashboardFailure(authenticated(), "PROJECTION", {
    status:200, code:"DASHBOARD_STATE_INVALID", responseReceived:true,
  });
  assert.equal(state.transport, TransportState.REACHABLE);
  assert.equal(state.stateRead, StateReadState.FAILED);
  assert.equal(state.runtimeError, "DASHBOARD_STATE_INVALID");
});


test("GET timeout is not UNKNOWN_RESULT while mutation timeout is", () => {
  assert.equal(requestFailureCode({ uncertainOnFailure:false, responseReceived:false }), "REQUEST_UNREACHABLE");
  assert.equal(requestFailureCode({ uncertainOnFailure:false, responseReceived:true }), "RESPONSE_READ_FAILED");
  assert.equal(requestFailureCode({ uncertainOnFailure:true, responseReceived:false }), "UNKNOWN_RESULT");
});


test("request semantics infer UNKNOWN_RESULT only for state-changing requests", () => {
  assert.equal(requestFailureCode({ url:"/api/state", method:"GET" }), "REQUEST_UNREACHABLE");
  assert.equal(requestFailureCode({ url:"/api/dashboard/session", method:"POST" }), "REQUEST_UNREACHABLE");
  assert.equal(requestFailureCode({ url:"/api/project/folder", method:"POST" }), "REQUEST_UNREACHABLE");
  assert.equal(requestFailureCode({ url:"/api/commands", method:"POST" }), "UNKNOWN_RESULT");
  assert.equal(requestFailureCode({ url:"/api/preparations/prep_1/approve", method:"POST" }), "UNKNOWN_RESULT");
});

test("all dashboard layers ready produce the derived ready projection", () => {
  const state = markStateReadReady(authenticated());
  assert.equal(state.transport, TransportState.REACHABLE);
  assert.equal(state.session, DashboardSessionState.AUTHENTICATED);
  assert.equal(state.stateRead, StateReadState.READY);
  assert.equal(dashboardStateReady(state), true);
});

test("extension and web binding project independently from dashboard transport", () => {
  const disconnected = projectBrowserState({ checks:{ extensionAuthenticated:false }, lastWebBinding:null });
  assert.equal(disconnected.extension, ExtensionState.DISCONNECTED);
  assert.equal(disconnected.binding, WebBindingState.UNKNOWN);

  const required = projectBrowserState({ checks:{ extensionAuthenticated:true }, lastWebBinding:null });
  assert.equal(required.extension, ExtensionState.AUTHENTICATED);
  assert.equal(required.binding, WebBindingState.REQUIRED);

  const bound = projectBrowserState({ checks:{ extensionAuthenticated:true }, lastWebBinding:{ bindingStatus:"BOUND" } });
  assert.equal(bound.binding, WebBindingState.BOUND);
});
