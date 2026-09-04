import { parseAgentPacket } from "./agent-packets.js";

export class ControllerPacketEnvelopeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ControllerPacketEnvelopeError";
    this.code = code;
  }
}

function lineStart(text, offset) {
  return offset === 0 || text[offset - 1] === "\n";
}

function outsideMarkdownFence(text, offset) {
  const prefix = text.slice(0, offset);
  let activeFence = null;
  for (const line of prefix.split(/\r?\n/u)) {
    if (activeFence === null) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/u);
      if (opening) activeFence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/u);
    if (
      closing
      && closing[1][0] === activeFence.marker
      && closing[1].length >= activeFence.length
    ) {
      activeFence = null;
    }
  }
  return activeFence === null;
}

function assertPacketJsonDepth(value, maxDepth) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new ControllerPacketEnvelopeError(
      "maxJsonDepth must be a positive safe integer.",
      "INVALID_PACKET_LIMIT",
    );
  }
  const seen = new Set();
  function visit(current, depth) {
    if (depth > maxDepth) {
      throw new ControllerPacketEnvelopeError(
        `Controller packet exceeds the maximum JSON depth of ${maxDepth}.`,
        "CONTROLLER_PACKET_TOO_DEEP",
      );
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) {
      throw new ControllerPacketEnvelopeError(
        "Controller packet JSON must not be cyclic.",
        "INVALID_PACKET_JSON",
      );
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
}

export function parseFinalControllerPacketEnvelope(rawText, { maxJsonDepth = 20 } = {}) {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    throw new ControllerPacketEnvelopeError(
      "Agent response must be a non-empty string.",
      "EMPTY_AGENT_RESPONSE",
    );
  }

  const closing = "</controller_packet>";
  const trimmedEnd = rawText.trimEnd();
  if (!trimmedEnd.endsWith(closing)) {
    throw new ControllerPacketEnvelopeError(
      "Agent response does not end with a controller packet.",
      "CONTROLLER_PACKET_MISSING",
    );
  }
  const closeOffset = trimmedEnd.length - closing.length;
  if (!lineStart(trimmedEnd, closeOffset) || !outsideMarkdownFence(trimmedEnd, closeOffset)) {
    throw new ControllerPacketEnvelopeError(
      "The final controller packet closing tag must be an unquoted standalone line.",
      "CONTROLLER_PACKET_AMBIGUOUS",
    );
  }

  const opening = "<controller_packet>";
  let openOffset = trimmedEnd.lastIndexOf(opening, closeOffset - 1);
  while (
    openOffset >= 0
    && (!lineStart(trimmedEnd, openOffset) || !outsideMarkdownFence(trimmedEnd, openOffset))
  ) {
    openOffset = trimmedEnd.lastIndexOf(opening, openOffset - 1);
  }
  if (openOffset < 0) {
    throw new ControllerPacketEnvelopeError(
      "The final controller packet has no unquoted standalone opening tag.",
      "CONTROLLER_PACKET_AMBIGUOUS",
    );
  }
  const openingLineEnd = openOffset + opening.length;
  const afterOpening = trimmedEnd.slice(openingLineEnd, closeOffset);
  if (!/^\r?\n/u.test(afterOpening)) {
    throw new ControllerPacketEnvelopeError(
      "The controller packet JSON must start on the line after its opening tag.",
      "CONTROLLER_PACKET_AMBIGUOUS",
    );
  }

  const packetText = afterOpening.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
  let parsed;
  try {
    parsed = JSON.parse(packetText);
  } catch (cause) {
    throw new ControllerPacketEnvelopeError(
      `Controller packet JSON is invalid: ${cause.message}`,
      "INVALID_PACKET_JSON",
    );
  }
  assertPacketJsonDepth(parsed, maxJsonDepth);

  let packet;
  try {
    packet = parseAgentPacket(parsed);
  } catch (cause) {
    const error = new ControllerPacketEnvelopeError(
      cause.message,
      cause.code || "INVALID_CONTROLLER_PACKET",
    );
    error.cause = cause;
    throw error;
  }

  const body = trimmedEnd.slice(0, openOffset).trimEnd();
  return Object.freeze({ body, packet, packetText });
}
