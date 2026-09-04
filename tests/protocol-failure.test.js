import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PACKET_REJECTED_EVENT_TYPE,
  AgentPacketParserStage,
  AgentPacketRejectionContractError,
  AgentPacketRejectionRecoverability,
  buildAgentPacketRejectedEvent,
  validateAgentPacketRejectedEvent,
} from "../src/domain/agent-packet-rejection.js";
import { sha256Text } from "../src/domain/canonical-json.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  AgentActor,
  AgentPacketType,
  AgentTurnInputKind,
  RunOutcomeType,
} from "../src/domain/vocabulary.js";
import {
  AGENT_PROTOCOL_REPAIR_EXHAUSTED,
  EXPECTED_PACKET_TYPE_REQUIRED,
  ProtocolFailureDecisionError,
  ProtocolFailureDecisionStatus,
  buildProtocolRepairTurnInput,
  decideAgentPacketRejection,
  validateProtocolFailureDecision,
} from "../src/orchestration/protocol-failure.js";

const AT = "2026-09-04T02:00:00.000Z";
const HASH_A = sha256Text("objective");
const HASH_B = sha256Text("policy");
const RAW_ARTIFACT_HASH = sha256Text("redacted pre-parse response");

function attribution(overrides = {}) {
  return {
    runId: "run-protocol-01",
    actor: AgentActor.CODEX_AGENT,
    sessionId: "session-codex-01",
    turnId: "turn-codex-01",
    deliveryId: "delivery-codex-01",
    objectiveHash: HASH_A,
    policyHash: HASH_B,
    ...overrides,
  };
}

