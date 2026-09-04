import assert from "node:assert/strict";
import test from "node:test";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";

function stubStore({ runs, sessions = {}, deliveries = {}, approvals = {} }) {
  return {
    listRuns: () => structuredClone(runs),
    listAgentSessions: (runId) => structuredClone(sessions[runId] ?? []),
    listDeliveries: (runId) => structuredClone(deliveries[runId] ?? []),
    listApprovals: ({ runId }) => structuredClone(approvals[runId] ?? []),
  };
}

test("startup recovery scan finds active turns, uncertain delivery, disconnect, and approval", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-1",
      version: 7,
      phase: "CODEX_TURN_RUNNING",
      activeActor: "CODEX_AGENT",
    }],
    sessions: {
      "run-1": [{
        actor: "CHATGPT_WEB_AGENT",
        sessionId: "web-session",
        status: "DISCONNECTED",
        activeTurnId: null,
      }],
    },
    deliveries: {
      "run-1": [{
        deliveryId: "delivery-1",
        messageId: "message-1",
        state: "SUBMITTED",
        attemptCount: 1,
      }],
    },
    approvals: {
      "run-1": [{ approvalId: "approval-1", status: "PENDING", scopeHash: "sha256:x" }],
    },
  }));

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons.map((item) => item.type), [
    "TURN_RUNNING",
    "DELIVERY_UNCERTAIN",
    "SESSION_DISCONNECTED",
    "APPROVAL_PENDING",
  ]);
  assert(Object.isFrozen(findings));
  assert(Object.isFrozen(findings[0].reasons));
});

test("startup recovery scan does not reinterpret stable waiting state as recovery", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-stable",
      version: 2,
      phase: "CODEX_TURN_PENDING",
      activeActor: null,
    }],
    sessions: {
      "run-stable": [{
        actor: "CODEX_AGENT",
        sessionId: "codex-session",
        status: "READY",
        activeTurnId: null,
      }],
    },
    deliveries: {
      "run-stable": [{
        deliveryId: "delivery-complete",
        messageId: "message-complete",
        state: "RELAYED",
        attemptCount: 1,
      }],
    },
  }));
  assert.deepEqual(findings, []);
});

test("a completed provider response that has not been relayed requires recovery", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{ runId: "run-relay-pending", version: 3, phase: "CODEX_RESPONSE_STORED", activeActor: null }],
    deliveries: {
      "run-relay-pending": [{
        deliveryId: "delivery-response-complete",
        messageId: "message-response-complete",
        state: "RESPONSE_COMPLETED",
        attemptCount: 1,
      }],
    },
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reasons[0].type, "DELIVERY_UNCERTAIN");
  assert.equal(findings[0].reasons[0].state, "RESPONSE_COMPLETED");
});

test("startup recovery scan fails closed when the store lacks a required query", () => {
  assert.throws(
    () => scanStartupRecovery({ listRuns() { return []; } }),
    /listAgentSessions/u,
  );
});
