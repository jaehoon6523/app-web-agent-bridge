import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as dashboardActionCapabilities from "../../public/dashboard-action-capabilities.js";
import * as dashboardConnectionState from "../../public/dashboard-connection-state.js";
import { externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState } from "../../public/dashboard-model.js";
import * as dashboardRunListKnowledge from "../../public/dashboard-run-list-knowledge.js";
import * as dashboardStartActions from "../../public/dashboard-start-actions.js";
import { renderProjectOverview } from "../../public/project-overview-view.js";
import { createRunActionLayout } from "../../public/run-action-layout.js";
import * as runContextView from "../../public/run-context-view.js";

function inlineModule(source) {
  const lines = [];
  let importing = false;
  for (const line of source.split(/\r?\n/u)) {
    if (!importing && /^\s*import\b/u.test(line)) {
      importing = !/;\s*$/u.test(line);
      continue;
    }
    if (importing) {
      if (/;\s*$/u.test(line)) importing = false;
      continue;
    }
    if (/^\s*export\s*\{/u.test(line)) continue;
    lines.push(line.replace(/^(\s*)export\s+/u, "$1"));
  }
  return lines.join("\n");
}

function withRunKnowledge(state) {
  if (!Array.isArray(state?.runs) || state.dataKnowledge != null) return state;
  return {
    ...state,
    dataKnowledge: { runs: { status: state.runs.length ? "AVAILABLE_NONEMPTY" : "AVAILABLE_EMPTY" } },
  };
}

export async function dashboard(state, mutate = async () => ({}), storage = new Map()) {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  const conversationSource = await readFile(new URL("../../public/conversation-view.js", import.meta.url), "utf8");
  const preparationSource = await readFile(new URL("../../public/preparation-view.js", import.meta.url), "utf8");
  const healthPresentationSource = await readFile(new URL("../../public/dashboard-health-presentation.js", import.meta.url), "utf8");
  const auditPresentationSource = await readFile(new URL("../../public/dashboard-audit-presentation.js", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../../public/dashboard-status-view.js", import.meta.url), "utf8");
  const elements = new Map(), all = [], calls = [];
  class Element {
    constructor(tagName = "") {
      this.tagName = String(tagName).toUpperCase();
      this.children = []; this.listeners = {}; this.dataset = {}; this.value = "";
      this.checked = false; this.hidden = false; this.textContent = ""; this.attributes = {};
      this.classList = {
        add: (...names) => { for (const name of names) this.className = `${this.className ?? ""} ${name}`.trim(); },
        remove: (...names) => { this.className = String(this.className ?? "").split(/\s+/u).filter((name) => !names.includes(name)).join(" "); },
        contains: (name) => String(this.className ?? "").split(/\s+/u).includes(name),
        toggle: (name, force) => {
          const included = force === undefined ? !this.classList.contains(name) : Boolean(force);
          this.classList[included ? "add" : "remove"](name);
          return included;
        },
      };
      all.push(this);
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    prepend(child) { if (!this.children.includes(child)) this.children.unshift(child); child.parentElement = this; }
    after(...siblings) {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      parent.children.splice(index + 1, 0, ...siblings);
      for (const sibling of siblings) sibling.parentElement = parent;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] ?? null;
    }
    querySelectorAll(selector) {
      const descendants = [];
      const visit = (element) => {
        for (const child of element.children) {
          if (selector.split(",").map(item => item.toUpperCase()).includes(child.tagName)) descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      return descendants;
    }
    querySelector(selector) {
      if (selector === "a[data-delivery-recovery]") return this.querySelectorAll("a")
        .find(element => Object.hasOwn(element.dataset, "deliveryRecovery")) ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    focus() {}
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    removeEventListener(key, callback) { if (this.listeners[key] === callback) delete this.listeners[key]; }
    contains() { return false; }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) { const element = new Element(); element.id = match[1]; }
  const context = vm.createContext({ location:{search:""},
    ...dashboardActionCapabilities,
    ...dashboardConnectionState,
    ...dashboardRunListKnowledge,
    ...dashboardStartActions,
    ...runContextView,
    externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState, renderProjectOverview, createRunActionLayout, Date, Map, Set, JSON, URL, URLSearchParams, Blob,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    crypto: { randomUUID: () => "request-1" },
    AbortSignal: { timeout: () => undefined }, setTimeout: () => {},
    window: { location: { origin:"http://127.0.0.1:8787", reload:() => {} } },
    document: {
      getElementById: (id) => elements.get(id),
      createElement: (tagName) => new Element(tagName), addEventListener() {},
      querySelectorAll: () => all.filter((element) => element.dataset.webCommand),
      querySelector: (selector) => [".session-recovery", ".preparation-tab-choice"].includes(selector)
        ? all.findLast(element => element.className === selector.slice(1)) ?? null : null,
    },
    fetch: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const body = url === "/api/dashboard/session" ? { token: "test" }
        : url.startsWith("/api/state") ? withRunKnowledge(state) : await mutate(url, options);
      return { ok: true, json: async () => body };
    },
  });
  const tabChoiceSource = await readFile(new URL("../../public/preparation-tab-choice.js", import.meta.url), "utf8");
  const executableSource = [
    inlineModule(tabChoiceSource),
    inlineModule(conversationSource),
    inlineModule(preparationSource),
    inlineModule(healthPresentationSource),
    inlineModule(auditPresentationSource),
    inlineModule(statusSource),
    inlineModule(source).replace(/\r?\n(?:void\s+)?poll\(\);\s*$/, ""),
  ].join("\n");
  vm.runInContext(executableSource, context);
  await vm.runInContext("refresh()", context);
  return { elements, calls, context, run: (code) => vm.runInContext(code, context) };
}
