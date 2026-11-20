import test from "node:test";
import assert from "node:assert/strict";
import { dashboard } from "../helpers/dashboard-ui.mjs";
import { workflowForRun } from "../../src/orchestration/preparation-service.js";

function stateFor(run, commandCapabilities) {
  return {run, runs:[run], workflow:workflowForRun(run), preparation:null,
    commandCapabilities, preflight:{checks:{extensionAuthenticated:true}}};
}
function renderedText(element) {
  return [element?.textContent ?? "", ...(element?.children ?? []).map(renderedText)].join("\n");
}

test("project overview displays stored conversation and per-task mapping without mixing projects", async () => {
  const done = {runId:"done", version:3, phase:"APPLIED", objective:"Initial app", preparationId:"prep-old",
    conversationUrl:"https://chatgpt.com/c/old", projectRef:{targetRoot:"C:/project"}};
  const state = stateFor(done, []);
  state.runs = [{...done, targetRoot:"C:/project"}, {...done, runId:"other", targetRoot:"C:/other"}];
  state.projectConversations = [{targetRoot:"C:/project", preparationId:"prep-saved", conversationUrl:"https://chatgpt.com/c/saved"}];
  const ui = await dashboard(state);
  ui.run('selectProject("C:/project")');
  assert.match(ui.elements.get("overviewConversation").textContent, /https:\/\/chatgpt.com\/c\/saved.*prep-saved/u);
  const cards = renderedText(ui.elements.get("overviewTasks"));
  assert.match(cards, /작업 ID done.*준비 ID prep-old/u);
  assert.match(cards, /https:\/\/chatgpt.com\/c\/old/u);
  ui.run('selectProject("C:/other")');
  assert.match(ui.elements.get("overviewConversation").textContent, /저장된 프로젝트 대화 없음/u);
  assert.doesNotMatch(renderedText(ui.elements.get("overviewTasks")), /작업 ID done/u);
});

for (const saved of [false, true]) test(`continue inherits the source conversation with project mapping ${saved}`, async () => {
  const done = {runId:"source", version:3, phase:"APPLIED", objective:"Initial app",
    conversationUrl:"https://chatgpt.com/c/source", projectRef:{targetRoot:"C:/project"}};
  const state = stateFor(done, []);
  state.projectConversations = saved ? [{targetRoot:"C:/project", conversationId:"saved", conversationUrl:"https://chatgpt.com/c/saved"}] : [];
  const ui = await dashboard(state);
  state.workflow = {stage:"START", state:"START_IDLE"}; state.run = null;
  await ui.elements.get("continueProject").listeners.click();
  const input = ui.elements.get("conversationUrl");
  assert.equal(input.value, `https://chatgpt.com/c/${saved ? "saved" : "source"}`);
  assert.equal(ui.elements.get("reuseProjectConversation").checked, saved);
  assert.match(ui.elements.get("followUpSource").textContent, /작업 ID source/u);
  if (!saved) {
    assert.equal(input.readOnly, false);
    input.value = ""; ui.run("render()");
    assert.equal(input.value, "");
    input.value = done.conversationUrl;
    ui.elements.get("startRoot").value = "C:/other"; ui.run("render()");
    assert.equal(input.value, "");
  }
  assert.equal(ui.calls.some(call => call.url.startsWith("/api/preparations")), false);
});

test("reuse start captures edits and current snapshots can replace or hide the selected mapping", async () => {
  const root = "C:/project";
  const mapping = {targetRoot:root, conversationId:"saved", conversationUrl:"https://chatgpt.com/c/saved"};
  const state = {workflow:{stage:"START",state:"START_IDLE"}, run:null, runs:[], preparation:null,
    commandCapabilities:["preparation.start"], preflight:{checks:{extensionAuthenticated:true}}, runtimeAvailability:{ready:true},
    projectConversations:[mapping]};
  const ui = await dashboard(state);
  const url = ui.elements.get("conversationUrl");
  const reuse = ui.elements.get("reuseProjectConversation");
  ui.elements.get("startRoot").value = root;
  ui.elements.get("startRoot").listeners.input();
  assert.equal(reuse.checked, true);
  assert.equal(url.readOnly, false);

  url.value = "https://chatgpt.com/c/manual";
  ui.elements.get("objective").value = "Fixture";
  await ui.run("beginPreparation()");
  const body = ui.calls.find(call => call.url === "/api/preparations").body;
  assert.equal(body.conversationUrl, "https://chatgpt.com/c/manual");
  assert.equal(body.reuseProjectConversation, true);

  state.projectConversations = [{...mapping, conversationId:"next", conversationUrl:"https://chatgpt.com/c/next"}];
  await ui.run("refresh()");
  assert.equal(url.value, "https://chatgpt.com/c/next");
  state.projectConversations = [];
  await ui.run("refresh()");
  assert.equal(ui.elements.get("projectConversationPanel").hidden, true);
  assert.equal(url.value, "https://chatgpt.com/c/next");
  await ui.run("beginPreparation()");
  const afterRemoval = ui.calls.filter(call => call.url === "/api/preparations").at(-1).body;
  assert.equal(afterRemoval.reuseProjectConversation, false);
  assert.equal(afterRemoval.conversationUrl, "https://chatgpt.com/c/next");
});
