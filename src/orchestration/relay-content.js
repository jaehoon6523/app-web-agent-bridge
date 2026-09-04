import { sha256Text } from "../domain/canonical-json.js";

export const DEFAULT_RELAY_CONTENT_LIMIT = 50_000;
export const DEFAULT_REPEAT_RUN_LIMIT = 4_096;

export class RelayContentError extends TypeError {
  constructor(message, code) {
    super(message);
    this.name = "RelayContentError";
    this.code = code;
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RelayContentError(`${name} must be a positive safe integer.`, "INVALID_RELAY_LIMIT");
  }
}

function hasExcessiveCharacterRun(value, limit) {
  let previous = "";
  let run = 0;
  for (const character of value) {
    if (character === previous) {
      run += 1;
    } else {
      previous = character;
      run = 1;
    }
    if (run > limit) return true;
  }
  return false;
}

export function sanitizeRelayContent(
  rawContent,
  {
    maxCharacters = DEFAULT_RELAY_CONTENT_LIMIT,
    repeatRunLimit = DEFAULT_REPEAT_RUN_LIMIT,
    overflow = "truncate",
  } = {},
) {
  if (typeof rawContent !== "string") {
    throw new RelayContentError("Relay content must be a string.", "INVALID_RELAY_CONTENT");
  }
  assertPositiveInteger(maxCharacters, "maxCharacters");
  assertPositiveInteger(repeatRunLimit, "repeatRunLimit");
  if (!new Set(["truncate", "reject"]).has(overflow)) {
    throw new RelayContentError("overflow must be truncate or reject.", "INVALID_RELAY_LIMIT");
  }
  if (rawContent.includes("\0")) {
    throw new RelayContentError("Relay content must not contain null bytes.", "BINARY_RELAY_CONTENT");
  }
  if (hasExcessiveCharacterRun(rawContent, repeatRunLimit)) {
    throw new RelayContentError(
      "Relay content contains an excessive repeated-character run.",
      "EXCESSIVE_RELAY_REPETITION",
    );
  }

  const originalHash = sha256Text(rawContent);
  const withoutControls = rawContent.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  const wasSanitized = withoutControls !== rawContent;
  if (withoutControls.length > maxCharacters && overflow === "reject") {
    throw new RelayContentError(
      `Relay content exceeds the ${maxCharacters} character limit.`,
      "RELAY_CONTENT_TOO_LARGE",
    );
  }

  const truncated = withoutControls.length > maxCharacters;
  const content = truncated ? withoutControls.slice(0, maxCharacters) : withoutControls;
  return Object.freeze({
    content,
    contentHash: sha256Text(content),
    originalHash,
    originalCharacters: rawContent.length,
    storedCharacters: content.length,
    truncated,
    wasSanitized,
  });
}

export function assertJsonDepth(value, maxDepth = 20) {
  assertPositiveInteger(maxDepth, "maxDepth");
  const seen = new Set();

  function visit(current, depth) {
    if (depth > maxDepth) {
      throw new RelayContentError(
        `JSON value exceeds the maximum depth of ${maxDepth}.`,
        "RELAY_JSON_TOO_DEEP",
      );
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) {
      throw new RelayContentError("JSON value must not be cyclic.", "INVALID_RELAY_JSON");
    }
    seen.add(current);
    try {
      for (const item of Array.isArray(current) ? current : Object.values(current)) {
        visit(item, depth + 1);
      }
    } finally {
      seen.delete(current);
    }
  }

  visit(value, 1);
  return value;
}
