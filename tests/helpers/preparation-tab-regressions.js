import test from "node:test";
import assert from "node:assert/strict";

export function registerTabSelectionTests({ dashboard, prepared }) {
  test("a historical unsent marker cannot hide recovery after a resumed dispatch", async () => {
    const state = prepared();
    state.workflow = { stage:"START", state:"RECOVERY_REQUIRED", preparationId:"p1", preparationVersion:3 };
    Object.assign(state.preparation, { state:"RECOVERY_REQUIRED", lifecycle:"ACTIVE",
      error:{ code:"PREPARATION_RECOVERY_REQUIRED", message:"A dispatched request must be inspected." },
      deliveries:[{ deliveryId:"d1", sessionId:"s1", state:"SUBMITTED", unsent:true }],
    });
    state.commandCapabilities = ["web.inspect", "preparation.discard"];
    const ui = await dashboard(state);
    assert.equal(ui.elements.get("discardPanel").hidden, false,
      "the current delivery state must override the historical unsent marker");
    for (const deliveryState of ["RECOVERY_REQUIRED", "RESPONSE_COMPLETED"]) {
      state.preparation.deliveries[0].state = deliveryState;
      state.preparation.version++;
      await ui.run("refresh()");
      assert.equal(ui.elements.get("discardPanel").hidden, false);
    }
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
    const root = ui.elements.get("proposalSummary").children[0];
    const radios = root.querySelectorAll("input");
    assert.equal(radios.length, 2);
    await radios[1].listeners.change();
    assert.equal(ui.calls.some(item => item.url === "/api/preparations/web"), false);
    const send = root.querySelectorAll("button").find(item => item.textContent === "이 탭에서 요청 전송 계속");
    await send.listeners.click();
    const call = ui.calls.find((item) => item.url === "/api/preparations/web");
    assert.equal(call.body.command, "web.rebind");
    assert.equal(call.body.selectedTabId, 12);
    assert.equal(call.body.sessionId, "s1");
    assert.equal(call.body.deliveryId, "d1");
  });

  test("initial tab selection is accessible on START and preserves the unsent delivery across refresh", async () => {
    const state = prepared();
    state.workflow = { stage:"START", state:"WEB_BLOCKED", preparationId:"p1", preparationVersion:3 };
    Object.assign(state.preparation, { state:"WEB_BLOCKED", lifecycle:"ACTIVE",
      error:{ code:"WEB_TAB_SELECTION_REQUIRED", message:"Select a tab.", details:{
        browserDispatchStarted:false, candidates:[{ tabId:12, windowId:2, url:"https://chatgpt.com/" }],
      } },
      deliveries:[{ deliveryId:"d1", sessionId:"s1", conversationId:null, state:"FAILED", unsent:true }],
    });
    Object.assign(state.preparation.webSession, { conversationUrl:null, conversationId:null });
    state.commandCapabilities = ["web.rebind", "web.inspect", "preparation.cancel"];
    const ui = await dashboard(state, async () => ({}));
    assert.equal(ui.elements.get("startPanel").hidden, false);
    assert.equal(ui.elements.get("projectPanel").hidden, true);
    const initialChoice = ui.elements.get("startRecovery").children.find(item => item.className === "preparation-tab-choice");
    assert.ok(initialChoice, "tab selection must be inside the visible START recovery host");
    assert.equal(ui.elements.get("discardPanel").hidden, true);
    assert.match(ui.elements.get("startProgressTitle").textContent, /탭.*선택/u);
    assert.doesNotMatch(ui.elements.get("startReason").textContent, /실패했습니다/u);
    assert.doesNotMatch(ui.elements.get("newRunReason").textContent, /응답.*확인 중/u);
    assert.equal(ui.elements.get("planRun").disabled, true);
    await initialChoice.querySelectorAll("input")[0].listeners.change();
    for (let refresh = 0; refresh < 2; refresh++) {
      const host = ui.elements.get("startRecovery");
      assert.equal(host.hidden, false);
      const choices = host.children.filter(item => item.className === "preparation-tab-choice");
      assert.equal(choices.length, 1);
      assert.equal(choices[0].parentElement, host);
      assert.equal(choices[0].querySelectorAll("input").length, 1);
      state.preparation.version++;
      state.workflow.preparationVersion = state.preparation.version;
      const pending = ui.run("refresh()");
      const loadingChoice = host.children.find(item => item.className === "preparation-tab-choice");
      const loadingSend = loadingChoice.querySelectorAll("button").find(item => item.className === "tab-choice-send");
      assert.equal(loadingSend.disabled, true, "state reads must still block sending");
      await loadingSend.listeners.click();
      await pending;
      const restored = host.children.find(item => item.className === "preparation-tab-choice");
      assert.equal(restored.querySelectorAll("input")[0].checked, true, "polling must preserve explicit selection");
      assert.equal(restored.querySelectorAll("button").find(item => item.className === "tab-choice-send").disabled, false);
    }
    assert.equal(ui.calls.some(item => item.url === "/api/preparations/web"), false);
    for (const change of [
      () => { state.preparation.error.details.candidates[0].url = "https://chatgpt.com/c/changed"; },
      () => { state.preparation.webSession.sessionId = "s2"; },
      () => { state.preparation.webSession.activeDeliveryId = "d2"; },
    ]) {
      change();
      await ui.run("refresh()");
      const reset = ui.elements.get("startRecovery").children.find(item => item.className === "preparation-tab-choice");
      assert.equal(reset.querySelectorAll("input")[0].checked, false);
      assert.equal(reset.querySelectorAll("button").find(item => item.className === "tab-choice-send").disabled, true);
      await reset.querySelectorAll("input")[0].listeners.change();
    }
    const choice = ui.elements.get("startRecovery").children.find(item => item.className === "preparation-tab-choice");
    await choice.querySelectorAll("input")[0].listeners.change();
    const send = choice.querySelectorAll("button").find(item => item.textContent === "이 탭에서 요청 전송 계속");
    await send.listeners.click();
    await send.listeners.click();
    const mutations = ui.calls.filter(item => item.url === "/api/preparations/web");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].body.command, "web.rebind");
    assert.equal(mutations[0].body.selectedTabId, 12);
    assert.equal(mutations[0].body.deliveryId, "d2");
    assert.equal(mutations[0].body.sessionId, "s2");
  });
}
