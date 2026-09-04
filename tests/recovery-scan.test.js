import assert from "node:assert/strict";
import test from "node:test";
import { scanStartupRecovery } from "../src/orchestration/recovery-scan.js";

function stubStore({
  runs,
  sessions = {},
  deliveries = {},
  approvals = {},
  recoveries = {},
  limits = {},
  messages = {},
  rejections = {},
}) {
  return {
    listRuns: () => structuredClone(runs),
    listAgentSessions: (runId) => structuredClone(sessions[runId] ?? []),
    listDeliveries: (runId) => structuredClone(deliveries[runId] ?? []),
    listApprovals: ({ runId }) => structuredClone(approvals[runId] ?? []),
    listRecoveryOperations: ({ runId }) => structuredClone(recoveries[runId] ?? []),
    getRunLimits: (runId) => structuredClone(limits[runId] ?? {
      limits: { maxDeliveryAttempts: 3 },
    }),
    getAgentMessageByInput: (inputId) => structuredClone(messages[inputId] ?? null),
    getAgentPacketRejectionByDelivery: (deliveryId) => (
      structuredClone(rejections[deliveryId] ?? null)
    ),
  };
}

test("startup recovery scan finds active turns, uncertain delivery, disconnect, and approval", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-1",
      version: 7,
      phase: "CODEX_TURN_RUNNING",
      activeActor: "CODEX_AGENT",
      blocker: { type: "RUNTIME_APPROVAL", approvalId: "approval-1" },
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
        inputId: "input-1",
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
        inputId: "input-complete",
        state: "RELAYED",
        attemptCount: 1,
      }],
    },
  }));
  assert.deepEqual(findings, []);
});

test("startup recovery scan finds the pending operation bound to a recovery blocker", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-recovery",
      version: 5,
      phase: "RECOVERY_REQUIRED",
      activeActor: null,
      blocker: {
        type: "RECOVERY_CONFIRMATION",
        operationId: "operation-recovery",
      },
    }],
    recoveries: {
      "run-recovery": [{
        operationId: "operation-recovery",
        status: "PENDING",
        detailsHash: "sha256:recovery",
      }],
    },
  }));

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons, [{
    type: "RECOVERY_OPERATION_PENDING",
    operationId: "operation-recovery",
    detailsHash: "sha256:recovery",
  }]);
});

test("startup recovery scan fails closed when a pending recovery operation mismatches its blocker", () => {
  const store = stubStore({
    runs: [{
      runId: "run-recovery-mismatch",
      version: 5,
      phase: "RECOVERY_REQUIRED",
      activeActor: null,
      blocker: {
        type: "RECOVERY_CONFIRMATION",
        operationId: "operation-expected",
      },
    }],
    recoveries: {
      "run-recovery-mismatch": [{
        operationId: "operation-observed",
        status: "PENDING",
        detailsHash: "sha256:recovery",
      }],
    },
  });

  assert.throws(
    () => scanStartupRecovery(store),
    /pending recovery operation.*active blocker/u,
  );
});

test("startup recovery scan finds the pending approval bound to its exact blocker", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-approval",
      version: 5,
      phase: "HUMAN_GATE",
      activeActor: null,
      blocker: { type: "RUNTIME_APPROVAL", approvalId: "approval-exact" },
    }],
    approvals: {
      "run-approval": [{
        approvalId: "approval-exact",
        status: "PENDING",
        scopeHash: "sha256:approval",
      }],
    },
  }));

  assert.deepEqual(findings[0].reasons, [{
    type: "APPROVAL_PENDING",
    approvalId: "approval-exact",
    scopeHash: "sha256:approval",
  }]);
});

test("startup recovery scan fails closed when pending approval and blocker do not match", () => {
  for (const run of [
    {
      runId: "run-approval-orphan",
      version: 5,
      phase: "HUMAN_GATE",
      activeActor: null,
      blocker: null,
    },
    {
      runId: "run-approval-mismatch",
      version: 5,
      phase: "HUMAN_GATE",
      activeActor: null,
      blocker: { type: "RUNTIME_APPROVAL", approvalId: "approval-expected" },
    },
  ]) {
    const store = stubStore({
      runs: [run],
      approvals: {
        [run.runId]: [{
          approvalId: "approval-observed",
          status: "PENDING",
          scopeHash: "sha256:approval",
        }],
      },
    });
    assert.throws(
      () => scanStartupRecovery(store),
      /pending runtime approval.*active blocker/u,
    );
  }
});

