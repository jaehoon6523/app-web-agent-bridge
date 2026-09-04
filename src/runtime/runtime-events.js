function enumObject(values) {
  return Object.freeze(Object.fromEntries(values.map((value) => [value, value])));
}

export const RuntimeEventType = enumObject([
  "SESSION_READY",
  "TURN_STARTED",
  "TEXT_DELTA",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "APPROVAL_REQUESTED",
  "TURN_COMPLETED",
  "TURN_INTERRUPTED",
  "TURN_FAILED",
  "SESSION_DISCONNECTED",
]);

export const RUNTIME_EVENT_TYPES = Object.freeze(Object.values(RuntimeEventType));

export class RuntimeEventContractError extends TypeError {
  constructor(message, value) {
    super(message);
    this.name = "RuntimeEventContractError";
    this.code = "INVALID_RUNTIME_EVENT_TYPE";
    this.value = value;
  }
}

export function validateRuntimeEventType(value) {
  if (typeof value !== "string" || !Object.hasOwn(RuntimeEventType, value)) {
    throw new RuntimeEventContractError(
      `Unsupported canonical runtime event type: ${JSON.stringify(value)}`,
      value,
    );
  }
  return value;
}
