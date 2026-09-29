import assert from "node:assert/strict";
import test from "node:test";
import {
  DashboardSessionState,
  ExtensionState,
  StateReadState,
  TransportState,
  WebBindingState,
  initialDashboardConnectionState,
  markDashboardSessionAuthenticated,
  markStateReadReady,
  projectBrowserState,
  projectDashboardKnowledge,
} from "../../public/dashboard-connection-state.js";

function readyDashboard() {
  return markStateReadReady(
    markDashboardSessionAuthenticated(initialDashboardConnectionState()),
  );
}

test("contract: extension disconnect does not downgrade HTTP, dashboard auth, or state-read knowledge", () => {
  const dashboard = projectDashboardKnowledge(readyDashboard());
  const browser = projectBrowserState({
    checks:{ extensionAuthenticated:false },
    lastWebBinding:null,
  });

  assert.deepEqual(dashboard, {
    transport:{
      state:TransportState.REACHABLE,
      currentlyReachable:true,
    },
    session:{
      lastKnownState:DashboardSessionState.AUTHENTICATED,
      currentlyVerified:true,
    },
    stateRead:{
      state:StateReadState.READY,
      currentlyAvailable:true,
    },
  });
  assert.deepEqual(browser, {
    extension:ExtensionState.DISCONNECTED,
    binding:WebBindingState.UNKNOWN,
  });
});

test("contract: missing binding is distinct from extension disconnect", () => {
  const missing = projectBrowserState({
    checks:{ extensionAuthenticated:true },
    lastWebBinding:null,
  });
  assert.deepEqual(missing, {
    extension:ExtensionState.AUTHENTICATED,
    binding:WebBindingState.REQUIRED,
  });

  const bound = projectBrowserState({
    checks:{ extensionAuthenticated:true },
    lastWebBinding:{ bindingStatus:"BOUND" },
  });
  assert.deepEqual(bound, {
    extension:ExtensionState.AUTHENTICATED,
    binding:WebBindingState.BOUND,
  });
});
