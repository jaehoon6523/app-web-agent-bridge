import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";
import { parseFinalControllerPacketEnvelope } from "../domain/controller-packet-envelope.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  AgentActor,
  AgentMessageKind,
  RunMode,
  RunOutcomeType,
  RunPhase,
  isVocabularyValue,
} from "../domain/vocabulary.js";
import {
  getAgentMessageByInputEntity,
  getAgentTurnInputEntity,
} from "./agent-communications.js";
import { getAgentPacketEntity } from "./sqlite-entities.js";
import { getProposalArtifactByReferenceEntity } from "./proposal-artifacts.js";
import { getRunOutcomeEntity } from "./run-outcomes.js";
import { DeliveryState } from "./schema.js";
import { getTurnSubmissionEvidenceByDeliveryEntity } from "./turn-submission-links.js";

const DISCUSSION_EVENT_TYPE = "AGENT_RESPONSE_STORED";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const PROPOSAL_MESSAGE_KINDS = new Set([
  AgentMessageKind.PROPOSAL,
  AgentMessageKind.REVISION,
]);
const RESPONSE_DISPOSITIONS = Object.freeze({
  RELAY: "RELAY",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  HELD: "HELD",
});

const DETAIL_KEYS = Object.freeze([
  "deliveryId",
  "inputId",
  "messageId",
  "messageHash",
  "messageContentHash",
  "packetId",
  "packetHash",
  "proposal",
  "next",
  "outcome",
  "disposition",
]);
const PROPOSAL_KEYS = Object.freeze([
  "proposalId",
  "proposalContentHash",
  "proposalRefHash",
  "reused",
]);
const NEXT_KEYS = Object.freeze(["inputId", "deliveryId"]);
const OUTCOME_KEYS = Object.freeze(["type", "hash"]);

function integrity(errors, context, message, options = undefined) {
  throw new errors.EventChainIntegrityError(`${context} ${message}`, options);
}

function requirePlainObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, context) {
  requirePlainObject(value, context);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${context} contains unsupported property ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${context} is missing ${key}`);
  }
}

function requireString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function requireHash(value, context) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${context} must be a sha256 digest`);
  }
  return value;
}

function decodeResponseEvent(row, errors) {
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    if (canonicalJson(payload) !== row.payload_json) {
      throw new TypeError("payload must be canonical JSON");
    }
    requireExactKeys(payload, PAYLOAD_KEYS, "payload");
    validateAgentRun(payload.run);
    if (payload.run.runId !== row.run_id) {
      throw new TypeError("payload run does not match event ownership");
    }
    const details = payload.details;
    requireExactKeys(details, DETAIL_KEYS, "details");
    requireString(details.deliveryId, "details.deliveryId");
    requireString(details.inputId, "details.inputId");
    requireString(details.messageId, "details.messageId");
    requireHash(details.messageHash, "details.messageHash");
    requireHash(details.messageContentHash, "details.messageContentHash");
    requireString(details.packetId, "details.packetId");
    requireHash(details.packetHash, "details.packetHash");
    if (!isVocabularyValue(RESPONSE_DISPOSITIONS, details.disposition)) {
      throw new TypeError("details.disposition must be RELAY, COMPLETE, BLOCKED, or HELD");
    }

    if (details.proposal !== null) {
      requireExactKeys(details.proposal, PROPOSAL_KEYS, "details.proposal");
      requireString(details.proposal.proposalId, "details.proposal.proposalId");
      requireHash(
        details.proposal.proposalContentHash,
        "details.proposal.proposalContentHash",
      );
      requireHash(details.proposal.proposalRefHash, "details.proposal.proposalRefHash");
      if (typeof details.proposal.reused !== "boolean") {
        throw new TypeError("details.proposal.reused must be a boolean");
      }
    }
    if (details.next !== null) {
      requireExactKeys(details.next, NEXT_KEYS, "details.next");
      requireString(details.next.inputId, "details.next.inputId");
      requireString(details.next.deliveryId, "details.next.deliveryId");
    }
    if (details.outcome !== null) {
      requireExactKeys(details.outcome, OUTCOME_KEYS, "details.outcome");
      if (!isVocabularyValue(RunOutcomeType, details.outcome.type)) {
        throw new TypeError("details.outcome.type must be a RunOutcomeType");
      }
      requireHash(details.outcome.hash, "details.outcome.hash");
    }

    if (
      details.disposition === RESPONSE_DISPOSITIONS.RELAY
      && (details.next === null || details.outcome !== null)
    ) {
      throw new TypeError("RELAY requires next and forbids outcome");
    }
    if (
      details.disposition === RESPONSE_DISPOSITIONS.COMPLETE
      && (details.next !== null || details.outcome === null)
    ) {
      throw new TypeError("COMPLETE requires outcome and forbids next");
    }
    if (details.disposition === RESPONSE_DISPOSITIONS.BLOCKED && details.next !== null) {
      throw new TypeError("BLOCKED forbids next");
    }
    if (
      details.disposition === RESPONSE_DISPOSITIONS.HELD
      && (details.next !== null || details.outcome !== null)
    ) {
      throw new TypeError("HELD forbids next and outcome");
    }
    return { run: payload.run, details };
  } catch (cause) {
    integrity(errors, context, "has invalid details", { cause });
  }
}

