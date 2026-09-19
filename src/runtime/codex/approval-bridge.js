import { EventEmitter } from "node:events";
import { CodexApprovalError } from "./errors.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

const BASE_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

/** @typedef {Record<string, any>} CodexApprovalRecord */

/** @param {unknown} id */
function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

/** @param {unknown} value */
function validExecpolicyAmendment(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((part) => typeof part === "string");
}

/**
 * @param {unknown} left
 * @param {unknown} right
 */
function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part === right[index]);
}

/** @param {CodexApprovalRecord} entry */
function copyRequest(entry) {
  return Object.freeze({
    requestId: entry.requestId,
    method: entry.method,
    threadId: entry.threadId,
    turnId: entry.turnId,
    itemId: entry.itemId,
    reason: entry.reason,
    command: entry.command,
    cwd: entry.cwd,
    grantRoot: entry.grantRoot,
    networkApprovalContext: entry.networkApprovalContext,
    availableDecisions: Object.freeze([...entry.availableDecisions]),
    proposedExecpolicyAmendment: entry.proposedExecpolicyAmendment === null
      ? null
      : Object.freeze([...entry.proposedExecpolicyAmendment]),
    status: entry.status,
  });
}

/**
 * @param {CodexApprovalRecord} entry
 * @param {any} decision
 */
function validateDecision(entry, decision) {
  if (typeof decision === "string") {
    if (!BASE_DECISIONS.has(decision)) {
      throw new CodexApprovalError(
        `Unsupported Codex approval decision: ${decision}`,
        "CODEX_APPROVAL_DECISION_UNSUPPORTED",
      );
    }
    if (!entry.availableDecisions.includes(decision)) {
      throw new CodexApprovalError(
        `Decision ${decision} was not offered for approval ${String(entry.requestId)}`,
        "CODEX_APPROVAL_DECISION_NOT_OFFERED",
      );
    }
    return decision;
  }

  const amendment = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
  if (
    entry.method === "item/commandExecution/requestApproval"
    && validExecpolicyAmendment(amendment)
    && sameStringArray(amendment, entry.proposedExecpolicyAmendment)
  ) {
    return decision;
  }
  if (validExecpolicyAmendment(amendment)) {
    throw new CodexApprovalError(
      `Execpolicy amendment was not offered for approval ${String(entry.requestId)}`,
      "CODEX_APPROVAL_DECISION_NOT_OFFERED",
    );
  }
  throw new CodexApprovalError(
    "Invalid Codex approval decision payload",
    "CODEX_APPROVAL_DECISION_INVALID",
  );
}

export class CodexApprovalBridge extends EventEmitter {
  /** @type {any} */
  #peer;
  /** @type {Map<string, CodexApprovalRecord>} */
  #pending = new Map();

  /** @param {{peer?: any}} [options] */
  constructor({ peer } = {}) {
    super();
    if (!peer || typeof peer.respond !== "function") {
      throw new TypeError("CodexApprovalBridge requires a JSON-RPC peer");
    }
    this.#peer = peer;
  }

