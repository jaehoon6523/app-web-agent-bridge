import assert from "node:assert/strict";
import test from "node:test";

import {
  CHATGPT_WEB_PROVIDER,
  canonicalWebConversationUrl,
  createWebConversationProviderRegistry,
  extractWebConversationId,
  isWebProviderRootUrl,
  webConversationProviderForUrl,
} from "../src/runtime/web/provider-registry.js";
import {
  canonicalChatGptUrl,
  conversationIdFromUrl,
  createWebTargetProviderRegistry,
} from "../extension/runtime/conversation.js";

test("default Web provider registry preserves the existing ChatGPT URL contract", () => {
  assert.equal(canonicalWebConversationUrl("https://chatgpt.com/c/example/?x=1#part"),
    "https://chatgpt.com/c/example");
  assert.equal(extractWebConversationId("https://chatgpt.com/uc/example"), "example");
  assert.equal(extractWebConversationId("https://chatgpt.com/c/WEB:temporary"), null);
  assert.equal(isWebProviderRootUrl("https://chatgpt.com/"), true);
  assert.equal(webConversationProviderForUrl("https://chatgpt.com/c/example")?.provider, "CHATGPT_WEB");
  assert.equal(canonicalChatGptUrl("https://chatgpt.com/c/example/?x=1"), "https://chatgpt.com/c/example");
  assert.equal(conversationIdFromUrl("https://chatgpt.com/c/example"), "example");
});

test("provider registries accept a distinct future provider without weakening unknown-host rejection", () => {
  const testProvider = Object.freeze({
    provider:"TEST_WEB",
    rootUrl:"https://example.test/",
    urlPatterns:Object.freeze(["https://example.test/*"]),
    canonicalize(value) {
      let url;
      try { url = new URL(value); } catch { return null; }
      if (url.protocol !== "https:" || url.hostname !== "example.test") return null;
      url.search = ""; url.hash = ""; url.username = ""; url.password = "";
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
      return `${url.origin}${path}`;
    },
    conversationIdFromUrl(value) {
      const canonical = this.canonicalize(value);
      if (!canonical) return null;
      const parts = new URL(canonical).pathname.split("/").filter(Boolean);
      return parts[0] === "chat" && parts[1] ? decodeURIComponent(parts[1]) : null;
    },
  });

  const controllerRegistry = createWebConversationProviderRegistry([
    CHATGPT_WEB_PROVIDER,
    testProvider,
  ]);
  assert.equal(controllerRegistry.providerForUrl("https://example.test/chat/abc")?.provider, "TEST_WEB");
  assert.equal(controllerRegistry.canonicalize("https://example.test/chat/abc/?q=1"), "https://example.test/chat/abc");
  assert.equal(controllerRegistry.conversationIdFromUrl("https://example.test/chat/abc"), "abc");
  assert.equal(controllerRegistry.providerForUrl("https://unknown.test/chat/abc"), null);

  const extensionRegistry = createWebTargetProviderRegistry([testProvider]);
  assert.equal(extensionRegistry.providerForUrl("https://example.test/chat/abc")?.provider, "TEST_WEB");
  assert.equal(extensionRegistry.conversationIdFromUrl("https://example.test/chat/abc"), "abc");
  assert.equal(extensionRegistry.providerForUrl("https://unknown.test/chat/abc"), null);
});