function verifyResponseState(row, eventRun, message, errors) {
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  const expectedPhase = message.actor === AgentActor.CODEX_AGENT
    ? RunPhase.CODEX_RESPONSE_STORED
    : RunPhase.WEB_RESPONSE_STORED;
  if (
    eventRun.phase !== expectedPhase
    || eventRun.activeActor !== null
    || eventRun.objectiveHash !== message.objectiveHash
    || eventRun.policyHash !== message.policyHash
  ) {
    integrity(errors, context, "run state does not match the stored Agent response");
  }
}

function verifySourceLinks(database, row, details, errors) {
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  const delivery = database.prepare(`
    SELECT run_id, input_id, state, provider_receipt_json
    FROM delivery_attempts WHERE delivery_id = ?
  `).get(details.deliveryId);
  if (
    !delivery
    || delivery.run_id !== row.run_id
    || delivery.input_id !== details.inputId
  ) {
    integrity(errors, context, "delivery/input link is inconsistent");
  }
  const expectedState = details.disposition === RESPONSE_DISPOSITIONS.RELAY
    ? DeliveryState.RELAYED
    : DeliveryState.RESPONSE_COMPLETED;
  if (delivery.state !== expectedState) {
    integrity(
      errors,
      context,
      `source delivery state ${delivery.state} does not match ${details.disposition}`,
    );
  }

  const input = getAgentTurnInputEntity(database, details.inputId, errors);
  if (!input || input.runId !== row.run_id) {
    integrity(errors, context, "input link is inconsistent");
  }

  const message = getAgentMessageByInputEntity(database, details.inputId, errors);
  if (
    !message
    || message.runId !== row.run_id
    || message.messageId !== details.messageId
    || sha256CanonicalJson(message) !== details.messageHash
    || message.contentHash !== details.messageContentHash
  ) {
    integrity(errors, context, "message/input link is inconsistent");
  }

  let providerReceipt;
  try {
    providerReceipt = JSON.parse(delivery.provider_receipt_json);
    if (
      canonicalJson(providerReceipt) !== delivery.provider_receipt_json
      || providerReceipt === null
      || typeof providerReceipt !== "object"
      || Array.isArray(providerReceipt)
      || providerReceipt.externalTurnId !== message.turnId
    ) {
      throw new TypeError("provider receipt does not identify the response turn");
    }
  } catch (cause) {
    integrity(errors, context, "provider receipt/message turn link is inconsistent", { cause });
  }

  const submission = getTurnSubmissionEvidenceByDeliveryEntity(
    database,
    details.deliveryId,
    errors,
  );
  if (
    submission === null
    || submission.sessionId !== message.sessionId
    || submission.turnId !== message.turnId
  ) {
    integrity(errors, context, "submission/message session and turn attribution is inconsistent");
  }

  const packet = getAgentPacketEntity(database, details.packetId, errors);
  let contentPacket;
  try {
    contentPacket = parseFinalControllerPacketEnvelope(message.content).packet;
  } catch (cause) {
    integrity(errors, context, "message content has no valid final controller packet", { cause });
  }
  if (
    !packet
    || packet.runId !== row.run_id
    || packet.messageId !== message.messageId
    || packet.packetHash !== details.packetHash
    || canonicalJson(packet.packet) !== canonicalJson(message.normalizedPacket)
    || canonicalJson(contentPacket) !== canonicalJson(message.normalizedPacket)
  ) {
    integrity(errors, context, "packet/message link is inconsistent");
  }
  return message;
}

function verifyProposalLink(database, row, details, message, errors) {
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  const expectsProposal = PROPOSAL_MESSAGE_KINDS.has(message.kind);
  if ((details.proposal !== null) !== expectsProposal) {
    integrity(errors, context, "proposal presence does not match the AgentMessage kind");
  }
  if (details.proposal === null) return;

  const artifact = getProposalArtifactByReferenceEntity(
    database,
    row.run_id,
    details.proposal.proposalRefHash,
    errors,
  );
  if (
    !artifact
    || artifact.proposalId !== details.proposal.proposalId
    || artifact.proposalContentHash !== details.proposal.proposalContentHash
    || artifact.proposalRefHash !== details.proposal.proposalRefHash
    || artifact.runId !== row.run_id
  ) {
    integrity(errors, context, "proposal link is inconsistent");
  }
  const sourceMatches = artifact.sourceMessageId === message.messageId;
  if (sourceMatches === details.proposal.reused) {
    integrity(errors, context, "proposal reused flag does not match its source message");
  }
  if (
    artifact.summary !== message.normalizedPacket.summary
    || artifact.body !== message.normalizedPacket.body
    || canonicalJson(artifact.assumptions) !== canonicalJson(message.normalizedPacket.assumptions)
    || canonicalJson(artifact.openDecisions)
      !== canonicalJson(message.normalizedPacket.open_decisions)
  ) {
    integrity(errors, context, "proposal content does not match the current AgentMessage");
  }
}

