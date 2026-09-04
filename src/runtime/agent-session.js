import {
  AgentActor,
  RunMode,
  isVocabularyValue,
} from "../domain/vocabulary.js";

export const AGENT_CAPABILITY_FIELDS = Object.freeze([
  "persistentSession",
  "structuredOutput",
  "interruption",
  "steering",
  "localRead",
  "localWrite",
  "shellExecution",
]);

const CAPABILITY_FIELD_SET = new Set(AGENT_CAPABILITY_FIELDS);

/**
 * @typedef {object} AgentCapabilitiesValue
 * @property {boolean} persistentSession
 * @property {boolean} structuredOutput
 * @property {boolean} interruption
 * @property {boolean} steering
 * @property {boolean} localRead
 * @property {boolean} localWrite
 * @property {boolean} shellExecution
 */

/**
 * @typedef {object} AgentSessionAdapterValue
 * @property {(input: unknown) => unknown} start
 * @property {(input: unknown) => unknown} resume
 * @property {(input: unknown) => unknown} inspect
 * @property {(input: unknown) => unknown} submitTurn
 * @property {(input: unknown) => unknown} interrupt
 * @property {(input: unknown) => unknown} close
 * @property {(listener: Function) => unknown} onEvent
 * @property {((input: unknown) => unknown)=} steer
 */

export class AgentSessionContractError extends TypeError {
  constructor(message, code = "INVALID_AGENT_SESSION_CONTRACT") {
    super(message);
    this.name = "AgentSessionContractError";
    this.code = code;
  }
}

export class RuntimeCapabilityError extends Error {
  constructor({ actor, capability, operation }) {
    super(`${actor} does not permit ${capability} for ${operation}`);
    this.name = "RuntimeCapabilityError";
    this.code = "RUNTIME_CAPABILITY_UNAVAILABLE";
    this.actor = actor;
    this.capability = capability;
    this.operation = operation;
  }
}

export class ExplicitCapabilityPolicyRequiredError extends AgentSessionContractError {
  constructor(actor) {
    super(
      `CODE_CHANGE requires an explicit capability policy for ${actor}`,
      "EXPLICIT_CAPABILITY_POLICY_REQUIRED",
    );
    this.name = "ExplicitCapabilityPolicyRequiredError";
    this.actor = actor;
  }
}

function requireActor(actor) {
  if (!isVocabularyValue(AgentActor, actor)) {
    throw new AgentSessionContractError(
      `Unsupported AgentActor: ${JSON.stringify(actor)}`,
      "INVALID_AGENT_ACTOR",
    );
  }
  return actor;
}

function requireRunMode(mode) {
  if (!isVocabularyValue(RunMode, mode)) {
    throw new AgentSessionContractError(
      `Unsupported RunMode: ${JSON.stringify(mode)}`,
      "INVALID_RUN_MODE",
    );
  }
  return mode;
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentSessionContractError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentSessionContractError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AgentSessionContractError(`${label} must not contain symbol properties`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw new AgentSessionContractError(`${label} must be a function`);
  }
  return value;
}

export function validateAgentCapabilities(value) {
  const capabilities = requirePlainObject(value, "AgentCapabilities");
  const actualKeys = Object.keys(capabilities);

  for (const field of actualKeys) {
    if (!CAPABILITY_FIELD_SET.has(field)) {
      throw new AgentSessionContractError(
        `AgentCapabilities contains unsupported property ${JSON.stringify(field)}`,
      );
    }
  }
  for (const field of AGENT_CAPABILITY_FIELDS) {
    if (!Object.hasOwn(capabilities, field)) {
      throw new AgentSessionContractError(
        `AgentCapabilities is missing required property ${JSON.stringify(field)}`,
      );
    }
    if (typeof capabilities[field] !== "boolean") {
      throw new AgentSessionContractError(
        `AgentCapabilities.${field} must be a boolean`,
      );
    }
  }
  return capabilities;
}

export function createAgentCapabilities(value) {
  validateAgentCapabilities(value);
  return Object.freeze({ ...value });
}

const DISCUSSION_CODEX_CAPABILITIES = createAgentCapabilities({
  persistentSession: true,
  structuredOutput: true,
  interruption: true,
  steering: true,
  localRead: true,
  localWrite: false,
  shellExecution: false,
});

const DISCUSSION_WEB_CAPABILITIES = createAgentCapabilities({
  persistentSession: true,
  structuredOutput: false,
  interruption: true,
  steering: false,
  localRead: false,
  localWrite: false,
  shellExecution: false,
});

export const DISCUSSION_CAPABILITY_PROFILES = Object.freeze({
  [AgentActor.CODEX_AGENT]: DISCUSSION_CODEX_CAPABILITIES,
  [AgentActor.CHATGPT_WEB_AGENT]: DISCUSSION_WEB_CAPABILITIES,
});

export function getDiscussionCapabilities(actor) {
  return DISCUSSION_CAPABILITY_PROFILES[requireActor(actor)];
}

