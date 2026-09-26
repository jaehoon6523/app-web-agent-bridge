import assert from "node:assert/strict";
import test from "node:test";

import { createConversationBootstrapTab, reopenExactConversationTab } from "../extension/runtime/conversation-bootstrap.js";
import { createWebTargetProviderRegistry, resolveWebTargetProvider } from "../extension/runtime/provider-target.js";

function providerFixture() {
  return Object.freeze({
    provider:"TEST_WEB",
    rootUrl:"https://example.test/",
    urlPatterns:Object.freeze(["https://example.test/*"]),
    canonicalize(value) {
      let url;
      try { url = new URL(value); } catch { return null; }
      if (url.protocol !== "https:" || url.hostname !== "example.test") return null;
      url.search = "";
      url.hash = "";
      url.username = "";
      url.password = "";
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
      return url.origin + path;
    },
    conversationIdFromUrl(value) {
      const canonical = this.canonicalize(value);
      if (!canonical) return null;
      const parts = new URL(canonical).pathname.split("/").filter(Boolean);
      return parts[0] === "chat" && parts[1] ? decodeURIComponent(parts[1]) : null;
    },
  });
}

test("provider resolver is fail-closed for unknown or mismatched providers", () => {
  const provider = providerFixture();
  const registry = createWebTargetProviderRegistry([provider]);
  assert.equal(resolveWebTargetProvider({ provider:"TEST_WEB", registry })?.provider, "TEST_WEB");
  assert.equal(resolveWebTargetProvider({ provider:"MISSING", registry }), null);
  assert.equal(resolveWebTargetProvider({
    provider:"TEST_WEB",
    conversationUrl:"https://other.test/chat/1",
    registry,
  }), null);
  assert.equal(resolveWebTargetProvider()?.provider, "CHATGPT_WEB");
});

test("bootstrap creates the supplied provider root instead of a hard-coded ChatGPT URL", async () => {
  const provider = providerFixture();
  const calls = [];
  const chromeApi = { tabs:{
    create:async(options) => { calls.push(options); return { id:41 }; },
    get:async(id) => ({ id, windowId:2, url:provider.rootUrl }),
  } };
  const tab = await createConversationBootstrapTab(chromeApi, async() => {}, provider);
  assert.equal(tab.url, provider.rootUrl);
  assert.deepEqual(calls, [{ url:provider.rootUrl, active:true }]);
});

test("exact conversation reopen validates with the supplied provider identity rules", async () => {
  const provider = providerFixture();
  const requested = {
    provider:"TEST_WEB",
    conversationUrl:"https://example.test/chat/abc",
    conversationId:"abc",
  };
  const chromeApi = { tabs:{
    create:async() => ({ id:7 }),
    get:async(id) => ({ id, windowId:1, url:requested.conversationUrl }),
  } };
  const tab = await reopenExactConversationTab(chromeApi, async() => {}, requested, provider);
  assert.equal(tab.url, requested.conversationUrl);
});
