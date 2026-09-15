import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../domain/canonical-json.js";
import { decodeCanonicalJson } from "./canonical-record.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  DeliveryState,
  initializeSqliteSchema,
  readSqliteSchemaVersion,
} from "./schema.js";
import { canTransitionDelivery } from "./delivery-state.js";
import {
  calculateDomainEventHash,
  domainEventDigestInput,
  listDomainEventsEntity,
  verifyEventChainsEntity,
} from "./event-chain.js";
import {
  DeliveryTransitionError,
  EventChainIntegrityError,
  OptimisticConcurrencyError,
  PersistenceError,
} from "./errors.js";
import {
  createAgentSessionEntity,
  createApprovalEntity,
  createRecoveryOperationEntity,
  getAgentPacketEntity,
  getAgentSessionEntity,
  getApprovalEntity,
  getRecoveryOperationEntity,
  listAgentPacketsEntity,
  listAgentSessionsEntity,
  listApprovalsEntity,
  listRecoveryOperationsEntity,
  resolveApprovalEntity,
  resolveRecoveryOperationEntity,
  saveAgentPacketEntity,
  upsertAgentSessionEntity,
} from "./sqlite-entities.js";
import {
  rebuildRunProjectionEntity,
  rebuildRunProjectionsEntity,
} from "./projection-rebuilder.js";
import {
  RunLimitExceededError,
  createRunLimitsEntity,
  getRunLimitsEntity,
  recordConsecutiveActorFailureEntity,
  recordProtocolRepairEntity,
  resetConsecutiveActorFailuresEntity,
} from "./run-limits.js";
import {
  getAgentMessageByInputEntity,
  getAgentMessageEntity,
  getAgentTurnInputEntity,
  listAgentMessagesEntity,
  listAgentTurnInputsEntity,
  saveAgentMessageEntity,
  saveAgentTurnInputWithDeliveryEntity,
  verifyAgentCommunicationLinksEntity,
} from "./agent-communications.js";
import {
  getProposalArtifactByReferenceEntity,
  getProposalArtifactBySourceMessageEntity,
  getProposalArtifactEntity,
  listProposalArtifactsEntity,
  saveProposalArtifactEntity,
  verifyProposalArtifactsEntity,
} from "./proposal-artifacts.js";
import { verifyDiscussionResponseLinksEntity } from "./discussion-response-links.js";
import { getAgentPacketRejectionByDeliveryEntity, verifyAgentPacketRejectionsEntity } from "./agent-packet-rejections.js";
import { getRunOutcomeEntity, saveRunOutcomeEntity, verifyRunOutcomesEntity } from "./run-outcomes.js";
import { verifyTurnQueueLinksEntity } from "./turn-queue-links.js";
import { verifyControlSideRecordLinksEntity } from "./control-side-record-links.js";
import { deleteRunEntity } from "./run-deletion.js";
import { listArtifactHashesEntity } from "./artifact-references.js";
import { validateSubmittedProviderReceipt } from "./delivery-transition-input.js";
const DELIVERY_STATES = new Set(Object.values(DeliveryState));

function persistenceErrorTypes() {
  return { PersistenceError, OptimisticConcurrencyError, EventChainIntegrityError };
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireDeliveryState(value, name) {
  if (!DELIVERY_STATES.has(value)) {
    throw new TypeError(`${name} must be a DeliveryState`);
  }
  return value;
}

function encodeJson(value) {
  return canonicalJson(value);
}

function optionalJson(value) {
  return value === undefined || value === null ? null : encodeJson(value);
}

function parseOptionalJson(value, context) {
  return value === null ? null : decodeCanonicalJson(value, context);
}

function rowChanges(result) {
  return Number(result.changes);
}

function normalizeConstructorInput(input) {
  if (typeof input === "string") return { filename: input };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("SqliteStore requires a filename or options object");
  }
  return input;
}

export class SqliteStore {
  #database;
  #closed = false;
  #transactionDepth = 0;

