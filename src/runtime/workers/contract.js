const requiredMethods = [
  "start",
  "submitTurn",
  "interrupt",
  "inspect",
  "close",
];

export function validateWorkerAdapter(worker) {
  if (!worker || typeof worker !== "object") throw new TypeError("Worker adapter is required.");
  for (const method of requiredMethods) {
    if (typeof worker[method] !== "function") throw new TypeError(`Worker adapter must implement ${method}().`);
  }
  if (typeof worker.provider !== "string" || !worker.provider) throw new TypeError("Worker provider is required.");
  return worker;
}

export function normalizeWorkerCompletion(value, fallback = {}) {
  if (!value || typeof value !== "object") throw new Error("Worker completion must be an object.");
  if (typeof value.turnId !== "string" || !value.turnId) throw new Error("Worker completion requires turnId.");
  if (value.status !== "completed") throw new Error("Worker completion status must be completed.");
  if (typeof value.text !== "string") throw new Error("Worker completion requires text.");
  return Object.freeze({
    provider: value.provider || fallback.provider,
    model: value.model || fallback.model || null,
    sessionId: value.sessionId || value.threadId || fallback.sessionId || null,
    threadId: value.threadId || value.sessionId || fallback.sessionId || null,
    turnId: value.turnId,
    status: value.status,
    text: value.text,
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : null,
  });
}
