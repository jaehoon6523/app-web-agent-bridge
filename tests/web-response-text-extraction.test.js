import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("assistant extraction selects the full response over a short matching child", () => {
  const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const start = source.indexOf("function elementText(element) {");
  const end = source.indexOf("\nfunction messageContainer(", start);
  assert.ok(start >= 0 && end > start);
  class HTMLElement {
    constructor(text = "") { this.innerText = text; this.textContent = text; }
  }
  const full = "판정\nCONTROLLER_PACKET_BEGIN\n{\"type\":\"REVIEW_ASSERTIONS\"}\nCONTROLLER_PACKET_END";
  const short = new HTMLElement("답");
  const long = new HTMLElement(full);
  const container = new HTMLElement(full);
  container.matches = () => false;
  container.querySelectorAll = (selector) => selector === ".markdown" ? [short, long] : [];
  const context = { HTMLElement, registry:{ groups:{ messageContent:[".markdown"] } }, selectorTelemetry:new Map() };
  vm.createContext(context);
  const extract = vm.runInContext(`(${source.slice(start, end)})`, context);
  assert.equal(extract(container), full);
  assert.equal(context.selectorTelemetry.get("messageContent"), ".markdown");
});