  constructor(input) {
    const options = normalizeConstructorInput(input);
    requireNonEmptyString(options.filename, "filename");
    this.filename = options.filename;
    this.#database = new DatabaseSync(options.filename);

    try {
      this.#database.exec("PRAGMA journal_mode = WAL");
      initializeSqliteSchema(this.#database);
      if (options.verifyOnOpen !== false) {
        this.verifyEventChains();
        this.verifyAgentCommunicationLinks();
        this.verifyProposalArtifacts();
        this.verifyRunOutcomes();
        this.verifyDiscussionResponseLinks();
        this.verifyAgentPacketRejections();
        this.verifyTurnQueueLinks();
        this.verifyControlSideRecordLinks();
        this.rebuildRunProjections({ compare: true });
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  get schemaVersion() {
    this.#assertOpen();
    return readSqliteSchemaVersion(this.#database);
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen() {
    if (this.#closed) throw new PersistenceError("SQLite store is closed", "STORE_CLOSED");
  }

  #transaction(operation) {
    this.#assertOpen();
    if (this.#transactionDepth > 0) return operation();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the operation error; a failed rollback cannot make it successful.
      }
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  /**
   * Joins Controller-owned synchronous persistence operations into one SQLite
   * transaction.  The callback receives this store so callers cannot reach
   * the underlying database handle or bypass the validated store methods.
   */
  withTransaction(operation) {
    this.#assertOpen();
    if (typeof operation !== "function") {
      throw new TypeError("withTransaction requires a synchronous function");
    }
    return this.#transaction(() => {
      const result = operation(this);
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        throw new TypeError("withTransaction does not accept an asynchronous operation");
      }
      return result;
    });
  }

  createRun(run, eventOptions = {}) {
    this.#assertOpen();
    validateAgentRun(run);
    if (eventOptions.runLimits === undefined) {
      throw new PersistenceError("runLimits must be frozen with run creation", "RUN_LIMITS_REQUIRED");
    }
    const eventId = eventOptions.eventId ?? `${run.runId}:created`;
    const eventType = eventOptions.eventType ?? "RUN_CREATED";
    const payload = eventOptions.payload ?? run;
    const createdAt = eventOptions.createdAt ?? run.createdAt;
    requireNonEmptyString(eventId, "eventId");
    requireNonEmptyString(eventType, "eventType");
    requireNonEmptyString(createdAt, "createdAt");
    if (eventType !== "RUN_CREATED") {
      throw new PersistenceError(
        "the initial run event must be RUN_CREATED",
        "INVALID_INITIAL_EVENT",
      );
    }
    if (encodeJson(payload) !== encodeJson(run)) {
      throw new PersistenceError(
        "the RUN_CREATED payload must equal the initial AgentRun",
        "PROJECTION_PAYLOAD_MISMATCH",
      );
    }

    return this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT 1 AS present FROM runs WHERE run_id = ?")
        .get(run.runId);
      if (existing) {
        throw new PersistenceError(`run ${run.runId} already exists`, "RUN_ALREADY_EXISTS");
      }

      const event = {
        sequence: 1,
        eventId,
        runId: run.runId,
        eventType,
        payload: structuredClone(payload),
        createdAt,
      };
      const eventHash = calculateDomainEventHash(null, event);
      const runJson = encodeJson(run);

      this.#database.prepare(`
        INSERT INTO runs (
          run_id, run_json, version, event_count, last_event_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(run.runId, runJson, run.version, eventHash, run.createdAt, run.updatedAt);

      this.#insertEvent(event, null, eventHash);

      this.#database.prepare(`
        INSERT INTO run_projections (
          run_id, projection_json, version, last_event_sequence, last_event_hash, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(run.runId, runJson, run.version, eventHash, run.updatedAt);

      createRunLimitsEntity(this.#database, {
        runId: run.runId,
        policyHash: run.policyHash,
        limits: eventOptions.runLimits,
        createdAt,
        updatedAt: createdAt,
      });

      return Object.freeze({ ...event, previousHash: null, eventHash });
    });
  }

  getRunLimits(runId) {
    this.#assertOpen();
    return getRunLimitsEntity(this.#database, runId);
  }

  recordProtocolRepair(input) {
    this.#assertOpen();
    return recordProtocolRepairEntity(this.#database, input);
  }

  recordConsecutiveActorFailure(input) {
    this.#assertOpen();
    return recordConsecutiveActorFailureEntity(this.#database, input);
  }

  resetConsecutiveActorFailures(input) {
    this.#assertOpen();
    return resetConsecutiveActorFailuresEntity(this.#database, input);
  }

  getRun(runId) {
    this.#assertOpen();
    requireNonEmptyString(runId, "runId");
    const row = this.#database
      .prepare("SELECT run_json, version FROM runs WHERE run_id = ?")
      .get(runId);
    if (!row) return null;
    const run = decodeCanonicalJson(row.run_json, `run ${runId}`);
    try {
      validateAgentRun(run);
    } catch (cause) {
      throw new EventChainIntegrityError(`run ${runId} violates its domain contract`, { cause });
    }
    if (run.version !== Number(row.version)) {
      throw new EventChainIntegrityError(`run ${runId} version metadata does not match its JSON`);
    }
    return run;
  }

  listRuns() {
    this.#assertOpen();
    return this.#database.prepare("SELECT run_id FROM runs ORDER BY created_at, run_id")
      .all().map((row) => this.getRun(row.run_id));
  }

  /** Permanently removes a terminal run and every record owned by it. */
  deleteRun(runId) {
    this.#assertOpen();
    requireNonEmptyString(runId, "runId");
    return this.#transaction(() => deleteRunEntity(this.#database, runId, PersistenceError));
  }

  listArtifactHashes(runId = null) {
    this.#assertOpen();
    return listArtifactHashesEntity(this.#database, runId);
  }

  getRunProjection(runId) {
    this.#assertOpen();
    requireNonEmptyString(runId, "runId");
    const row = this.#database.prepare(`
      SELECT projection_json, version, last_event_sequence, last_event_hash
      FROM run_projections WHERE run_id = ?
    `).get(runId);
    if (!row) return null;
    const projection = decodeCanonicalJson(row.projection_json, `run projection ${runId}`);
    try {
      validateAgentRun(projection);
    } catch (cause) {
      throw new EventChainIntegrityError(
        `run projection ${runId} violates its domain contract`,
        { cause },
      );
    }
    if (projection.version !== Number(row.version)) {
      throw new EventChainIntegrityError(
        `run projection ${runId} version metadata does not match its JSON`,
      );
    }
    return {
      run: projection,
      lastEventSequence: Number(row.last_event_sequence),
      lastEventHash: row.last_event_hash,
    };
  }

  rebuildRunProjection(runId, options = undefined) {
    this.#assertOpen();
    return rebuildRunProjectionEntity(
      this.#database,
      runId,
      options,
      persistenceErrorTypes(),
    );
  }

  rebuildRunProjections(options = undefined) {
    this.#assertOpen();
    return rebuildRunProjectionsEntity(
      this.#database,
      options,
      persistenceErrorTypes(),
    );
  }

  createAgentSession(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      createAgentSessionEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  upsertAgentSession(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      upsertAgentSessionEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  getAgentSession(sessionId) {
    this.#assertOpen();
    return getAgentSessionEntity(this.#database, sessionId, persistenceErrorTypes());
  }

  listAgentSessions(runId) {
    this.#assertOpen();
    return listAgentSessionsEntity(this.#database, runId, persistenceErrorTypes());
  }

  saveAgentPacket(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      saveAgentPacketEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  getAgentPacket(packetId) {
    this.#assertOpen();
    return getAgentPacketEntity(this.#database, packetId, persistenceErrorTypes());
  }

  listAgentPackets(runId) {
    this.#assertOpen();
    return listAgentPacketsEntity(this.#database, runId, persistenceErrorTypes());
  }

  createApproval(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      createApprovalEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  resolveApproval(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      resolveApprovalEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  getApproval(approvalId) {
    this.#assertOpen();
    return getApprovalEntity(this.#database, approvalId, persistenceErrorTypes());
  }

  listApprovals(input) {
    this.#assertOpen();
    return listApprovalsEntity(this.#database, input, persistenceErrorTypes());
  }

  createRecoveryOperation(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      createRecoveryOperationEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  resolveRecoveryOperation(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      resolveRecoveryOperationEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  getRecoveryOperation(operationId) {
    this.#assertOpen();
    return getRecoveryOperationEntity(this.#database, operationId, persistenceErrorTypes());
  }

  listRecoveryOperations(input) {
    this.#assertOpen();
    return listRecoveryOperationsEntity(this.#database, input, persistenceErrorTypes());
  }

  appendEventAndUpdateProjection(input) {
    this.#assertOpen();
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("append input must be an object");
    }
    const {
      runId,
      expectedVersion,
      eventId,
      eventType,
      payload,
      createdAt,
      nextRun,
    } = input;
    requireNonEmptyString(runId, "runId");
    requireSafeInteger(expectedVersion, "expectedVersion", 1);
    requireNonEmptyString(eventId, "eventId");
    requireNonEmptyString(eventType, "eventType");
    requireNonEmptyString(createdAt, "createdAt");
    validateAgentRun(nextRun);
    if (nextRun.runId !== runId) throw new TypeError("nextRun.runId must match runId");
    if (nextRun.version !== expectedVersion + 1) {
      throw new OptimisticConcurrencyError(
        `next run version ${nextRun.version} must equal expected version + 1`,
      );
    }
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !Object.hasOwn(payload, "run")
      || encodeJson(payload.run) !== encodeJson(nextRun)
    ) {
      throw new PersistenceError(
        "event payload.run must equal nextRun so the projection is replayable",
        "PROJECTION_PAYLOAD_MISMATCH",
      );
    }

    return this.#transaction(() => {
      const current = this.#database.prepare(`
        SELECT run_json, version, event_count, last_event_hash FROM runs WHERE run_id = ?
      `).get(runId);
      if (!current) throw new PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
      if (Number(current.version) !== expectedVersion) {
        throw new OptimisticConcurrencyError(
          `run ${runId} expected version ${expectedVersion}, observed ${current.version}`,
        );
      }
      const currentRun = decodeCanonicalJson(current.run_json, `run ${runId}`);
      for (const field of [
        "runId",
        "mode",
        "objective",
        "objectiveHash",
        "policyHash",
        "maxTurns",
        "createdAt",
      ]) {
        if (nextRun[field] !== currentRun[field]) {
          throw new PersistenceError(
            `AgentRun.${field} is immutable after run creation`,
            "IMMUTABLE_RUN_METADATA",
          );
        }
      }

      const sequence = Number(current.event_count) + 1;
      const previousHash = current.last_event_hash;
      const event = {
        sequence,
        eventId,
        runId,
        eventType,
        payload: structuredClone(payload),
        createdAt,
      };
      const eventHash = calculateDomainEventHash(previousHash, event);
      const nextRunJson = encodeJson(nextRun);

      this.#insertEvent(event, previousHash, eventHash);

      const runUpdate = this.#database.prepare(`
        UPDATE runs
        SET run_json = ?, version = ?, event_count = ?, last_event_hash = ?, updated_at = ?
        WHERE run_id = ? AND version = ? AND event_count = ?
      `).run(
        nextRunJson,
        nextRun.version,
        sequence,
        eventHash,
        nextRun.updatedAt,
        runId,
        expectedVersion,
        sequence - 1,
      );
      if (rowChanges(runUpdate) !== 1) {
        throw new OptimisticConcurrencyError(`run ${runId} changed while appending event`);
      }

      const projectionUpdate = this.#database.prepare(`
        UPDATE run_projections
        SET projection_json = ?, version = ?, last_event_sequence = ?,
            last_event_hash = ?, updated_at = ?
        WHERE run_id = ? AND version = ?
      `).run(
        nextRunJson,
        nextRun.version,
        sequence,
        eventHash,
        nextRun.updatedAt,
        runId,
        expectedVersion,
      );
      if (rowChanges(projectionUpdate) !== 1) {
        throw new OptimisticConcurrencyError(`projection for run ${runId} changed while appending`);
      }

      return Object.freeze({ ...event, previousHash, eventHash });
    });
  }

  #insertEvent(event, previousHash, eventHash) {
    this.#database.prepare(`
      INSERT INTO domain_events (
        run_id, sequence, event_id, event_type, payload_json,
        previous_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.runId,
      event.sequence,
      event.eventId,
      event.eventType,
      encodeJson(event.payload),
      previousHash,
      eventHash,
      event.createdAt,
    );
  }

  listDomainEvents(runId) {
    this.#assertOpen();
    return listDomainEventsEntity(this.#database, runId, persistenceErrorTypes());
  }

  verifyEventChains(runId = null) {
    this.#assertOpen();
    return verifyEventChainsEntity(this.#database, runId, persistenceErrorTypes());
  }

  verifyAgentCommunicationLinks() {
    this.#assertOpen();
    return verifyAgentCommunicationLinksEntity(this.#database, persistenceErrorTypes());
  }

  saveAgentTurnInputWithDelivery(input) {
    this.#assertOpen();
    return this.#transaction(() => {
      saveAgentTurnInputWithDeliveryEntity(
        this.#database,
        input,
        persistenceErrorTypes(),
      );
      return this.getDelivery(input.deliveryId);
    });
  }

  saveAgentMessage(input) {
    this.#assertOpen();
    return this.#transaction(() => {
      saveAgentMessageEntity(this.#database, input, persistenceErrorTypes());
      return this.getAgentMessage(input.message.messageId);
    });
  }

  getAgentTurnInput(inputId) {
    this.#assertOpen();
    return getAgentTurnInputEntity(this.#database, inputId, persistenceErrorTypes());
  }

  listAgentTurnInputs(runId) {
    this.#assertOpen();
    return listAgentTurnInputsEntity(this.#database, runId, persistenceErrorTypes());
  }

  getAgentMessage(messageId) {
    this.#assertOpen();
    return getAgentMessageEntity(this.#database, messageId, persistenceErrorTypes());
  }

  getAgentMessageByInput(inputId) {
    this.#assertOpen();
    return getAgentMessageByInputEntity(this.#database, inputId, persistenceErrorTypes());
  }

  listAgentMessages(runId) {
    this.#assertOpen();
    return listAgentMessagesEntity(this.#database, runId, persistenceErrorTypes());
  }

  saveProposalArtifact(artifact) {
    this.#assertOpen();
    return this.#transaction(() => (
      saveProposalArtifactEntity(this.#database, artifact, persistenceErrorTypes())
    ));
  }

  getProposalArtifact(proposalId) {
    this.#assertOpen();
    return getProposalArtifactEntity(this.#database, proposalId, persistenceErrorTypes());
  }

  getProposalArtifactBySourceMessage(messageId) {
    this.#assertOpen();
    return getProposalArtifactBySourceMessageEntity(
      this.#database,
      messageId,
      persistenceErrorTypes(),
    );
  }

  getProposalArtifactByReference(runId, proposalRefHash) {
    this.#assertOpen();
    return getProposalArtifactByReferenceEntity(
      this.#database,
      runId,
      proposalRefHash,
      persistenceErrorTypes(),
    );
  }

  listProposalArtifacts(runId) {
    this.#assertOpen();
    return listProposalArtifactsEntity(this.#database, runId, persistenceErrorTypes());
  }

  verifyProposalArtifacts() {
    this.#assertOpen();
    return verifyProposalArtifactsEntity(this.#database, persistenceErrorTypes());
  }

  saveRunOutcome(input) {
    this.#assertOpen();
    return this.#transaction(() => (
      saveRunOutcomeEntity(this.#database, input, persistenceErrorTypes())
    ));
  }

  getRunOutcome(runId) {
    this.#assertOpen();
    return getRunOutcomeEntity(this.#database, runId, persistenceErrorTypes());
  }

  verifyRunOutcomes() {
    this.#assertOpen();
    return verifyRunOutcomesEntity(this.#database, persistenceErrorTypes());
  }

  verifyDiscussionResponseLinks() {
    this.#assertOpen();
    return verifyDiscussionResponseLinksEntity(this.#database, persistenceErrorTypes());
  }

  getAgentPacketRejectionByDelivery(deliveryId) {
    this.#assertOpen();
    return getAgentPacketRejectionByDeliveryEntity(
      this.#database,
      deliveryId,
      persistenceErrorTypes(),
    );
  }

  verifyAgentPacketRejections() {
    this.#assertOpen();
    return verifyAgentPacketRejectionsEntity(this.#database, persistenceErrorTypes());
  }

  verifyTurnQueueLinks() {
    this.#assertOpen(); return verifyTurnQueueLinksEntity(this.#database, persistenceErrorTypes());
  }
  verifyControlSideRecordLinks() {
    this.#assertOpen(); return verifyControlSideRecordLinksEntity(this.#database, persistenceErrorTypes());
  }

  getDelivery(deliveryId) {
    this.#assertOpen();
    requireNonEmptyString(deliveryId, "deliveryId");
    const row = this.#database
      .prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ?")
      .get(deliveryId);
    return row ? this.#deliveryFromRow(row) : null;
  }

  listDeliveries(runId) {
    this.#assertOpen();
    requireNonEmptyString(runId, "runId");
    return this.#database.prepare(`
      SELECT delivery_id FROM delivery_attempts
      WHERE run_id = ? ORDER BY created_at, delivery_id
    `).all(runId).map((row) => this.getDelivery(row.delivery_id));
  }

  #deliveryFromRow(row) {
    return {
      deliveryId: row.delivery_id,
      runId: row.run_id,
      inputId: row.input_id,
      idempotencyKey: row.idempotency_key,
      state: row.state,
      attemptCount: Number(row.attempt_count),
      version: Number(row.version),
      providerReceipt: parseOptionalJson(
        row.provider_receipt_json,
        `delivery ${row.delivery_id} provider receipt`,
      ),
      error: parseOptionalJson(row.error_json, `delivery ${row.delivery_id} error`),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listDispatchableDeliveries({ runId = null, limit = 100 } = {}) {
    this.#assertOpen();
    if (runId !== null) requireNonEmptyString(runId, "runId");
    requireSafeInteger(limit, "limit", 1);
    const rows = runId === null
      ? this.#database.prepare(`
          SELECT * FROM delivery_attempts
          WHERE state = ? ORDER BY created_at, delivery_id LIMIT ?
        `).all(DeliveryState.PENDING, limit)
      : this.#database.prepare(`
          SELECT * FROM delivery_attempts
          WHERE state = ? AND run_id = ?
          ORDER BY created_at, delivery_id LIMIT ?
        `).all(DeliveryState.PENDING, runId, limit);
    return rows.map((row) => this.#deliveryFromRow(row));
  }

  getSingleDispatchableDelivery({ runId = null } = {}) {
    const deliveries = this.listDispatchableDeliveries({ runId, limit: 2 });
    if (deliveries.length > 1) throw new PersistenceError(
      `Run ${runId} has multiple pending deliveries.`, "MULTIPLE_PENDING_DELIVERIES",
    );
    return deliveries[0] ?? null;
  }

  /** @param {{runId?: string | null, claimedAt?: string}} [input] */
  claimNextPendingDelivery({ runId = null, claimedAt } = {}) {
    this.#assertOpen();
    if (runId !== null) requireNonEmptyString(runId, "runId");
    requireNonEmptyString(claimedAt, "claimedAt");
    return this.#transaction(() => {
      let row;
      let frozenLimits;
      while (true) {
        row = runId === null
          ? this.#database.prepare(`
              SELECT * FROM delivery_attempts
              WHERE state = ? ORDER BY created_at, delivery_id LIMIT 1
            `).get(DeliveryState.PENDING)
          : this.#database.prepare(`
              SELECT * FROM delivery_attempts
              WHERE state = ? AND run_id = ?
              ORDER BY created_at, delivery_id LIMIT 1
            `).get(DeliveryState.PENDING, runId);
        if (!row) return null;

        frozenLimits = getRunLimitsEntity(this.#database, row.run_id);
        if (!frozenLimits) {
          throw new PersistenceError(
            `run ${row.run_id} has no frozen RunLimits`,
            "RUN_LIMITS_NOT_FOUND",
          );
        }
        if (Number(row.attempt_count) < frozenLimits.limits.maxDeliveryAttempts) break;
        this.#database.prepare(`
          UPDATE delivery_attempts
          SET state = ?, version = version + 1, error_json = ?, updated_at = ?
          WHERE delivery_id = ? AND state = ? AND version = ?
        `).run(
          DeliveryState.FAILED,
          encodeJson({
            code: "DELIVERY_ATTEMPTS_EXHAUSTED",
            maxDeliveryAttempts: frozenLimits.limits.maxDeliveryAttempts,
          }),
          claimedAt,
          row.delivery_id,
          DeliveryState.PENDING,
          row.version,
        );
      }

      const update = this.#database.prepare(`
        UPDATE delivery_attempts
        SET state = ?, attempt_count = attempt_count + 1,
            version = version + 1, updated_at = ?
        WHERE delivery_id = ? AND state = ? AND version = ?
      `).run(
        DeliveryState.DISPATCHING,
        claimedAt,
        row.delivery_id,
        DeliveryState.PENDING,
        row.version,
      );
      if (rowChanges(update) !== 1) {
        throw new OptimisticConcurrencyError(`delivery ${row.delivery_id} was claimed concurrently`);
      }
      return this.getDelivery(row.delivery_id);
    });
  }

  transitionDelivery(input) {
    this.#assertOpen();
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("delivery transition input must be an object");
    }
    const {
      deliveryId,
      expectedState,
      expectedVersion,
      nextState,
      updatedAt,
    } = input;
    requireNonEmptyString(deliveryId, "deliveryId");
    requireDeliveryState(expectedState, "expectedState");
    requireSafeInteger(expectedVersion, "expectedVersion", 1);
    requireDeliveryState(nextState, "nextState");
    requireNonEmptyString(updatedAt, "updatedAt");

    if (!canTransitionDelivery(expectedState, nextState)) {
      throw new DeliveryTransitionError(
        `delivery transition ${expectedState} -> ${nextState} is not allowed`,
      );
    }

    return this.#transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ?")
        .get(deliveryId);
      if (!row) {
        throw new PersistenceError(`delivery ${deliveryId} does not exist`, "DELIVERY_NOT_FOUND");
      }
      if (row.state !== expectedState) {
        throw new DeliveryTransitionError(
          `delivery ${deliveryId} expected state ${expectedState}, observed ${row.state}`,
          "DELIVERY_STATE_CONFLICT",
        );
      }
      if (Number(row.version) !== expectedVersion) {
        throw new OptimisticConcurrencyError(
          `delivery ${deliveryId} expected version ${expectedVersion}, observed ${row.version}`,
        );
      }
      if (nextState === DeliveryState.SUBMITTED) validateSubmittedProviderReceipt(input);
      const isRetryReset = expectedState === DeliveryState.FAILED
        && nextState === DeliveryState.PENDING;
      if (isRetryReset) {
        const frozenLimits = getRunLimitsEntity(this.#database, row.run_id);
        if (!frozenLimits) {
          throw new PersistenceError(
            `run ${row.run_id} has no frozen RunLimits`,
            "RUN_LIMITS_NOT_FOUND",
          );
        }
        if (Number(row.attempt_count) >= frozenLimits.limits.maxDeliveryAttempts) {
          throw new RunLimitExceededError(
            "maxDeliveryAttempts",
            frozenLimits.limits.maxDeliveryAttempts,
          );
        }
      }
      const receiptJson = isRetryReset
        ? null
        : Object.hasOwn(input, "providerReceipt")
        ? optionalJson(input.providerReceipt)
        : row.provider_receipt_json;
      const errorJson = isRetryReset
        ? null
        : Object.hasOwn(input, "error")
        ? optionalJson(input.error)
        : row.error_json;
      const update = this.#database.prepare(`
        UPDATE delivery_attempts
        SET state = ?, version = version + 1, provider_receipt_json = ?,
            error_json = ?, updated_at = ?
        WHERE delivery_id = ? AND state = ? AND version = ?
      `).run(
        nextState,
        receiptJson,
        errorJson,
        updatedAt,
        deliveryId,
        expectedState,
        expectedVersion,
      );
      if (rowChanges(update) !== 1) {
        throw new OptimisticConcurrencyError(`delivery ${deliveryId} changed concurrently`);
      }
      return this.getDelivery(deliveryId);
    });
  }
}

export { DeliveryState } from "./schema.js";
export {
  DeliveryTransitionError,
  EventChainIntegrityError,
  OptimisticConcurrencyError,
  PersistenceError,
} from "./errors.js";
export { calculateDomainEventHash, domainEventDigestInput };
