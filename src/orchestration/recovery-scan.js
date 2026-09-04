import {
  AgentSessionStatus,
  RunBlockerType,
  RunPhase,
} from "../domain/vocabulary.js";
import { DeliveryState } from "../persistence/schema.js";

const ACTIVE_TURN_PHASES = new Set([
  RunPhase.CODEX_TURN_RUNNING,
  RunPhase.WEB_TURN_RUNNING,
]);
const UNCERTAIN_DELIVERY_STATES = new Set([
  DeliveryState.DISPATCHING,
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.AMBIGUOUS,
]);

function requireStore(store) {
  for (const method of [
    "listRuns",
    "listAgentSessions",
    "listDeliveries",
    "listApprovals",
    "listRecoveryOperations",
    "getRunLimits",
    "getAgentMessageByInput",
    "getAgentPacketRejectionByDelivery",
  ]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`Recovery scan requires store.${method}().`);
    }
  }
  return store;
}

function reason(type, fields = {}) {
  return Object.freeze({ type, ...fields });
}

function pendingRecoveryOperation(store, run) {
  const pending = store.listRecoveryOperations({ runId: run.runId })
    .filter((operation) => operation.status === "PENDING");
  const blockerOperationId = run.phase === RunPhase.RECOVERY_REQUIRED
    && run.blocker?.type === RunBlockerType.RECOVERY_CONFIRMATION
    ? run.blocker.operationId
    : null;

  if (
    blockerOperationId === null
      ? pending.length > 0
      : pending.length !== 1 || pending[0].operationId !== blockerOperationId
  ) {
    throw new TypeError(
      `Run ${run.runId} pending recovery operation does not match its active blocker.`,
    );
  }
  return blockerOperationId === null ? null : pending[0];
}

function pendingRuntimeApproval(store, run) {
  const pending = store.listApprovals({ runId: run.runId })
    .filter((approval) => approval.status === "PENDING");
  const blockerApprovalId = run.blocker?.type === RunBlockerType.RUNTIME_APPROVAL
    ? run.blocker.approvalId
    : null;

  if (
    blockerApprovalId === null
      ? pending.length > 0
      : pending.length !== 1 || pending[0].approvalId !== blockerApprovalId
  ) {
    throw new TypeError(
      `Run ${run.runId} pending runtime approval does not match its active blocker.`,
    );
  }
  return blockerApprovalId === null ? null : pending[0];
}

/**
 * Read-only startup classification. It deliberately does not retry, create a
 * replacement session, or resolve an approval. The Controller must persist a
 * recovery operation and obtain the applicable decision before changing state.
 */
export function scanStartupRecovery(store) {
  requireStore(store);
  const findings = [];

  for (const run of store.listRuns()) {
    const reasons = [];
    const runLimits = store.getRunLimits(run.runId);
    if (
      !Number.isSafeInteger(runLimits?.limits?.maxDeliveryAttempts)
      || runLimits.limits.maxDeliveryAttempts < 1
    ) {
      throw new TypeError(`Run ${run.runId} has no valid maxDeliveryAttempts.`);
    }
    const recoveryOperation = pendingRecoveryOperation(store, run);
    if (recoveryOperation !== null) {
      reasons.push(reason("RECOVERY_OPERATION_PENDING", {
        operationId: recoveryOperation.operationId,
        detailsHash: recoveryOperation.detailsHash,
      }));
    }
    const runtimeApproval = pendingRuntimeApproval(store, run);
    if (ACTIVE_TURN_PHASES.has(run.phase)) {
      reasons.push(reason("TURN_RUNNING", {
        actor: run.activeActor,
        phase: run.phase,
      }));
    }

    for (const delivery of store.listDeliveries(run.runId)) {
      let completedWithoutCanonicalResponse = false;
      if (delivery.state === DeliveryState.FAILED) {
        const exhausted = delivery.attemptCount >= runLimits.limits.maxDeliveryAttempts;
        reasons.push(reason(
          exhausted ? "DELIVERY_ATTEMPTS_EXHAUSTED" : "DELIVERY_FAILED_RETRYABLE",
          {
          deliveryId: delivery.deliveryId,
          inputId: delivery.inputId,
          attemptCount: delivery.attemptCount,
          maxDeliveryAttempts: runLimits.limits.maxDeliveryAttempts,
          },
        ));
      }
      if (delivery.state === DeliveryState.RESPONSE_COMPLETED) {
        const message = store.getAgentMessageByInput(delivery.inputId);
        const rejection = store.getAgentPacketRejectionByDelivery(delivery.deliveryId);
        if (message !== null && rejection !== null) {
          throw new TypeError(
            `Delivery ${delivery.deliveryId} has both a message and packet rejection.`,
          );
        }
        completedWithoutCanonicalResponse = message === null && rejection === null;
      }
      if (UNCERTAIN_DELIVERY_STATES.has(delivery.state) || completedWithoutCanonicalResponse) {
        reasons.push(reason("DELIVERY_UNCERTAIN", {
          deliveryId: delivery.deliveryId,
          inputId: delivery.inputId,
          state: delivery.state,
          attemptCount: delivery.attemptCount,
        }));
      }
    }

    for (const session of store.listAgentSessions(run.runId)) {
      if (session.status === AgentSessionStatus.DISCONNECTED) {
        reasons.push(reason("SESSION_DISCONNECTED", {
          actor: session.actor,
          sessionId: session.sessionId,
          activeTurnId: session.activeTurnId,
        }));
      }
    }
    if (runtimeApproval !== null) {
      reasons.push(reason("APPROVAL_PENDING", {
        approvalId: runtimeApproval.approvalId,
        scopeHash: runtimeApproval.scopeHash,
      }));
    }

    if (reasons.length > 0) {
      findings.push(Object.freeze({
        runId: run.runId,
        runVersion: run.version,
        phase: run.phase,
        reasons: Object.freeze(reasons),
      }));
    }
  }

  return Object.freeze(findings);
}

export function hasRecoveryWork(store) {
  return scanStartupRecovery(store).length > 0;
}

export { ACTIVE_TURN_PHASES, UNCERTAIN_DELIVERY_STATES };
