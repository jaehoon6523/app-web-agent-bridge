import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { normalizeWorkerCompletion, validateWorkerAdapter } from "./contract.js";

export async function createGenericJsonlWorker({
  provider,
  model = null,
  executablePath,
  args = [],
  workspaceRoot,
}) {
  if (!["deepseek", "claude", "qwen", "gemini"].includes(provider)) {
    throw new Error("Generic JSONL worker supports deepseek, claude, qwen, and gemini.");
  }
  if (typeof executablePath !== "string" || !executablePath) {
    throw new Error(`${provider} requires CODE_WORKER_EXECUTABLE or a provider shim executable.`);
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new TypeError("Worker args must be literal strings.");
  }

  const inheritedEnvKeys = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "LANG", "LC_ALL", "TERM",
  ];
  const workerEnv = Object.fromEntries(
    inheritedEnvKeys
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
  const processHandle = spawn(executablePath, args, {
    cwd: workspaceRoot,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...workerEnv,
      BRIDGE_WORKER_PROVIDER: provider,
      BRIDGE_WORKER_MODEL: model || "",
      BRIDGE_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  const lines = readline.createInterface({ input: processHandle.stdout });
  const pending = new Map();
  let stderr = "";
  let closed = false;
  let sessionId = null;
  let malformedProtocolLines = 0;

  function fail(error) {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  const spawned = new Promise((resolve, reject) => {
    processHandle.once("spawn", resolve);
    processHandle.on("error", (error) => {
      fail(error);
      reject(error);
    });
  });
  processHandle.stdin.on("error", fail);

  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
  });

  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      malformedProtocolLines += 1;
      if (malformedProtocolLines >= 5) {
        fail(new Error(`${provider} worker emitted too many malformed protocol lines.`));
      }
      return;
    }
    const turnId = message?.turnId;
    const waiter = pending.get(turnId);
    if (!waiter) return;
    if (message.type === "completion") {
      pending.delete(turnId);
      sessionId = message.sessionId || sessionId;
      try {
        waiter.resolve(normalizeWorkerCompletion({
          ...message,
          provider,
          model: message.model || model,
          status: message.status || "completed",
        }, { provider, model, sessionId }));
      } catch (error) {
        waiter.reject(error);
      }
    } else if (message.type === "error") {
      pending.delete(turnId);
      waiter.reject(new Error(message.message || `${provider} worker failed.`));
    }
  });

  processHandle.on("exit", (code, signal) => {
    const error = new Error(`${provider} worker exited code=${code} signal=${signal ?? "none"}${stderr ? `: ${stderr}` : ""}`);
    fail(error);
  });

  const adapter = {
    provider,
    model,
    get externalSessionId() { return sessionId; },
    async start() {
      if (closed) throw new Error("Worker process is closed.");
      if (!sessionId) sessionId = `${provider}_${randomUUID()}`;
      return { provider, model, sessionId };
    },
    async submitTurn({ text, outputSchema }) {
      if (closed) throw new Error("Worker process is closed.");
      const turnId = `turn_${randomUUID()}`;
      const completion = new Promise((resolve, reject) => {
        pending.set(turnId, { resolve, reject });
      });
      processHandle.stdin.write(`${JSON.stringify({
        type: "turn",
        provider,
        model,
        sessionId,
        turnId,
        workspaceRoot,
        text,
        outputSchema,
      })}\n`);
      return Object.freeze({ turnId, completion });
    },
    async interrupt({ turnId }) {
      if (closed) return { interrupted: false };
      processHandle.stdin.write(`${JSON.stringify({ type: "interrupt", sessionId, turnId })}\n`);
      return { interrupted: true, turnId };
    },
    async inspect() {
      return { provider, model, sessionId, closed, pid: processHandle.pid, malformedProtocolLines };
    },
    async close() {
      if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
      closed = true;
      try { lines.close(); } catch {}
      /** @type {Promise<void>} */
      const exited = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`${provider} worker did not exit after termination request.`));
        }, 5000);
        const onExit = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timer);
          processHandle.off("exit", onExit);
        };
        processHandle.once("exit", onExit);
      });
      if (!processHandle.kill()) {
        throw new Error(`${provider} worker termination request was not accepted.`);
      }
      await exited;
    },
  };
  await spawned;
  return validateWorkerAdapter(adapter);
}
