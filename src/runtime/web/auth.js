import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  WEB_BRIDGE_PROTOCOL_VERSION,
  WebProtocolError,
  isPlainObject,
} from "./protocol.js";
import { requireStrongSharedSecret } from "../../security/shared-secret.js";

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WebProtocolError(`${label} must be a non-empty string`, "INVALID_AUTH_CONFIGURATION");
  }
  return value;
}

export function computeWebChallengeHmac(nonce, sharedSecret) {
  requireNonEmptyString(nonce, "nonce");
  requireNonEmptyString(sharedSecret, "sharedSecret");
  return createHmac("sha256", sharedSecret).update(nonce, "utf8").digest("hex");
}

export function constantTimeHexEqual(actual, expected) {
  if (
    typeof actual !== "string"
    || typeof expected !== "string"
    || !HEX_SHA256_PATTERN.test(actual)
    || !HEX_SHA256_PATTERN.test(expected)
  ) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class WebExtensionAuthenticator {
  #challengeTtlMs;
  #clock;
  #expectedExtensionIdentity;
  #pendingById = new Map();
  #randomBytes;
  #sharedSecret;
  #usedNonces = new Map();

  /**
   * @param {{
   *   sharedSecret?: string,
   *   expectedExtensionIdentity?: string,
   *   challengeTtlMs?: number,
   *   clock?: () => number,
   *   randomBytesFn?: typeof randomBytes
   * }} [options]
   */
  constructor({
    sharedSecret,
    expectedExtensionIdentity,
    challengeTtlMs = 30_000,
    clock = () => Date.now(),
    randomBytesFn = randomBytes,
  } = {}) {
    try {
      this.#sharedSecret = requireStrongSharedSecret(sharedSecret, "sharedSecret");
    } catch (error) {
      throw new WebProtocolError(error.message, "INVALID_AUTH_CONFIGURATION");
    }
    this.#expectedExtensionIdentity = requireNonEmptyString(
      expectedExtensionIdentity,
      "expectedExtensionIdentity",
    );
    if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1) {
      throw new WebProtocolError(
        "challengeTtlMs must be a positive safe integer",
        "INVALID_AUTH_CONFIGURATION",
      );
    }
    this.#challengeTtlMs = challengeTtlMs;
    this.#clock = clock;
    this.#randomBytes = randomBytesFn;
  }

  issueChallenge() {
    this.#pruneExpired();
    let nonce;
    do {
      nonce = this.#randomBytes(32).toString("hex");
    } while (
      this.#usedNonces.has(nonce)
      || [...this.#pendingById.values()].some((challenge) => challenge.nonce === nonce)
    );
    let challengeId;
    do {
      challengeId = `wch_${this.#randomBytes(16).toString("hex")}`;
    } while (this.#pendingById.has(challengeId));
    const issuedAtMs = this.#clock();
    const challenge = Object.freeze({
      challengeId,
      nonce,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#challengeTtlMs,
    });
    this.#pendingById.set(challengeId, challenge);
    return Object.freeze({
      type: "controller.auth.challenge",
      protocolVersion: WEB_BRIDGE_PROTOCOL_VERSION,
      challengeId,
      nonce,
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
    });
  }

  verifyResponse(response) {
    if (!isPlainObject(response)) {
      throw new WebProtocolError("Authentication response must be an object", "AUTH_RESPONSE_INVALID");
    }
    const challenge = this.#pendingById.get(response.challengeId);
    if (!challenge) {
      throw new WebProtocolError("Authentication challenge is unknown or already consumed", "AUTH_REPLAY_REJECTED");
    }

    // Every verification attempt consumes the nonce. A failed response must obtain a new challenge.
    this.#pendingById.delete(challenge.challengeId);
    this.#usedNonces.set(challenge.nonce, this.#clock() + this.#challengeTtlMs);

    const expectedKeys = new Set([
      "type",
      "protocolVersion",
      "challengeId",
      "extensionIdentity",
      "hmacSha256",
    ]);
    if (
      Object.keys(response).some((key) => !expectedKeys.has(key))
      || [...expectedKeys].some((key) => !Object.hasOwn(response, key))
    ) {
      throw new WebProtocolError("Authentication response fields are invalid", "AUTH_RESPONSE_INVALID");
    }

    if (this.#clock() > challenge.expiresAtMs) {
      throw new WebProtocolError("Authentication challenge expired", "AUTH_CHALLENGE_EXPIRED");
    }
    if (
      response.type !== "extension.auth.response"
      || response.protocolVersion !== WEB_BRIDGE_PROTOCOL_VERSION
    ) {
      throw new WebProtocolError("Authentication response protocol is invalid", "AUTH_RESPONSE_INVALID");
    }
    if (response.extensionIdentity !== this.#expectedExtensionIdentity) {
      throw new WebProtocolError("Extension identity does not match", "AUTH_IDENTITY_MISMATCH");
    }
    const expected = computeWebChallengeHmac(challenge.nonce, this.#sharedSecret);
    if (!constantTimeHexEqual(response.hmacSha256, expected)) {
      throw new WebProtocolError("Extension authentication failed", "AUTH_HMAC_INVALID");
    }
    return Object.freeze({
      extensionIdentity: response.extensionIdentity,
      challengeId: challenge.challengeId,
      authenticatedAt: new Date(this.#clock()).toISOString(),
    });
  }

  #pruneExpired() {
    const now = this.#clock();
    for (const [nonce, expiresAtMs] of this.#usedNonces) {
      if (expiresAtMs < now) this.#usedNonces.delete(nonce);
    }
    for (const [challengeId, challenge] of this.#pendingById) {
      if (challenge.expiresAtMs < now) {
        this.#pendingById.delete(challengeId);
        this.#usedNonces.set(challenge.nonce, now + this.#challengeTtlMs);
      }
    }
  }
}
