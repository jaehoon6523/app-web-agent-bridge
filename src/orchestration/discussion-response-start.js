import { validateAgentTurnInput } from "../domain/agent-messages.js";
import { validateAgentRun } from "../domain/contracts.js";
import { AgentActor, RunPhase } from "../domain/vocabulary.js";
import { DeliveryState } from "../persistence/schema.js";
import { requireSubmittedDiscussionSession } from "./discussion-session-binding.js";

const RUNNING_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_TURN_RUNNING,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_TURN_RUNNING,
});

export class DiscussionResponseStartError extends Error {
  constructor(message, code = "DISCUSSION_RESPONSE_START_ERROR") {
    super(message);
    this.name = "DiscussionResponseStartError";
    this.code = code;
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireVersion(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function markDiscussionResponseStarted({
  store,
  clock,
  runId,
  expectedRunVersion,
  deliveryId,
  expectedDeliveryVersion,
  sessionId,
  turnId,
}) {
  if (typeof store?.withTransaction !== "function") {
    throw new TypeError("markDiscussionResponseStarted requires a transactional store.");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function.");
  requireString(runId, "runId");
  requireVersion(expectedRunVersion, "expectedRunVersion");
  requireString(deliveryId, "deliveryId");
  requireVersion(expectedDeliveryVersion, "expectedDeliveryVersion");
  requireString(sessionId, "sessionId");
  requireString(turnId, "turnId");

  return store.withTransaction(() => {
    const run = store.getRun(runId);
    if (run === null) {
      throw new DiscussionResponseStartError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
    }
    validateAgentRun(run);
    if (run.version !== expectedRunVersion) {
      throw new DiscussionResponseStartError(
        `Run ${runId} changed before response-start persistence.`,
        "RUN_VERSION_CONFLICT",
      );
    }
    const delivery = store.getDelivery(deliveryId);
    if (delivery === null) {
      throw new DiscussionResponseStartError(
        `Delivery ${deliveryId} does not exist.`,
        "DELIVERY_NOT_FOUND",
      );
    }
    if (delivery.version !== expectedDeliveryVersion) {
      throw new DiscussionResponseStartError(
        `Delivery ${deliveryId} changed before response-start persistence.`,
        "DELIVERY_VERSION_CONFLICT",
      );
    }
    if (delivery.runId !== runId || delivery.state !== DeliveryState.SUBMITTED) {
      throw new DiscussionResponseStartError(
        "Only this run's SUBMITTED delivery can start a response.",
        "DELIVERY_RESPONSE_START_STATE_MISMATCH",
      );
    }
    const turnInput = store.getAgentTurnInput(delivery.inputId);
    validateAgentTurnInput(turnInput);
    if (
      run.phase !== RUNNING_PHASE_BY_ACTOR[turnInput.targetActor]
      || run.activeActor !== turnInput.targetActor
    ) {
      throw new DiscussionResponseStartError(
        "The response-start input does not match the active run actor.",
        "RUN_RESPONSE_ROUTE_MISMATCH",
      );
    }
    const session = requireSubmittedDiscussionSession({
      store,
      run,
      turnInput,
      delivery,
      sessionId,
      turnId,
    });
    const started = store.transitionDelivery({
      deliveryId,
      expectedState: DeliveryState.SUBMITTED,
      expectedVersion: delivery.version,
      nextState: DeliveryState.RESPONSE_STARTED,
      updatedAt: clock(),
    });
    return Object.freeze({ run, delivery: started, turnInput, session });
  });
}
