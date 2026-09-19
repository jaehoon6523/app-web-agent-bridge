import {
  RuntimeEventType,
  validateRuntimeEventType,
} from "../runtime-events.js";

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
]);

function freezeEvent(type, fields) {
  validateRuntimeEventType(type);
  return Object.freeze({ type, ...fields });
}

function ids(params = {}) {
  return {
    threadId: params.threadId || params.thread?.id || null,
    turnId: params.turnId || params.turn?.id || null,
    itemId: params.itemId || params.item?.id || null,
  };
}

export class CodexEventNormalizer {
  normalizeNotification(message) {
    const method = message?.method;
    const params = message?.params || {};
    const common = { sourceMethod: method, ...ids(params) };

    if (method === "thread/started") {
      return freezeEvent(RuntimeEventType.SESSION_READY, common);
    }
    if (method === "turn/started") {
      return freezeEvent(RuntimeEventType.TURN_STARTED, common);
    }
    if (method === "item/agentMessage/delta") {
      return freezeEvent(RuntimeEventType.TEXT_DELTA, {
        ...common,
        delta: typeof params.delta === "string" ? params.delta : "",
      });
    }
    if (method === "item/started" && TOOL_ITEM_TYPES.has(params.item?.type)) {
      return freezeEvent(RuntimeEventType.TOOL_STARTED, {
        ...common,
        toolType: params.item.type,
      });
    }
    if (method === "item/completed" && TOOL_ITEM_TYPES.has(params.item?.type)) {
      return freezeEvent(RuntimeEventType.TOOL_COMPLETED, {
        ...common,
        toolType: params.item.type,
        status: params.item.status || null,
      });
    }
    if (method === "turn/completed") {
      const status = params.turn?.status;
      if (status === "interrupted") {
        return freezeEvent(RuntimeEventType.TURN_INTERRUPTED, common);
      }
      if (status === "failed") {
        return freezeEvent(RuntimeEventType.TURN_FAILED, {
          ...common,
          error: params.turn?.error || null,
        });
      }
      if (status === "completed") {
        return freezeEvent(RuntimeEventType.TURN_COMPLETED, {
          ...common,
          status,
        });
      }
      return freezeEvent(RuntimeEventType.TURN_FAILED, {
        ...common,
        error: {
          code: "CODEX_TURN_STATUS_INVALID",
          status: status ?? null,
        },
      });
    }
    if (method === "error") {
      return freezeEvent(RuntimeEventType.TURN_FAILED, {
        ...common,
        error: params.error || null,
      });
    }
    return null;
  }

  normalizeApproval(request) {
    return freezeEvent(RuntimeEventType.APPROVAL_REQUESTED, {
      sourceMethod: request.method,
      requestId: request.requestId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      reason: request.reason ?? null,
      command: request.command ?? null,
      cwd: request.cwd ?? null,
      grantRoot: request.grantRoot ?? null,
      networkApprovalContext: request.networkApprovalContext ?? null,
      availableDecisions: request.availableDecisions,
      proposedExecpolicyAmendment: request.proposedExecpolicyAmendment,
    });
  }

  normalizeDisconnect({ threadId = null, turnId = null, ambiguous = false } = {}) {
    return freezeEvent(RuntimeEventType.SESSION_DISCONNECTED, {
      sourceMethod: "codex/process-disconnected",
      threadId,
      turnId,
      itemId: null,
      ambiguous,
    });
  }
}

export { TOOL_ITEM_TYPES };
