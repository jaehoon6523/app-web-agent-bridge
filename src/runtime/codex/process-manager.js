import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  CodexProtocolError,
  CodexTransportClosedError,
} from "./errors.js";
import { createCodexChildEnvironment } from "./environment.js";
import { resolvePinnedExecutable, verifyPinnedExecutable } from "./executable.js";
import { JsonlRpcPeer } from "./jsonl-rpc-peer.js";
import { CodexApprovalBridge } from "./approval-bridge.js";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "vibe_flow_agent_controller",
  title: "VIBE_FLOW Agent Controller",
  version: "0.1.0",
});

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

/**
 * @typedef {{
 *   executablePath?: string,
 *   workspaceRoot?: string,
 *   authPathKeys?: string[],
 *   sourceEnv?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   appServerArgs?: string[],
 *   spawn?: any,
 *   clientInfo?: Record<string, any>,
 *   initializeTimeoutMs?: number,
 * }} CodexProcessCreateOptions
 */

/**
 * @typedef {{
 *   pin?: any,
 *   environment?: any,
 *   appServerArgs?: string[],
 *   spawn?: any,
 *   clientInfo?: Record<string, any>,
 *   initializeTimeoutMs?: number,
 * }} CodexProcessManagerOptions
 */

/** @param {unknown} value */
function hashText(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

export class CodexProcessManager extends EventEmitter {
  #pin;
  #environment;
  #args;
  #spawn;
  #clientInfo;
  #initializeTimeoutMs;
  #process = null;
  #peer = null;
  #approvalBridge = null;
  #startPromise = null;
  #status = "STOPPED";
  #generation = 0;
  #closing = false;

  /** @param {CodexProcessCreateOptions} [options] */
  static async create({
    executablePath,
    workspaceRoot,
    authPathKeys = [],
    sourceEnv = process.env,
    platform = process.platform,
    appServerArgs = ["app-server"],
    spawn = nodeSpawn,
    clientInfo = DEFAULT_CLIENT_INFO,
    initializeTimeoutMs = 30_000,
  } = {}) {
    const pin = await resolvePinnedExecutable({ executablePath, workspaceRoot, platform });
    const environment = createCodexChildEnvironment({ sourceEnv, authPathKeys, platform });
    return new CodexProcessManager({
      pin,
      environment,
      appServerArgs,
      spawn,
      clientInfo,
      initializeTimeoutMs,
    });
  }

  /** @param {CodexProcessManagerOptions} [options] */
  constructor({
    pin,
    environment,
    appServerArgs = ["app-server"],
    spawn = nodeSpawn,
    clientInfo = DEFAULT_CLIENT_INFO,
    initializeTimeoutMs = 30_000,
  } = {}) {
    super();
    if (!pin || typeof pin.path !== "string") throw new TypeError("CodexProcessManager requires an executable pin");
    if (!environment?.env || typeof environment.snapshotSha256 !== "string") {
      throw new TypeError("CodexProcessManager requires a filtered environment");
    }
    if (!Array.isArray(appServerArgs) || !appServerArgs.every((part) => typeof part === "string")) {
      throw new TypeError("appServerArgs must be a string array");
    }
    if (typeof spawn !== "function") throw new TypeError("spawn must be a function");
    this.#pin = pin;
    this.#environment = environment;
    this.#args = Object.freeze([...appServerArgs]);
    this.#spawn = spawn;
    this.#clientInfo = Object.freeze({ ...clientInfo });
    this.#initializeTimeoutMs = initializeTimeoutMs;
  }

  get status() {
    return this.#status;
  }

  get executablePin() {
    return this.#pin;
  }

  get environmentSnapshotSha256() {
    return this.#environment.snapshotSha256;
  }

  get environmentKeys() {
    return this.#environment.keys;
  }

  get processGeneration() {
    return this.#generation;
  }

  get processId() {
    return this.#process?.pid ?? null;
  }

  get approvalBridge() {
    return this.#approvalBridge;
  }

  async start() {
    if (this.#status === "READY" && this.#process && this.#peer && !this.#peer.closed) return;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startInternal();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async ensureReadyForNewOperation() {
    await verifyPinnedExecutable(this.#pin);
    await this.start();
    if (this.#status !== "READY" || !this.#peer || this.#peer.closed) {
      throw new CodexTransportClosedError("Codex app-server is not ready");
    }
  }

  request(method, params = {}, timeoutMs) {
    if (this.#status !== "READY" || !this.#peer) {
      return Promise.reject(new CodexTransportClosedError("Codex app-server is not ready"));
    }
    return this.#peer.request(method, params, timeoutMs);
  }

  notify(method, params = {}) {
    if (this.#status !== "READY" || !this.#peer) {
      throw new CodexTransportClosedError("Codex app-server is not ready");
    }
    this.#peer.notify(method, params);
  }

  respondToApproval(input) {
    if (!this.#approvalBridge) {
      throw new CodexTransportClosedError("Codex approval bridge is unavailable");
    }
    return this.#approvalBridge.respond(input);
  }

  async close() {
    this.#closing = true;
    const proc = this.#process;
    const peer = this.#peer;
    this.#process = null;
    this.#peer = null;
    this.#approvalBridge?.disconnect(new CodexTransportClosedError("Codex app-server closed by controller"));
    this.#approvalBridge = null;
    peer?.close(new CodexTransportClosedError("Codex app-server closed by controller"));
    if (proc && !proc.killed) proc.kill();
    this.#setStatus("STOPPED");
    this.#closing = false;
  }

  async #startInternal() {
    await verifyPinnedExecutable(this.#pin);
    this.#setStatus("STARTING");
    let proc;
    try {
      proc = this.#spawn(this.#pin.path, this.#args, {
        cwd: this.#pin.workspaceRoot,
        env: { ...this.#environment.env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#setStatus("FAILED");
      throw error;
    }
    this.#process = proc;
    this.#generation += 1;
    const generation = this.#generation;

    const peer = new JsonlRpcPeer({ input: proc.stdin, output: proc.stdout });
    this.#peer = peer;
    const approvalBridge = new CodexApprovalBridge({ peer });
    this.#approvalBridge = approvalBridge;

    peer.on("notification", (message) => {
      approvalBridge.handleNotification(message);
      this.emit("notification", message);
    });
    peer.on("serverRequest", (message) => this.#handleServerRequest(message, approvalBridge));
    peer.on("protocolError", (error) => this.emit("protocolError", error));
    for (const diagnostic of ["orphanResponse", "lateResponse", "duplicateResponse"]) {
      peer.on(diagnostic, (message) => this.emit(diagnostic, {
        id: message?.id ?? null,
        hasResult: Boolean(message && Object.hasOwn(message, "result")),
        hasError: Boolean(message && Object.hasOwn(message, "error")),
      }));
    }
    peer.on("sent", (message) => this.emit("rpcSent", {
      id: message.id ?? null,
      method: message.method ?? null,
      notification: !Object.hasOwn(message, "id"),
    }));
    approvalBridge.on("approvalRequested", (request) => this.emit("approvalRequested", request));
    approvalBridge.on("approvalResponded", (request) => this.emit("approvalResponded", request));
    approvalBridge.on("approvalResolved", (request) => this.emit("approvalResolved", request));

    proc.stderr?.setEncoding?.("utf8");
    proc.stderr?.on?.("data", (chunk) => {
      this.emit("stderrObserved", {
        byteLength: Buffer.byteLength(String(chunk), "utf8"),
        sha256: hashText(chunk),
      });
    });
    proc.once("error", (cause) => this.#handleProcessEnd(generation, { cause, code: null, signal: null }));
    proc.once("exit", (code, signal) => this.#handleProcessEnd(generation, { code, signal, cause: null }));

    try {
      await peer.request("initialize", {
        clientInfo: this.#clientInfo,
        capabilities: { experimentalApi: false },
      }, this.#initializeTimeoutMs);
      peer.notify("initialized", {});
      if (this.#process !== proc || peer.closed) throw new CodexTransportClosedError();
      this.#setStatus("READY");
      this.emit("ready", {
        processGeneration: generation,
        processId: proc.pid ?? null,
        executableSha256: this.#pin.sha256,
        environmentSnapshotSha256: this.#environment.snapshotSha256,
      });
    } catch (error) {
      if (this.#process === proc) {
        this.#process = null;
        this.#peer = null;
        this.#approvalBridge = null;
      }
      approvalBridge.disconnect(error);
      peer.close(error);
      if (!proc.killed) proc.kill();
      this.#setStatus("FAILED");
      throw error;
    }
  }

  /**
   * @param {any} message
   * @param {CodexApprovalBridge} approvalBridge
   */
  #handleServerRequest(message, approvalBridge) {
    try {
      if (approvalBridge.capture(message)) return;
      if (message.method === "currentTime/read") {
        this.#peer?.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      }
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        paramsPresent: Boolean(message.params),
      });
      this.#peer?.respondError(message.id, {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: "Method not found",
      });
    } catch (error) {
      this.emit("protocolError", error);
      try {
        this.#peer?.respondError(message.id, {
          code: JSON_RPC_INVALID_PARAMS,
          message: "Invalid server request",
        });
      } catch (responseError) {
        this.emit("protocolError", responseError);
      }
    }
  }

  /**
   * @param {number} generation
   * @param {any} details
   */
  #handleProcessEnd(generation, details) {
    if (generation !== this.#generation || !this.#process) return;
    const peer = this.#peer;
    const approvalBridge = this.#approvalBridge;
    this.#process = null;
    this.#peer = null;
    this.#approvalBridge = null;
    const error = new CodexTransportClosedError(
      `Codex app-server exited (code=${String(details.code)}, signal=${String(details.signal)})`,
      { exitCode: details.code, signal: details.signal, cause: details.cause },
    );
    approvalBridge?.disconnect(error);
    peer?.close(error);
    if (this.#closing) {
      this.#setStatus("STOPPED");
      return;
    }
    this.#setStatus("FAILED");
    this.emit("disconnected", {
      processGeneration: generation,
      processId: null,
      error,
    });
  }

  /** @param {string} status */
  #setStatus(status) {
    if (status === this.#status) return;
    this.#status = status;
    this.emit("status", status);
  }
}
