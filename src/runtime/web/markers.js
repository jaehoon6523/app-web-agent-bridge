import { WebProtocolError } from "./protocol.js";

const MARKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROLLER_MARKER_PATTERN = /^\[controller_message_id:([^\]\r\n]+)\]$/gm;
const RUN_MARKER_PATTERN = /^\[run_id:([^\]\r\n]+)\]$/gm;

function requireMarkerId(value, label) {
  if (typeof value !== "string" || !MARKER_ID_PATTERN.test(value)) {
    throw new WebProtocolError(`${label} contains unsupported characters`, "INVALID_PROMPT_MARKER");
  }
  return value;
}

export function createPromptMarkers({ controllerMessageId, runId }) {
  requireMarkerId(controllerMessageId, "controllerMessageId");
  requireMarkerId(runId, "runId");
  return Object.freeze({
    controllerMessageId,
    runId,
    text: `[controller_message_id:${controllerMessageId}]\n[run_id:${runId}]`,
  });
}

export function createMarkedPrompt({ controllerMessageId, runId, content }) {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new WebProtocolError("Prompt content must be non-empty", "INVALID_PROMPT_CONTENT");
  }
  if (content.includes("[controller_message_id:") || content.includes("[run_id:")) {
    throw new WebProtocolError("Prompt content contains reserved controller markers", "RESERVED_PROMPT_MARKER");
  }
  const markers = createPromptMarkers({ controllerMessageId, runId });
  return `${markers.text}\n\n${content}`;
}

export function parsePromptMarkers(text) {
  if (typeof text !== "string") return null;
  const controllerMatches = [...text.matchAll(CONTROLLER_MARKER_PATTERN)];
  const runMatches = [...text.matchAll(RUN_MARKER_PATTERN)];
  if (controllerMatches.length !== 1 || runMatches.length !== 1) return null;
  if (!MARKER_ID_PATTERN.test(controllerMatches[0][1]) || !MARKER_ID_PATTERN.test(runMatches[0][1])) return null;
  return Object.freeze({
    controllerMessageId: controllerMatches[0][1],
    runId: runMatches[0][1],
  });
}

export function hasExactPromptMarkers(text, expected) {
  const observed = parsePromptMarkers(text);
  return Boolean(
    observed
    && observed.controllerMessageId === expected.controllerMessageId
    && observed.runId === expected.runId,
  );
}
