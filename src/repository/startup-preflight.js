import { stat } from "node:fs/promises";
import { isLoopbackHost } from "../security/local-auth.js";
import { SQLITE_SCHEMA_VERSION } from "../persistence/schema.js";
import { verifyPinnedExecutable } from "../runtime/codex/executable.js";

export const MINIMUM_NODE_VERSION = Object.freeze({ major: 22, minor: 5, patch: 0 });

export class StartupPreflightError extends Error {
  constructor(failures, checks) {
    super(`Startup preflight failed (${failures.length} check(s))`);
    this.name = "StartupPreflightError";
    this.code = "STARTUP_PREFLIGHT_FAILED";
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    this.checks = Object.freeze(checks.map((check) => Object.freeze({ ...check })));
  }
}

function parseNodeVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

export function isSupportedNodeVersion(
  value,
  minimum = MINIMUM_NODE_VERSION,
) {
  const parsed = parseNodeVersion(value);
  if (!parsed) return false;
  for (const key of ["major", "minor", "patch"]) {
    if (parsed[key] > minimum[key]) return true;
    if (parsed[key] < minimum[key]) return false;
  }
  return true;
}

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(check, error, fallbackCode, message) {
  const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
    ? error.code
    : fallbackCode;
  return {
    check,
    code: errorCode,
    message,
  };
}

async function openDefaultStore(filename) {
  const { SqliteStore } = await import("../persistence/sqlite-store.js");
  return new SqliteStore(filename);
}

function result(check, ok, detail = undefined) {
  return detail === undefined ? { check, ok } : { check, ok, detail };
}

function requireOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("startup preflight options must be an object");
  }
  return value;
}

export async function runStartupPreflight(options) {
  requireOptions(options);
  const checks = [];
  const failures = [];

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeOk = isSupportedNodeVersion(nodeVersion);
  checks.push(result("node_version", nodeOk, {
    minimum: `${MINIMUM_NODE_VERSION.major}.${MINIMUM_NODE_VERSION.minor}.${MINIMUM_NODE_VERSION.patch}`,
    observed: typeof nodeVersion === "string" ? nodeVersion : "INVALID",
  }));
  if (!nodeOk) {
    failures.push({
      check: "node_version",
      code: "NODE_VERSION_UNSUPPORTED",
      message: "Node.js 22.5.0 or newer is required",
    });
  }

  const hostOk = isLoopbackHost(options.host);
  checks.push(result("loopback_host", hostOk));
  if (!hostOk) {
    failures.push({
      check: "loopback_host",
      code: "NON_LOOPBACK_HOST_REJECTED",
      message: "Controller host must be a loopback host",
    });
  }

  try {
    if (typeof options.workspace !== "string" || options.workspace.length === 0) {
      throw new TypeError("workspace must be a non-empty path");
    }
    const workspaceStat = await stat(options.workspace);
    if (!workspaceStat.isDirectory()) {
      const error = /** @type {Error & {code?: string}} */ (
        new Error("Configured workspace is not a directory")
      );
      error.code = "WORKSPACE_NOT_DIRECTORY";
      throw error;
    }
    checks.push(result("workspace_directory", true));
  } catch (error) {
    checks.push(result("workspace_directory", false));
    failures.push(failure(
      "workspace_directory",
      error,
      "WORKSPACE_UNAVAILABLE",
      "Configured workspace is unavailable or is not a directory",
    ));
  }

  const extensionConfig = options.extensionConfig;
  const extensionSecretPresent = configured(extensionConfig?.sharedSecret);
  const extensionIdentityPresent = configured(extensionConfig?.expectedExtensionIdentity);
  const extensionOk = extensionSecretPresent && extensionIdentityPresent;
  checks.push(result("extension_configuration", extensionOk, {
    sharedSecretPresent: extensionSecretPresent,
    expectedIdentityPresent: extensionIdentityPresent,
  }));
  if (!extensionOk) {
    failures.push({
      check: "extension_configuration",
      code: "EXTENSION_CONFIGURATION_MISSING",
      message: "Extension shared secret and expected identity are required",
    });
  }

  try {
    if (options.codexPin === null || typeof options.codexPin !== "object") {
      const error = /** @type {Error & {code?: string}} */ (
        new Error("Pinned Codex executable metadata is required")
      );
      error.code = "CODEX_EXECUTABLE_PIN_MISSING";
      throw error;
    }
    const verifier = options.verifyCodexExecutable ?? verifyPinnedExecutable;
    if (typeof verifier !== "function") {
      throw new TypeError("verifyCodexExecutable must be a function");
    }
    const verified = await verifier(options.codexPin);
    if (verified !== true) {
      const error = /** @type {Error & {code?: string}} */ (
        new Error("Pinned Codex executable verifier did not confirm integrity")
      );
      error.code = "CODEX_EXECUTABLE_NOT_VERIFIED";
      throw error;
    }
    checks.push(result("codex_executable_pin", true));
  } catch (error) {
    checks.push(result("codex_executable_pin", false));
    failures.push(failure(
      "codex_executable_pin",
      error,
      "CODEX_EXECUTABLE_VERIFICATION_FAILED",
      "Pinned Codex executable integrity could not be verified",
    ));
  }

  try {
    if (typeof options.databaseFilename !== "string" || options.databaseFilename.length === 0) {
      throw new TypeError("databaseFilename must be a non-empty path");
    }
    const openStore = options.openStore ?? openDefaultStore;
    if (typeof openStore !== "function") throw new TypeError("openStore must be a function");
    const store = await openStore(options.databaseFilename);
    try {
      if (store === null || typeof store !== "object" || typeof store.close !== "function") {
        throw new TypeError("openStore must return a closable store");
      }
      if (store.schemaVersion !== SQLITE_SCHEMA_VERSION) {
        const error = /** @type {Error & {code?: string}} */ (
          new Error("SQLite schema version does not match the current repository schema")
        );
        error.code = "SQLITE_SCHEMA_VERSION_MISMATCH";
        throw error;
      }
      checks.push(result("sqlite_store", true, { schemaVersion: store.schemaVersion }));
    } finally {
      if (store && typeof store.close === "function") await store.close();
    }
  } catch (error) {
    checks.push(result("sqlite_store", false));
    failures.push(failure(
      "sqlite_store",
      error,
      "SQLITE_STORE_UNAVAILABLE",
      "SQLite store or current schema is unavailable",
    ));
  }

  if (failures.length > 0) throw new StartupPreflightError(failures, checks);
  return Object.freeze({
    ok: true,
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
  });
}
