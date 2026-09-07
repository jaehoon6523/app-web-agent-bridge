import { agentPacketHash, validateAgentPacket } from "../domain/agent-packets.js";
import { canonicalJson } from "../domain/canonical-json.js";
import {
  ControllerPacketEnvelopeError,
  parseFinalControllerPacketEnvelope,
} from "../domain/controller-packet-envelope.js";
import { AgentPacketParserStage } from "../domain/agent-packet-rejection.js";
import { AgentActor } from "../domain/vocabulary.js";

export class DiscussionRuntimeResponseError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   parserStage?: string,
   *   rawText?: string,
   *   recordablePacketRejection?: boolean,
   *   cause?: unknown
   * }} [options]
   */
  constructor(message, options = {}) {
    const {
      code = "INVALID_RUNTIME_RESPONSE",
      parserStage = AgentPacketParserStage.DOMAIN_VALIDATION,
      rawText = "",
      recordablePacketRejection = false,
      cause = undefined,
    } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DiscussionRuntimeResponseError";
    this.code = code;
    this.parserStage = parserStage;
    this.rawText = rawText;
    this.recordablePacketRejection = recordablePacketRejection;
  }
}

function requireObject(value, name, rawText = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscussionRuntimeResponseError(`${name} must be an object.`, {
      code: "RUNTIME_COMPLETION_INVALID",
      rawText,
    });
  }
  return value;
}

function validatePacket(packet, rawText, code, { recordablePacketRejection = false } = {}) {
  try {
    validateAgentPacket(packet);
    return packet;
  } catch (cause) {
    throw new DiscussionRuntimeResponseError(cause.message, {
      code,
      parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
      rawText,
      recordablePacketRejection,
      cause,
    });
  }
}

function projectCodexEnvelope(value, rawText, code, options = {}) {
  const envelope = requireObject(value, "Codex structured output", rawText);
  const fields = {
    PROPOSAL: ["type", "summary", "body", "assumptions", "open_decisions"],
    CRITIQUE: [
      "type",
      "target_proposal_sha256",
      "blocking_findings",
      "non_blocking_findings",
      "requested_changes",
    ],
    ACCEPT: ["type", "accepted_proposal_sha256", "blocking_findings"],
    BLOCKED: ["type", "reason_code", "description", "required_decisions"],
  };
  const selected = fields[envelope.type];
  if (selected === undefined) {
    throw new DiscussionRuntimeResponseError("Codex output has an unknown packet type.", {
      code,
      parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
      rawText,
      recordablePacketRejection: options.recordablePacketRejection,
    });
  }
  return validatePacket(
    Object.fromEntries(selected.map((key) => [key, envelope[key]])),
    rawText,
    code,
    options,
  );
}

function assertTurnId(completion, expectedTurnId, rawText) {
  if (completion.turnId !== expectedTurnId) {
    throw new DiscussionRuntimeResponseError(
      "Runtime completion turnId does not match the submitted turn.",
      {
        code: "RUNTIME_COMPLETION_TURN_MISMATCH",
        parserStage: AgentPacketParserStage.HASH_BINDING,
        rawText,
      },
    );
  }
}

