import { createHash } from "node:crypto";
import path from "node:path";
import { CodexConfigurationError } from "./errors.js";

export const CODEX_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
]);
export const CODEX_AUTH_PATH_ALLOWLIST = Object.freeze(["CODEX_HOME"]);

function readEnvironmentValue(sourceEnv, key, platform) {
  if (Object.hasOwn(sourceEnv, key)) return sourceEnv[key];
  if (platform !== "win32") return undefined;
  const actualKey = Object.keys(sourceEnv).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  return actualKey === undefined ? undefined : sourceEnv[actualKey];
}

function validateAuthPathKey(key) {
  if (typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new CodexConfigurationError(
      `Invalid explicitly configured auth-path environment key: ${JSON.stringify(key)}`,
      "CODEX_AUTH_PATH_KEY_INVALID",
    );
  }
  if (CODEX_ENV_ALLOWLIST.includes(key)) {
    throw new CodexConfigurationError(
      `${key} is a base environment key, not an auth-path key`,
      "CODEX_AUTH_PATH_KEY_DUPLICATE",
    );
  }
  if (!CODEX_AUTH_PATH_ALLOWLIST.includes(key)) {
    throw new CodexConfigurationError(
      `${key} is not an approved Codex authentication-path environment key`,
      "CODEX_AUTH_PATH_KEY_NOT_ALLOWED",
    );
  }
}

function snapshotHash(environment) {
  const hash = createHash("sha256");
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    hash.update(key, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(value), "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function createCodexChildEnvironment({
  sourceEnv = process.env,
  authPathKeys = [],
  platform = process.platform,
} = {}) {
  if (!sourceEnv || typeof sourceEnv !== "object" || Array.isArray(sourceEnv)) {
    throw new CodexConfigurationError(
      "sourceEnv must be an environment object",
      "CODEX_SOURCE_ENV_INVALID",
    );
  }
  if (!Array.isArray(authPathKeys)) {
    throw new CodexConfigurationError(
      "authPathKeys must be an array",
      "CODEX_AUTH_PATH_KEYS_INVALID",
    );
  }

  const uniqueAuthKeys = [...new Set(authPathKeys)];
  for (const key of uniqueAuthKeys) validateAuthPathKey(key);

  const env = Object.create(null);
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = readEnvironmentValue(sourceEnv, key, platform);
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  for (const key of uniqueAuthKeys) {
    const value = readEnvironmentValue(sourceEnv, key, platform);
    if (typeof value !== "string" || value === "") {
      throw new CodexConfigurationError(
        `Configured auth-path environment variable ${key} is missing`,
        "CODEX_AUTH_PATH_VALUE_MISSING",
        { key },
      );
    }
    if (!path.isAbsolute(value)) {
      throw new CodexConfigurationError(
        `Configured auth-path environment variable ${key} must contain an absolute path`,
        "CODEX_AUTH_PATH_VALUE_NOT_ABSOLUTE",
        { key },
      );
    }
    env[key] = value;
  }

  return Object.freeze({
    env: Object.freeze(env),
    keys: Object.freeze(Object.keys(env).sort()),
    snapshotSha256: snapshotHash(env),
  });
}
