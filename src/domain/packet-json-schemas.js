import { HUMAN_GATE_REASONS } from "./vocabulary.js";

const NON_EMPTY_STRING = Object.freeze({ type: "string", minLength: 1 });
const SHA256_STRING = Object.freeze({
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
});
const STRING_ARRAY = Object.freeze({
  type: "array",
  items: NON_EMPTY_STRING,
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
  proposal_id: NON_EMPTY_STRING,
  proposal_sha256: SHA256_STRING,
  summary: NON_EMPTY_STRING,
  body: NON_EMPTY_STRING,
  assumptions: STRING_ARRAY,
  open_decisions: STRING_ARRAY,
});

export const CritiquePacketSchema = closedObject({
  type: discriminator("CRITIQUE"),
  target_proposal_sha256: SHA256_STRING,
  blocking_findings: STRING_ARRAY,
  non_blocking_findings: STRING_ARRAY,
  requested_changes: STRING_ARRAY,
});

export const AcceptancePacketSchema = closedObject({
  type: discriminator("ACCEPT"),
  accepted_proposal_sha256: SHA256_STRING,
  blocking_findings: STRING_ARRAY,
});

export const BlockedPacketSchema = closedObject({
  type: discriminator("BLOCKED"),
  reason_code: Object.freeze({
    type: "string",
    enum: HUMAN_GATE_REASONS,
  }),
  description: NON_EMPTY_STRING,
  required_decisions: STRING_ARRAY,
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
    error.code = type === "PROTOCOL_ERROR"
      ? "PROTOCOL_ERROR_PACKET_SCHEMA_UNDEFINED"
      : "UNKNOWN_AGENT_PACKET_TYPE";
    throw error;
  }
  return structuredClone(schema);
}
