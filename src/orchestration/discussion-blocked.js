import { deriveAgentBlockedDecisionIds } from "../domain/agent-blocked.js";
import { transitionRunState } from "../domain/run-state-machine.js";
import {
  RunBlockerType,
  RunPhase,
} from "../domain/vocabulary.js";

export function planBlockedDiscussionTransition({ run, message, updatedAt }) {
  return {
    state: transitionRunState(run, {
      to: RunPhase.HUMAN_GATE,
      blocker: {
        type: RunBlockerType.USER_DECISION,
        decisionIds: deriveAgentBlockedDecisionIds(message),
      },
      expectedVersion: run.version,
      updatedAt,
    }),
    outcome: null,
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
