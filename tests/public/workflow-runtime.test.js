import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { normalizeDashboardState } from "../../public/dashboard-model.js";

export async function dashboard(state, mutate = async () => ({})) {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
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
        toggle: () => {},
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
          if (selector === "p" && child.tagName === "P") descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      return descendants;
    }
    focus() {}
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    contains() { return false; }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) { const element = new Element(); element.id = match[1]; }
  const context = vm.createContext({
    normalizeDashboardState, Date, Map, Set, JSON, URL, Blob, crypto: { randomUUID: () => "request-1" },
    AbortSignal: { timeout: () => undefined }, setTimeout: () => {},
    document: {
      getElementById: (id) => elements.get(id),
      createElement: (tagName) => new Element(tagName), addEventListener() {},
      querySelectorAll: () => all.filter((element) => element.dataset.webCommand),
      querySelector: (selector) => selector === ".session-recovery" ? all.findLast(element => element.className === "session-recovery") ?? null : null,
    },
    fetch: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const body = url === "/api/dashboard/session" ? { token: "test" }
        : url.startsWith("/api/state") ? state : await mutate(url, options);
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/, "").replace(/\r?\npoll\(\);\s*$/, ""), context);
  await vm.runInContext("refresh()", context);
  return { elements, calls, context, run: (code) => vm.runInContext(code, context) };
}
function prepared() {
  return {
    workflow: { stage: "PREPARE", state: "DISCUSSING", preparationId: "p1", preparationVersion: 3 },
    preparation: {
      preparationId: "p1", version: 3, objective: "  아무거나\n", targetRoot: "C:/project",
      agreement: { status: "DISCUSSING", summary: "어떤 기능이 필요한가요?", unresolvedQuestions: ["원하는 기능?"], requirements: [] },
      discussion: [{ turnId: "t1", preparationId: "p1", sequence: 1, actor: "USER", content: "아무거나" }],
      webSession: { sessionId: "s1", conversationId: "c1", conversationUrl: "https://chatgpt.com/c/c1", activeDeliveryId: "d1" },
    },
    runs: [], run: null, preflight: { checks: { extensionAuthenticated: true } }, commandCapabilities: ["preparation.reply", "web.reconcile"],
  };
}
test("refresh restores preparation and questions, and reply retains preparation identity", async () => {
  const ui = await dashboard(prepared());
  assert.equal(ui.elements.get("projectPanel").hidden, false);
  assert.equal(ui.elements.get("startPanel").hidden, true);
  assert.equal(ui.elements.get("planningObjective").value, "  아무거나\n");
  assert.equal(ui.elements.get("reviseRequirements").disabled, false);
  assert.equal(ui.elements.get("saveProject").disabled, true);
  ui.elements.get("proposalFeedback").value = "채팅";
  await ui.elements.get("reviseRequirements").listeners.click();
  const mutation = ui.calls.find((call) => call.url.endsWith("/reply"));
  assert.deepEqual(mutation, { url: "/api/preparations/p1/reply", body: { content: "채팅", requestId: "request-1", expectedVersion: 3 } });
});
test("reconcile sends exact identity and never follows with a proposal", async () => {
  const ui = await dashboard(prepared());
  await ui.run('webSessionCommand("web.reconcile")');
  const calls = ui.calls.filter((call) => call.url === "/api/preparations/web");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sessionId, "s1");
  assert.equal(calls[0].body.deliveryId, "d1");
  assert.equal(calls[0].body.preparationId, "p1");
  assert.equal(ui.calls.some((call) => call.url.includes("proposal")), false);
});
test("timeout inspects request outcome and prevents duplicate reply", async () => {
  const ui = await dashboard(prepared(), async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); });
  ui.elements.get("proposalFeedback").value = "채팅";
  await ui.elements.get("reviseRequirements").listeners.click();
  await ui.elements.get("reviseRequirements").listeners.click();
  assert.equal(ui.calls.filter((call) => call.url.endsWith("/reply")).length, 1);
  assert.ok(ui.calls.some((call) => call.url === "/api/state?requestId=request-1"));
  assert.equal(ui.elements.get("reviseRequirements").disabled, true);
});
test("missing server workflow fails closed without constructing a preparation", async () => {
  const ui = await dashboard({ runs: [], preflight: {}, commandCapabilities: ["preparation.start"] });
  assert.equal(ui.elements.get("planRun").disabled, true);
  assert.match(ui.elements.get("connectionNotice").textContent, /WORKFLOW_CONTRACT/);
});
test("approval is a single mutation carrying the canonical version", async () => {
  const state = prepared();
  state.workflow.state = "AGREEMENT_READY";
  state.commandCapabilities = ["preparation.approve"];
  const ui = await dashboard(state);
  await ui.elements.get("projectForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(ui.calls.filter((call) => call.url.startsWith("/api/preparations")), [
    { url: "/api/preparations/p1/approve", body: { requestId: "request-1", expectedVersion: 3 } },
  ]);
});

for (const [stage, state] of [["START", "START_IDLE"], ["WORK", "WORKER_RUNNING"],
  ["RESULT", "HOLD"], ["RESULT", "AWAITING_APPLY"]]) {
  test(`fresh UI restores ${stage}/${state} using only the server snapshot`, async () => {
    const run = stage === "START" ? null : { runId: "r1", version: 7, phase: state, objective: "테스트 작업" };
    const snapshot = { workflow: { stage, state, runId: run?.runId ?? null, runVersion: run?.version ?? null },
      preparation: null, run, runs: run ? [run] : [], preflight: {}, commandCapabilities: [] };
    // Each load has a new VM and no retained selection, draft or local storage.
    for (let load = 0; load < 2; load++) {
      const ui = await dashboard(snapshot);
      assert.equal(ui.elements.get("connectionNotice").textContent, "");
      assert.equal(ui.elements.get("startPanel").hidden, stage !== "START");
      assert.equal(ui.elements.get("projectPanel").hidden, true);
      assert.equal(ui.elements.get("runPanel").hidden, stage === "START");
      const step = { START: "stepStart", WORK: "stepWork", RESULT: "stepResult" }[stage];
      assert.equal(ui.elements.get(step).attributes["aria-current"], "step");
      assert.deepEqual(ui.calls.map((call) => call.url), ["/api/dashboard/session", "/api/state"]);
    }
  });
}
