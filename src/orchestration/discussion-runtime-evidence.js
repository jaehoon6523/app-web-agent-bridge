import { AgentPacketParserStage } from "../domain/agent-packet-rejection.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { AgentActor, AgentPacketType } from "../domain/vocabulary.js";

const EVIDENCE_SCHEMA = "discussion-runtime-response-evidence-v1";
const EVIDENCE_KEYS = Object.freeze([
  "schema",
  "actor",
  "parserStage",
  "observedCandidatePacketType",
]);
const ACTORS = new Set(Object.values(AgentActor));
const PARSER_STAGES = new Set(Object.values(AgentPacketParserStage));
const PACKET_TYPES = new Set(Object.values(AgentPacketType));
const TYPED_EVIDENCE_STAGES = new Set([
  AgentPacketParserStage.SCHEMA_VALIDATION,
  AgentPacketParserStage.DOMAIN_VALIDATION,
  AgentPacketParserStage.HASH_BINDING,
]);

export class DiscussionRuntimeEvidenceError extends Error {
  /** @param {string} message @param {string} [code] @param {{cause?: unknown}} [options] */
  constructor(message, code = "INVALID_DISCUSSION_RUNTIME_EVIDENCE", { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DiscussionRuntimeEvidenceError";
    this.code = code;
  }
}

function candidateType(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && PACKET_TYPES.has(value.type)
    ? value.type
    : null;
}

function candidateFromProviderBytes(actor, rawText) {
  if (typeof rawText !== "string") return null;
  try {
    if (actor === AgentActor.CODEX_AGENT) return candidateType(JSON.parse(rawText));
    if (actor === AgentActor.CHATGPT_WEB_AGENT) {
      return candidateType(parseFinalControllerPacketJsonEnvelope(rawText).parsed);
    }
  } catch {
    return null;
  }
  return null;
}

function requireContext(actor, parserStage) {
  if (!ACTORS.has(actor)) throw new TypeError("actor must be an AgentActor.");
  if (!PARSER_STAGES.has(parserStage)) {
    throw new TypeError("parserStage must be an AgentPacketParserStage.");
  }
}

export function buildDiscussionRuntimeEvidence({ actor, parserStage, rawText }) {
  requireContext(actor, parserStage);
  if (typeof rawText !== "string") throw new TypeError("rawText must be a string.");
  return canonicalJson({
    schema: EVIDENCE_SCHEMA,
    actor,
    parserStage,
    observedCandidatePacketType: TYPED_EVIDENCE_STAGES.has(parserStage)
      ? candidateFromProviderBytes(actor, rawText)
      : null,
  });
}

export function parseDiscussionRuntimeEvidence(text, { actor, parserStage }) {
  requireContext(actor, parserStage);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new DiscussionRuntimeEvidenceError(
      "Runtime-response evidence is not JSON.",
      "RUNTIME_EVIDENCE_INVALID_JSON",
      { cause },
    );
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== EVIDENCE_KEYS.length
    || EVIDENCE_KEYS.some((key) => !Object.hasOwn(value, key))
    || canonicalJson(value) !== text
  ) {
    throw new DiscussionRuntimeEvidenceError(
      "Runtime-response evidence has an invalid canonical shape.",
    );
  }
  if (
    value.schema !== EVIDENCE_SCHEMA
    || !ACTORS.has(value.actor)
    || !PARSER_STAGES.has(value.parserStage)
    || (
      value.observedCandidatePacketType !== null
      && !PACKET_TYPES.has(value.observedCandidatePacketType)
    )
    || (
      !TYPED_EVIDENCE_STAGES.has(value.parserStage)
      && value.observedCandidatePacketType !== null
    )
  ) {
    throw new DiscussionRuntimeEvidenceError(
      "Runtime-response evidence contains an invalid closed value.",
    );
  }
  if (value.actor !== actor || value.parserStage !== parserStage) {
    throw new DiscussionRuntimeEvidenceError(
      "Runtime-response evidence does not match its response context.",
      "RUNTIME_EVIDENCE_CONTEXT_MISMATCH",
    );
  }
  return Object.freeze({ ...value });
}

export { EVIDENCE_SCHEMA as DISCUSSION_RUNTIME_EVIDENCE_SCHEMA };
