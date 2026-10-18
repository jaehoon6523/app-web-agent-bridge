import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/server.js";

test("legacy proposal endpoints cannot bind, send, recover, or replace canonical preparation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-session-api-"));
  const token = "test-only-delivery-token-0123456789abcdef";
  let providerCalls = 0;
  const config = { host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0",
    persistence: { databasePath: path.join(directory, "controller.sqlite") },
    dashboard: { token }, webExtension: { sharedSecret: "test-only-delivery-secret-0123456789abcdef", expectedExtensionIdentity: "test-extension" },
    relay: { webResponseTimeoutMs: 500 } };
  const bridge = createBridgeServer({ runtimeConfig: config, createLiveRuntime: async () => { providerCalls++; throw new Error("Must not provision"); } });
  t.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const address = await bridge.listen(), base = "http://127.0.0.1:" + address.port;
  for (const route of ["/api/project/proposal", "/api/project/proposal/session"]) {
    const response = await fetch(base + route, { method: "POST",
      headers: { authorization: "Bearer " + token, origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ objective: "anything", action: "recover" }) });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "PREPARATION_API_REQUIRED");
  }
  assert.equal(providerCalls, 0);
});
