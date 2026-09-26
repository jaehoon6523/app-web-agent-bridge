import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState } from "../../public/dashboard-model.js";
import { workflowForRun } from "../../src/orchestration/preparation-service.js";

export async function dashboard(state, mutate = async () => ({}), storage = new Map()) {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  const conversationSource = await readFile(new URL("../../public/conversation-view.js", import.meta.url), "utf8");
  const preparationSource = await readFile(new URL("../../public/preparation-view.js", import.meta.url), "utf8");
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
          if (selector.toUpperCase() === child.tagName) descendants.push(child);
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
    externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState, Date, Map, Set, JSON, URL, Blob,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    crypto: { randomUUID: () => "request-1" },
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
  vm.runInContext(conversationSource.replace("export function", "function") + preparationSource.replace("export function", "function") + source.replace(/^(?:import .*;\r?\n)+/, "").replace(/\r?\npoll\(\);\s*$/, ""), context);
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
function renderedText(element) {
  return [element?.textContent ?? "", ...(element?.children ?? []).map(renderedText)].join("\n");
}
test("task conversation attributes each turn to its role and reviewed candidate after reopening", async () => {
  const run = { runId:"r1", version:3, phase:"AWAITING_APPLY", objective:"Greeting", candidate:{ candidateId:"candidate-2" },
    preparationSnapshot:{ preparationId:"prep-1", discussion:[
      { actor:"USER", content:"인사말을 보여줘", createdAt:"2026-01-01T00:00:00Z" },
      { actor:"WEB_DESIGNER", content:"인사말 요구사항", createdAt:"2026-01-01T00:01:00Z" },
    ] },
    messages:[
      { fromActor:"CODE_WORKER", content:JSON.stringify({ summary:"구현했다고 보고함" }), candidateId:"candidate-2", createdAt:"2026-01-01T00:02:00Z" },
      { messageId:"judge-1", fromActor:"CHATGPT_WEB_AGENT", role:"JUDGE", content:"근거 확인 요청", createdAt:"2026-01-01T00:03:00Z" },
      { messageId:"critic-1", fromActor:"CHATGPT_WEB_AGENT", role:"CRITIC", content:"반례 확인", createdAt:"2026-01-01T00:04:00Z" },
    ], requests:[
      { requestId:"judge-1", phase:"ROUND0", candidateId:"candidate-2", auditManifestHash:"manifest-2" },
      { requestId:"critic-1", phase:"ROUND1", candidateId:"candidate-2", auditManifestHash:"manifest-2" },
    ], userDecisions:[{ at:"2026-01-01T00:05:00Z", candidateId:"candidate-2", responses:[{ requestItemId:"q1", answer:"이 문구입니다" }] }],
    reviews:[{ decision:"PASS", candidateId:"candidate-2", auditManifestHash:"manifest-2", createdAt:"2026-01-01T00:06:00Z" }],
  };
  const state = { workflow:workflowForRun(run), run, runs:[run], commandCapabilities:[], preflight:{ checks:{} } };
  const ui = await dashboard(state);
  const cards = ui.elements.get("conversationTimeline").children;
  assert.deepEqual(cards.map((card) => card.children[0].textContent),
    ["사용자 · 요구사항", "웹 설계자 · 요구사항", "구현자 보고", "Judge 의견", "Critic 의견", "사용자 답변", "감사 판정"]);
  assert.match(renderedText(cards[3]), /ROUND0 · 후보 candidate-2 · 감사 기준 manifest-2/u);
  assert.match(renderedText(cards[4]), /ROUND1 · 후보 candidate-2/u);
  assert.match(renderedText(cards[5]), /질문 q1/u);
  assert.match(renderedText(cards[6]), /판정: PASS/u);
  assert.doesNotMatch(renderedText(cards[2]), /판정: PASS/u);
  ui.elements.get("showAudit").listeners.click();
  assert.equal(ui.elements.get("conversationPanel").hidden, true);
  assert.equal(ui.elements.get("auditPanel").hidden, false);
  ui.elements.get("showConversation").listeners.click();
  assert.equal(ui.elements.get("conversationPanel").hidden, false);
});

test("implementation intervention sends only bounded guidance and keeps requirement changes outside the active run", async () => {
  const run = { runId:"worker-live", version:4, phase:"WORKER_RUNNING", objective:"Greeting",
    workerTurnId:"turn-1", projectRef:{ targetRoot:"C:/project" } };
  const state = { workflow:workflowForRun(run), run, runs:[run], commandCapabilities:["code.worker.intervene","run.stop"],
    workerRuntime:{ turnId:"turn-1" }, preflight:{ checks:{ extensionAuthenticated:true } } };
  const ui = await dashboard(state, async () => ({ payload:{ status:"DELIVERED", interventionId:"intervention-1", turnId:"turn-1" } }));
  assert.equal(ui.elements.get("workerInterventionPanel").hidden, false);
  assert.equal(ui.elements.get("workerInterventionKind").value, "GUIDANCE");
  assert.equal(ui.elements.get("sendWorkerIntervention").disabled, true);

  ui.elements.get("workerInterventionText").value = "Reuse the existing helper before adding another one.";
  ui.elements.get("workerInterventionText").listeners.input();
  assert.equal(ui.elements.get("sendWorkerIntervention").disabled, false);
  await ui.elements.get("sendWorkerIntervention").listeners.click();
  const mutation = ui.calls.find((call) => call.url === "/api/commands" && call.body.type === "code.worker.intervene");
  assert.deepEqual(mutation.body.payload, { runId:"worker-live", expectedVersion:4, turnId:"turn-1", kind:"GUIDANCE",
    text:"Reuse the existing helper before adding another one." });
  assert.equal(ui.elements.get("workerInterventionText").value, "");

  const commandCount = ui.calls.filter((call) => call.url === "/api/commands").length;
  ui.elements.get("workerInterventionKind").value = "REQUIREMENTS_CHANGE";
  ui.elements.get("workerInterventionKind").listeners.change();
  ui.elements.get("workerInterventionText").value = "Also add account settings.";
  ui.elements.get("workerInterventionText").listeners.input();
  assert.equal(ui.elements.get("sendWorkerIntervention").disabled, true);
  assert.match(ui.elements.get("workerInterventionStatus").textContent, /새 작업에서 다시 합의·승인/u);
  await ui.elements.get("sendWorkerIntervention").listeners.click();
  assert.equal(ui.calls.filter((call) => call.url === "/api/commands").length, commandCount);
});

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
  assert.deepEqual(mutation, { url: "/api/preparations/p1/reply", body: { content: "채팅", requestId: "request-1" } });
});
test("refresh restores the completed root action trace without an active delivery pointer", async () => {
  const state = prepared();
  state.preparation.webSession = {
    sessionId: "s-root", conversationId: "created", conversationUrl: "https://chatgpt.com/c/created",
    activeDeliveryId: null, bindingState: "BOUND", tabId: 8, windowId: 1,
    documentId: "document-root", frameId: 0,
  };
  state.preparation.diagnostics = { exactConversation: true, tabId: 8, pageReachable: true };
  state.preparation.deliveries = [{
    commandRequestId: "command-start", deliveryId: "delivery-root", preparationId: "p1", sessionId: "s-root",
    state: "ACKNOWLEDGED", processingState: "COMPLETE", validation: { status: "CONFIRMED", checks: [] },
    trace: { requestId: "delivery-root", actionId: "delivery-root", bindingId: "s-root:p1",
      tabId: 8, documentId: "document-root", frameId: 0, result: "success" },
  }];
  for (let load = 0; load < 2; load++) {
    const ui = await dashboard(state);
    const output = renderedText(ui.elements.get("preparationDiagnosticsBody"));
    assert.match(output, /command-start/);
    assert.match(output, /document-root/);
    assert.match(output, /"result": "success"/);
    assert.match(output, /응답 처리 완료/u);
  }
});
test("a stored response stays visibly unfinished while acknowledgement is pending", async () => {
  const state = prepared();
  state.preparation.diagnostics = { exactConversation: true, canRecover: true, tabId: 8, pageReachable: true };
  state.preparation.deliveries = [{
    deliveryId: "d1", preparationId: "p1", sessionId: "s1", state: "RESPONSE_COMPLETED",
    processingState: "ACK_PENDING", response: { rawText: "stored raw response", packet: { type: "REQUIREMENTS_PROPOSAL", questions: [], items: [] } },
    validation: { status: "CONFIRMED", checks: [] },
  }];
  const ui = await dashboard(state);
  const output = renderedText(ui.elements.get("preparationDiagnosticsBody"));
  assert.match(output, /응답 검증·저장 완료 · 전송 정리 확인 필요/u);
  assert.doesNotMatch(output, /응답 처리 완료 · 성공 trace 보존됨/u);
  assert.doesNotMatch(output, /응답 수신·전송 종료 확인됨/u);
  assert.match(output, /raw 응답/u);
  assert.match(output, /stored raw response/u);
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
test("ambiguous preparation renders eligible ChatGPT tabs and sends the selected tab identity", async () => {
  const state = prepared();
  state.workflow.state = "WEB_BLOCKED";
  state.preparation.state = "WEB_BLOCKED";
  state.preparation.deliveries = [{ deliveryId:"d1", sessionId:"s1", conversationId:"c1", state:"FAILED" }];
  state.preparation.webSession.activeDeliveryId = "d1";
  state.preparation.error = { code:"WEB_TAB_SELECTION_REQUIRED", message:"Select a tab.", details:{
    browserDispatchStarted:false,
    candidates:[
      { tabId:11, windowId:1, url:"https://chatgpt.com/c/c1" },
      { tabId:12, windowId:2, url:"https://chatgpt.com/c/c1" },
    ],
  } };
  state.commandCapabilities = ["web.rebind", "web.inspect", "preparation.cancel"];
  const ui = await dashboard(state, async () => ({}));
  const buttons = ui.run('document.querySelectorAll("[data-web-command]").filter((button) => button.dataset.webCommand === "web.rebind")');
  assert.equal(buttons.length, 2);
  await buttons[1].listeners.click();
  const call = ui.calls.find((item) => item.url === "/api/preparations/web");
  assert.equal(call.body.command, "web.rebind");
  assert.equal(call.body.selectedTabId, 12);
  assert.equal(call.body.sessionId, "s1");
  assert.equal(call.body.deliveryId, "d1");
});
test("approval is a single mutation carrying the canonical version", async () => {
  const state = prepared();
  state.workflow.state = "AGREEMENT_READY";
  state.commandCapabilities = ["preparation.approve"];
  const ui = await dashboard(state);
  await ui.elements.get("projectForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(ui.calls.filter((call) => call.url.startsWith("/api/preparations")), [
    { url: "/api/preparations/p1/approve", body: { requestId: "request-1" } },
  ]);
});
test("blank conversation URL starts at the ChatGPT root and keeps automatic approval intent", async () => {
  const state = { workflow: { stage: "START", state: "START_IDLE" }, preparation: null,
    run: null, runs: [], preflight: { checks: { extensionAuthenticated: true } },
    commandCapabilities: ["preparation.start"] };
  const ui = await dashboard(state);
  ui.elements.get("objective").value = "Make a page";
  ui.elements.get("startRoot").value = "C:/project";
  ui.elements.get("autoApprovePreparation").checked = true;
  await ui.run("beginPreparation()");
  assert.deepEqual(ui.calls.find((call) => call.url === "/api/preparations").body, {
    objective: "Make a page", targetRoot: "C:/project", conversationUrl: "https://chatgpt.com/",
    autoApproveOnReady: true, reuseProjectConversation:false, requestId: "request-1",
  });
});
test("a saved project conversation is selected for the same folder and can be explicitly replaced", async () => {
  const state = { workflow:{ stage:"START", state:"START_IDLE" }, preparation:null, run:null, runs:[],
    preflight:{ checks:{ extensionAuthenticated:true } }, commandCapabilities:["preparation.start"],
    projectConversations:[{ targetRoot:"C:/project", conversationUrl:"https://chatgpt.com/c/project-thread",
      conversationId:"project-thread", updatedAt:"2026-09-25T00:00:00Z" }] };
  const ui = await dashboard(state);
  ui.elements.get("objective").value = "Next feature";
  ui.elements.get("startRoot").value = "C:/project";
  ui.elements.get("startRoot").listeners.input();
  assert.equal(ui.elements.get("projectConversationPanel").hidden, false);
  assert.equal(ui.elements.get("reuseProjectConversation").checked, true);
  assert.equal(ui.elements.get("conversationUrl").value, "https://chatgpt.com/c/project-thread");
  await ui.run("beginPreparation()");
  const first = ui.calls.find((item) => item.url === "/api/preparations");
  assert.equal(first.body.reuseProjectConversation, true);
  assert.equal(first.body.conversationUrl, "https://chatgpt.com/c/project-thread");
  ui.elements.get("startRoot").value = "C:/other-project";
  ui.elements.get("startRoot").listeners.input();
  assert.equal(ui.elements.get("projectConversationPanel").hidden, true);
  assert.equal(ui.elements.get("conversationUrl").value, "");
  ui.elements.get("startRoot").value = "C:/project";
  ui.elements.get("startRoot").listeners.input();
  assert.equal(ui.elements.get("reuseProjectConversation").checked, true);
  ui.elements.get("reuseProjectConversation").checked = false;
  ui.elements.get("reuseProjectConversation").listeners.input();
  assert.equal(ui.elements.get("conversationUrl").value, "");
  assert.equal(ui.elements.get("conversationUrl").readOnly, false);
});
test("automatic approval survives UI reload and does not resend after an attempt", async () => {
  const state = prepared(), storage = new Map();
  state.workflow.state = "AGREEMENT_READY";
  state.preparation.lifecycle = "ACTIVE";
  state.preparation.autoApproveOnReady = true;
  state.preparation.agreement = { status: "READY", unresolvedQuestions: [], requirements: [] };
  state.preparation.deliveries = [{}];
  state.commandCapabilities = ["preparation.approve"];
  const first = await dashboard(state, async () => ({}), storage);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first.calls.filter((call) => call.url.endsWith("/approve")).length, 1);
  const reloaded = await dashboard(state, async () => ({}), storage);
  assert.equal(reloaded.calls.filter((call) => call.url.endsWith("/approve")).length, 0);
});

