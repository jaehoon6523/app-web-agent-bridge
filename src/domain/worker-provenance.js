/** Configuration and runtime-reported identity have different evidentiary strength. */
export function workerProvenance(requested, completed) {
  const reportedProvider = typeof completed?.provider === "string" && completed.provider.trim() ? completed.provider : null;
  const reportedModel = typeof completed?.model === "string" && completed.model.trim() ? completed.model : null;
  return {
    requested: { provider:requested?.provider ?? null, model:requested?.model ?? null },
    reported: { provider:reportedProvider, model:reportedModel },
    evidence: { provider:reportedProvider ? "RUNTIME_REPORTED" : "CONFIGURED_ONLY",
      model:reportedModel ? "RUNTIME_REPORTED" : "CONFIGURED_ONLY" },
  };
}
