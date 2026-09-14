import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELECTOR_FILES = [
  "selector-version.js",
  "composer-selectors.js",
  "send-button-selectors.js",
  "stop-button-selectors.js",
  "message-selectors.js",
];

test("selector scripts build an ordered, versioned registry without orchestration dependencies", async () => {
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  for (const file of SELECTOR_FILES) {
    const source = await readFile(path.join(ROOT, "extension", "selectors", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  const registry = context.ChatGptBridgeSelectors;
  assert.match(registry.version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  for (const group of ["composer", "sendButton", "stopButton", "message", "messageContainer", "messageContent"]) {
    assert.ok(Array.isArray(registry.groups[group]));
    assert.ok(registry.groups[group].length > 0);
  }
  assert.equal(registry.groups.composer[0], "#prompt-textarea");
  assert.equal(registry.groups.sendButton[0], "button[data-testid='send-button']");
  assert.equal(registry.groups.message[0], "[data-testid^='conversation-turn-']");
  assert.ok(registry.groups.message.includes(".user-turn, .agent-turn, .assistant-turn"));
  const calls = [];
  const fallback = registry.resolveFirst("composer", (selector) => {
    calls.push(selector);
    return selector === registry.groups.composer[1] ? [{ id: "fallback" }] : [];
  });
  assert.equal(fallback.selector, registry.groups.composer[1]);
  assert.deepEqual(calls, [...registry.groups.composer].slice(0, 2));
  assert.equal(registry.resolveFirst("composer", () => []), null);
});

test("extension manifest targets chatgpt.com only and loads selectors before content logic", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, 5), SELECTOR_FILES.map((file) => `selectors/${file}`));
  assert.equal(manifest.content_scripts[0].js.at(-1), "content.js");
  const background = await readFile(path.join(ROOT, "extension", "background.js"), "utf8");
  assert.doesNotMatch(background, /chrome\.tabs\.create/);
  assert.doesNotMatch(background, /searchParams\.set/);
  assert.doesNotMatch(background, /controllerToken|selectedTabId/);
});
