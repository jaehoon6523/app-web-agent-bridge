import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("assistant extraction selects the full response over a short matching child", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("runtime/response-text.js") >= 0);
  assert.ok(scripts.indexOf("runtime/response-text.js") < scripts.indexOf("content.js"));
  const source = readFileSync(new URL("../extension/runtime/response-text.js", import.meta.url), "utf8");
  class HTMLElement {
    constructor(text = "") { this.innerText = text; this.textContent = text; }
  }
  const full = "판정\nCONTROLLER_PACKET_BEGIN\n{\"type\":\"REVIEW_ASSERTIONS\"}\nCONTROLLER_PACKET_END";
  const short = new HTMLElement("답");
  const long = new HTMLElement(full);
  const container = new HTMLElement(full);
  container.matches = () => false;
  container.querySelectorAll = (selector) => selector === ".markdown" ? [short, long] : [];
  const context = { HTMLElement, selectorTelemetry:new Map() };
  vm.createContext(context);
  vm.runInContext(source, context, { filename:"extension/runtime/response-text.js" });
  assert.equal(context.ChatGptBridgeResponseText.elementText(container, [".markdown"], context.selectorTelemetry), full);
  assert.equal(context.selectorTelemetry.get("messageContent"), ".markdown");
  container.querySelectorAll = () => [short];
  assert.equal(context.ChatGptBridgeResponseText.elementText(container, [".markdown"], context.selectorTelemetry), full);
  assert.equal(context.selectorTelemetry.get("messageContent"), "messageContainer:packet");
});
