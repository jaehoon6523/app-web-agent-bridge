import { AGENT_BLOCKED_REASONS } from "./vocabulary.js";

const NON_EMPTY_STRING = Object.freeze({ type: "string", minLength: 1 });
const SHA256_STRING = Object.freeze({
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
});
const STRING_ARRAY = Object.freeze({
  type: "array",
  items: NON_EMPTY_STRING,
});
const NORMALIZABLE_TEXT_ARRAY = Object.freeze({
  type: "array",
  items: Object.freeze({ type: "string", pattern: "\\S" }),
});

function closedObject(properties, required = Object.keys(properties)) {
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
    additionalProperties: false,
  });
}

function discriminator(value) {
  return Object.freeze({ type: "string", enum: Object.freeze([value]) });
}

export const ProposalPacketSchema = closedObject({
  type: discriminator("PROPOSAL"),
  summary: NON_EMPTY_STRING,
  body: NON_EMPTY_STRING,
  assumptions: STRING_ARRAY,
  open_decisions: NORMALIZABLE_TEXT_ARRAY,
});

export const CritiquePacketSchema = closedObject({
  type: discriminator("CRITIQUE"),
  target_proposal_sha256: SHA256_STRING,
  blocking_findings: NORMALIZABLE_TEXT_ARRAY,
  non_blocking_findings: NORMALIZABLE_TEXT_ARRAY,
  requested_changes: NORMALIZABLE_TEXT_ARRAY,
});

export const AcceptancePacketSchema = closedObject({
  type: discriminator("ACCEPT"),
  accepted_proposal_sha256: SHA256_STRING,
  blocking_findings: NORMALIZABLE_TEXT_ARRAY,
});

export const BlockedPacketSchema = closedObject({
  type: discriminator("BLOCKED"),
  reason_code: Object.freeze({
    type: "string",
    enum: AGENT_BLOCKED_REASONS,
  }),
  description: NON_EMPTY_STRING,
  required_decisions: NORMALIZABLE_TEXT_ARRAY,
});

export const DiscussionPacketSchema = Object.freeze({
  oneOf: Object.freeze([
    ProposalPacketSchema,
    CritiquePacketSchema,
    AcceptancePacketSchema,
    BlockedPacketSchema,
  ]),
});

export const AGENT_PACKET_JSON_SCHEMAS = Object.freeze({
  PROPOSAL: ProposalPacketSchema,
  CRITIQUE: CritiquePacketSchema,
  ACCEPT: AcceptancePacketSchema,
  BLOCKED: BlockedPacketSchema,
});

export function packetJsonSchema(type) {
  const schema = AGENT_PACKET_JSON_SCHEMAS[type];
  if (!schema) {
    const error = /** @type {TypeError & {code?: string}} */ (
      new TypeError(`No authorized output schema exists for packet type ${String(type)}.`)
    );
    error.code = "UNKNOWN_AGENT_PACKET_TYPE";
    throw error;
  }
  return structuredClone(schema);
}
