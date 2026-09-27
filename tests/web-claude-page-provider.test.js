import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const registrySource = fs.readFileSync(new URL("../extension/runtime/page-provider-registry.js", import.meta.url), "utf8");
const claudeSource = fs.readFileSync(new URL("../extension/runtime/providers/claude-page.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

function loadClaudeProvider() {
  const context = { URL, WeakMap, Map, Object, TypeError, console, setTimeout, clearTimeout, DOMException };
  context.globalThis = context;
  vm.runInNewContext(registrySource, context, { filename:"page-provider-registry.js" });
  vm.runInNewContext(claudeSource, context, { filename:"claude-page.js" });
  return context.WebBridgePageProviders.provider("CLAUDE_WEB");
}

test("Claude page provider uses the strict /new and /chat/{id} URL contract", () => {
  const provider = loadClaudeProvider();
  assert.ok(provider);
  assert.equal(provider.rootUrl, "https://claude.ai/new");
  assert.equal(provider.canonicalizeUrl("https://claude.ai/new?x=1#y"), "https://claude.ai/new");
  assert.equal(provider.canonicalizeUrl("https://claude.ai/chat/abc/?x=1"), "https://claude.ai/chat/abc");
  assert.equal(provider.conversationIdFromUrl("https://claude.ai/chat/abc"), "abc");
  assert.equal(provider.conversationIdFromUrl("https://claude.ai/new"), null);
  assert.equal(provider.canonicalizeUrl("https://claude.ai/"), null);
  assert.equal(provider.canonicalizeUrl("https://claude.ai/settings"), null);
  assert.equal(provider.canonicalizeUrl("https://claude.ai/project/example"), null);
  assert.equal(provider.canonicalizeUrl("https://example.com/chat/abc"), null);
});

test("manifest loads the Claude page provider before shared content orchestration", () => {
  assert.ok(manifest.host_permissions.includes("https://claude.ai/*"));
  const script = manifest.content_scripts.find((entry) => entry.matches.includes("https://claude.ai/*"));
  assert.ok(script);
  const registryIndex = script.js.indexOf("runtime/page-provider-registry.js");
  const chatGptIndex = script.js.indexOf("runtime/providers/chatgpt-page.js");
  const claudeIndex = script.js.indexOf("runtime/providers/claude-page.js");
  const contentIndex = script.js.indexOf("content.js");
  assert.ok(registryIndex >= 0);
  assert.ok(chatGptIndex > registryIndex);
  assert.ok(claudeIndex > chatGptIndex);
  assert.ok(contentIndex > claudeIndex);
});

test("Claude adapter keeps mutation guarded and message identity element-scoped", () => {
  assert.ok(claudeSource.includes('[data-testid="chat-input"][contenteditable="true"]'));
  assert.ok(claudeSource.includes('[data-testid="user-message"]'));
  assert.ok(claudeSource.includes('.font-claude-response'));
  assert.ok(claudeSource.includes('button[aria-label="Send message"]'));
  assert.ok(claudeSource.includes("const ephemeralMessageIds = new WeakMap();"));
  assert.equal((claudeSource.match(/assertCanMutate\?\.\(\);/gu) ?? []).length, 2);
  assert.ok(claudeSource.includes('path !== "/new"'));
  assert.ok(claudeSource.includes('!/^\\/chat\\/[^/]+$/u.test(path)'));
});
