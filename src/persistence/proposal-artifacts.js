import { canonicalJson } from "../domain/canonical-json.js";
import {
  validateAgentRun,
  validateProposalArtifact,
} from "../domain/contracts.js";
import { validateAgentMessage } from "../domain/agent-messages.js";
import { AgentMessageKind } from "../domain/vocabulary.js";

const PROPOSAL_MESSAGE_KINDS = new Set([
  AgentMessageKind.PROPOSAL,
  AgentMessageKind.REVISION,
]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function decodeCanonical(text, context, validator, errors) {
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

function readRun(database, runId, errors) {
  const row = database.prepare("SELECT run_json FROM runs WHERE run_id = ?").get(runId);
  if (!row) {
    throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
  }
  return decodeCanonical(row.run_json, `run ${runId}`, validateAgentRun, errors);
}

function readSourceMessage(database, messageId, errors) {
  const row = database.prepare(`
    SELECT * FROM agent_messages WHERE message_id = ?
  `).get(messageId);
  if (!row) {
    throw new errors.PersistenceError(
      `agent message ${messageId} does not exist`,
      "AGENT_MESSAGE_NOT_FOUND",
    );
  }
  const message = decodeCanonical(
    row.message_json,
    `agent message ${messageId}`,
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
      `agent message ${messageId} metadata does not match its JSON`,
    );
  }
  return message;
}

function mismatch(errors, artifact, field, integrity) {
  const message = `proposal ${artifact.proposalId} ${field} does not match its source`;
  if (integrity) throw new errors.EventChainIntegrityError(message);
  throw new errors.PersistenceError(message, "PROPOSAL_SOURCE_MISMATCH");
}

function assertEqual(errors, artifact, field, expected, observed, integrity) {
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    mismatch(errors, artifact, field, integrity);
  }
}

function verifyArtifactSource(database, artifact, errors, integrity) {
  const run = readRun(database, artifact.runId, errors);
  const message = readSourceMessage(database, artifact.sourceMessageId, errors);
  if (!PROPOSAL_MESSAGE_KINDS.has(message.kind)) {
    const detail = `proposal ${artifact.proposalId} source message must be PROPOSAL or REVISION`;
    if (integrity) throw new errors.EventChainIntegrityError(detail);
    throw new errors.PersistenceError(detail, "PROPOSAL_SOURCE_KIND_MISMATCH");
  }

  assertEqual(errors, artifact, "runId", message.runId, artifact.runId, integrity);
  assertEqual(errors, artifact, "authorActor", message.actor, artifact.authorActor, integrity);
  assertEqual(
    errors,
    artifact,
    "sourceSessionId",
    message.sessionId,
    artifact.sourceSessionId,
    integrity,
  );
  assertEqual(
    errors,
    artifact,
    "sourceTurnId",
    message.turnId,
    artifact.sourceTurnId,
    integrity,
  );
  assertEqual(
    errors,
    artifact,
    "objectiveHash",
    run.objectiveHash,
    artifact.objectiveHash,
    integrity,
  );
  assertEqual(
    errors,
    artifact,
    "policyHash",
    run.policyHash,
    artifact.policyHash,
    integrity,
  );
  assertEqual(
    errors,
    artifact,
    "message objectiveHash",
    message.objectiveHash,
    artifact.objectiveHash,
    integrity,
  );
  assertEqual(
    errors,
    artifact,
    "message policyHash",
    message.policyHash,
    artifact.policyHash,
    integrity,
  );

  const packet = message.normalizedPacket;
  assertEqual(errors, artifact, "summary", packet.summary, artifact.summary, integrity);
  assertEqual(errors, artifact, "body", packet.body, artifact.body, integrity);
  assertEqual(errors, artifact, "assumptions", packet.assumptions, artifact.assumptions, integrity);
  assertEqual(
    errors,
    artifact,
    "openDecisions",
    packet.open_decisions,
    artifact.openDecisions,
    integrity,
  );
}

