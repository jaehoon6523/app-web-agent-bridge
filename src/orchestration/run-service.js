import { randomUUID } from "node:crypto";
import { sha256Text } from "../domain/canonical-json.js";
import {
  createRunLimits,
  createInitialRunState,
  enforceTurnLimit,
  requestPause,
  resumeRun,
  setRunBlocker,
  transitionRunState,
} from "../domain/run-state-machine.js";
import { RunMode, RunPhase, isVocabularyValue } from "../domain/vocabulary.js";

export class RunServiceError extends Error {
  constructor(message, code = "RUN_SERVICE_ERROR") {
    super(message);
    this.name = "RunServiceError";
    this.code = code;
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive safe integer.");
  }
  return value;
}

export class RunService {
  #store;
  #clock;
  #idFactory;
  #activeCommands = new Set();

  constructor({ store, clock = () => new Date().toISOString(), idFactory = randomUUID }) {
    if (!store || typeof store.createRun !== "function"
      || typeof store.appendEventAndUpdateProjection !== "function"
      || typeof store.getRun !== "function") {
      throw new TypeError("RunService requires a compatible SQLite store.");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("clock and idFactory must be functions.");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  createRun({ runId = `run_${this.#idFactory()}`, mode, objective, policyHash, limits }) {
    if (!isVocabularyValue(RunMode, mode)) throw new TypeError("mode must be a RunMode.");
    requiredString(objective, "objective");
    requiredString(policyHash, "policyHash");
    const frozenLimits = createRunLimits(limits);
    const at = this.#clock();
    const run = createInitialRunState({
      runId,
      mode,
      objective,
      objectiveHash: sha256Text(objective),
      policyHash,
      maxTurns: frozenLimits.maxTurns,
      createdAt: at,
    });
    this.#store.createRun(run, {
      eventId: `event_${this.#idFactory()}`,
      eventType: "RUN_CREATED",
      payload: run,
      createdAt: at,
      runLimits: frozenLimits,
    });
    return run;
  }

  getRun(runId) {
    requiredString(runId, "runId");
    return this.#store.getRun(runId);
  }

  transition({ runId, expectedVersion, to, blocker }) {
    if (to === RunPhase.COMPLETE) {
      throw new RunServiceError(
        "COMPLETE requires a persisted, independently evaluated RunOutcome.",
        "RUN_COMPLETION_EVIDENCE_REQUIRED",
      );
    }
    return this.#write(runId, expectedVersion, "RUN_PHASE_CHANGED", (current, at) => {
      const input = { expectedVersion, to, updatedAt: at };
      if (blocker !== undefined) input.blocker = blocker;
      return transitionRunState(current, input);
    }, { to });
  }

  pause({ runId, expectedVersion }) {
    return this.#write(runId, expectedVersion, "RUN_PAUSED", (current, at) => requestPause(current, {
      expectedVersion,
      updatedAt: at,
    }));
  }

  resume({ runId, expectedVersion }) {
    return this.#write(runId, expectedVersion, "RUN_RESUMED", (current, at) => resumeRun(current, {
      expectedVersion,
      updatedAt: at,
    }));
  }

  setBlocker({ runId, expectedVersion, blocker }) {
    return this.#write(runId, expectedVersion, "RUN_BLOCKER_CHANGED", (current, at) => setRunBlocker(current, {
      expectedVersion,
      blocker,
      updatedAt: at,
    }), { blocker });
  }

  enforceMaxTurns({ runId, expectedVersion, unresolvedFindings = [] }) {
    requiredString(runId, "runId");
    requiredExpectedVersion(expectedVersion);
    return this.#exclusive(runId, () => {
      const current = this.#requireRun(runId);
      if (current.version !== expectedVersion) {
        throw new RunServiceError(
          `Run version conflict: expected ${expectedVersion}, current ${current.version}.`,
          "RUN_VERSION_CONFLICT",
        );
      }
      const at = this.#clock();
      const result = enforceTurnLimit(current, {
        expectedVersion,
        unresolvedFindings,
        updatedAt: at,
      });
      if (result.outcome === null) return result;
      this.#persist(current, result.state, "RUN_COMPLETED", {
        outcome: result.outcome,
      }, at);
      return result;
    });
  }

  #write(runId, expectedVersion, eventType, reducer, details = {}) {
    requiredString(runId, "runId");
    requiredExpectedVersion(expectedVersion);
    return this.#exclusive(runId, () => {
      const current = this.#requireRun(runId);
      if (current.version !== expectedVersion) {
        throw new RunServiceError(
          `Run version conflict: expected ${expectedVersion}, current ${current.version}.`,
          "RUN_VERSION_CONFLICT",
        );
      }
      const at = this.#clock();
      const next = reducer(current, at);
      if (next === current) return current;
      this.#persist(current, next, eventType, details, at);
      return next;
    });
  }

  #persist(current, next, eventType, details, at) {
    this.#store.appendEventAndUpdateProjection({
      runId: current.runId,
      expectedVersion: current.version,
      eventId: `event_${this.#idFactory()}`,
      eventType,
      payload: { run: next, details },
      createdAt: at,
      nextRun: next,
    });
  }

  #requireRun(runId) {
    const run = this.#store.getRun(runId);
    if (!run) throw new RunServiceError(`Run ${runId} does not exist.`, "RUN_NOT_FOUND");
    return run;
  }

  #exclusive(runId, operation) {
    if (this.#activeCommands.has(runId)) {
      throw new RunServiceError(`Run ${runId} already has an active command.`, "RUN_COMMAND_IN_PROGRESS");
    }
    this.#activeCommands.add(runId);
    try {
      return operation();
    } finally {
      this.#activeCommands.delete(runId);
    }
  }
}

export { RunPhase };
