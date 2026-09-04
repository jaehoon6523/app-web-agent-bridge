import { canonicalJson } from "../domain/canonical-json.js";
import { agentPacketHash, validateAgentPacket } from "../domain/agent-packets.js";
import {
  validateAgentMessage,
  validateAgentTurnInput,
} from "../domain/agent-messages.js";
import { validateAgentRun } from "../domain/contracts.js";
import { AgentActor, AgentTurnInputKind } from "../domain/vocabulary.js";
import { DeliveryState } from "./schema.js";

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function decode(text, context, validator, errors) {
  let value;
  try {
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("value is not canonical JSON");
    validator(value);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} is invalid`, { cause });
  }
  return value;
}

function requireRun(database, runId, errors) {
  const row = database.prepare("SELECT run_json FROM runs WHERE run_id = ?").get(runId);
  if (!row) throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
  return decode(row.run_json, `run ${runId}`, validateAgentRun, errors);
}

function assertRunHashes(record, run, kind, id, errors) {
  if (record.objectiveHash !== run.objectiveHash || record.policyHash !== run.policyHash) {
    throw new errors.PersistenceError(
      `${kind} ${id} is not bound to the current run hashes`,
      "RUN_HASH_MISMATCH",
    );
  }
}

function decodeTurnInput(row, errors) {
  const input = decode(
    row.input_json,
    `agent turn input ${row.input_id}`,
    validateAgentTurnInput,
    errors,
  );
  if (
    input.inputId !== row.input_id
    || input.runId !== row.run_id
    || input.targetActor !== row.target_actor
    || input.kind !== row.kind
    || input.sourceMessageId !== row.source_message_id
    || input.payloadHash !== row.payload_hash
    || input.promptHash !== row.prompt_hash
    || input.createdAt !== row.created_at
  ) {
    throw new errors.EventChainIntegrityError(
      `agent turn input ${row.input_id} metadata does not match its JSON`,
    );
  }
  return input;
}

function decodeAgentMessage(row, errors) {
  const message = decode(
    row.message_json,
    `agent message ${row.message_id}`,
    validateAgentMessage,
    errors,
  );
  if (
    message.messageId !== row.message_id
    || message.runId !== row.run_id
    || message.sequence !== Number(row.sequence)
    || message.actor !== row.actor
    || message.sessionId !== row.session_id
    || message.turnId !== row.turn_id
    || message.kind !== row.kind
    || message.contentHash !== row.content_hash
    || message.createdAt !== row.created_at
  ) {
    throw new errors.EventChainIntegrityError(
      `agent message ${row.message_id} metadata does not match its JSON`,
    );
  }
  return message;
}

export function saveAgentTurnInputWithDeliveryEntity(database, value, errors) {
  const input = requireObject(value, "turn input delivery");
  const keys = new Set(["turnInput", "deliveryId", "idempotencyKey", "createdAt"]);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new TypeError(`turn input delivery contains unsupported ${key}`);
  }
  const turnInput = input.turnInput;
  validateAgentTurnInput(turnInput);
  requireString(input.deliveryId, "deliveryId");
  requireString(input.idempotencyKey, "idempotencyKey");
  requireString(input.createdAt, "createdAt");

  const run = requireRun(database, turnInput.runId, errors);
  assertRunHashes(turnInput, run, "agent turn input", turnInput.inputId, errors);

  if (turnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    if (turnInput.targetActor !== AgentActor.CODEX_AGENT) {
      throw new errors.PersistenceError(
        "INITIAL_OBJECTIVE must target CODEX_AGENT",
        "INITIAL_OBJECTIVE_TARGET_MISMATCH",
      );
    }
    const prior = database.prepare(
      "SELECT 1 AS present FROM agent_turn_inputs WHERE run_id = ? LIMIT 1",
    ).get(turnInput.runId);
    if (prior) {
      throw new errors.PersistenceError(
        `run ${turnInput.runId} already has an AgentTurnInput`,
        "INITIAL_OBJECTIVE_NOT_FIRST",
      );
    }
  }

  if (turnInput.sourceMessageId !== null) {
    const source = database.prepare(`
      SELECT run_id, actor FROM agent_messages WHERE message_id = ?
    `).get(turnInput.sourceMessageId);
    if (!source) {
      throw new errors.PersistenceError(
        `source message ${turnInput.sourceMessageId} does not exist`,
        "SOURCE_MESSAGE_NOT_FOUND",
      );
    }
    if (source.run_id !== turnInput.runId || source.actor === turnInput.targetActor) {
      throw new errors.PersistenceError(
        `source message ${turnInput.sourceMessageId} does not match the turn input route`,
        "SOURCE_MESSAGE_ROUTE_MISMATCH",
      );
    }
  }

  database.prepare(`
    INSERT INTO agent_turn_inputs (
      input_id, run_id, target_actor, kind, source_message_id,
      payload_hash, prompt_hash, input_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    turnInput.inputId,
    turnInput.runId,
    turnInput.targetActor,
    turnInput.kind,
    turnInput.sourceMessageId,
    turnInput.payloadHash,
    turnInput.promptHash,
    canonicalJson(turnInput),
    turnInput.createdAt,
  );
  database.prepare(`
    INSERT INTO delivery_attempts (
      delivery_id, run_id, input_id, idempotency_key, state,
      attempt_count, version, provider_receipt_json, error_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 1, NULL, NULL, ?, ?)
  `).run(
    input.deliveryId,
    turnInput.runId,
    turnInput.inputId,
    input.idempotencyKey,
    DeliveryState.PENDING,
    input.createdAt,
    input.createdAt,
  );
}

