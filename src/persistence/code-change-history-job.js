import { Worker } from "node:worker_threads";

export const HISTORY_VERIFICATION_DEADLINE_MS = 60_000;
const CANCELLATION_DEADLINE_MS = 2_000;

// One-shot verifier owns its own SQLite handle. Completion includes natural
// thread exit; forced cleanup is reported as a failure, never successful close.
export class CodeChangeHistoryJob {
  /** @param {string} filename @param {{migrate?: boolean, signal?: AbortSignal, onProgress?: (count: number) => void, timeoutMs?: number}} [options] */
  constructor(filename, {migrate = false, signal, onProgress, timeoutMs = HISTORY_VERIFICATION_DEADLINE_MS} = {}) {
    this.cancellation = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(new URL("./code-change-history-worker.js", import.meta.url), {
      workerData:{filename, migrate, cancellation:this.cancellation.buffer},
    });
    let output, fault;
    this.closed = new Promise((resolve, reject) => {
      this.worker.once("exit", code => {
        this.exited = true;
        clearTimeout(this.deadline); clearTimeout(this.cleanupDeadline);
        signal?.removeEventListener("abort", abort);
        if (this.forced) reject(Object.assign(new Error("History verifier required forced cleanup."), {code:"CODE_CHANGE_HISTORY_FORCED_CLEANUP"}));
        else if (code !== 0 || fault) reject(Object.assign(new Error("History verifier exited abnormally."), {code:"CODE_CHANGE_HISTORY_WORKER_EXIT"}));
        else resolve(undefined);
      });
    });
    this.worker.on("message", message => {
      if (message.progress !== undefined) {
        try { onProgress?.(message.progress); } catch { /* Observation is not authority. */ }
      } else output = message;
    });
    this.worker.once("error", error => { fault = error; });
    const abort = () => this.cancel(signal.reason);
    signal?.addEventListener("abort", abort, {once:true});
    if (signal?.aborted) abort();
    this.deadline = setTimeout(() => this.cancel(Object.assign(new Error("History verification deadline exceeded."), {
      code:"CODE_CHANGE_HISTORY_DEADLINE",
    })), timeoutMs);
    this.result = this.closed.then(() => {
      if (this.cancelReason) throw this.cancelReason;
      if (!output) throw Object.assign(new Error("History verifier returned no result."), {code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
      if (!output.ok) throw Object.assign(new Error(output.error.message), {code:output.error.code, errcode:output.error.errcode});
      return output.verified;
    });
    this.result.catch(() => {});
  }
  cancel(reason = Object.assign(new Error("Code change history verification cancelled."), {code:"CODE_CHANGE_HISTORY_CANCELLED"})) {
    if (this.cancelReason || this.exited) return;
    this.cancelReason = reason;
    Atomics.store(this.cancellation, 0, 1);
    this.cleanupDeadline = setTimeout(() => {
      this.forced = true;
      this.worker.terminate().catch(() => {});
    }, CANCELLATION_DEADLINE_MS);
  }
}