test("history search and status filter narrow the sidebar without changing the selected project view", async () => {
  const state = { workflow:{ stage:"START", state:"START_IDLE" }, preparation:null, run:null,
    preflight:{ checks:{ extensionAuthenticated:true } }, commandCapabilities:["preparation.start"],
    runs:[
      { runId:"alpha", version:1, phase:"WORKER_RUNNING", objective:"Alpha chat", targetRoot:"C:/work/one" },
      { runId:"beta", version:1, phase:"HOLD", objective:"Beta settings", targetRoot:"C:/work/two" },
      { runId:"done", version:1, phase:"APPLIED", objective:"Release", targetRoot:"C:/work/one" },
    ] };
  const storage = new Map();
  const ui = await dashboard(state, undefined, storage);
  assert.match(ui.elements.get("historyFilterSummary").textContent, /전체 3건/u);
  assert.match(renderedText(ui.elements.get("runList")), /Alpha chat/u);
  assert.match(renderedText(ui.elements.get("runList")), /Beta settings/u);
  ui.run('selectProject("C:/work/one")');
  assert.equal(ui.elements.get("projectOverview").hidden, false);

  ui.elements.get("historySearch").value = "beta";
  ui.elements.get("historySearch").listeners.input();
  assert.doesNotMatch(renderedText(ui.elements.get("runList")), /Alpha chat/u);
  assert.match(renderedText(ui.elements.get("runList")), /Beta settings/u);
  assert.equal(ui.elements.get("projectOverview").hidden, false, "sidebar filtering must not close the main project view");
  assert.equal(storage.get("bridge.history.query"), "beta");

  ui.elements.get("historySearch").value = "";
  ui.elements.get("historySearch").listeners.input();
  ui.elements.get("historyStatusFilter").value = "ATTENTION";
  ui.elements.get("historyStatusFilter").listeners.change();
  assert.match(renderedText(ui.elements.get("runList")), /Beta settings/u);
  assert.doesNotMatch(renderedText(ui.elements.get("runList")), /Release/u);
  assert.match(ui.elements.get("historyFilterSummary").textContent, /3건 중 1건 표시/u);
  assert.equal(storage.get("bridge.history.scope"), "ATTENTION");
  ui.elements.get("historyClearFilters").listeners.click();
  assert.match(ui.elements.get("historyFilterSummary").textContent, /전체 3건/u);
});

