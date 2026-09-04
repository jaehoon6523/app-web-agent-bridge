import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { isLoopbackHost } from "./security/local-auth.js";
import { requireStrongSharedSecret } from "./security/shared-secret.js";

dotenv.config({ quiet: true });

function integer(env, name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false. Received: ${raw}`);
}

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required outside demo mode.`);
  }
  return value.trim();
}

function optionalStrongToken(env, name) {
  const value = env[name];
  if (value === undefined || value.trim() === "") return null;
  const token = requireStrongSharedSecret(value.trim(), name);
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error(`${name} must use base64url-safe characters only.`);
  }
  return token;
}

export function loadConfig({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const host = env.HOST || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("HOST must be a loopback address; remote binding is not supported.");
  }
  const port = integer(env, "PORT", 8787, { min: 1, max: 65535 });
  const workspace = path.resolve(cwd, env.WORKSPACE || ".");
  const dataDirectory = path.resolve(workspace, env.CONTROLLER_DATA_DIR || ".agent-controller");
  const demoMode = boolean(env, "DEMO_MODE", false);
  const sharedSecret = demoMode
    ? (env.WEB_EXTENSION_SHARED_SECRET?.trim() || null)
    : requireStrongSharedSecret(
      requiredString(env, "WEB_EXTENSION_SHARED_SECRET"),
      "WEB_EXTENSION_SHARED_SECRET",
    );

  return Object.freeze({
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    workspace,
    persistence: Object.freeze({
      databasePath: path.join(dataDirectory, "controller.sqlite"),
      artifactDirectory: path.join(dataDirectory, "artifacts"),
    }),
    codex: Object.freeze({
      executablePath: typeof env.CODEX_EXECUTABLE === "string" && env.CODEX_EXECUTABLE.trim() !== ""
        ? path.resolve(env.CODEX_EXECUTABLE.trim())
        : null,
      authPathKeys: env.CODEX_HOME?.trim() ? Object.freeze(["CODEX_HOME"]) : Object.freeze([]),
      approvalPolicy: "untrusted",
    }),
    dashboard: Object.freeze({
      token: optionalStrongToken(env, "DASHBOARD_TOKEN"),
    }),
    demoMode,
    webExtension: Object.freeze({
      sharedSecret,
      expectedExtensionIdentity: demoMode
        ? (env.WEB_EXTENSION_EXPECTED_IDENTITY?.trim() || null)
        : requiredString(env, "WEB_EXTENSION_EXPECTED_IDENTITY"),
    }),
    relay: Object.freeze({
      webResponseTimeoutMs: integer(env, "WEB_RESPONSE_TIMEOUT_MS", 300_000, { min: 10_000 }),
    }),
  });
}