  get pendingApprovals() {
    return Object.freeze([...this.#pending.values()].map(copyRequest));
  }

  /** @param {CodexApprovalRecord | null | undefined} message */
  capture(message) {
    if (!message || !APPROVAL_METHODS.has(message.method)) return false;
    const { id, method } = message;
    const params = message.params || {};
    if (id === undefined || id === null) {
      throw new CodexApprovalError(
        "Approval request is missing its JSON-RPC id",
        "CODEX_APPROVAL_REQUEST_ID_MISSING",
      );
    }
    if (typeof params.threadId !== "string" || params.threadId === "") {
      throw new CodexApprovalError(
        "Approval request is missing threadId",
        "CODEX_APPROVAL_THREAD_ID_MISSING",
      );
    }
    if (typeof params.turnId !== "string" || params.turnId === "") {
      throw new CodexApprovalError(
        "Approval request is missing turnId",
        "CODEX_APPROVAL_TURN_ID_MISSING",
      );
    }
    const key = idKey(id);
    if (this.#pending.has(key)) {
      throw new CodexApprovalError(
        `Duplicate pending approval request id ${String(id)}`,
        "CODEX_APPROVAL_REQUEST_DUPLICATE",
      );
    }

    const offered = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((value) => typeof value === "string" && BASE_DECISIONS.has(value))
      : method === "item/fileChange/requestApproval"
        ? [...BASE_DECISIONS]
        : [];
    const availableDecisions = [...new Set(offered)];
    const proposedExecpolicyAmendment = (
      method === "item/commandExecution/requestApproval"
      && validExecpolicyAmendment(params.proposedExecpolicyAmendment)
    )
      ? [...params.proposedExecpolicyAmendment]
      : null;
    const entry = {
      requestId: id,
      method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: typeof params.itemId === "string" ? params.itemId : null,
      reason: typeof params.reason === "string" ? params.reason : null,
      command: params.command ?? null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      grantRoot: typeof params.grantRoot === "string" ? params.grantRoot : null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      availableDecisions,
      proposedExecpolicyAmendment,
      status: "PENDING",
    };
    this.#pending.set(key, entry);
    this.emit("approvalRequested", copyRequest(entry));
    return true;
  }

  /** @param {{requestId?: any, threadId?: any, turnId?: any, decision?: any}} [input] */
  respond({ requestId, threadId, turnId, decision } = {}) {
    const key = idKey(requestId);
    const entry = this.#pending.get(key);
    if (!entry) {
      throw new CodexApprovalError(
        `Unknown approval request ${String(requestId)}`,
        "CODEX_APPROVAL_REQUEST_UNKNOWN",
      );
    }
    if (entry.status !== "PENDING") {
      throw new CodexApprovalError(
        `Approval request ${String(requestId)} has already been answered`,
        "CODEX_APPROVAL_ALREADY_ANSWERED",
      );
    }
    if (threadId !== entry.threadId || turnId !== entry.turnId) {
      throw new CodexApprovalError(
        "Approval response does not match the request thread and turn",
        "CODEX_APPROVAL_CORRELATION_MISMATCH",
        {
          expectedThreadId: entry.threadId,
          expectedTurnId: entry.turnId,
          actualThreadId: threadId,
          actualTurnId: turnId,
        },
      );
    }

    const validatedDecision = validateDecision(entry, decision);
    this.#peer.respond(entry.requestId, { decision: validatedDecision });
    entry.status = "RESPONDED";
    const snapshot = copyRequest(entry);
    this.emit("approvalResponded", snapshot);
    return snapshot;
  }

  /** @param {{requestId?: any, threadId?: string | null}} [input] */
  resolve({ requestId, threadId = null } = {}) {
    const key = idKey(requestId);
    const entry = this.#pending.get(key);
    if (!entry) return false;
    if (threadId !== null && threadId !== entry.threadId) {
      this.emit("resolutionMismatch", {
        requestId,
        expectedThreadId: entry.threadId,
        actualThreadId: threadId,
      });
      return false;
    }
    this.#pending.delete(key);
    this.emit("approvalResolved", copyRequest({ ...entry, status: "RESOLVED" }));
    return true;
  }

  /** @param {CodexApprovalRecord | null | undefined} message */
  handleNotification(message) {
    if (message?.method !== "serverRequest/resolved") return false;
    const params = message.params || {};
    return this.resolve({
      requestId: params.requestId,
      threadId: typeof params.threadId === "string" ? params.threadId : null,
    });
  }

  /** @param {unknown} [cause] */
  disconnect(cause = null) {
    for (const entry of this.#pending.values()) {
      this.emit("approvalDisconnected", {
        ...copyRequest({ ...entry, status: "DISCONNECTED" }),
        cause,
      });
    }
    this.#pending.clear();
  }
}

export { APPROVAL_METHODS };