function rejectionEvent(overrides = {}) {
  return {
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    runId: "run-protocol-01",
    actor: AgentActor.CODEX_AGENT,
    sessionId: "session-codex-01",
    turnId: "turn-codex-01",
    deliveryId: "delivery-codex-01",
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The final packet was not valid JSON.",
    rawResponseArtifactHash: RAW_ARTIFACT_HASH,
    protocolRepairsUsed: 1,
    recoverability: AgentPacketRejectionRecoverability.REPAIRABLE,
    createdAt: AT,
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  return {
    confirmedAttribution: attribution(),
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The final packet was not valid JSON.",
    rawResponseArtifactHash: RAW_ARTIFACT_HASH,
    limits: createDiscussionRunPolicy().limits,
    protocolRepairsUsed: 0,
    expectedPacketType: AgentPacketType.PROPOSAL,
    createdAt: AT,
    ...overrides,
  };
}

test("AgentPacketRejectedEvent is a strict Controller event containing only an artifact hash", () => {
  const event = buildAgentPacketRejectedEvent(rejectionEvent());
  assert.equal(validateAgentPacketRejectedEvent(event), event);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(event.rawResponseArtifactHash, RAW_ARTIFACT_HASH);
  assert.equal(Object.hasOwn(event, "rawResponse"), false);
  assert.equal(Object.hasOwn(AgentPacketType, AGENT_PACKET_REJECTED_EVENT_TYPE), false);

  assert.throws(
    () => buildAgentPacketRejectedEvent({ ...rejectionEvent(), rawResponse: "secret" }),
    (error) => error instanceof AgentPacketRejectionContractError
      && /unsupported property/u.test(error.message),
  );
  assert.throws(
    () => buildAgentPacketRejectedEvent(rejectionEvent({ rawResponseArtifactHash: "bad" })),
    /sha256/u,
  );
  assert.throws(
    () => buildAgentPacketRejectedEvent(rejectionEvent({ parserStage: "PROVIDER_GUESS" })),
    /AgentPacketParserStage/u,
  );
});

test("first confirmed rejection reserves the one repair and fixes the same-actor route", () => {
  const decision = decideAgentPacketRejection(decisionInput());
  assert.equal(decision.status, ProtocolFailureDecisionStatus.REPAIR_REQUIRED);
  assert.equal(decision.protocolRepairsUsed, 1);
  assert.equal(
    decision.rejectionEvent.recoverability,
    AgentPacketRejectionRecoverability.REPAIRABLE,
  );
  assert.equal(decision.rejectionEvent.protocolRepairsUsed, 1);
  assert.equal(decision.repairContext.expectedPacketType, AgentPacketType.PROPOSAL);

  const repairInput = buildProtocolRepairTurnInput(decision, {
    inputId: "input-repair-01",
    instructionId: "repair-exact-proposal",
    promptTemplateVersion: "controller-prompt-v1",
    promptHash: sha256Text("rendered repair prompt"),
    createdAt: "2026-09-04T02:00:01.000Z",
  });
  assert.equal(repairInput.runId, decision.rejectionEvent.runId);
  assert.equal(repairInput.targetActor, decision.rejectionEvent.actor);
  assert.equal(repairInput.kind, AgentTurnInputKind.PROTOCOL_REPAIR);
  assert.equal(repairInput.sourceMessageId, null);
  assert.equal(repairInput.objectiveHash, HASH_A);
  assert.equal(repairInput.policyHash, HASH_B);
  assert.deepEqual(repairInput.payload, {
    rejectedDeliveryId: "delivery-codex-01",
    parserStage: AgentPacketParserStage.JSON_PARSE,
    errorCode: "INVALID_AGENT_PACKET_JSON",
    errorSummary: "The final packet was not valid JSON.",
    expectedPacketType: AgentPacketType.PROPOSAL,
  });
  assert.equal(Object.hasOwn(repairInput.payload, "rawResponseArtifactHash"), false);
  assert.throws(
    () => buildProtocolRepairTurnInput(decision, {
      inputId: "input-repair-forged",
      instructionId: "repair-exact-proposal",
      promptTemplateVersion: "controller-prompt-v1",
      payload: { expectedPacketType: AgentPacketType.CRITIQUE },
      promptHash: sha256Text("rendered repair prompt"),
      createdAt: "2026-09-04T02:00:01.000Z",
    }),
    /unsupported property "payload"/u,
  );
});

test("an absent or ambiguous expected packet type fails closed without spending repair budget", () => {
  for (const expectedPacketType of [null, undefined, [AgentPacketType.PROPOSAL], "PROTOCOL_ERROR"]) {
    const input = decisionInput({ expectedPacketType });
    if (expectedPacketType === undefined) delete input.expectedPacketType;
    const decision = decideAgentPacketRejection(input);
    assert.equal(decision.status, ProtocolFailureDecisionStatus.AUTHORITY_REQUIRED);
    assert.equal(decision.reason, EXPECTED_PACKET_TYPE_REQUIRED);
    assert.equal(decision.protocolRepairsUsed, 0);
    assert.equal(decision.repairContext, null);
    assert.equal(decision.outcome, null);
    assert.equal(
      decision.rejectionEvent.recoverability,
      AgentPacketRejectionRecoverability.AMBIGUOUS,
    );
    assert.throws(
      () => buildProtocolRepairTurnInput(decision, {}),
      (error) => error instanceof ProtocolFailureDecisionError
        && error.code === "PROTOCOL_REPAIR_NOT_AUTHORIZED",
    );
  }

});

test("an exhausted repair budget wins before packet-type ambiguity and always fails", () => {
  const decision = decideAgentPacketRejection(decisionInput({
    protocolRepairsUsed: 1,
    expectedPacketType: null,
  }));
  assert.equal(decision.status, ProtocolFailureDecisionStatus.FAILED);
  assert.equal(decision.protocolRepairsUsed, 1);
  assert.equal(decision.repairContext, null);
  assert.deepEqual(decision.outcome, {
    type: RunOutcomeType.FAILED,
    errorCode: AGENT_PROTOCOL_REPAIR_EXHAUSTED,
  });
  assert.equal(
    decision.rejectionEvent.recoverability,
    AgentPacketRejectionRecoverability.EXHAUSTED,
  );
  assert.throws(
    () => buildProtocolRepairTurnInput(decision, {}),
    (error) => error.code === "PROTOCOL_REPAIR_NOT_AUTHORIZED",
  );
});

test("full decision validation rejects forged counters, routes, outcomes, and contexts", () => {
  const repair = decideAgentPacketRejection(decisionInput());
  assert.equal(validateProtocolFailureDecision(repair), repair);

  const forgeries = [
    { ...repair, protocolRepairsUsed: 0 },
    {
      ...repair,
      protocolRepairsUsed: 0,
      rejectionEvent: { ...repair.rejectionEvent, protocolRepairsUsed: 0 },
    },
    {
      ...repair,
      rejectionEvent: {
        ...repair.rejectionEvent,
        recoverability: AgentPacketRejectionRecoverability.EXHAUSTED,
      },
    },
    {
      ...repair,
      repairContext: {
        ...repair.repairContext,
        targetActor: AgentActor.CHATGPT_WEB_AGENT,
      },
    },
    { ...repair, outcome: { type: RunOutcomeType.FAILED, errorCode: "FORGED" } },
    { ...repair, reason: EXPECTED_PACKET_TYPE_REQUIRED },
  ];
  for (const forged of forgeries) {
    assert.throws(
      () => validateProtocolFailureDecision(forged),
      ProtocolFailureDecisionError,
    );
    assert.throws(
      () => buildProtocolRepairTurnInput(forged, {
        inputId: "input-forged",
        instructionId: "repair-forged",
        promptTemplateVersion: "controller-prompt-v1",
        promptHash: sha256Text("forged prompt"),
        createdAt: AT,
      }),
      ProtocolFailureDecisionError,
    );
  }

  const failed = decideAgentPacketRejection(decisionInput({ protocolRepairsUsed: 1 }));
  assert.equal(validateProtocolFailureDecision(failed), failed);
  assert.throws(
    () => validateProtocolFailureDecision({
      ...failed,
      outcome: { type: RunOutcomeType.FAILED, errorCode: "FORGED" },
    }),
    ProtocolFailureDecisionError,
  );
});

test("the pure decision refuses invented attribution and impossible durable counters", () => {
  const missingTurn = attribution();
  delete missingTurn.turnId;
  assert.throws(
    () => decideAgentPacketRejection(decisionInput({ confirmedAttribution: missingTurn })),
    /missing required property "turnId"/u,
  );
  assert.throws(
    () => decideAgentPacketRejection(decisionInput({ protocolRepairsUsed: 2 })),
    (error) => error instanceof ProtocolFailureDecisionError
      && error.code === "PROTOCOL_REPAIR_COUNTER_INVALID",
  );
});
