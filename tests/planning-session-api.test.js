import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeServer } from "../src/server.js";

test("legacy proposal endpoints cannot bind, send, recover, or replace canonical preparation", async (t) => {
  const token = "test-only-delivery-token-0123456789abcdef";
  let providerCalls = 0;
  const config = { host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0",
    dashboard: { token }, webExtension: { sharedSecret: "test-only-delivery-secret-0123456789abcdef", expectedExtensionIdentity: "test-extension" },
    relay: { webResponseTimeoutMs: 500 } };
  const bridge = createBridgeServer({ runtimeConfig: config, createLiveRuntime: async () => { providerCalls++; throw new Error("Must not provision"); } });
  t.after(() => bridge.close());
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
