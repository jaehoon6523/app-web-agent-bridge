export class CodexRuntimeError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    for (const [key, value] of Object.entries(details)) {
      if (["name", "message", "code", "stack"].includes(key)) continue;
      this[key] = value;
    }
    this.details = details;
  }
}

export class CodexConfigurationError extends CodexRuntimeError {
  constructor(message, code = "CODEX_CONFIGURATION_INVALID", details = {}) {
    super(message, code, details);
  }
}

export class ExecutableIntegrityError extends CodexRuntimeError {
  constructor(message, code = "CODEX_EXECUTABLE_INTEGRITY_FAILED", details = {}) {
    super(message, code, details);
  }
}

export class CodexProtocolError extends CodexRuntimeError {
  constructor(message, code = "CODEX_PROTOCOL_ERROR", details = {}) {
    super(message, code, details);
  }
}

export class CodexRpcError extends CodexRuntimeError {
  constructor(method, rpcError, requestId) {
    super(
      `Codex RPC ${method} failed: ${rpcError?.message || "unknown RPC error"}`,
      "CODEX_RPC_FAILED",
      { method, rpcError, requestId },
    );
  }
}

export class CodexTransportClosedError extends CodexRuntimeError {
  constructor(message = "Codex app-server transport closed", details = {}) {
    super(message, "CODEX_TRANSPORT_CLOSED", details);
  }
}

export class CodexRpcTimeoutError extends CodexRuntimeError {
  constructor(method, requestId, timeoutMs) {
    super(
      `Codex RPC ${method} timed out after ${timeoutMs} ms`,
      "CODEX_RPC_TIMEOUT",
      { method, requestId, timeoutMs },
    );
  }
}

export class CodexSessionStateError extends CodexRuntimeError {
  constructor(message, code = "CODEX_SESSION_STATE_INVALID", details = {}) {
    super(message, code, details);
  }
}

export class CodexThreadPersistenceError extends CodexRuntimeError {
  constructor(threadId, cause) {
    super(
      `Codex created thread ${threadId}, but its binding could not be persisted`,
      "CODEX_THREAD_PERSISTENCE_FAILED",
      { threadId, cause },
    );
  }
}

export class CodexTurnFailedError extends CodexRuntimeError {
  constructor(threadId, turnId, detail, rawTurn = null) {
    super(detail || `Codex turn ${turnId} failed`, "CODEX_TURN_FAILED", {
      threadId,
      turnId,
      rawTurn,
    });
  }
}

export class CodexTurnInterruptedError extends CodexRuntimeError {
  constructor(threadId, turnId) {
    super(`Codex turn ${turnId} was interrupted`, "CODEX_TURN_INTERRUPTED", {
      threadId,
      turnId,
    });
  }
}

export class CodexTurnAmbiguousError extends CodexRuntimeError {
  constructor(threadId, turnId, cause = null) {
    super(
      `Codex process disconnected while turn ${turnId || "(unknown)"} was active; its outcome is ambiguous`,
      "CODEX_TURN_AMBIGUOUS",
      { threadId, turnId, cause },
    );
  }
}

export class CodexAuthoritativeOutputMissingError extends CodexRuntimeError {
  constructor(threadId, turnId) {
    super(
      `Codex turn ${turnId} completed without an authoritative completed agentMessage`,
      "CODEX_AUTHORITATIVE_OUTPUT_MISSING",
      { threadId, turnId },
    );
  }
}

export class CodexAuthoritativeOutputInvalidError extends CodexRuntimeError {
  constructor(threadId, turnId, reason, details = {}) {
    const description = reason === "SCHEMA_VALIDATION_FAILED"
      ? "does not satisfy the caller-supplied output schema"
      : "is not valid JSON";
    super(
      `Codex turn ${turnId} authoritative output ${description}`,
      "CODEX_AUTHORITATIVE_OUTPUT_INVALID",
      { threadId, turnId, reason, ...details },
    );
  }
}

export class CodexApprovalError extends CodexRuntimeError {
  constructor(message, code = "CODEX_APPROVAL_INVALID", details = {}) {
    super(message, code, details);
  }
}
