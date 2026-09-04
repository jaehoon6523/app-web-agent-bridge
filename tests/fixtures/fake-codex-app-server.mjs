import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const stateArgument = process.argv.indexOf("--state-file");
const stateFile = stateArgument >= 0 ? process.argv[stateArgument + 1] : null;
let savedState = null;
if (stateFile && existsSync(stateFile)) {
  try {
    savedState = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    savedState = null;
  }
}

const threads = new Map((savedState?.threads || []).map((thread) => [thread.id, thread]));
const approvals = new Map();
const reverseRequests = new Map();
let threadSequence = savedState?.threadSequence || 0;
let turnSequence = savedState?.turnSequence || 0;
let approvalSequence = 0;
let reverseSequence = 0;

function saveState() {
  if (!stateFile) return;
  writeFileSync(stateFile, JSON.stringify({
    threadSequence,
    turnSequence,
    threads: [...threads.values()],
  }));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendRaw(line) {
  process.stdout.write(`${line}\n`);
}

function promptText(input) {
  return Array.isArray(input)
    ? input.filter((item) => item?.type === "text").map((item) => item.text).join("\n")
    : "";
}

function threadStatus(record) {
  return record.turns.some((turn) => turn.status === "inProgress")
    ? { type: "active", activeFlags: [] }
    : { type: "idle" };
}

function completeTurn(record, turn, payload = {}, emitEvents = true, terminalStatus = "completed") {
  const text = JSON.stringify({
    ok: true,
    prompt: turn.prompt,
    outputSchemaReceived: Boolean(turn.outputSchema),
    sandboxType: turn.sandboxPolicy?.type || null,
    ...payload,
  });
  const item = {
    type: "agentMessage",
    id: `item_${turn.id}`,
    phase: "final_answer",
    text,
  };
  if (terminalStatus === null) delete turn.status;
  else turn.status = terminalStatus;
  turn.items = [item];
  saveState();
  if (!emitEvents) return;
  send({
    method: "item/completed",
    params: { threadId: record.id, turnId: turn.id, item, completedAtMs: Date.now() },
  });
  send({
    method: "turn/completed",
    params: { threadId: record.id, turn: { ...turn } },
  });
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    send({ id, result: { userAgent: "fake-codex", platformFamily: process.platform } });
    return;
  }
  if (method === "thread/start") {
    if (!["read-only", "workspace-write"].includes(params.sandbox)) {
      send({ id, error: { code: -32602, message: "invalid sandbox mode" } });
      return;
    }
    const threadId = `thr_${++threadSequence}`;
    const thread = { id: threadId, sessionId: threadId, turns: [] };
    threads.set(threadId, thread);
    saveState();
    send({ id, result: { thread: { id: threadId, sessionId: threadId, ephemeral: false } } });
    send({ method: "thread/started", params: { thread: { id: threadId, sessionId: threadId } } });
    return;
  }
  if (method === "thread/resume") {
    const record = threads.get(params.threadId);
    if (!record) {
      send({ id, error: { code: -32004, message: "thread not found" } });
      return;
    }
    send({ id, result: { thread: { id: record.id, sessionId: record.id, ephemeral: false } } });
    send({ method: "thread/started", params: { thread: { id: record.id, sessionId: record.id } } });
    return;
  }
  if (method === "thread/read") {
    const record = threads.get(params.threadId);
    if (!record) {
      send({ id, error: { code: -32004, message: "thread not found" } });
      return;
    }
    for (const turn of record.turns) {
      if (turn.status !== "inProgress" || turn.prompt !== "__complete_on_second_read_wrong_schema__") continue;
      turn.inspectionCount = (turn.inspectionCount || 0) + 1;
      if (turn.inspectionCount >= 2) completeTurn(record, turn, { ok: "wrong-type" }, false);
      else saveState();
    }
    send({
      id,
      result: {
        thread: {
          id: record.id,
          sessionId: record.id,
          status: threadStatus(record),
          turns: params.includeTurns ? record.turns.map((turn) => ({ ...turn })) : undefined,
        },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const record = threads.get(params.threadId);
    if (!record) {
      send({ id, error: { code: -32004, message: "thread not found" } });
      return;
    }
    const turn = {
      id: `turn_${++turnSequence}`,
      status: "inProgress",
      items: [],
      error: null,
      prompt: promptText(params.input),
      outputSchema: params.outputSchema,
      sandboxPolicy: params.sandboxPolicy,
    };
    record.turns.push(turn);
    saveState();
    if (turn.prompt === "__crash_before_turn_response__") {
      setImmediate(() => process.exit(19));
      return;
    }
    send({ id, result: { turn: { id: turn.id, status: turn.status, items: [], error: null } } });
    send({
      method: "turn/started",
      params: { threadId: record.id, turn: { id: turn.id, status: "inProgress", items: [] } },
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: record.id, turnId: turn.id, itemId: `item_${turn.id}`, delta: "ui-only-delta" },
    });

    if (["__interrupt__", "__interrupt_inspect__", "__interrupt_reject_once__"].includes(turn.prompt)) return;
    if (turn.prompt === "__crash__") {
      setImmediate(() => process.exit(17));
      return;
    }
    if (turn.prompt === "__delta_only__") {
      turn.status = "completed";
      saveState();
      send({
        method: "turn/completed",
        params: { threadId: record.id, turn: { ...turn } },
      });
      return;
    }
    if (turn.prompt === "__approval__") {
      const requestId = `approval_${++approvalSequence}`;
      approvals.set(requestId, { record, turn });
      send({
        method: "item/started",
        params: {
          threadId: record.id,
          turnId: turn.id,
          startedAtMs: Date.now(),
          item: {
            type: "commandExecution",
            id: `command_${turn.id}`,
            command: ["fake-command"],
            cwd: process.cwd(),
            status: "inProgress",
          },
        },
      });
      send({
        id: requestId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: record.id,
          turnId: turn.id,
          itemId: `command_${turn.id}`,
          reason: "fake approval",
          command: ["fake-command"],
          cwd: process.cwd(),
          availableDecisions: ["accept", "decline", "cancel"],
        },
      });
      return;
    }
    if (turn.prompt === "__wrong_schema_value__") {
      completeTurn(record, turn, { ok: "wrong-type" });
      return;
    }
    if (turn.prompt === "__missing_terminal_status__") {
      completeTurn(record, turn, {}, true, null);
      return;
    }
    if (turn.prompt === "__unknown_terminal_status__") {
      completeTurn(record, turn, {}, true, "mysteriouslyDone");
      return;
    }
    if (turn.prompt === "__complete_on_second_read_wrong_schema__") return;
    completeTurn(record, turn);
    return;
  }
  if (method === "turn/interrupt") {
    const record = threads.get(params.threadId);
    const turn = record?.turns.find((candidate) => candidate.id === params.turnId);
    if (!record || !turn || turn.status !== "inProgress") {
      send({ id, error: { code: -32004, message: "active turn not found" } });
      return;
    }
    if (turn.prompt === "__interrupt_reject_once__" && !turn.interruptRejectedOnce) {
      turn.interruptRejectedOnce = true;
      send({ id, error: { code: -32020, message: "synthetic interrupt rejection" } });
      return;
    }
    send({ id, result: {} });
    turn.status = "interrupted";
    saveState();
    if (turn.prompt === "__interrupt_inspect__") return;
    send({
      method: "turn/completed",
      params: { threadId: record.id, turn: { ...turn } },
    });
    return;
  }
  if (method === "turn/steer") {
    send({ id, result: { turnId: params.expectedTurnId } });
    return;
  }
  if (method === "test/environment") {
    send({ id, result: { keys: Object.keys(process.env).sort(), pid: process.pid } });
    return;
  }
  if (method === "test/invalid-json") {
    send({ id, result: { ok: true } });
    sendRaw("{definitely-not-json");
    return;
  }
  if (method === "test/orphan-response") {
    send({ id, result: { ok: true } });
    send({ id: 987654321, result: { orphan: true } });
    return;
  }
  if (method === "test/duplicate-response") {
    send({ id, result: { ok: true } });
    send({ id, result: { duplicate: true } });
    return;
  }
  if (method === "test/late-response") {
    setTimeout(() => send({ id, result: { late: true } }), 40);
    return;
  }
  if (method === "test/late-turn-event") {
    send({ id, result: { ok: true } });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: `late_${params.turnId}`,
        delta: "stale-late-delta",
      },
    });
    return;
  }
  if (method === "test/unsupported-reverse-request") {
    const reverseRequestId = `reverse_${++reverseSequence}`;
    reverseRequests.set(reverseRequestId, id);
    send({
      id: reverseRequestId,
      method: "test/unsupported-server-request",
      params: { mustFailClosed: true },
    });
    return;
  }
  send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
}

function handleApprovalResponse(message) {
  const pending = approvals.get(String(message.id));
  if (!pending) return false;
  approvals.delete(String(message.id));
  send({
    method: "serverRequest/resolved",
    params: { threadId: pending.record.id, requestId: message.id },
  });
  completeTurn(pending.record, pending.turn, { approvalDecision: message.result?.decision || null });
  return true;
}

function handleReverseResponse(message) {
  const outerRequestId = reverseRequests.get(String(message.id));
  if (outerRequestId === undefined) return false;
  reverseRequests.delete(String(message.id));
  send({
    id: outerRequestId,
    result: {
      reverseError: message.error ?? null,
      reverseResult: message.result ?? null,
    },
  });
  return true;
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method === "string") {
    if (Object.hasOwn(message, "id")) handleRequest(message);
    return;
  }
  if (Object.hasOwn(message, "id")) {
    if (handleReverseResponse(message)) return;
    handleApprovalResponse(message);
  }
});
