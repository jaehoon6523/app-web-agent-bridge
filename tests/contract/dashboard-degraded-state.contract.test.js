import assert from "node:assert/strict";
import test from "node:test";
import {
  DashboardSessionState,
  StateReadState,
  TransportState,
  classifyDashboardFailure,
  connectionNoticeFor,
  initialDashboardConnectionState,
  markDashboardSessionAuthenticated,
  markStateReadReady,
  projectDashboardKnowledge,
  requestFailureCode,
} from "../../public/dashboard-connection-state.js";

function authenticated() {
  return markDashboardSessionAuthenticated(initialDashboardConnectionState());
}

function ready() {
  return markStateReadReady(authenticated());
}

test("contract: received state 503 keeps transport/auth currently verified while state becomes unavailable", () => {
  const state = classifyDashboardFailure(authenticated(), "STATE", {
    status:503,
    responseReceived:true,
  });
  assert.deepEqual(projectDashboardKnowledge(state), {
    transport:{
      state:TransportState.REACHABLE,
      currentlyReachable:true,
    },
    session:{
      lastKnownState:DashboardSessionState.AUTHENTICATED,
      currentlyVerified:true,
    },
    stateRead:{
      state:StateReadState.FAILED,
      currentlyAvailable:false,
    },
  });
  const notice = connectionNoticeFor(state, "09:00");
  assert.match(notice, /상태 조회 실패/u);
  assert.doesNotMatch(notice, /서버 응답 없음|UNKNOWN_RESULT|npm start/u);
});

test("contract: network failure preserves last-known auth without claiming current verification", () => {
  const state = classifyDashboardFailure(authenticated(), "STATE", {
    code:"REQUEST_UNREACHABLE",
    responseReceived:false,
  });
  assert.equal(state.session, DashboardSessionState.AUTHENTICATED,
    "transport loss is not evidence that the last-known authenticated session was revoked");
  assert.deepEqual(projectDashboardKnowledge(state), {
    transport:{
      state:TransportState.UNREACHABLE,
      currentlyReachable:false,
    },
    session:{
      lastKnownState:DashboardSessionState.AUTHENTICATED,
      currentlyVerified:false,
    },
    stateRead:{
      state:StateReadState.FAILED,
      currentlyAvailable:false,
    },
  });
  assert.equal(requestFailureCode({
    url:"/api/state",
    method:"GET",
    responseReceived:false,
  }), "REQUEST_UNREACHABLE");
  const notice = connectionNoticeFor(state, "09:00");
  assert.match(notice, /서버 응답 없음/u);
  assert.doesNotMatch(notice, /UNKNOWN_RESULT/u);
});

test("contract: malformed HTTP 200 keeps transport/auth currently verified but marks state projection unavailable", () => {
  const state = classifyDashboardFailure(ready(), "PROJECTION", {
    status:200,
    code:"DASHBOARD_STATE_INVALID",
    responseReceived:true,
  });
  assert.deepEqual(projectDashboardKnowledge(state), {
    transport:{
      state:TransportState.REACHABLE,
      currentlyReachable:true,
    },
    session:{
      lastKnownState:DashboardSessionState.AUTHENTICATED,
      currentlyVerified:true,
    },
    stateRead:{
      state:StateReadState.FAILED,
      currentlyAvailable:false,
    },
  });
  assert.equal(state.runtimeError, "DASHBOARD_STATE_INVALID");
  const notice = connectionNoticeFor(state, "09:00");
  assert.match(notice, /상태 응답 해석 실패/u);
  assert.doesNotMatch(notice, /서버 응답 없음|UNKNOWN_RESULT|npm start/u);
});
