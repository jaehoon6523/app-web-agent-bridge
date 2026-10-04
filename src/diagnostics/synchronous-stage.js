import { performance } from "node:perf_hooks";
import { diagnosticErrorCode } from "./server-observer.js";

// Observe synchronous boundaries without changing execution order or failures.
export function observeSynchronousStage(onDiagnostic, stage, operation) {
  const started = performance.now();
  const emit = (status, error = undefined) => {
    try { onDiagnostic?.({type:`${stage}.${status}`,
      ...(status === "started" ? {} : {elapsedMs:performance.now()-started}),
      ...(status === "failed" ? {errorCode:diagnosticErrorCode(error)} : {})}); }
    catch { /* Diagnostic observers cannot change production behavior. */ }
  };
  emit("started");
  try {
    const result = operation();
    emit("completed");
    return result;
  } catch (error) { emit("failed", error); throw error; }
}
