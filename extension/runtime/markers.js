const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function createControlledPrompt({ controllerMessageId, runId, text }) {
  if (!ID_PATTERN.test(controllerMessageId) || !ID_PATTERN.test(runId)) {
    throw new TypeError("Controller message and run IDs must use the marker-safe ID format");
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TypeError("Prompt text must be non-empty");
  }
  if (text.includes("[controller_message_id:") || text.includes("[run_id:")) {
    throw new TypeError("Prompt text contains a reserved marker");
  }
  return `[controller_message_id:${controllerMessageId}]\n[run_id:${runId}]\n\n${text}`;
}

