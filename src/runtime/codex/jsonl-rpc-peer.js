import { EventEmitter } from "node:events";
import readline from "node:readline";
import {
  CodexProtocolError,
  CodexRpcError,
  CodexRpcTimeoutError,
  CodexTransportClosedError,
} from "./errors.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function responseKey(id) {
  return `${typeof id}:${String(id)}`;
}

/**
 * @param {Set<any>} set
 * @param {number} limit
 */
function pruneSet(set, limit) {
  while (set.size > limit) set.delete(set.values().next().value);
}

export class JsonlRpcPeer extends EventEmitter {
  /** @type {any} */
  #input;
  /** @type {any} */
  #output;
  #reader;
  #nextRequestId;
  /** @type {Map<string, any>} */
  #pending = new Map();
  /** @type {Set<string>} */
  #settled = new Set();
  /** @type {Set<string>} */
  #timedOut = new Set();
  #defaultTimeoutMs;
  #closed = false;

  /**
   * @param {{
   *   input?: any,
   *   output?: any,
   *   defaultTimeoutMs?: number,
   *   requestIdStart?: number,
   * }} [options]
   */
  constructor({ input, output, defaultTimeoutMs = 30_000, requestIdStart = 0 } = {}) {
    super();
    if (!input || typeof input.write !== "function") {
      throw new TypeError("JsonlRpcPeer input must be a writable stream");
    }
    if (!output || typeof output.on !== "function") {
      throw new TypeError("JsonlRpcPeer output must be a readable stream");
    }
    if (!Number.isSafeInteger(requestIdStart) || requestIdStart < 0) {
      throw new TypeError("requestIdStart must be a non-negative safe integer");
    }
    this.#input = input;
    this.#output = output;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#nextRequestId = requestIdStart;
    this.#reader = readline.createInterface({ input: output, crlfDelay: Infinity });
    this.#reader.on("line", (line) => this.#handleLine(line));
    output.once("error", (error) => this.close(error));
  }

  get closed() {
    return this.#closed;
  }

  get pendingRequestCount() {
    return this.#pending.size;
  }

  request(method, params = {}, timeoutMs = this.#defaultTimeoutMs) {
    if (this.#closed || !this.#input.writable) {
      return Promise.reject(new CodexTransportClosedError());
    }
    if (typeof method !== "string" || method === "") {
      return Promise.reject(new TypeError("JSON-RPC method must be a non-empty string"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("JSON-RPC timeout must be a positive integer"));
    }

    const id = ++this.#nextRequestId;
    const key = responseKey(id);
    const completion = deferred();
    const timer = setTimeout(() => {
      const entry = this.#pending.get(key);
      if (!entry) return;
      this.#pending.delete(key);
      this.#timedOut.add(key);
      pruneSet(this.#timedOut, 2_000);
      entry.completion.reject(new CodexRpcTimeoutError(method, id, timeoutMs));
    }, timeoutMs);
    this.#pending.set(key, { id, method, timer, completion });

    try {
      this.#write({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(key);
      completion.reject(error);
    }
    return completion.promise;
  }

  notify(method, params = {}) {
    if (typeof method !== "string" || method === "") {
      throw new TypeError("JSON-RPC notification method must be a non-empty string");
    }
    this.#write({ method, params });
  }

  respond(id, result) {
    if (id === undefined || id === null) {
      throw new TypeError("JSON-RPC response id is required");
    }
    this.#write({ id, result });
  }

  respondError(id, error) {
    if (id === undefined || id === null) {
      throw new TypeError("JSON-RPC response id is required");
    }
    if (!error || typeof error.code !== "number" || typeof error.message !== "string") {
      throw new TypeError("JSON-RPC error requires numeric code and string message");
    }
    this.#write({ id, error });
  }

  close(cause = null) {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    const error = cause instanceof CodexTransportClosedError
      ? cause
      : new CodexTransportClosedError("Codex app-server transport closed", { cause });
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.completion.reject(error);
    }
    this.#pending.clear();
    this.emit("closed", error);
  }

  #write(message) {
    if (this.#closed || !this.#input.writable) throw new CodexTransportClosedError();
    const line = `${JSON.stringify(message)}\n`;
    this.#input.write(line);
    this.emit("sent", message);
  }

  #handleLine(line) {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this.emit(
        "protocolError",
        new CodexProtocolError("App-server emitted invalid JSON", "CODEX_INVALID_JSON", {
          cause,
          byteLength: Buffer.byteLength(line, "utf8"),
        }),
      );
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.emit(
        "protocolError",
        new CodexProtocolError("App-server emitted a non-object JSON-RPC message"),
      );
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = typeof message.method === "string" && message.method !== "";
    if (hasMethod && hasId) {
      this.emit("serverRequest", message);
      return;
    }
    if (hasMethod) {
      this.emit("notification", message);
      return;
    }
    if (hasId) {
      this.#handleResponse(message);
      return;
    }
    this.emit(
      "protocolError",
      new CodexProtocolError("App-server emitted an unrecognized JSON-RPC object", "CODEX_UNKNOWN_MESSAGE"),
    );
  }

  /** @param {any} message */
  #handleResponse(message) {
    const key = responseKey(message.id);
    const entry = this.#pending.get(key);
    if (!entry) {
      if (this.#settled.has(key)) {
        this.emit("duplicateResponse", message);
      } else if (this.#timedOut.has(key)) {
        this.emit("lateResponse", message);
      } else {
        this.emit("orphanResponse", message);
      }
      return;
    }

    clearTimeout(entry.timer);
    this.#pending.delete(key);
    this.#settled.add(key);
    pruneSet(this.#settled, 2_000);
    if (Object.hasOwn(message, "error")) {
      entry.completion.reject(new CodexRpcError(entry.method, message.error, message.id));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      entry.completion.reject(
        new CodexProtocolError(
          `Codex RPC ${entry.method} response has neither result nor error`,
          "CODEX_RPC_RESPONSE_INVALID",
          { method: entry.method, requestId: message.id },
        ),
      );
      return;
    }
    entry.completion.resolve(message.result);
  }
}