for (const [stage, state] of [["START", "START_IDLE"], ["WORK", "WORKER_RUNNING"],
  ["WORK", "HOLD"], ["WORK", "RECOVERY_REQUIRED"], ["RESULT", "AWAITING_APPLY"]]) {
  test(`fresh UI restores ${stage}/${state} using only the server snapshot`, async () => {
    const run = stage === "START" ? null : { runId: "r1", version: 7, phase: state, objective: "테스트 작업" };
    const workflow = run ? workflowForRun(run) : { stage: "START", state: "START_IDLE" };
    assert.equal(workflow.stage, stage);
    assert.equal(workflow.state, state);
    const snapshot = { workflow,
      preparation: null, run, runs: run ? [run] : [], preflight: {}, commandCapabilities: [] };
    // Each load has a new VM and no retained selection, draft or local storage.
    for (let load = 0; load < 2; load++) {
      const ui = await dashboard(snapshot);
      assert.equal(ui.elements.get("connectionNotice").textContent, "");
      assert.equal(ui.elements.get("startPanel").hidden, stage !== "START");
      assert.equal(ui.elements.get("projectPanel").hidden, true);
      assert.equal(ui.elements.get("runPanel").hidden, stage === "START");
      const step = { START: "stepCollect", WORK: "stepWork", RESULT: "stepResult" }[stage];
      assert.equal(ui.elements.get(step).attributes["aria-current"], "step");
      assert.deepEqual(ui.calls.map((call) => call.url), ["/api/dashboard/session", "/api/state"]);
    }
  });
}
test("the UI rejects RESULT for recoverable work states", () => {
  for (const phase of ["HOLD", "RECOVERY_REQUIRED"]) {
    assert.throws(() => normalizeDashboardState({ workflow: { stage: "RESULT", state: phase },
      run: { runId: "r1", version: 1, phase }, runs: [], commandCapabilities: [] }),
    /workflow.state is invalid/);
  }
});
test("recovery diagnosis uses run identity, shows observations, and cannot bypass discard confirmation", async () => {
  const run = { runId: "r1", version: 7, phase: "RECOVERY_REQUIRED", objective: "작업" };
  const state = { workflow: workflowForRun(run), run, runs: [run], preparation: null,
    preflight: {}, commandCapabilities: ["run.reconcile", "run.abandon"] };
  const ui = await dashboard(state, async () => ({ payload: {
    runId: "r1", classification: "RECOVERY_REQUIRED", observations: [{ source: "controller", stage: "RECOVERY_REQUIRED" }],
    allowedActions: ["run.abandon"], readOnly: true,
  } }));
  assert.equal(ui.elements.get("reconcileRun").disabled, false);
  assert.equal(ui.elements.get("abandonRun").disabled, true);
  await ui.elements.get("reconcileRun").listeners.click();
  assert.deepEqual(ui.calls.filter((call) => call.url === "/api/commands"), [{
    url: "/api/commands", body: { type: "run.reconcile", requestId: "request-1",
      payload: { runId: "r1", expectedVersion: 7 } },
  }]);
  assert.match(ui.elements.get("reconcileResult").textContent, /RECOVERY_REQUIRED/);
  assert.match(ui.elements.get("reconcileResult").textContent, /controller/);
  assert.equal(ui.elements.get("abandonRun").disabled, true);
  ui.elements.get("recoveryConfirm").checked = true;
  ui.elements.get("recoveryConfirm").listeners.input();
  assert.equal(ui.elements.get("abandonRun").disabled, false);
});

