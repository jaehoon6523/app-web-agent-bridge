import { agentPacketHash, validateAgentPacket } from "../domain/agent-packets.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { validateRelayMessage } from "../domain/contracts.js";
import { DeliveryState } from "./schema.js";

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Executes inside the SqliteStore transaction supplied by the caller.
 * Runtime orchestration chooses the applicable phase; this entity function
 * only guarantees that the event, projection, relay, packet, and outbox are
 * either all visible or all rolled back.
 */
export function appendCompoundRelayEntity(database, input, operations, errors) {
  requireObject(input, "compound relay input");
  const event = requireObject(input.event, "compound relay event");
  const message = input.message;
  validateRelayMessage(message);
  if (message.normalizedPacket === null) {
    throw new errors.PersistenceError(
      `relay message ${message.messageId} has no normalized packet`,
      "RELAY_PACKET_MISSING",
    );
  }
  validateAgentPacket(message.normalizedPacket);
  requireString(input.packetId, "packetId");
  requireString(input.deliveryId, "deliveryId");
  requireString(input.idempotencyKey, "idempotencyKey");
  if (event.runId !== message.runId) {
    throw new errors.PersistenceError(
      "event and relay message must belong to the same run",
      "RUN_OWNERSHIP_MISMATCH",
    );
  }

  const packetHash = agentPacketHash(message.normalizedPacket);
  const appendedEvent = operations.appendEvent({
    ...event,
    payload: {
      run: event.nextRun,
      details: {
        relayMessage: message,
        packet: { packetId: input.packetId, packetHash },
        delivery: {
          deliveryId: input.deliveryId,
          idempotencyKey: input.idempotencyKey,
          state: DeliveryState.PENDING,
        },
      },
    },
  });
  const delivery = operations.saveRelay({
    message,
    deliveryId: input.deliveryId,
    idempotencyKey: input.idempotencyKey,
    createdAt: event.createdAt,
  });
  database.prepare(`
    INSERT INTO agent_packets (
      packet_id, run_id, message_id, packet_hash, packet_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.packetId,
    message.runId,
    message.messageId,
    packetHash,
    canonicalJson(message.normalizedPacket),
    event.createdAt,
  );
  return Object.freeze({
    event: appendedEvent,
    message: operations.getRelayMessage(message.messageId),
    packet: operations.getAgentPacket(input.packetId),
    delivery,
  });
}

function decodeCanonical(text, context, errors) {
  try {
    const value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("value is not canonical JSON");
    return value;
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} is not valid canonical JSON`, { cause });
  }
}

function integrityFailure(message, errors) {
  throw new errors.EventChainIntegrityError(message);
}

export function verifyCompoundRelayLinksEntity(database, errors) {
  const rows = database.prepare(`
    SELECT run_id, sequence, payload_json
    FROM domain_events ORDER BY run_id, sequence
  `).all();
  let verified = 0;
  for (const row of rows) {
    const payload = decodeCanonical(
      row.payload_json,
      `event ${row.run_id}/${row.sequence} payload`,
      errors,
    );
    const details = payload?.details;
    if (!details || !Object.hasOwn(details, "relayMessage")) continue;
    const message = details.relayMessage;
    validateRelayMessage(message);
    const relay = database.prepare(`
      SELECT run_id, message_json FROM relay_messages WHERE message_id = ?
    `).get(message.messageId);
    if (!relay || relay.run_id !== row.run_id || relay.message_json !== canonicalJson(message)) {
      integrityFailure(`event-linked relay message ${message.messageId} is missing or inconsistent`, errors);
    }

    const packet = details.packet;
    const packetRow = database.prepare(`
      SELECT run_id, message_id, packet_hash, packet_json
      FROM agent_packets WHERE packet_id = ?
    `).get(packet?.packetId);
    if (
      !packetRow
      || packetRow.run_id !== row.run_id
      || packetRow.message_id !== message.messageId
      || packetRow.packet_hash !== packet?.packetHash
      || packetRow.packet_json !== canonicalJson(message.normalizedPacket)
    ) {
      integrityFailure(`event-linked packet ${packet?.packetId ?? "(missing)"} is inconsistent`, errors);
    }

    const delivery = details.delivery;
    const deliveryRow = database.prepare(`
      SELECT run_id, message_id, idempotency_key, created_at
      FROM delivery_attempts WHERE delivery_id = ?
    `).get(delivery?.deliveryId);
    if (
      !deliveryRow
      || deliveryRow.run_id !== row.run_id
      || deliveryRow.message_id !== message.messageId
      || deliveryRow.idempotency_key !== delivery?.idempotencyKey
      || deliveryRow.created_at !== row.createdAt
    ) {
      integrityFailure(`event-linked delivery ${delivery?.deliveryId ?? "(missing)"} is inconsistent`, errors);
    }
    verified += 1;
  }
  return Object.freeze({ valid: true, verified });
}
