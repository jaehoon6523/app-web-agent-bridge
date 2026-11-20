import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore, ArtifactStoreError } from "../src/evidence/artifact-store.js";
import {
  LocalAuthError,
  LocalSessionAuthenticator,
  isLoopbackHost,
} from "../src/security/local-auth.js";
import { REDACTED, redactForEvidence } from "../src/security/redaction.js";

test("redaction removes secret fields, authorization values, and configured paths", () => {
  const root = path.resolve(os.tmpdir(), "private-home");
  const input = {
    Authorization: "Bearer abc.def.ghi",
    nested: {
      apiKey: "super-secret",
      message: `password=hunter2 file=${root}${path.sep}repo`,
    },
  };
  const output = redactForEvidence(input, { sensitiveRoots: [root] });
  assert.equal(output.Authorization, REDACTED);
  assert.equal(output.nested.apiKey, REDACTED);
  assert.doesNotMatch(output.nested.message, /hunter2|private-home/u);
  assert.match(output.nested.message, /\[REDACTED\]|<REDACTED_PATH>/u);
  assert.equal(input.nested.apiKey, "super-secret");
});

test("artifact store is content-addressed and detects tampering", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  const store = new ArtifactStore(directory);
  const receipt = store.put("redacted output", { mimeType: "text/plain", redacted: true });
  assert.equal(receipt.size, Buffer.byteLength("redacted output"));
  assert.equal(receipt.redacted, true);
  assert.equal(store.read(receipt.sha256).toString("utf8"), "redacted output");
  assert.deepEqual(store.put("redacted output", { mimeType: "text/plain", redacted: true }), receipt);

  const filename = receipt.sha256.slice("sha256:".length);
  fs.writeFileSync(path.join(directory, filename), "tampered");
  assert.throws(
    () => store.verify(receipt.sha256),
    (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_HASH_MISMATCH",
  );
});

test("local mutation authentication requires both exact origin and bearer token", () => {
  const { token, authenticator } = LocalSessionAuthenticator.issue({
    allowedOrigins: ["http://127.0.0.1:8787", "http://localhost:8787"],
  });
  assert.equal(authenticator.verifyMutation({
    authorization: `Bearer ${token}`,
    origin: "http://127.0.0.1:8787",
  }), true);
  assert.throws(
    () => authenticator.verifyMutation({
      authorization: "Bearer incorrect-but-still-long-enough",
      origin: "http://127.0.0.1:8787",
    }),
    (error) => error instanceof LocalAuthError && error.code === "DASHBOARD_AUTH_INVALID",
  );
  assert.throws(
    () => authenticator.verifyMutation({
      authorization: `Bearer ${token}`,
      origin: "http://attacker.invalid",
    }),
    (error) => error instanceof LocalAuthError && error.statusCode === 403,
  );
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