function normalizeCodex(completion, { turnId, externalSessionId }) {
  const value = requireObject(completion, "Codex completion");
  const rawText = typeof value.text === "string" ? value.text : "";
  assertTurnId(value, turnId, rawText);
  if (
    externalSessionId !== null
    && externalSessionId !== undefined
    && value.threadId !== externalSessionId
  ) {
    throw new DiscussionRuntimeResponseError(
      "Codex completion threadId does not match the persisted session.",
      {
        code: "RUNTIME_COMPLETION_SESSION_MISMATCH",
        parserStage: AgentPacketParserStage.HASH_BINDING,
        rawText,
      },
    );
  }
  if (rawText.trim() === "") {
    throw new DiscussionRuntimeResponseError("Codex completion has no authoritative text.", {
      code: "CODEX_AUTHORITATIVE_OUTPUT_MISSING",
      parserStage: AgentPacketParserStage.CONTROLLER_PACKET_EXTRACTION,
      rawText,
      recordablePacketRejection: true,
    });
  }

  let parsedText;
  try {
    parsedText = JSON.parse(rawText);
  } catch (cause) {
    throw new DiscussionRuntimeResponseError("Codex authoritative output is not JSON.", {
      code: "INVALID_AGENT_PACKET_JSON",
      parserStage: AgentPacketParserStage.JSON_PARSE,
      rawText,
      recordablePacketRejection: true,
      cause,
    });
  }
  const parsedPacket = projectCodexEnvelope(parsedText, rawText, "INVALID_AGENT_PACKET", {
    recordablePacketRejection: true,
  });
  if (!Object.hasOwn(value, "structuredOutput")) {
    throw new DiscussionRuntimeResponseError(
      "Codex completion has no schema-validated structured output.",
      {
        code: "CODEX_STRUCTURED_OUTPUT_MISSING",
        parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
        rawText,
      },
    );
  }
  const structuredPacket = projectCodexEnvelope(
    value.structuredOutput,
    rawText,
    "INVALID_CODEX_STRUCTURED_OUTPUT",
  );
  if (agentPacketHash(parsedPacket) !== agentPacketHash(structuredPacket)) {
    throw new DiscussionRuntimeResponseError(
      "Codex text and structured output do not describe the same packet.",
      {
        code: "CODEX_OUTPUT_HASH_MISMATCH",
        parserStage: AgentPacketParserStage.HASH_BINDING,
        rawText,
      },
    );
  }

  return Object.freeze({
    content: `<controller_packet>\n${canonicalJson(parsedPacket)}\n</controller_packet>`,
    packet: parsedPacket,
    rawText,
  });
}

function normalizeWeb(completion, { turnId }) {
  const value = requireObject(completion, "Web completion");
  const rawText = typeof value.rawText === "string" ? value.rawText : "";
  assertTurnId(value, turnId, rawText);
  if (rawText.trim() === "") {
    throw new DiscussionRuntimeResponseError("Web completion has no authoritative response.", {
      code: "WEB_AUTHORITATIVE_OUTPUT_MISSING",
      parserStage: AgentPacketParserStage.CONTROLLER_PACKET_EXTRACTION,
      rawText,
      recordablePacketRejection: true,
    });
  }

  let parsed;
  try {
    parsed = parseFinalControllerPacketEnvelope(rawText);
  } catch (cause) {
    const parserStage = cause instanceof ControllerPacketEnvelopeError
      && cause.code === "INVALID_PACKET_JSON"
      ? AgentPacketParserStage.JSON_PARSE
      : cause instanceof ControllerPacketEnvelopeError
        && ["INVALID_CONTROLLER_PACKET", "INVALID_AGENT_PACKET"].includes(cause.code)
        ? AgentPacketParserStage.SCHEMA_VALIDATION
        : AgentPacketParserStage.CONTROLLER_PACKET_EXTRACTION;
    throw new DiscussionRuntimeResponseError(cause.message, {
      code: cause.code || "INVALID_WEB_CONTROLLER_PACKET",
      parserStage,
      rawText,
      recordablePacketRejection: true,
      cause,
    });
  }
  if (!Object.hasOwn(value, "packet")) {
    throw new DiscussionRuntimeResponseError("Web completion has no parsed packet.", {
      code: "WEB_PARSED_PACKET_MISSING",
      parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
      rawText,
    });
  }
  const supplied = validatePacket(value.packet, rawText, "INVALID_WEB_PARSED_PACKET");
  if (agentPacketHash(parsed.packet) !== agentPacketHash(supplied)) {
    throw new DiscussionRuntimeResponseError(
      "Web raw response and parsed packet do not match.",
      {
        code: "WEB_OUTPUT_HASH_MISMATCH",
        parserStage: AgentPacketParserStage.HASH_BINDING,
        rawText,
      },
    );
  }
  return Object.freeze({ content: rawText, packet: parsed.packet, rawText });
}

export function normalizeDiscussionRuntimeCompletion({
  actor,
  completion,
  turnId,
  externalSessionId = null,
}) {
  if (actor === AgentActor.CODEX_AGENT) {
    return normalizeCodex(completion, { turnId, externalSessionId });
  }
  if (actor === AgentActor.CHATGPT_WEB_AGENT) {
    return normalizeWeb(completion, { turnId });
  }
  throw new TypeError(`Unsupported discussion runtime actor: ${String(actor)}.`);
}
