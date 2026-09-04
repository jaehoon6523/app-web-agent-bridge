import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKED_ROUTE_BY_REASON,
  DISCUSSION_ACTION_MATRIX,
  DiscussionActionPolicyError,
  assertDiscussionPacketTypeAllowed,
  blockedRoutingResult,
  resolveDiscussionActionPolicy,
} from "../src/domain/discussion-actions.js";
import {
  AgentBlockedReason,
  AgentTurnInputKind,
  OperationalBlockerReason,
  RunPhase,
} from "../src/domain/vocabulary.js";

const EXPECTED_MATRIX = Object.freeze({
  INITIAL_OBJECTIVE: ["PROPOSE", "BLOCKED"],
  PEER_PROPOSAL: ["CRITIQUE", "ACCEPT", "BLOCKED"],
  PEER_REVISION: ["CRITIQUE", "ACCEPT", "BLOCKED"],
  PEER_CRITIQUE: ["REVISE", "BLOCKED"],
  PEER_ACCEPTANCE: ["ACCEPT", "CRITIQUE", "BLOCKED"],
});

test("discussion-actions-v1 is the approved state-specific action matrix", () => {
  assert.deepEqual(DISCUSSION_ACTION_MATRIX, EXPECTED_MATRIX);

  const initial = resolveDiscussionActionPolicy({
    inputKind: AgentTurnInputKind.INITIAL_OBJECTIVE,
  });
  assert.deepEqual(initial.allowedActions, EXPECTED_MATRIX.INITIAL_OBJECTIVE);
  assert.deepEqual(initial.allowedPacketTypes, ["PROPOSAL", "BLOCKED"]);

  for (const peerMessageKind of ["PROPOSAL", "REVISION", "CRITIQUE", "ACCEPTANCE"]) {
    const resolved = resolveDiscussionActionPolicy({
      inputKind: AgentTurnInputKind.PEER_RELAY,
      peerMessageKind,
    });
    assert.deepEqual(resolved.allowedActions, EXPECTED_MATRIX[`PEER_${peerMessageKind}`]);
  }
});

test("protocol repair accepts the frozen allowed packet-type set", () => {
  const context = {
    inputKind: AgentTurnInputKind.PROTOCOL_REPAIR,
    allowedPacketTypes: ["CRITIQUE", "BLOCKED"],
  };
  const resolved = resolveDiscussionActionPolicy(context);
  assert.deepEqual(resolved.allowedActions, []);
  assert.deepEqual(resolved.allowedPacketTypes, ["CRITIQUE", "BLOCKED"]);
  assert.equal(resolved.expectedPacketType, null);
  assert.equal(assertDiscussionPacketTypeAllowed(context, "CRITIQUE"), "CRITIQUE");
  assert.equal(assertDiscussionPacketTypeAllowed(context, "BLOCKED"), "BLOCKED");
  assert.throws(() => assertDiscussionPacketTypeAllowed(context, "ACCEPT"),
    (error) => error instanceof DiscussionActionPolicyError
      && error.code === "DISCUSSION_PACKET_TYPE_NOT_ALLOWED");
  assert.throws(
    () => resolveDiscussionActionPolicy({
      inputKind: AgentTurnInputKind.PROTOCOL_REPAIR,
      allowedPacketTypes: ["CRITIQUE", "CRITIQUE"],
    }),
    (error) => error.code === "INVALID_PROTOCOL_REPAIR_EXPECTATION",
  );
});

test("peer BLOCKED is not relayable and only Agent-owned blockers have routes", () => {
  assert.throws(() => resolveDiscussionActionPolicy({
    inputKind: AgentTurnInputKind.PEER_RELAY,
    peerMessageKind: "BLOCKER",
  }), /no authorized PEER_RELAY action policy/u);

  assert.deepEqual(BLOCKED_ROUTE_BY_REASON, {
    PRODUCT_DECISION_REQUIRED: RunPhase.HUMAN_GATE,
    CONSENSUS_NOT_REACHED: RunPhase.HUMAN_GATE,
    INSUFFICIENT_INFORMATION: RunPhase.HUMAN_GATE,
    AGENT_CAPABILITY_LIMIT: RunPhase.HUMAN_GATE,
  });
  for (const reasonCode of Object.values(AgentBlockedReason)) {
    const result = blockedRoutingResult(reasonCode);
    assert.equal(result.reasonCode, reasonCode);
    assert.equal(result.route, BLOCKED_ROUTE_BY_REASON[reasonCode]);
  }
  for (const reasonCode of Object.values(OperationalBlockerReason)) {
    assert.throws(
      () => blockedRoutingResult(reasonCode),
      (error) => error.code === "UNKNOWN_BLOCKED_REASON",
    );
  }
  assert.throws(
    () => blockedRoutingResult("POLICY_VIOLATION"),
    (error) => error.code === "UNKNOWN_BLOCKED_REASON",
  );
});