function stateFor(run, capabilities) {
  return { workflow: workflowForRun(run), run, runs: [run], preparation: null,
    preflight: { checks: { extensionAuthenticated: true } }, commandCapabilities: capabilities,
    events: [], messages: [], assessments: [], findings: [], evidence: [] };
}

test("project view groups tasks, surfaces pending action, and opens the selected task", async () => {
  const active = { runId:"active", version:4, phase:"AWAITING_APPLY", objective:"Add greeting",
    projectRef:{ targetRoot:"C:/project" }, createdAt:"2026-09-25T00:00:00Z", updatedAt:"2026-09-25T01:00:00Z" };
  const state = stateFor(active, ["code.apply"]);
  state.runs = [
    { runId:"old", phase:"APPLIED", objective:"Initial app", targetRoot:"C:/project", createdAt:"2026-09-24T00:00:00Z" },
    { ...active, targetRoot:"C:/project" },
  ];
  const storage = new Map();
  const ui = await dashboard(state, undefined, storage);
  ui.run('selectProject("C:/project")');
  assert.equal(ui.elements.get("projectOverview").hidden, false);
  assert.match(ui.elements.get("overviewSummary").textContent, /기록 2건 · 확인할 작업 1건/);
  assert.equal(ui.elements.get("newProjectTask").disabled, true);
  assert.equal(ui.elements.get("openProjectBlocker").hidden, false);
  assert.match(renderedText(ui.elements.get("overviewTasks")), /통과 후보의 근거를 확인/);
  assert.equal(storage.get("bridge.project.view"), "C:/project");
  await ui.elements.get("openProjectBlocker").listeners.click();
  assert.equal(ui.elements.get("projectOverview").hidden, true);
  assert.equal(ui.elements.get("runPanel").hidden, false);
  assert.equal(ui.run("selected"), "active");
});

