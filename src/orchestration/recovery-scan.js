import { AgentSessionStatus, RunPhase } from "../domain/vocabulary.js";
import { DeliveryState } from "../persistence/schema.js";

const ACTIVE_TURN_PHASES = new Set([
  RunPhase.CODEX_TURN_RUNNING,
  RunPhase.WEB_TURN_RUNNING,
]);
const UNCERTAIN_DELIVERY_STATES = new Set([
  DeliveryState.DISPATCHING,
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.RESPONSE_COMPLETED,
  DeliveryState.AMBIGUOUS,
]);

function requireStore(store) {
  for (const method of [
    "listRuns",
    "listAgentSessions",
    "listDeliveries",
    "listApprovals",
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
    if (ACTIVE_TURN_PHASES.has(run.phase)) {
      reasons.push(reason("TURN_RUNNING", {
        actor: run.activeActor,
        phase: run.phase,
      }));
    }

    for (const delivery of store.listDeliveries(run.runId)) {
      if (UNCERTAIN_DELIVERY_STATES.has(delivery.state)) {
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

    for (const approval of store.listApprovals({ runId: run.runId })) {
      if (approval.status === "PENDING") {
        reasons.push(reason("APPROVAL_PENDING", {
          approvalId: approval.approvalId,
          scopeHash: approval.scopeHash,
        }));
      }
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
