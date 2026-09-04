import { validateAgentSessionRecord } from "../domain/contracts.js";
import { AgentSessionStatus } from "../domain/vocabulary.js";
import { validateSubmittedProviderReceipt } from "../persistence/delivery-transition-input.js";

const READY_SESSION_STATES = new Set([
  AgentSessionStatus.READY,
  AgentSessionStatus.WAITING,
]);

export class DiscussionSessionBindingError extends Error {
  constructor(message, code = "DISCUSSION_SESSION_BINDING_ERROR") {
    super(message);
    this.name = "DiscussionSessionBindingError";
    this.code = code;
  }
}

function sameBinding(session, snapshot) {
  return session.sessionId === snapshot.sessionId
    && session.version === snapshot.version
    && session.externalSessionId === snapshot.externalSessionId
    && session.externalLocator === snapshot.externalLocator;
}

export function bindDiscussionProviderReceipt(providerReceipt, session) {
  validateAgentSessionRecord(session);
  const receipt = {
    ...providerReceipt,
    sessionBinding: {
      sessionId: session.sessionId,
      version: session.version,
      externalSessionId: session.externalSessionId,
      externalLocator: session.externalLocator,
    },
  };
  validateSubmittedProviderReceipt({ providerReceipt: receipt });
  return Object.freeze({
    ...receipt,
    sessionBinding: Object.freeze({ ...receipt.sessionBinding }),
  });
}

export function sessionForDiscussionSubmission(store, run, turnInput, providerReceipt) {
  const receipt = validateSubmittedProviderReceipt({ providerReceipt });
  const matches = store.listAgentSessions(run.runId).filter((session) => (
    session.actor === turnInput.targetActor
  ));
  if (matches.length !== 1 || !READY_SESSION_STATES.has(matches[0].status)) {
    throw new DiscussionSessionBindingError(
      `Input ${turnInput.inputId} requires one ready ${turnInput.targetActor} session.`,
      "DISCUSSION_SESSION_NOT_READY",
    );
  }
  if (!sameBinding(matches[0], receipt.sessionBinding)) {
    throw new DiscussionSessionBindingError(
      `Input ${turnInput.inputId} no longer has its preflighted runtime session binding.`,
      "AGENT_SESSION_BINDING_CHANGED",
    );
  }
  return matches[0];
}

export function markDiscussionSessionRunning(store, session, turnId, updatedAt) {
  return store.upsertAgentSession({
    session: {
      ...session,
      status: AgentSessionStatus.RUNNING,
      activeTurnId: turnId,
      lastObservedAt: updatedAt,
      version: session.version + 1,
    },
    expectedVersion: session.version,
    updatedAt,
  });
}

export function requireSubmittedDiscussionSession({
  store,
  run,
  turnInput,
  delivery,
  sessionId,
  turnId,
}) {
  const receipt = validateSubmittedProviderReceipt({
    providerReceipt: delivery.providerReceipt,
  });
  const session = store.getAgentSession(sessionId);
  if (
    session === null
    || session.runId !== run.runId
    || session.actor !== turnInput.targetActor
  ) {
    throw new DiscussionSessionBindingError(
      `Agent session ${sessionId} does not own input ${turnInput.inputId}.`,
      "AGENT_SESSION_INPUT_MISMATCH",
    );
  }
  if (
    receipt.externalTurnId !== turnId
    || session.status !== AgentSessionStatus.RUNNING
    || session.activeTurnId !== turnId
  ) {
    throw new DiscussionSessionBindingError(
      `Agent session ${sessionId} is not running attributed turn ${turnId}.`,
      "AGENT_SESSION_TURN_MISMATCH",
    );
  }
  const expectedRunningBinding = {
    ...receipt.sessionBinding,
    version: receipt.sessionBinding.version + 1,
  };
  if (!sameBinding(session, expectedRunningBinding)) {
    throw new DiscussionSessionBindingError(
      `Agent session ${sessionId} changed after turn ${turnId} was submitted.`,
      "AGENT_SESSION_BINDING_CHANGED",
    );
  }
  return session;
}