test("project action starts a new task in its folder after the previous run closes", async () => {
  const done = { runId:"done", version:3, phase:"APPLIED", objective:"Initial app",
    projectRef:{ targetRoot:"C:/project" } };
  const state = stateFor(done, []);
  state.runs = [{ runId:"done", phase:"APPLIED", objective:"Initial app", targetRoot:"C:/project" }];
  const ui = await dashboard(state);
  ui.run('selectProject("C:/project")');
  assert.equal(ui.elements.get("newProjectTask").disabled, false);
  state.workflow = { stage:"START", state:"START_IDLE" }; state.run = null;
  state.commandCapabilities = ["preparation.start"];
  await ui.elements.get("newProjectTask").listeners.click();
  assert.equal(ui.elements.get("projectOverview").hidden, true);
  assert.equal(ui.elements.get("startPanel").hidden, false);
  assert.equal(ui.elements.get("startRoot").value, "C:/project");
  assert.equal(ui.elements.get("objective").value, "");
});
test("continue applied task sends its identity and shows the new approval boundary", async () => {
  const done = { runId:"applied-1", version:4, phase:"APPLIED", objective:"Initial app",
    projectRef:{ targetRoot:"C:/project" } };
  const state = stateFor(done, []);
  const ui = await dashboard(state);
  assert.equal(ui.elements.get("continueProject").disabled, false);
  const navigating = ui.elements.get("continueProject").listeners.click();
  state.workflow = { stage:"START", state:"START_IDLE" }; state.run = null;
  state.commandCapabilities = ["preparation.start"];
  await navigating;
  assert.equal(ui.run("followUpSource?.runId"), "applied-1");
  assert.match(ui.elements.get("followUpSource").textContent, /Initial app · 새 부탁과 요구사항은 다시 승인/u);
  ui.elements.get("objective").value = "Add settings";
  ui.elements.get("startForm").listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sent = ui.calls.find((call) => call.url === "/api/preparations");
  assert.equal(sent.body.followUpRunId, "applied-1");
  assert.equal(sent.body.targetRoot, "C:/project");
});
test("reopened follow-up preparation shows its source and still requires fresh approval", async () => {
  const state = prepared();
  state.preparation.followUp = { runId:"applied-1", objective:"Initial app", candidateId:"candidate-1" };
  const ui = await dashboard(state);
  assert.match(ui.elements.get("planningFollowUp").textContent, /Initial app · 요구사항은 이번에 다시 승인/u);
  assert.equal(ui.elements.get("saveProject").disabled, true);
});
test("follow-up task can reopen its available source; deleted source stays labelled", async () => {
  const run = { runId:"next", version:2, phase:"APPLIED", objective:"Settings",
    projectRef:{ targetRoot:"C:/project" }, followUp:{ runId:"first", objective:"Initial app" } };
  const state = stateFor(run, []);
  const ui = await dashboard(state);
  assert.equal(ui.elements.get("openFollowUp").disabled, true);
  assert.match(ui.elements.get("runFollowUp").textContent, /first/u);
  state.runs.push({ runId:"first", phase:"APPLIED", objective:"Initial app", targetRoot:"C:/project" });
  await ui.run("refresh()");
  assert.equal(ui.elements.get("openFollowUp").disabled, false);
  await ui.elements.get("openFollowUp").listeners.click();
  assert.equal(ui.run("selected"), "first");
});

