import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isSupportedNodeVersion,
  runStartupPreflight,
  StartupPreflightError,
} from "../src/repository/startup-preflight.js";

function tempDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-bridge-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Node version support starts at 22.5.0", () => {
  assert.equal(isSupportedNodeVersion("22.4.99"), false);
  assert.equal(isSupportedNodeVersion("v22.5.0"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
  assert.equal(isSupportedNodeVersion("not-a-version"), false);
});

test("startup preflight verifies workspace, SQLite schema, extension configuration, and Codex pin", async (t) => {
  const workspace = tempDirectory(t);
  const seenPins = [];
  const output = await runStartupPreflight({
    nodeVersion: "22.5.0",
    host: "127.0.0.1",
    workspace,
    databaseFilename: path.join(workspace, "controller.sqlite"),
    codexPin: { path: "opaque", sha256: "opaque" },
    verifyCodexExecutable: async (pin) => {
      seenPins.push(pin);
      return true;
    },
    extensionConfig: {
      sharedSecret: "must-not-appear-in-result",
      expectedExtensionIdentity: "extension-identity",
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.checks.every((check) => check.ok), true);
  assert.deepEqual(seenPins, [{ path: "opaque", sha256: "opaque" }]);
  assert.doesNotMatch(JSON.stringify(output), /must-not-appear|extension-identity/u);
  assert.deepEqual(
    output.checks.find((check) => check.check === "sqlite_store")?.detail,
    { schemaVersion: 5 },
  );
});

test("startup preflight aggregates failures without exposing extension secrets", async (t) => {
  const workspace = tempDirectory(t);
  const secret = "very-sensitive-extension-secret";
  await assert.rejects(
    runStartupPreflight({
      nodeVersion: "20.0.0",
      host: "0.0.0.0",
      workspace: path.join(workspace, "missing"),
      databaseFilename: "",
      codexPin: null,
      extensionConfig: { sharedSecret: secret, expectedExtensionIdentity: "" },
    }),
    (error) => {
      assert.equal(error instanceof StartupPreflightError, true);
      assert.deepEqual(
        new Set(error.failures.map((item) => item.code)),
        new Set([
          "NODE_VERSION_UNSUPPORTED",
          "NON_LOOPBACK_HOST_REJECTED",
          "ENOENT",
          "EXTENSION_CONFIGURATION_MISSING",
          "CODEX_EXECUTABLE_PIN_MISSING",
          "SQLITE_STORE_UNAVAILABLE",
        ]),
      );
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, "u"));
      assert.doesNotMatch(JSON.stringify(error), /agent-bridge-preflight/u);
      return true;
    },
  );
});