function decodeArtifactRow(database, row, errors) {
  const artifact = decodeCanonical(
    row.artifact_json,
    `proposal artifact ${row.proposal_id}`,
    validateProposalArtifact,
    errors,
  );
  if (
    artifact.proposalId !== row.proposal_id
    || artifact.runId !== row.run_id
    || artifact.sourceMessageId !== row.source_message_id
    || artifact.authorActor !== row.author_actor
    || artifact.sourceSessionId !== row.source_session_id
    || artifact.sourceTurnId !== row.source_turn_id
    || artifact.proposalContentHash !== row.proposal_content_hash
    || artifact.proposalRefHash !== row.proposal_ref_hash
    || artifact.createdAt !== row.created_at
  ) {
    throw new errors.EventChainIntegrityError(
      `proposal artifact ${row.proposal_id} metadata does not match its JSON`,
    );
  }
  verifyArtifactSource(database, artifact, errors, true);
  return artifact;
}

export function saveProposalArtifactEntity(database, artifact, errors) {
  validateProposalArtifact(artifact);
  verifyArtifactSource(database, artifact, errors, false);

  const existingId = database.prepare(`
    SELECT 1 AS present FROM proposal_artifacts WHERE proposal_id = ?
  `).get(artifact.proposalId);
  if (existingId) {
    throw new errors.PersistenceError(
      `proposal ${artifact.proposalId} already exists`,
      "PROPOSAL_ALREADY_EXISTS",
    );
  }
  const existingSource = database.prepare(`
    SELECT proposal_id FROM proposal_artifacts WHERE source_message_id = ?
  `).get(artifact.sourceMessageId);
  if (existingSource) {
    throw new errors.PersistenceError(
      `agent message ${artifact.sourceMessageId} already produced proposal ${existingSource.proposal_id}`,
      "PROPOSAL_SOURCE_ALREADY_USED",
    );
  }
  const existingReference = database.prepare(`
    SELECT proposal_id FROM proposal_artifacts
    WHERE run_id = ? AND proposal_ref_hash = ?
  `).get(artifact.runId, artifact.proposalRefHash);
  if (existingReference) {
    throw new errors.PersistenceError(
      `proposal reference ${artifact.proposalRefHash} already belongs to ${existingReference.proposal_id}`,
      "PROPOSAL_REFERENCE_ALREADY_EXISTS",
    );
  }

  database.prepare(`
    INSERT INTO proposal_artifacts (
      proposal_id, run_id, source_message_id, author_actor,
      source_session_id, source_turn_id, proposal_content_hash,
      proposal_ref_hash, artifact_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.proposalId,
    artifact.runId,
    artifact.sourceMessageId,
    artifact.authorActor,
    artifact.sourceSessionId,
    artifact.sourceTurnId,
    artifact.proposalContentHash,
    artifact.proposalRefHash,
    canonicalJson(artifact),
    artifact.createdAt,
  );

  return getProposalArtifactEntity(database, artifact.proposalId, errors);
}

export function getProposalArtifactEntity(database, proposalId, errors) {
  requireNonEmptyString(proposalId, "proposalId");
  const row = database.prepare(`
    SELECT * FROM proposal_artifacts WHERE proposal_id = ?
  `).get(proposalId);
  return row ? decodeArtifactRow(database, row, errors) : null;
}

export function getProposalArtifactBySourceMessageEntity(database, messageId, errors) {
  requireNonEmptyString(messageId, "messageId");
  const row = database.prepare(`
    SELECT * FROM proposal_artifacts WHERE source_message_id = ?
  `).get(messageId);
  return row ? decodeArtifactRow(database, row, errors) : null;
}

export function listProposalArtifactsEntity(database, runId, errors) {
  requireNonEmptyString(runId, "runId");
  readRun(database, runId, errors);
  return database.prepare(`
    SELECT * FROM proposal_artifacts
    WHERE run_id = ? ORDER BY created_at, proposal_id
  `).all(runId).map((row) => decodeArtifactRow(database, row, errors));
}

export function verifyProposalArtifactsEntity(database, errors) {
  let artifacts = 0;
  for (const row of database.prepare("SELECT * FROM proposal_artifacts").all()) {
    decodeArtifactRow(database, row, errors);
    artifacts += 1;
  }
  return Object.freeze({ valid: true, artifacts });
}
