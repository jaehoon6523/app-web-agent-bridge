import { sha256CanonicalJson, sha256Text } from "./canonical-json.js";
import { validateAgentPacket } from "./agent-packets.js";
import {
  AgentActor,
  AgentPacketType,
  AgentSessionStatus,
  RelayMessageKind,
  RunBlockerType,
  RunMode,
  RunPhase,
  SessionProvider,
  isVocabularyValue,
} from "./vocabulary.js";

export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class DomainContractError extends TypeError {
  constructor(message, path = "value", code = "INVALID_DOMAIN_CONTRACT") {
    super(`${message} at ${path}`);
    this.name = "DomainContractError";
    this.code = code;
    this.path = path;
  }
}

function requirePlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainContractError("must be a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DomainContractError("must be a plain object", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new DomainContractError("must not contain symbol properties", path);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, path) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new DomainContractError(`contains unsupported property ${JSON.stringify(key)}`, path);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new DomainContractError(`is missing required property ${JSON.stringify(key)}`, path);
    }
  }
}

function requireBuilderKeys(value, requiredKeys, optionalKeys, path) {
  requirePlainObject(value, path);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new DomainContractError(`contains unsupported property ${JSON.stringify(key)}`, path);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new DomainContractError(`is missing required property ${JSON.stringify(key)}`, path);
    }
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainContractError("must be a non-empty string", path);
  }
  return value;
}

function requireNullableString(value, path) {
  if (value !== null) requireNonEmptyString(value, path);
  return value;
}

function requireHash(value, path) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new DomainContractError("must be a sha256:<64 lowercase hex> digest", path);
  }
  return value;
}

function requireEnum(value, vocabulary, name, path) {
  if (!isVocabularyValue(vocabulary, value)) {
    throw new DomainContractError(`must be a ${name}`, path);
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new DomainContractError("must be a boolean", path);
  }
  return value;
}

function requireInteger(value, path, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DomainContractError(`must be a safe integer greater than or equal to ${minimum}`, path);
  }
  return value;
}

function requireStringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new DomainContractError("must be an array", path);
  }
  value.forEach((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
  return value;
}

const RUNNING_PHASE_ACTOR = Object.freeze({
  [RunPhase.CODEX_TURN_RUNNING]: AgentActor.CODEX_AGENT,
  [RunPhase.WEB_TURN_RUNNING]: AgentActor.CHATGPT_WEB_AGENT,
});

const TERMINAL_RUN_PHASES = new Set([
  RunPhase.COMPLETE,
  RunPhase.FAILED,
  RunPhase.CANCELLED,
]);

function validateAgentRunInvariants(run) {
  const expectedActor = RUNNING_PHASE_ACTOR[run.phase] ?? null;
  if (run.activeActor !== expectedActor) {
    throw new DomainContractError(
      `must be ${expectedActor ?? "null"} while phase is ${run.phase}`,
      "AgentRun.activeActor",
      "RUN_ACTOR_PHASE_MISMATCH",
    );
  }
  if (run.phase === RunPhase.HUMAN_GATE && run.blocker === null) {
    throw new DomainContractError(
      "must be present in HUMAN_GATE",
      "AgentRun.blocker",
      "RUN_BLOCKER_REQUIRED",
    );
  }
  if (
    run.phase === RunPhase.RECOVERY_REQUIRED
    && run.blocker?.type !== RunBlockerType.RECOVERY_CONFIRMATION
  ) {
    throw new DomainContractError(
      "must be a RECOVERY_CONFIRMATION blocker in RECOVERY_REQUIRED",
      "AgentRun.blocker",
      "RUN_RECOVERY_BLOCKER_REQUIRED",
    );
  }
  if (TERMINAL_RUN_PHASES.has(run.phase) && run.blocker !== null) {
    throw new DomainContractError(
      "must be null in a terminal phase",
      "AgentRun.blocker",
      "TERMINAL_RUN_BLOCKER_PRESENT",
    );
  }
  const oddTurnPhases = new Set([
    RunPhase.CODEX_RESPONSE_STORED,
    RunPhase.CODEX_TO_WEB_PENDING,
    RunPhase.WEB_TURN_RUNNING,
  ]);
  const evenTurnPhases = new Set([
    RunPhase.CODEX_TURN_PENDING,
    RunPhase.CODEX_TURN_RUNNING,
    RunPhase.WEB_RESPONSE_STORED,
    RunPhase.WEB_TO_CODEX_PENDING,
  ]);
  if (oddTurnPhases.has(run.phase) && run.currentTurn % 2 !== 1) {
    throw new DomainContractError(
      `must be odd while phase is ${run.phase}`,
      "AgentRun.currentTurn",
      "RUN_TURN_PHASE_MISMATCH",
    );
  }
  if (evenTurnPhases.has(run.phase) && run.currentTurn % 2 !== 0) {
    throw new DomainContractError(
      `must be even while phase is ${run.phase}`,
      "AgentRun.currentTurn",
      "RUN_TURN_PHASE_MISMATCH",
    );
  }
  if (
    (run.phase === RunPhase.WEB_RESPONSE_STORED
      || run.phase === RunPhase.WEB_TO_CODEX_PENDING
      || run.phase === RunPhase.CONSENSUS_CHECK)
    && run.currentTurn === 0
  ) {
    throw new DomainContractError(
      `must be positive while phase is ${run.phase}`,
      "AgentRun.currentTurn",
      "RUN_TURN_PHASE_MISMATCH",
    );
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function immutableClone(value) {
  return deepFreeze(structuredClone(value));
}

export const AGENT_RUN_FIELDS = Object.freeze([
  "runId",
  "mode",
  "objective",
  "objectiveHash",
  "policyHash",
  "phase",
  "activeActor",
  "maxTurns",
  "currentTurn",
  "paused",
  "blocker",
  "version",
  "createdAt",
  "updatedAt",
]);

export const AGENT_SESSION_RECORD_FIELDS = Object.freeze([
  "sessionId",
  "runId",
  "actor",
  "provider",
  "externalSessionId",
  "externalLocator",
  "status",
  "activeTurnId",
  "lastCompletedTurnId",
  "lastObservedAt",
  "version",
]);

export const RELAY_MESSAGE_FIELDS = Object.freeze([
  "messageId",
  "runId",
  "sequence",
  "fromActor",
  "toActor",
  "sourceSessionId",
  "sourceTurnId",
  "inReplyTo",
  "kind",
  "content",
  "contentHash",
  "normalizedPacket",
  "objectiveHash",
  "policyHash",
  "createdAt",
]);

export const PROPOSAL_ARTIFACT_FIELDS = Object.freeze([
  "proposalId",
  "runId",
  "authorActor",
  "title",
  "body",
  "assumptions",
  "decisions",
  "proposalHash",
  "createdFromMessageId",
]);

export function validateRunBlocker(value, path = "blocker") {
  const blocker = requirePlainObject(value, path);
  requireNonEmptyString(blocker.type, `${path}.type`);

  switch (blocker.type) {
    case RunBlockerType.RUNTIME_APPROVAL:
      requireExactKeys(blocker, ["type", "approvalId"], path);
      requireNonEmptyString(blocker.approvalId, `${path}.approvalId`);
      break;
    case RunBlockerType.USER_DECISION:
      requireExactKeys(blocker, ["type", "decisionIds"], path);
      requireStringArray(blocker.decisionIds, `${path}.decisionIds`);
      break;
    case RunBlockerType.SESSION_AUTH:
      requireExactKeys(blocker, ["type", "actor"], path);
      requireEnum(blocker.actor, AgentActor, "AgentActor", `${path}.actor`);
      break;
    case RunBlockerType.RECOVERY_CONFIRMATION:
      requireExactKeys(blocker, ["type", "operationId"], path);
      requireNonEmptyString(blocker.operationId, `${path}.operationId`);
      break;
    default:
      throw new DomainContractError("has an unknown RunBlocker type", `${path}.type`);
  }
  return blocker;
}

export function validateAgentRun(value) {
  const run = requirePlainObject(value, "AgentRun");
  requireExactKeys(run, AGENT_RUN_FIELDS, "AgentRun");
  requireNonEmptyString(run.runId, "AgentRun.runId");
  requireEnum(run.mode, RunMode, "RunMode", "AgentRun.mode");
  requireNonEmptyString(run.objective, "AgentRun.objective");
  requireHash(run.objectiveHash, "AgentRun.objectiveHash");
  if (run.objectiveHash !== sha256Text(run.objective)) {
    throw new DomainContractError("does not match objective", "AgentRun.objectiveHash", "HASH_MISMATCH");
  }
  requireHash(run.policyHash, "AgentRun.policyHash");
  requireEnum(run.phase, RunPhase, "RunPhase", "AgentRun.phase");
  if (run.activeActor !== null) {
    requireEnum(run.activeActor, AgentActor, "AgentActor", "AgentRun.activeActor");
  }
  requireInteger(run.maxTurns, "AgentRun.maxTurns", 1);
  requireInteger(run.currentTurn, "AgentRun.currentTurn", 0);
  if (run.currentTurn > run.maxTurns) {
    throw new DomainContractError("must not exceed maxTurns", "AgentRun.currentTurn");
  }
  requireBoolean(run.paused, "AgentRun.paused");
  if (run.blocker !== null) validateRunBlocker(run.blocker, "AgentRun.blocker");
  requireInteger(run.version, "AgentRun.version", 1);
  requireNonEmptyString(run.createdAt, "AgentRun.createdAt");
  requireNonEmptyString(run.updatedAt, "AgentRun.updatedAt");
  validateAgentRunInvariants(run);
  return run;
}

export function buildAgentRun(input) {
  const required = AGENT_RUN_FIELDS.filter((key) => key !== "objectiveHash");
  requireBuilderKeys(input, required, ["objectiveHash"], "AgentRun input");
  const run = {
    ...structuredClone(input),
    objectiveHash: input.objectiveHash ?? sha256Text(input.objective),
  };
  validateAgentRun(run);
  return immutableClone(run);
}

export const createAgentRun = buildAgentRun;

export function validateAgentSessionRecord(value) {
  const record = requirePlainObject(value, "AgentSessionRecord");
  requireExactKeys(record, AGENT_SESSION_RECORD_FIELDS, "AgentSessionRecord");
  requireNonEmptyString(record.sessionId, "AgentSessionRecord.sessionId");
  requireNonEmptyString(record.runId, "AgentSessionRecord.runId");
  requireEnum(record.actor, AgentActor, "AgentActor", "AgentSessionRecord.actor");
  requireEnum(record.provider, SessionProvider, "SessionProvider", "AgentSessionRecord.provider");
  const expectedProvider = record.actor === AgentActor.CODEX_AGENT
    ? SessionProvider.CODEX_APP_SERVER
    : SessionProvider.CHATGPT_WEB;
  if (record.provider !== expectedProvider) {
    throw new DomainContractError(
      `must be ${expectedProvider} for ${record.actor}`,
      "AgentSessionRecord.provider",
      "ACTOR_PROVIDER_MISMATCH",
    );
  }
  requireNullableString(record.externalSessionId, "AgentSessionRecord.externalSessionId");
  requireNullableString(record.externalLocator, "AgentSessionRecord.externalLocator");
  requireEnum(
    record.status,
    AgentSessionStatus,
    "AgentSessionStatus",
    "AgentSessionRecord.status",
  );
  requireNullableString(record.activeTurnId, "AgentSessionRecord.activeTurnId");
  requireNullableString(record.lastCompletedTurnId, "AgentSessionRecord.lastCompletedTurnId");
  requireNullableString(record.lastObservedAt, "AgentSessionRecord.lastObservedAt");
  requireInteger(record.version, "AgentSessionRecord.version", 1);
  return record;
}

export function buildAgentSessionRecord(input) {
  requirePlainObject(input, "AgentSessionRecord input");
  requireExactKeys(input, AGENT_SESSION_RECORD_FIELDS, "AgentSessionRecord input");
  validateAgentSessionRecord(input);
  return immutableClone(input);
}

export const createAgentSessionRecord = buildAgentSessionRecord;

export function validateRelayMessage(value) {
  const message = requirePlainObject(value, "RelayMessage");
  requireExactKeys(message, RELAY_MESSAGE_FIELDS, "RelayMessage");
  requireNonEmptyString(message.messageId, "RelayMessage.messageId");
  requireNonEmptyString(message.runId, "RelayMessage.runId");
  requireInteger(message.sequence, "RelayMessage.sequence", 1);
  requireEnum(message.fromActor, AgentActor, "AgentActor", "RelayMessage.fromActor");
  requireEnum(message.toActor, AgentActor, "AgentActor", "RelayMessage.toActor");
  if (message.fromActor === message.toActor) {
    throw new DomainContractError(
      "must differ from fromActor",
      "RelayMessage.toActor",
      "INVALID_RELAY_ROUTE",
    );
  }
  requireNonEmptyString(message.sourceSessionId, "RelayMessage.sourceSessionId");
  requireNullableString(message.sourceTurnId, "RelayMessage.sourceTurnId");
  requireNullableString(message.inReplyTo, "RelayMessage.inReplyTo");
  requireEnum(message.kind, RelayMessageKind, "RelayMessageKind", "RelayMessage.kind");
  if (message.kind === RelayMessageKind.INITIAL_OBJECTIVE) {
    throw new DomainContractError(
      "sender and source-session provenance are not defined by the current authority",
      "RelayMessage.kind",
      "INITIAL_OBJECTIVE_PROVENANCE_UNDEFINED",
    );
  }
  requireNonEmptyString(message.content, "RelayMessage.content");
  requireHash(message.contentHash, "RelayMessage.contentHash");
  if (message.contentHash !== sha256Text(message.content)) {
    throw new DomainContractError("does not match content", "RelayMessage.contentHash", "HASH_MISMATCH");
  }
  if (message.normalizedPacket !== null) validateAgentPacket(message.normalizedPacket);
  const expectedPacketType = {
    [RelayMessageKind.PROPOSAL]: AgentPacketType.PROPOSAL,
    [RelayMessageKind.REVISION]: AgentPacketType.PROPOSAL,
    [RelayMessageKind.CRITIQUE]: AgentPacketType.CRITIQUE,
    [RelayMessageKind.ACCEPTANCE]: AgentPacketType.ACCEPT,
    [RelayMessageKind.BLOCKER]: AgentPacketType.BLOCKED,
  }[message.kind];
  if (expectedPacketType !== undefined) {
    if (message.normalizedPacket === null) {
      throw new DomainContractError(
        `requires a ${expectedPacketType} normalized packet`,
        "RelayMessage.normalizedPacket",
        "RELAY_PACKET_REQUIRED",
      );
    }
    if (message.normalizedPacket.type !== expectedPacketType) {
      throw new DomainContractError(
        `must be ${expectedPacketType} for ${message.kind}`,
        "RelayMessage.normalizedPacket.type",
        "RELAY_PACKET_KIND_MISMATCH",
      );
    }
  }
  requireHash(message.objectiveHash, "RelayMessage.objectiveHash");
  requireHash(message.policyHash, "RelayMessage.policyHash");
  requireNonEmptyString(message.createdAt, "RelayMessage.createdAt");
  return message;
}

export function buildRelayMessage(input) {
  const required = RELAY_MESSAGE_FIELDS.filter((key) => key !== "contentHash");
  requireBuilderKeys(input, required, ["contentHash"], "RelayMessage input");
  const message = {
    ...structuredClone(input),
    contentHash: input.contentHash ?? sha256Text(input.content),
  };
  validateRelayMessage(message);
  return immutableClone(message);
}

export const createRelayMessage = buildRelayMessage;

export function proposalArtifactDigestInput(value) {
  const artifact = requirePlainObject(value, "ProposalArtifact");
  const allowed = new Set(PROPOSAL_ARTIFACT_FIELDS);
  for (const key of Object.keys(artifact)) {
    if (!allowed.has(key)) {
      throw new DomainContractError(
        `contains unsupported property ${JSON.stringify(key)}`,
        "ProposalArtifact",
      );
    }
  }
  const digestInput = {};
  for (const key of PROPOSAL_ARTIFACT_FIELDS) {
    if (key === "proposalHash") continue;
    if (!Object.hasOwn(artifact, key)) {
      throw new DomainContractError(
        `is missing required property ${JSON.stringify(key)}`,
        "ProposalArtifact",
      );
    }
    digestInput[key] = structuredClone(artifact[key]);
  }
  return digestInput;
}

export function proposalArtifactHash(value) {
  return sha256CanonicalJson(proposalArtifactDigestInput(value));
}

export function validateProposalArtifact(value) {
  const artifact = requirePlainObject(value, "ProposalArtifact");
  requireExactKeys(artifact, PROPOSAL_ARTIFACT_FIELDS, "ProposalArtifact");
  requireNonEmptyString(artifact.proposalId, "ProposalArtifact.proposalId");
  requireNonEmptyString(artifact.runId, "ProposalArtifact.runId");
  requireEnum(artifact.authorActor, AgentActor, "AgentActor", "ProposalArtifact.authorActor");
  requireNonEmptyString(artifact.title, "ProposalArtifact.title");
  requireNonEmptyString(artifact.body, "ProposalArtifact.body");
  requireStringArray(artifact.assumptions, "ProposalArtifact.assumptions");
  // ProposalDecision has no current schema owner; keep this at the authorized string[] boundary.
  requireStringArray(artifact.decisions, "ProposalArtifact.decisions");
  requireHash(artifact.proposalHash, "ProposalArtifact.proposalHash");
  if (artifact.proposalHash !== proposalArtifactHash(artifact)) {
    throw new DomainContractError(
      "does not match the canonical proposal artifact fields",
      "ProposalArtifact.proposalHash",
      "HASH_MISMATCH",
    );
  }
  requireNonEmptyString(
    artifact.createdFromMessageId,
    "ProposalArtifact.createdFromMessageId",
  );
  return artifact;
}

export function buildProposalArtifact(input) {
  const required = PROPOSAL_ARTIFACT_FIELDS.filter((key) => key !== "proposalHash");
  requireBuilderKeys(input, required, ["proposalHash"], "ProposalArtifact input");
  const draft = structuredClone(input);
  const artifact = {
    ...draft,
    proposalHash: draft.proposalHash ?? proposalArtifactHash(draft),
  };
  validateProposalArtifact(artifact);
  return immutableClone(artifact);
}

export const createProposalArtifact = buildProposalArtifact;
