import { sha256CanonicalJson, sha256Text } from "./canonical-json.js";
import {
  AgentActor,
  AgentSessionStatus,
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

export const PROPOSAL_ARTIFACT_FIELDS = Object.freeze([
  "proposalId",
  "runId",
  "authorActor",
  "sourceMessageId",
  "sourceSessionId",
  "sourceTurnId",
  "summary",
  "body",
  "assumptions",
  "openDecisions",
  "objectiveHash",
  "policyHash",
  "proposalContentHash",
  "proposalRefHash",
  "createdAt",
]);

export const PROPOSAL_CONTENT_HASH_SCHEMA = "proposal-content-v1";
export const PROPOSAL_REF_HASH_SCHEMA = "proposal-ref-v1";

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

function normalizeTextItem(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : value;
}

function normalizeTextArray(value) {
  return Array.isArray(value) ? value.map(normalizeTextItem) : value;
}

function requireCanonicalTextArray(value, path) {
  if (!Array.isArray(value)) {
    throw new DomainContractError("must be an array", path);
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const normalized = normalizeTextItem(item);
    if (typeof normalized !== "string" || normalized.length === 0) {
      throw new DomainContractError("must be a non-blank string", itemPath);
    }
    if (item !== normalized) {
      throw new DomainContractError("must be NFC-normalized and trimmed", itemPath);
    }
  });
  return value;
}

export function proposalContentHashInput(value) {
  const content = requirePlainObject(value, "ProposalContent");
  requireNonEmptyString(content.summary, "ProposalContent.summary");
  requireNonEmptyString(content.body, "ProposalContent.body");
  requireStringArray(content.assumptions, "ProposalContent.assumptions");
  requireCanonicalTextArray(content.openDecisions, "ProposalContent.openDecisions");
  return {
    schema: PROPOSAL_CONTENT_HASH_SCHEMA,
    summary: content.summary,
    body: content.body,
    assumptions: structuredClone(content.assumptions),
    openDecisions: structuredClone(content.openDecisions),
  };
}

export function proposalContentHash(value) {
  return sha256CanonicalJson(proposalContentHashInput(value));
}

export function proposalRefHashInput(value) {
  const reference = requirePlainObject(value, "ProposalReference");
  requireNonEmptyString(reference.runId, "ProposalReference.runId");
  requireHash(reference.objectiveHash, "ProposalReference.objectiveHash");
  requireHash(reference.policyHash, "ProposalReference.policyHash");
  requireHash(reference.proposalContentHash, "ProposalReference.proposalContentHash");
  return {
    schema: PROPOSAL_REF_HASH_SCHEMA,
    runId: reference.runId,
    objectiveHash: reference.objectiveHash,
    policyHash: reference.policyHash,
    proposalContentHash: reference.proposalContentHash,
  };
}

export function proposalRefHash(value) {
  return sha256CanonicalJson(proposalRefHashInput(value));
}

export function validateProposalArtifact(value) {
  const artifact = requirePlainObject(value, "ProposalArtifact");
  requireExactKeys(artifact, PROPOSAL_ARTIFACT_FIELDS, "ProposalArtifact");
  requireNonEmptyString(artifact.proposalId, "ProposalArtifact.proposalId");
  requireNonEmptyString(artifact.runId, "ProposalArtifact.runId");
  requireEnum(artifact.authorActor, AgentActor, "AgentActor", "ProposalArtifact.authorActor");
  requireNonEmptyString(artifact.sourceMessageId, "ProposalArtifact.sourceMessageId");
  requireNonEmptyString(artifact.sourceSessionId, "ProposalArtifact.sourceSessionId");
  requireNonEmptyString(artifact.sourceTurnId, "ProposalArtifact.sourceTurnId");
  requireNonEmptyString(artifact.summary, "ProposalArtifact.summary");
  requireNonEmptyString(artifact.body, "ProposalArtifact.body");
  requireStringArray(artifact.assumptions, "ProposalArtifact.assumptions");
  requireCanonicalTextArray(artifact.openDecisions, "ProposalArtifact.openDecisions");
  requireHash(artifact.objectiveHash, "ProposalArtifact.objectiveHash");
  requireHash(artifact.policyHash, "ProposalArtifact.policyHash");
  requireHash(artifact.proposalContentHash, "ProposalArtifact.proposalContentHash");
  if (artifact.proposalContentHash !== proposalContentHash(artifact)) {
    throw new DomainContractError(
      "does not match the canonical proposal content",
      "ProposalArtifact.proposalContentHash",
      "HASH_MISMATCH",
    );
  }
  requireHash(artifact.proposalRefHash, "ProposalArtifact.proposalRefHash");
  if (artifact.proposalRefHash !== proposalRefHash(artifact)) {
    throw new DomainContractError(
      "does not match the canonical run-bound proposal reference",
      "ProposalArtifact.proposalRefHash",
      "HASH_MISMATCH",
    );
  }
  requireNonEmptyString(artifact.createdAt, "ProposalArtifact.createdAt");
  return artifact;
}

export function buildProposalArtifact(input) {
  const derivedFields = new Set(["proposalContentHash", "proposalRefHash"]);
  const required = PROPOSAL_ARTIFACT_FIELDS.filter((key) => !derivedFields.has(key));
  requireBuilderKeys(
    input,
    required,
    ["proposalContentHash", "proposalRefHash"],
    "ProposalArtifact input",
  );
  const draft = {
    ...structuredClone(input),
    openDecisions: normalizeTextArray(input.openDecisions),
  };
  const contentHash = proposalContentHash(draft);
  const artifact = {
    ...draft,
    proposalContentHash: draft.proposalContentHash ?? contentHash,
  };
  artifact.proposalRefHash = draft.proposalRefHash ?? proposalRefHash(artifact);
  validateProposalArtifact(artifact);
  return immutableClone(artifact);
}

export const createProposalArtifact = buildProposalArtifact;

export {
  AGENT_MESSAGE_FIELDS,
  AGENT_TURN_INPUT_FIELDS,
  AgentCommunicationContractError,
  buildAgentMessage,
  buildAgentTurnInput,
  validateAgentMessage,
  validateAgentTurnInput,
} from "./agent-messages.js";