function verifyNextLink(database, row, details, message, errors) {
  if (details.next === null) return;
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  const input = getAgentTurnInputEntity(database, details.next.inputId, errors);
  if (
    !input
    || input.runId !== row.run_id
    || input.sourceMessageId !== message.messageId
  ) {
    integrity(errors, context, "next input link is inconsistent");
  }
  const delivery = database.prepare(`
    SELECT run_id, input_id FROM delivery_attempts WHERE delivery_id = ?
  `).get(details.next.deliveryId);
  if (
    !delivery
    || delivery.run_id !== row.run_id
    || delivery.input_id !== input.inputId
  ) {
    integrity(errors, context, "next delivery link is inconsistent");
  }
}

function verifyOutcomeLink(database, row, details, errors) {
  if (details.outcome === null) return;
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  const outcome = getRunOutcomeEntity(database, row.run_id, errors);
  if (
    !outcome
    || outcome.outcomeType !== details.outcome.type
    || outcome.outcomeHash !== details.outcome.hash
  ) {
    integrity(errors, context, "outcome link is inconsistent");
  }
}

function registerResponseEvidence(seen, row, details, errors) {
  const context = `discussion response event ${row.run_id}/${row.sequence}`;
  for (const [kind, id] of [
    ["delivery", details.deliveryId],
    ["input", details.inputId],
    ["message", details.messageId],
    ["packet", details.packetId],
  ]) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) integrity(errors, context, `duplicates response evidence for ${key}`);
    seen.add(key);
  }
}

function discussionRunIds(database, errors) {
  const ids = new Set();
  for (const row of database.prepare("SELECT run_id, run_json FROM runs").all()) {
    try {
      const run = JSON.parse(row.run_json);
      if (canonicalJson(run) !== row.run_json || run.runId !== row.run_id) {
        throw new TypeError("run projection is not canonical or has wrong ownership");
      }
      if (run.mode === RunMode.DISCUSSION) ids.add(row.run_id);
    } catch (cause) {
      integrity(errors, `run ${row.run_id}`, "cannot be classified for response coverage", {
        cause,
      });
    }
  }
  return ids;
}

function verifyMessageCoverage(database, runIds, seen, errors) {
  for (const runId of runIds) {
    const rows = database.prepare(`
      SELECT
        messages.message_id,
        messages.input_id,
        packets.packet_id,
        deliveries.delivery_id
      FROM agent_messages AS messages
      LEFT JOIN agent_packets AS packets ON packets.message_id = messages.message_id
      LEFT JOIN delivery_attempts AS deliveries ON deliveries.input_id = messages.input_id
      WHERE messages.run_id = ?
      ORDER BY messages.sequence
    `).all(runId);
    for (const row of rows) {
      if (
        row.packet_id === null
        || row.delivery_id === null
        || !seen.has(`message:${row.message_id}`)
        || !seen.has(`input:${row.input_id}`)
        || !seen.has(`packet:${row.packet_id}`)
        || !seen.has(`delivery:${row.delivery_id}`)
      ) {
        integrity(
          errors,
          `AgentMessage ${row.message_id}`,
          "has no exact hash-chained discussion response evidence",
        );
      }
    }
  }
}

/**
 * Verifies the durable row bindings claimed by discussion-response events.
 * Other event types have independent payload contracts and are intentionally ignored.
 */
export function verifyDiscussionResponseLinksEntity(database, errors) {
  const rows = database.prepare(`
    SELECT run_id, sequence, payload_json
    FROM domain_events
    WHERE event_type = ?
    ORDER BY run_id, sequence
  `).all(DISCUSSION_EVENT_TYPE);
  const runIds = discussionRunIds(database, errors);
  const seen = new Set();

  for (const row of rows) {
    if (!runIds.has(row.run_id)) {
      integrity(
        errors,
        `discussion response event ${row.run_id}/${row.sequence}`,
        "belongs to a non-discussion run",
      );
    }
    const decoded = decodeResponseEvent(row, errors);
    const { details } = decoded;
    registerResponseEvidence(seen, row, details, errors);
    const message = verifySourceLinks(database, row, details, errors);
    verifyResponseState(row, decoded.run, message, errors);
    verifyProposalLink(database, row, details, message, errors);
    verifyNextLink(database, row, details, message, errors);
    verifyOutcomeLink(database, row, details, errors);
  }
  verifyMessageCoverage(database, runIds, seen, errors);
  return Object.freeze({ valid: true, responses: rows.length });
}
