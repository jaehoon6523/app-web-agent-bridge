import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { externalEventRecords, groupRunsByProject, normalizeDashboardState } from "../../public/dashboard-model.js";
import { workflowForRun } from "../../src/orchestration/preparation-service.js";

export async function dashboard(state, mutate = async () => ({}), storage = new Map()) {
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
    externalEventRecords, groupRunsByProject, normalizeDashboardState, Date, Map, Set, JSON, URL, Blob,
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
function renderedText(element) {
  return [element?.textContent ?? "", ...(element?.children ?? []).map(renderedText)].join("\n");
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