test("a held reviewer question accepts a human answer with the exact run and question identities", async () => {
  const run = { runId:"run-question", version:4, phase:"HOLD", objective:"Implement greeting",
    terminationReason:"USER_DECISION_REQUIRED", candidate:{ candidateId:"candidate-1" },
    missingInformation:[{ requestItemId:"question-1", status:"NEEDS_USER_DECISION", reason:"Which greeting?" }] };
  const state = stateFor(run, ["code.decision.reply"]);
  const ui = await dashboard(state, async () => ({ payload:{ status:"USER_DECISION_ACCEPTED" } }));
  assert.equal(ui.elements.get("decisionPanel").hidden, false);
  assert.equal(ui.elements.get("submitDecision").disabled, true);
  const answer = ui.elements.get("decisionQuestions").querySelectorAll("textarea")[0];
  assert.equal(answer.dataset.requestItemId, "question-1");
  answer.value = "Use the greeting already specified in R1.";
  answer.listeners.input();
  await ui.elements.get("submitDecision").listeners.click();
  const mutation = ui.calls.find((item) => item.url === "/api/commands");
  assert.equal(mutation.body.type, "code.decision.reply");
  assert.deepEqual(mutation.body.payload, { runId:"run-question", expectedVersion:4,
    responses:[{ requestItemId:"question-1", answer:"Use the greeting already specified in R1." }] });
});

