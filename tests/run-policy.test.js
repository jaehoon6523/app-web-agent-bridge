import assert from "node:assert/strict";
import test from "node:test";
import { sha256CanonicalJson } from "../src/domain/canonical-json.js";
import {
  DEFAULT_DISCUSSION_RUN_POLICY,
  calculateRunPolicyHash,
  createDiscussionRunPolicy,
  freezeRunPolicy,
} from "../src/domain/run-policy.js";

test("run-policy-v1 has the approved fixed identity and default limits", () => {
  assert.deepEqual(DEFAULT_DISCUSSION_RUN_POLICY, {
    schema: "run-policy-v1",
    mode: "DISCUSSION",
    startingActor: "CODEX_AGENT",
    limits: {
      maxTurns: 12,
      maxProtocolRepairs: 1,
      maxDeliveryAttempts: 3,
      maxConsecutiveActorFailures: 2,
    },
    packetSchemaVersion: "agent-packet-v1",
    proposalHashVersion: "proposal-ref-v1",
    actionMatrixVersion: "discussion-actions-v1",
    consensusVersion: "consensus-v1",
  });
  assert(Object.isFrozen(DEFAULT_DISCUSSION_RUN_POLICY));
  assert(Object.isFrozen(DEFAULT_DISCUSSION_RUN_POLICY.limits));
  assert.equal(
    calculateRunPolicyHash(DEFAULT_DISCUSSION_RUN_POLICY),
    sha256CanonicalJson(DEFAULT_DISCUSSION_RUN_POLICY),
  );
});

test("only an even maxTurns override of at least two is accepted", () => {
  assert.equal(createDiscussionRunPolicy({ maxTurns: 2 }).limits.maxTurns, 2);
  assert.equal(createDiscussionRunPolicy({ maxTurns: 20 }).limits.maxTurns, 20);
  for (const maxTurns of [0, 1, 3, 11, 2.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => createDiscussionRunPolicy({ maxTurns }),
      /even safe integer >= 2/u,
    );
  }
  assert.throws(
    () => createDiscussionRunPolicy({ maxDeliveryAttempts: 4 }),
    /unsupported property/u,
  );
});

test("policy validation is closed and its hash covers the frozen limits", () => {
  const policy = structuredClone(DEFAULT_DISCUSSION_RUN_POLICY);
  policy.limits.maxTurns = 8;
  const frozen = freezeRunPolicy(policy);
  assert(Object.isFrozen(frozen));
  assert(Object.isFrozen(frozen.limits));
  assert.notEqual(
    calculateRunPolicyHash(frozen),
    calculateRunPolicyHash(DEFAULT_DISCUSSION_RUN_POLICY),
  );

  const unsupported = structuredClone(policy);
  unsupported.compatibilityMode = true;
  assert.throws(() => freezeRunPolicy(unsupported), /unsupported property/u);

  const changedVersion = structuredClone(policy);
  changedVersion.consensusVersion = "consensus-v2";
  assert.throws(() => freezeRunPolicy(changedVersion), /must be "consensus-v1"/u);
});
