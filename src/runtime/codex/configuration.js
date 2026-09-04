import path from "node:path";
import AjvModule from "ajv";
import { CodexConfigurationError } from "./errors.js";

const AjvConstructor = /** @type {any} */ (AjvModule);
const outputSchemaCompiler = new AjvConstructor({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  validateFormats: false,
});

/** @param {any} value */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {any} value
 * @param {string} label
 */
export function jsonClone(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw new CodexConfigurationError(
      `${label} must be JSON serializable`,
      "CODEX_JSON_VALUE_INVALID",
      { cause },
    );
  }
}

/** @param {any} schema */
export function assertStrictOutputSchema(schema) {
  if (!isPlainObject(schema) || Object.keys(schema).length === 0) {
    throw new CodexConfigurationError(
      "turn/start requires a non-empty caller-supplied outputSchema",
      "CODEX_OUTPUT_SCHEMA_REQUIRED",
    );
  }
  if (schema.type === "object") {
    if (!isPlainObject(schema.properties) || Object.keys(schema.properties).length === 0) {
      throw new CodexConfigurationError(
        "Object outputSchema must declare properties; {type: object} is not accepted",
        "CODEX_OUTPUT_SCHEMA_NOT_STRICT",
      );
    }
    if (!Array.isArray(schema.required)) {
      throw new CodexConfigurationError(
        "Object outputSchema must declare required properties",
        "CODEX_OUTPUT_SCHEMA_NOT_STRICT",
      );
    }
    if (schema.additionalProperties !== false) {
      throw new CodexConfigurationError(
        "Object outputSchema must set additionalProperties to false",
        "CODEX_OUTPUT_SCHEMA_NOT_STRICT",
      );
    }
  } else if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    for (const branch of schema.oneOf) assertStrictOutputSchema(branch);
  } else {
    throw new CodexConfigurationError(
      "outputSchema must be a strict object schema or a non-empty oneOf of strict object schemas",
      "CODEX_OUTPUT_SCHEMA_NOT_STRICT",
    );
  }
  return jsonClone(schema, "outputSchema");
}

/** @param {any} schema */
export function compileOutputSchema(schema) {
  try {
    return outputSchemaCompiler.compile(schema);
  } catch (cause) {
    throw new CodexConfigurationError(
      "outputSchema is not a valid JSON Schema",
      "CODEX_OUTPUT_SCHEMA_INVALID",
      { cause },
    );
  }
}

/** @param {any[] | null | undefined} errors */
export function copyValidationErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
    params: jsonClone(error.params, "validation error params"),
  }));
}

/**
 * @param {any} value
 * @param {string} label
 */
export function requireAbsoluteRoot(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new CodexConfigurationError(
      `${label} must be an absolute path`,
      "CODEX_SANDBOX_ROOT_INVALID",
      { label },
    );
  }
  return path.resolve(value);
}

/** @param {any} value */
export function validateApprovalPolicy(value) {
  if (typeof value === "string") {
    if (!["untrusted", "on-request", "never"].includes(value)) {
      throw new CodexConfigurationError(
        `Unsupported installed app-server approvalPolicy: ${JSON.stringify(value)}`,
        "CODEX_APPROVAL_POLICY_UNSUPPORTED",
      );
    }
    return value;
  }
  if (isPlainObject(value) && isPlainObject(value.granular)) {
    if (Object.keys(value).some((key) => key !== "granular")) {
      throw new CodexConfigurationError(
        "Granular approvalPolicy must not contain fields beside granular",
        "CODEX_APPROVAL_POLICY_INVALID",
      );
    }
    const granular = value.granular;
    for (const required of ["mcp_elicitations", "rules", "sandbox_approval"]) {
      if (typeof granular[required] !== "boolean") {
        throw new CodexConfigurationError(
          `Granular approvalPolicy requires boolean ${required}`,
          "CODEX_APPROVAL_POLICY_INVALID",
        );
      }
    }
    for (const optional of ["request_permissions", "skill_approval"]) {
      if (Object.hasOwn(granular, optional) && typeof granular[optional] !== "boolean") {
        throw new CodexConfigurationError(
          `Granular approvalPolicy field ${optional} must be boolean`,
          "CODEX_APPROVAL_POLICY_INVALID",
        );
      }
    }
    return jsonClone(value, "approvalPolicy");
  }
  throw new CodexConfigurationError(
    "approvalPolicy must match the installed app-server schema",
    "CODEX_APPROVAL_POLICY_INVALID",
  );
}

/**
 * @param {{
 *   mode?: string,
 *   workspaceRoot?: string,
 *   readableRoots?: string[],
 *   networkAccess?: boolean,
 * }} [options]
 */
export function buildCodexSandboxPolicy({
  mode,
  workspaceRoot,
  readableRoots = [],
  networkAccess = false,
} = {}) {
  if (!Array.isArray(readableRoots)) {
    throw new CodexConfigurationError("readableRoots must be an array", "CODEX_READ_ROOTS_INVALID");
  }
  if (typeof networkAccess !== "boolean") {
    throw new CodexConfigurationError("networkAccess must be boolean", "CODEX_NETWORK_POLICY_INVALID");
  }
  const workspace = requireAbsoluteRoot(workspaceRoot, "workspaceRoot");
  if (readableRoots.length > 0) {
    throw new CodexConfigurationError(
      "Installed app-server schema cannot encode restricted readable roots",
      "CODEX_RESTRICTED_READ_SCOPE_UNSUPPORTED",
    );
  }

  if (mode === "DISCUSSION") {
    if (networkAccess) {
      throw new CodexConfigurationError(
        "DISCUSSION sandbox does not permit network access",
        "CODEX_DISCUSSION_NETWORK_FORBIDDEN",
      );
    }
    return Object.freeze({ type: "readOnly", networkAccess: false });
  }
  if (mode === "CODE_CHANGE") {
    return Object.freeze({
      type: "workspaceWrite",
      writableRoots: Object.freeze([workspace]),
      networkAccess,
    });
  }
  throw new CodexConfigurationError(
    `Unsupported Codex run mode: ${JSON.stringify(mode)}`,
    "CODEX_RUN_MODE_INVALID",
  );
}
