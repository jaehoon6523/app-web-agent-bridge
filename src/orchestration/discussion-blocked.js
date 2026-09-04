import { sha256CanonicalJson } from "../domain/canonical-json.js";
import { transitionRunState } from "../domain/run-state-machine.js";
import {
  HumanGateReason,
  RunBlockerType,
  RunOutcomeType,
  RunPhase,
} from "../domain/vocabulary.js";

function decisionIds(message) {
  const texts = message.normalizedPacket.required_decisions.length > 0
    ? message.normalizedPacket.required_decisions
    : [message.normalizedPacket.description];
  return texts.map((text, index) => (
    `decision_${sha256CanonicalJson({ messageId: message.messageId, index, text }).slice(7)}`
  ));
}

export function planBlockedDiscussionTransition({ run, message, updatedAt, id }) {
  const reason = message.normalizedPacket.reason_code;
  if (reason === HumanGateReason.POLICY_VIOLATION) {
    const outcome = Object.freeze({
      type: RunOutcomeType.FAILED,
      errorCode: HumanGateReason.POLICY_VIOLATION,
    });
    return {
      state: transitionRunState(run, {
        to: RunPhase.FAILED,
        blocker: null,
        expectedVersion: run.version,
        updatedAt,
      }),
      outcome,
      sideRecord: null,
    };
  }
  if (reason === HumanGateReason.SESSION_AUTH_REQUIRED) {
    return {
      state: transitionRunState(run, {
        to: RunPhase.HUMAN_GATE,
        blocker: { type: RunBlockerType.SESSION_AUTH, actor: message.actor },
        expectedVersion: run.version,
        updatedAt,
      }),
      outcome: null,
      sideRecord: null,
    };
  }
  if (reason === HumanGateReason.RUNTIME_APPROVAL_REQUIRED) {
    const approvalId = id("approval");
    return {
      state: transitionRunState(run, {
        to: RunPhase.HUMAN_GATE,
        blocker: { type: RunBlockerType.RUNTIME_APPROVAL, approvalId },
        expectedVersion: run.version,
        updatedAt,
      }),
      outcome: null,
      sideRecord: {
        type: "APPROVAL",
        value: {
          approvalId,
          runId: run.runId,
          status: "PENDING",
          scope: {
            reasonCode: reason,
            sourceMessageId: message.messageId,
            requiredDecisions: message.normalizedPacket.required_decisions,
          },
          createdAt: updatedAt,
          updatedAt,
        },
      },
    };
  }
  if (reason === HumanGateReason.RECOVERY_AMBIGUOUS) {
    const operationId = id("recovery");
    return {
      state: transitionRunState(run, {
        to: RunPhase.RECOVERY_REQUIRED,
        blocker: { type: RunBlockerType.RECOVERY_CONFIRMATION, operationId },
        expectedVersion: run.version,
        updatedAt,
      }),
      outcome: null,
      sideRecord: {
        type: "RECOVERY",
        value: {
          operationId,
          runId: run.runId,
          status: "PENDING",
          details: {
            reasonCode: reason,
            sourceMessageId: message.messageId,
            requiredDecisions: message.normalizedPacket.required_decisions,
          },
          createdAt: updatedAt,
          updatedAt,
        },
      },
    };
  }
  return {
    state: transitionRunState(run, {
      to: RunPhase.HUMAN_GATE,
      blocker: { type: RunBlockerType.USER_DECISION, decisionIds: decisionIds(message) },
      expectedVersion: run.version,
      updatedAt,
    }),
    outcome: null,
    sideRecord: null,
  };
}

export function holdDiscussionForExistingBlocker({ run, updatedAt }) {
  if (run.blocker === null) {
    throw new TypeError("A held discussion response requires an existing blocker.");
  }
  const phase = run.blocker.type === RunBlockerType.RECOVERY_CONFIRMATION
    ? RunPhase.RECOVERY_REQUIRED
    : RunPhase.HUMAN_GATE;
  return transitionRunState(run, {
    to: phase,
    blocker: run.blocker,
    expectedVersion: run.version,
    updatedAt,
  });
}

export function persistBlockedSideRecord(store, sideRecord) {
  if (sideRecord === null) return null;
  if (sideRecord.type === "APPROVAL") {
    const record = store.createApproval(sideRecord.value);
    return Object.freeze({
      type: sideRecord.type,
      id: record.approvalId,
      hash: record.scopeHash,
    });
  }
  if (sideRecord.type === "RECOVERY") {
    const record = store.createRecoveryOperation(sideRecord.value);
    return Object.freeze({
      type: sideRecord.type,
      id: record.operationId,
      hash: record.detailsHash,
    });
  }
  throw new TypeError(`Unsupported blocked side record ${String(sideRecord.type)}.`);
}