function rejectActorCapabilityEscalation(actor, capabilities) {
  if (actor === AgentActor.CHATGPT_WEB_AGENT) {
    const forbidden = [
      "structuredOutput",
      "steering",
      "localRead",
      "localWrite",
      "shellExecution",
    ];
    for (const capability of forbidden) {
      if (capabilities[capability]) {
        throw new RuntimeCapabilityError({
          actor,
          capability,
          operation: "capability policy resolution",
        });
      }
    }
  }
}

function rejectDiscussionMutation(actor, capabilities) {
  if (capabilities.localWrite) {
    throw new RuntimeCapabilityError({
      actor,
      capability: "localWrite",
      operation: "DISCUSSION policy resolution",
    });
  }
  if (capabilities.shellExecution) {
    throw new RuntimeCapabilityError({
      actor,
      capability: "shellExecution",
      operation: "DISCUSSION policy resolution",
    });
  }
  if (actor === AgentActor.CHATGPT_WEB_AGENT && capabilities.localRead) {
    throw new RuntimeCapabilityError({
      actor,
      capability: "localRead",
      operation: "DISCUSSION policy resolution",
    });
  }
}

/**
 * @param {{actor?: string, mode?: string, capabilities?: AgentCapabilitiesValue}} [options]
 */
export function resolveAgentCapabilities({ actor, mode, capabilities } = {}) {
  requireActor(actor);
  requireRunMode(mode);

  if (mode === RunMode.CODE_CHANGE && capabilities === undefined) {
    throw new ExplicitCapabilityPolicyRequiredError(actor);
  }

  if (capabilities === undefined) {
    return getDiscussionCapabilities(actor);
  }

  const resolved = createAgentCapabilities(capabilities);
  rejectActorCapabilityEscalation(actor, resolved);
  if (mode === RunMode.DISCUSSION) rejectDiscussionMutation(actor, resolved);
  return resolved;
}

function requireCapabilityName(capability) {
  if (typeof capability !== "string" || !CAPABILITY_FIELD_SET.has(capability)) {
    throw new AgentSessionContractError(
      `Unsupported AgentCapability: ${JSON.stringify(capability)}`,
      "INVALID_AGENT_CAPABILITY",
    );
  }
  return capability;
}

export function assertAgentCapability(session, capability, operation = "runtime operation") {
  requireCapabilityName(capability);
  if (session === null || typeof session !== "object") {
    throw new AgentSessionContractError("AgentSession must be an object");
  }
  requireActor(session.actor);
  validateAgentCapabilities(session.capabilities);
  if (!session.capabilities[capability]) {
    throw new RuntimeCapabilityError({
      actor: session.actor,
      capability,
      operation,
    });
  }
}

export function invokeWithAgentCapabilities(
  session,
  requiredCapabilities,
  operation,
  invoke,
) {
  if (!Array.isArray(requiredCapabilities)) {
    throw new AgentSessionContractError("requiredCapabilities must be an array");
  }
  requireFunction(invoke, "invoke");
  for (const capability of requiredCapabilities) {
    assertAgentCapability(session, capability, operation);
  }
  return invoke();
}

const REQUIRED_ADAPTER_METHODS = Object.freeze([
  "start",
  "resume",
  "inspect",
  "submitTurn",
  "interrupt",
  "close",
  "onEvent",
]);

function validateAdapter(adapter, capabilities) {
  if (adapter === null || (typeof adapter !== "object" && typeof adapter !== "function")) {
    throw new AgentSessionContractError("AgentSession adapter must be an object");
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    requireFunction(adapter[method], `AgentSession adapter.${method}`);
  }
  if (capabilities.steering) {
    requireFunction(adapter.steer, "AgentSession adapter.steer");
  }
  return adapter;
}

export class AgentSession {
  #adapter;

  /**
   * @param {{
   *   actor?: string,
   *   capabilities?: AgentCapabilitiesValue,
   *   adapter?: AgentSessionAdapterValue
   * }} [options]
   */
  constructor({ actor, capabilities, adapter } = {}) {
    requireActor(actor);
    const immutableCapabilities = createAgentCapabilities(capabilities);
    validateAdapter(adapter, immutableCapabilities);

    Object.defineProperties(this, {
      actor: {
        value: actor,
        enumerable: true,
        writable: false,
        configurable: false,
      },
      capabilities: {
        value: immutableCapabilities,
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });
    this.#adapter = adapter;

    if (immutableCapabilities.steering) {
      Object.defineProperty(this, "steer", {
        enumerable: false,
        configurable: false,
        writable: false,
        value: (input) => this.#adapter.steer(input),
      });
    }

    Object.freeze(this);
  }

  start(input) {
    return this.#adapter.start(input);
  }

  resume(input) {
    assertAgentCapability(this, "persistentSession", "resume");
    return this.#adapter.resume(input);
  }

  inspect(input) {
    return this.#adapter.inspect(input);
  }

  submitTurn(input) {
    return this.#adapter.submitTurn(input);
  }

  interrupt(input) {
    assertAgentCapability(this, "interruption", "interrupt");
    return this.#adapter.interrupt(input);
  }

  close(input) {
    return this.#adapter.close(input);
  }

  onEvent(listener) {
    requireFunction(listener, "RuntimeEventListener");
    return this.#adapter.onEvent(listener);
  }
}
