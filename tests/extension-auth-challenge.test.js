import test from "node:test";
import assert from "node:assert/strict";
import { validControllerChallenge } from "../extension/runtime/auth-challenge.js";

test("extension ignores replayed, expired and malformed controller challenges", () => {
  const challenge = { protocolVersion: 2, challengeId: "challenge-1", nonce: "a".repeat(64), expiresAt: "2026-09-24T12:00:01.000Z" };
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  assert.equal(validControllerChallenge(challenge, 2, new Set(), now), true);
  assert.equal(validControllerChallenge(challenge, 2, new Set(["challenge-1"]), now), false);
  assert.equal(validControllerChallenge(challenge, 2, new Set(), now + 2_000), false);
  assert.equal(validControllerChallenge({ ...challenge, nonce: "a".repeat(63) }, 2, new Set(), now), false);
  assert.equal(validControllerChallenge({ ...challenge, protocolVersion: 1 }, 2, new Set(), now), false);
});