test("settled audit exposes free-form Judge/Critic discussion without changing audit controls", async () => {
  const run = { runId:"run-chat", version:5, phase:"HOLD", objective:"Implement greeting",
    terminationReason:"REPORT_REPAIR_LIMIT", candidate:{ candidateId:"candidate-1" },
    conversationBindings:[
      { role:"JUDGE", conversationUrl:"https://chatgpt.com/c/judge", conversationId:"judge", activeDeliveryId:null },
      { role:"CRITIC", conversationUrl:"https://chatgpt.com/c/critic", conversationId:"critic", activeDeliveryId:null },
    ], reviewDiscussions:[] };
  const state = stateFor(run, ["code.review.discuss","code.review.retry","run.stop"]);
  const ui = await dashboard(state, async (url, options) => {
    const body=JSON.parse(options.body);
    if(body.type==="code.review.discuss")return{payload:{status:"DELIVERED",discussionId:"discussion-1",role:body.payload.role,response:"Answer"}};
    return{payload:{}};
  });
  assert.equal(ui.elements.get("reviewDiscussionPanel").hidden,false);
  assert.equal(ui.elements.get("sendReviewDiscussion").disabled,true);
  ui.elements.get("reviewDiscussionRole").value="CRITIC";
  ui.elements.get("reviewDiscussionRole").listeners.change();
  ui.elements.get("reviewDiscussionText").value="What evidence is still weak?";
  ui.elements.get("reviewDiscussionText").listeners.input();
  assert.equal(ui.elements.get("sendReviewDiscussion").disabled,false);
  await ui.elements.get("sendReviewDiscussion").listeners.click();
  const mutation=ui.calls.find((item)=>item.url==="/api/commands"&&item.body.type==="code.review.discuss");
  assert.deepEqual(mutation.body.payload,{runId:"run-chat",expectedVersion:5,role:"CRITIC",text:"What evidence is still weak?"});
  assert.equal(ui.elements.get("retryRun").disabled,false);
  assert.match(ui.elements.get("reviewDiscussionStatus").textContent,/대화만으로 감사 판정은 바뀌지 않습니다/u);
});