test("startup recovery scan surfaces a failed delivery whose attempt budget is exhausted", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-delivery-exhausted",
      version: 2,
      phase: "CODEX_TURN_PENDING",
      activeActor: null,
    }],
    deliveries: {
      "run-delivery-exhausted": [{
        deliveryId: "delivery-exhausted",
        inputId: "input-exhausted",
        state: "FAILED",
        attemptCount: 3,
      }],
    },
    limits: {
      "run-delivery-exhausted": {
        limits: { maxDeliveryAttempts: 3 },
      },
    },
  }));

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons, [{
    type: "DELIVERY_ATTEMPTS_EXHAUSTED",
    deliveryId: "delivery-exhausted",
    inputId: "input-exhausted",
    attemptCount: 3,
    maxDeliveryAttempts: 3,
  }]);
});

test("startup recovery scan surfaces a retryable failed delivery without auto-resetting it", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-delivery-retryable",
      version: 2,
      phase: "CODEX_TURN_PENDING",
      activeActor: null,
    }],
    deliveries: {
      "run-delivery-retryable": [{
        deliveryId: "delivery-retryable",
        inputId: "input-retryable",
        state: "FAILED",
        attemptCount: 1,
      }],
    },
    limits: {
      "run-delivery-retryable": {
        limits: { maxDeliveryAttempts: 3 },
      },
    },
  }));

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].reasons, [{
    type: "DELIVERY_FAILED_RETRYABLE",
    deliveryId: "delivery-retryable",
    inputId: "input-retryable",
    attemptCount: 1,
    maxDeliveryAttempts: 3,
  }]);
});

test("a completed provider response that has not been relayed requires recovery", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{ runId: "run-relay-pending", version: 3, phase: "CODEX_RESPONSE_STORED", activeActor: null }],
    deliveries: {
      "run-relay-pending": [{
        deliveryId: "delivery-response-complete",
        inputId: "input-response-complete",
        state: "RESPONSE_COMPLETED",
        attemptCount: 1,
      }],
    },
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reasons[0].type, "DELIVERY_UNCERTAIN");
  assert.equal(findings[0].reasons[0].state, "RESPONSE_COMPLETED");
});

test("an atomically stored final response is settled without a peer relay", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{ runId: "run-final", version: 9, phase: "COMPLETE", activeActor: null }],
    deliveries: {
      "run-final": [{
        deliveryId: "delivery-final",
        inputId: "input-final",
        state: "RESPONSE_COMPLETED",
        attemptCount: 1,
      }],
    },
    messages: {
      "input-final": { messageId: "message-final" },
    },
  }));
  assert.deepEqual(findings, []);
});

test("an atomically stored packet rejection is settled without an AgentMessage", () => {
  const findings = scanStartupRecovery(stubStore({
    runs: [{
      runId: "run-rejected",
      version: 4,
      phase: "CODEX_RESPONSE_STORED",
      activeActor: null,
    }],
    deliveries: {
      "run-rejected": [{
        deliveryId: "delivery-rejected",
        inputId: "input-rejected",
        state: "RESPONSE_COMPLETED",
        attemptCount: 1,
      }],
    },
    rejections: {
      "delivery-rejected": { eventType: "AGENT_PACKET_REJECTED" },
    },
  }));
  assert.deepEqual(findings, []);
});

test("startup recovery fails closed when one delivery claims two terminal response types", () => {
  const store = stubStore({
    runs: [{ runId: "run-conflict", version: 4, phase: "COMPLETE", activeActor: null }],
    deliveries: {
      "run-conflict": [{
        deliveryId: "delivery-conflict",
        inputId: "input-conflict",
        state: "RESPONSE_COMPLETED",
        attemptCount: 1,
      }],
    },
    messages: { "input-conflict": { messageId: "message-conflict" } },
    rejections: {
      "delivery-conflict": { eventType: "AGENT_PACKET_REJECTED" },
    },
  });
  assert.throws(() => scanStartupRecovery(store), /both a message and packet rejection/u);
});

test("startup recovery scan fails closed when the store lacks a required query", () => {
  assert.throws(
    () => scanStartupRecovery({ listRuns() { return []; } }),
    /listAgentSessions/u,
  );
});