export function saveAgentMessageEntity(database, value, errors) {
  const input = requireObject(value, "agent message save input");
  const keys = Object.keys(input);
  if (
    keys.length !== 2
    || !Object.hasOwn(input, "inputId")
    || !Object.hasOwn(input, "message")
  ) {
    throw new TypeError("agent message save input must contain inputId and message");
  }
  requireString(input.inputId, "inputId");
  const message = input.message;
  validateAgentMessage(message);
  const run = requireRun(database, message.runId, errors);
  assertRunHashes(message, run, "agent message", message.messageId, errors);

  const turnInput = database.prepare(`
    SELECT run_id, target_actor FROM agent_turn_inputs WHERE input_id = ?
  `).get(input.inputId);
  if (!turnInput) {
    throw new errors.PersistenceError(
      `agent turn input ${input.inputId} does not exist`,
      "AGENT_TURN_INPUT_NOT_FOUND",
    );
  }
  if (turnInput.run_id !== message.runId || turnInput.target_actor !== message.actor) {
    throw new errors.PersistenceError(
      `agent message ${message.messageId} does not match input ${input.inputId}`,
      "AGENT_MESSAGE_INPUT_MISMATCH",
    );
  }
  const session = database.prepare(`
    SELECT run_id, actor FROM agent_sessions WHERE session_id = ?
  `).get(message.sessionId);
  if (!session) {
    throw new errors.PersistenceError(
      `agent session ${message.sessionId} does not exist`,
      "AGENT_SESSION_NOT_FOUND",
    );
  }
  if (session.run_id !== message.runId || session.actor !== message.actor) {
    throw new errors.PersistenceError(
      `agent session ${message.sessionId} does not own message ${message.messageId}`,
      "AGENT_MESSAGE_SESSION_MISMATCH",
    );
  }
  const latest = database.prepare(`
    SELECT MAX(sequence) AS sequence FROM agent_messages WHERE run_id = ?
  `).get(message.runId);
  const expectedSequence = Number(latest.sequence ?? 0) + 1;
  if (message.sequence !== expectedSequence) {
    throw new errors.PersistenceError(
      `agent message sequence ${message.sequence} must be ${expectedSequence}`,
      "AGENT_MESSAGE_SEQUENCE_MISMATCH",
    );
  }

  database.prepare(`
    INSERT INTO agent_messages (
      message_id, run_id, input_id, sequence, actor, session_id,
      turn_id, kind, content_hash, message_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.messageId,
    message.runId,
    input.inputId,
    message.sequence,
    message.actor,
    message.sessionId,
    message.turnId,
    message.kind,
    message.contentHash,
    canonicalJson(message),
    message.createdAt,
  );
}

export function getAgentTurnInputEntity(database, inputId, errors) {
  requireString(inputId, "inputId");
  const row = database.prepare(
    "SELECT * FROM agent_turn_inputs WHERE input_id = ?",
  ).get(inputId);
  return row ? decodeTurnInput(row, errors) : null;
}

export function listAgentTurnInputsEntity(database, runId, errors) {
  requireString(runId, "runId");
  requireRun(database, runId, errors);
  return database.prepare(`
    SELECT * FROM agent_turn_inputs
    WHERE run_id = ? ORDER BY created_at, input_id
  `).all(runId).map((row) => decodeTurnInput(row, errors));
}

export function getAgentMessageEntity(database, messageId, errors) {
  requireString(messageId, "messageId");
  const row = database.prepare(
    "SELECT * FROM agent_messages WHERE message_id = ?",
  ).get(messageId);
  return row ? decodeAgentMessage(row, errors) : null;
}

export function listAgentMessagesEntity(database, runId, errors) {
  requireString(runId, "runId");
  requireRun(database, runId, errors);
  return database.prepare(`
    SELECT * FROM agent_messages WHERE run_id = ? ORDER BY sequence
  `).all(runId).map((row) => decodeAgentMessage(row, errors));
}

export function verifyAgentCommunicationLinksEntity(database, errors) {
  let turnInputs = 0;
  let messages = 0;
  let packets = 0;
  let deliveries = 0;

  for (const row of database.prepare("SELECT * FROM agent_turn_inputs").all()) {
    const input = decodeTurnInput(row, errors);
    if (input.sourceMessageId !== null) {
      const source = database.prepare(`
        SELECT run_id, actor FROM agent_messages WHERE message_id = ?
      `).get(input.sourceMessageId);
      if (
        !source
        || source.run_id !== input.runId
        || source.actor === input.targetActor
      ) {
        throw new errors.EventChainIntegrityError(
          `agent turn input ${input.inputId} source-message link is inconsistent`,
        );
      }
    }
    turnInputs += 1;
  }

  for (const row of database.prepare("SELECT * FROM agent_messages").all()) {
    const message = decodeAgentMessage(row, errors);
    const input = database.prepare(`
      SELECT run_id, target_actor FROM agent_turn_inputs WHERE input_id = ?
    `).get(row.input_id);
    const session = database.prepare(`
      SELECT run_id, actor FROM agent_sessions WHERE session_id = ?
    `).get(message.sessionId);
    if (
      !input
      || input.run_id !== message.runId
      || input.target_actor !== message.actor
      || !session
      || session.run_id !== message.runId
      || session.actor !== message.actor
    ) {
      throw new errors.EventChainIntegrityError(
        `agent message ${message.messageId} input/session links are inconsistent`,
      );
    }
    messages += 1;
  }

  for (const row of database.prepare("SELECT * FROM agent_packets").all()) {
    const packet = decode(
      row.packet_json,
      `agent packet ${row.packet_id}`,
      validateAgentPacket,
      errors,
    );
    const messageRow = database.prepare(`
      SELECT run_id, message_json FROM agent_messages WHERE message_id = ?
    `).get(row.message_id);
    if (!messageRow || messageRow.run_id !== row.run_id) {
      throw new errors.EventChainIntegrityError(
        `agent packet ${row.packet_id} message link is inconsistent`,
      );
    }
    const message = decode(
      messageRow.message_json,
      `agent message ${row.message_id}`,
      validateAgentMessage,
      errors,
    );
    if (
      row.packet_hash !== agentPacketHash(packet)
      || canonicalJson(packet) !== canonicalJson(message.normalizedPacket)
    ) {
      throw new errors.EventChainIntegrityError(
        `agent packet ${row.packet_id} content is inconsistent`,
      );
    }
    packets += 1;
  }

  for (const row of database.prepare("SELECT * FROM delivery_attempts").all()) {
    const input = database.prepare(`
      SELECT run_id FROM agent_turn_inputs WHERE input_id = ?
    `).get(row.input_id);
    if (!input || input.run_id !== row.run_id) {
      throw new errors.EventChainIntegrityError(
        `delivery ${row.delivery_id} input link is inconsistent`,
      );
    }
    deliveries += 1;
  }

  return Object.freeze({ valid: true, turnInputs, messages, packets, deliveries });
}