test("audit hold → retry → pass → apply: commands use one run and the reviewed candidate", async () => {
  const run = { runId: "run-trace", version: 4, phase: "HOLD", objective: "Greeting",
    candidate: { candidateId: "candidate-1" }, capture: { artifact: { sha256: "patch-1" } },
    reviews: [{ reviewId: "review-1" }], baseCommit: "base-1" };
  const state = stateFor(run, ["code.review.retry"]);
  const effects = [];
  const ui = await dashboard(state, async (url, options) => {
    assert.equal(url, "/api/commands");
    const { type, payload, requestId } = JSON.parse(options.body);
    assert.equal(payload.runId, run.runId);
    assert.equal(payload.expectedVersion, run.version);
    assert.equal(typeof requestId, "string");
    effects.push(type);
    if (type === "code.review.retry") {
      assert.equal(run.phase, "HOLD");
      run.phase = "REVIEW_RUNNING"; run.version++;
      state.workflow = workflowForRun(run); state.commandCapabilities = ["run.stop"];
      return { payload: { status: "REVIEW_RETRY_ACCEPTED", candidateId: run.candidate.candidateId } };
    }
    if (type === "code.apply") {
      assert.equal(run.phase, "AWAITING_APPLY");
      assert.deepEqual(payload, { runId: run.runId, expectedVersion: run.version,
        candidateId: "candidate-1", reviewId: "review-2", artifactHash: "patch-1", baseCommit: "base-1" });
      run.phase = "APPLIED"; run.version++;
      state.workflow = workflowForRun(run); state.commandCapabilities = [];
      return { payload: { stage: "APPLIED" } };
    }
    throw new Error(`Unexpected command ${type}`);
  });
  assert.equal(ui.elements.get("retryRun").disabled, false);
  await ui.elements.get("retryRun").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run.phase, "REVIEW_RUNNING");
  assert.equal(ui.elements.get("applyCode").disabled, true);
  assert.deepEqual(effects, ["code.review.retry"]);

  // The audit outcome is supplied by the controller snapshot, not inferred from a button click.
  run.phase = "AWAITING_APPLY"; run.version++; run.reviews.push({ reviewId: "review-2" });
  state.workflow = workflowForRun(run); state.commandCapabilities = ["code.apply"];
  await ui.run("refresh()");
  assert.equal(ui.elements.get("applyCode").disabled, false, JSON.stringify({ calls: ui.calls, workflow: ui.run("workflow"), connected: ui.run("connected"), cap: ui.run("[...capabilities()]") }));
  await ui.elements.get("applyCode").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.elements.get("runStatus").textContent, "적용됨");
  assert.deepEqual(effects, ["code.review.retry", "code.apply"]);
  assert.equal(ui.elements.get("applyCode").disabled, true);
});

test("recovery diagnosis cannot authorize discard and disconnected state sends no command", async () => {
  const run = { runId: "run-recovery", version: 2, phase: "RECOVERY_REQUIRED", objective: "Greeting" };
  const state = stateFor(run, ["run.reconcile", "run.abandon"]);
  let calls = 0;
  const ui = await dashboard(state, async (url, options) => {
    assert.equal(url, "/api/commands"); calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.type, "run.reconcile");
    assert.equal(body.payload.expectedVersion, 2);
    return { payload: { runId: run.runId, classification: "RECOVERY_REQUIRED",
      observations: [{ source: "controller", localJob: false }], allowedActions: ["run.abandon"], readOnly: true } };
  });
  await ui.elements.get("reconcileRun").listeners.click();
  assert.equal(calls, 1);
  assert.equal(ui.elements.get("abandonRun").disabled, true);
  state.commandCapabilities = [];
  await ui.run("refresh()");
  assert.equal(ui.elements.get("reconcileRun").disabled, true);
  await ui.elements.get("reconcileRun").listeners.click();
  assert.equal(calls, 1);
  assert.equal(ui.elements.get("abandonRun").disabled, true);
  state.commandCapabilities = ["run.reconcile", "run.abandon"];
  ui.run("connected = false; render()");
  assert.equal(ui.elements.get("reconcileRun").disabled, true);
  await ui.elements.get("reconcileRun").listeners.click();
  assert.equal(calls, 1);
});

test("uncertain audit retry is not sent twice without a settled receipt", async () => {
  const run = { runId: "run-timeout", version: 3, phase: "HOLD", objective: "Greeting" };
  const state = stateFor(run, ["code.review.retry"]);
  const ui = await dashboard(state, async () => {
    throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
  });
  await ui.elements.get("retryRun").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.elements.get("retryRun").disabled, true);
  await ui.elements.get("retryRun").listeners.click();
  assert.equal(ui.calls.filter(({ url }) => url === "/api/commands").length, 1);
  assert.ok(ui.calls.some(({ url }) => url === "/api/state?requestId=request-1"), JSON.stringify({ calls: ui.calls, connected: ui.run("connected"), state: ui.run("operations.runCommand") }));
  assert.match(ui.elements.get("commandResult").textContent, /자동 재전송하지 않습니다/);
});
