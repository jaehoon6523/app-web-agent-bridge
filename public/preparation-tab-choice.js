// Hints never select a tab. Every send still uses the server's existing delivery.
export function choiceAvailability({ candidates, hint, operation, allowed }) {
  const hinted = hint == null ? null : Number(hint);
  const mismatch = hint != null && (!Number.isSafeInteger(hinted) || !candidates.some(tab => tab.tabId === hinted));
  const reason = operation === "UNKNOWN_RESULT" ? "선택 요청 결과를 확인할 수 없습니다. 최신 상태를 조회하세요."
    : operation !== "IDLE" ? "선택한 탭을 다시 확인하는 중입니다."
      : !allowed ? "현재 서버 상태에서 전송을 계속할 수 없습니다. 연결과 작업 상태를 확인하세요." : "";
  return { hinted, mismatch, reason, warning: mismatch ? "팝업에서 확인한 탭은 현재 후보가 아닙니다. 아래 현재 후보를 직접 선택하세요." : "", enabled: !reason && candidates.length > 0 };
}
function el(tag, text = "", className = "") {
  const item = document.createElement(tag); item.textContent = text; item.className = className; return item;
}
function button(text, className, action) {
  const item = el("button", text, className); item.type = "button"; item.addEventListener("click", action); return item;
}
function shell(step) {
  const root = el("section", "", "preparation-tab-choice"), steps = el("ol", "", "tab-choice-steps");
  root.setAttribute("aria-label", "준비 작업 탭 선택");
  ["탭 확인", "탭 선택", "전송 확인"].forEach((text, index) => {
    const item = el("li", `${index + 1}. ${text}`, index + 1 < step ? "done" : "");
    if (index + 1 === step) item.setAttribute("aria-current", "step"); steps.append(item);
  });
  const panel = el("div", "", "tab-choice-panel"), head = el("div", "", "tab-choice-head"), body = el("div", "", "tab-choice-body");
  head.append(el("b", "컨트롤러"), el("span", "여기서만 전송이 시작됩니다"));
  panel.append(head, body); root.append(steps, panel); return { root, body };
}
function rail(step) {
  const list = el("ol", "", "tab-choice-rail");
  ["탭 연결", "요청 전송", "응답 저장과 ACK"].forEach((text, index) => {
    const item = el("li", "", index < step ? "done" : "");
    item.append(el("span", index < step ? "✓" : String(index + 1), "rail-number"), el("span", text)); list.append(item);
  });
  return list;
}
export function createPreparationTabChoice() {
  let key = "", selectedTabId = null;
  return {
    candidates(preparation) {
      return preparation.error?.code === "WEB_TAB_SELECTION_REQUIRED" && Array.isArray(preparation.error?.details?.candidates)
        ? preparation.error.details.candidates : [];
    },
    reset() { key = ""; selectedTabId = null; },
    render({ preparation, ...options }) {
      const session = preparation.webSession;
      const nextKey = JSON.stringify([preparation.preparationId, session?.sessionId, session?.activeDeliveryId, options.candidates]);
      // Polling preserves an explicit choice only for the same request and candidate set.
      if (nextKey !== key || options.operation !== "IDLE" || options.rejection) selectedTabId = null;
      key = nextKey;
      return renderPreparationTabChoice({ ...options, selectedTabId, onSelect: tabId => { selectedTabId = tabId; } });
    },
  };
}
export function tabFocusKey(preparation) {
  return JSON.stringify([preparation?.preparationId, preparation?.version, preparation?.webSession?.sessionId,
    preparation?.webSession?.activeDeliveryId, preparation?.state, preparation?.lifecycle,
    preparation?.error?.details?.candidates?.map(tab => [tab.tabId, tab.url])]);
}
export function nextTabFocusState(previous, preparation) {
  const key = tabFocusKey(preparation);
  if (previous.key === key) return previous;
  const owner = JSON.stringify([preparation?.preparationId, preparation?.webSession?.activeDeliveryId]);
  const retained = previous.owner === owner && (previous.busy || previous.needsRefresh || previous.unconfirmedTabs?.size);
  const unconfirmedTabs = new Set(retained ? previous.unconfirmedTabs : []);
  if (retained && previous.target != null) unconfirmedTabs.add(previous.target);
  return {key, owner, needsRefresh:Boolean(retained), target:retained ? previous.target : null,
    unconfirmedTabs,
    message:retained ? "준비 상태가 변경됐습니다. 현재 상태를 다시 조회하세요." : ""};
}
export function createTabFocusActions(getPreparation, request) {
  const current = getPreparation(), key = tabFocusKey(current);
  const preparationId = current.preparationId, preparationVersion = current.version;
  const deliveryId = current.webSession?.activeDeliveryId;
  const targets = new Map((current.error?.details?.candidates ?? []).map(tab => [tab.tabId, tab.url]));
  const isCurrent = () => tabFocusKey(getPreparation()) === key;
  const stale = (executionOutcome = "UNKNOWN") => Object.assign(new Error("준비 또는 대상이 변경됐습니다."), {
    code:"TAB_FOCUS_STALE", executionOutcome, applicable:false,
  });
  return {
    isCurrent,
    onView: async tabId => {
      if (!isCurrent() || !targets.has(tabId)) throw stale("NOT_EXECUTED");
      const result = await request("/api/preparations/tab-focus", {method:"POST",
        body:JSON.stringify({preparationId, preparationVersion, deliveryId, tabId})});
      if (!isCurrent()) throw stale(result.executionOutcome ?? (result.opened === true && result.tabId === tabId ? "SUCCEEDED" : "UNKNOWN"));
      return result;
    },
    onInspect: async tabId => {
      if (!isCurrent() || !targets.has(tabId)) throw stale();
      const result = await request("/api/selector-diagnostics");
      if (!isCurrent()) throw stale();
      if (!result.tabs?.some(tab => tab.tabId === tabId && tab.url === targets.get(tabId))) {
        throw Object.assign(new Error("현재 대상 탭을 확인하지 못했습니다."), {code:"TAB_INSPECTION_UNCONFIRMED"});
      }
      // This is a current observation, never proof that an earlier focus executed.
      return {tabId, url:targets.get(tabId)};
    },
  };
}
function focusOutcomeMessage(result) {
  const outcome = result?.executionOutcome ?? result?.details?.executionOutcome;
  const applicable = result?.applicable ?? result?.details?.applicable;
  if (outcome === "SUCCEEDED" && applicable === false) return "탭 이동은 확인됐지만, 준비 상태가 바뀌어 현재 작업의 결과로 적용하지 않았습니다.";
  if (outcome === "SUCCEEDED") return "탭 이동은 확인됐습니다. 현재 준비 상태를 다시 확인하세요.";
  if (outcome === "FAILED") return "탭 이동 실패가 확인됐습니다. 현재 탭과 연결 상태를 확인하세요.";
  if (outcome === "NOT_EXECUTED" || (outcome == null && ["TAB_CHANGED", "WEB_SESSION_BUSY", "EXTENSION_NOT_AUTHENTICATED"].includes(result?.code))) {
    return "탭 이동을 진행하지 못했습니다. 연결과 대상 탭을 확인한 뒤 최신 상태를 조회하세요.";
  }
  return "탭 이동 결과가 미확인입니다. 이미 이동했을 수 있습니다. 현재 탭을 직접 확인하고, 연결이 끊겼다면 확장에서 Reconnect 후 최신 상태를 조회하세요. 자동 재시도하지 않습니다.";
}
export function renderPreparationTabChoice({ candidates, hint, operation, allowed, onSubmit, onRefresh, onView, onInspect, isCurrent = () => true, selectedTabId = null, onSelect, rejection = "", focusState = {} }) {
  focusState.unconfirmedTabs ??= new Set();
  const unconfirmed = tabId => focusState.unconfirmedTabs.has(tabId);
  const model = choiceAvailability({ candidates, hint, operation, allowed });
  const { root, body } = shell(operation === "IDLE" ? 2 : 3);
  const content = el("div"), overview = el("div"); overview.hidden = true;
  body.append(content, overview);
  content.append(el("h2", "이 작업에 쓸 탭 고르기"), el("p", operation !== "IDLE" ? model.reason
    : "후보를 직접 눌러 고르세요. 선택만으로는 전송되지 않습니다.", "tab-choice-lead"));
  const notice = el("div", rejection || model.reason || model.warning, "tab-choice-note" + (rejection ? " rejected" : ""));
  notice.hidden = !notice.textContent; notice.setAttribute("role", "status"); content.append(notice);
  const group = el("fieldset"); group.append(el("legend", "사용할 ChatGPT 탭"));
  let selected = null, submitted = false;
  const send = button("이 탭에서 요청 전송 계속", "tab-choice-send", async () => {
    if (!isCurrent() || send.disabled || submitted || focusState.busy || focusState.needsRefresh || selected === null || unconfirmed(selected) || !model.enabled) return;
    submitted = true; send.disabled = true; back.disabled = true; refresh.disabled = true;
    for (const control of group.querySelectorAll("input,button")) control.disabled = true;
    reason.textContent = "선택한 탭을 다시 확인하는 중입니다.";
    try {
      const accepted = await onSubmit(selected);
      if (accepted === false) {
        notice.hidden = false; notice.classList.add("rejected"); notice.textContent = "요청이 승인되지 않았습니다. 최신 상태와 거부 이유를 확인하세요.";
        send.hidden = true; refresh.disabled = false;
      }
    } catch {
      notice.hidden = false; notice.textContent = "선택 요청 결과를 확인할 수 없습니다. 재전송 전에 최신 상태를 조회하세요.";
      send.hidden = true; refresh.disabled = false;
    }
  });
  send.disabled = true;
  const reason = el("p", "후보를 먼저 선택하면 전송 버튼이 켜집니다.", "tab-choice-reason"); reason.setAttribute("role", "status");
  const syncFocus = () => {
    const blocked = submitted || focusState.busy || focusState.needsRefresh || operation !== "IDLE";
    for (const control of group.querySelectorAll("input,button")) {
      control.disabled = Boolean(blocked || unconfirmed(control.focusTabId)
        || (control.tagName === "INPUT" && (!model.enabled || rejection)));
    }
    send.disabled = Boolean(blocked || selected === null || unconfirmed(selected) || !model.enabled || rejection);
    refresh.disabled = Boolean(focusState.busy || focusState.refreshing || operation === "RUNNING");
    if (focusState.message) reason.textContent = focusState.message;
  };
  const states = [];
  for (const candidate of candidates) {
    const card = el("div", "", "tab-choice-candidate"), label = el("label"), radio = el("input");
    radio.type = "radio"; radio.name = "preparation-tab-choice"; radio.value = String(candidate.tabId);
    radio.focusTabId = candidate.tabId;
    radio.disabled = !model.enabled || Boolean(rejection);
    const copy = el("span", "", "tab-choice-copy"), status = el("span", "눌러서 선택", "tab-choice-state");
    copy.append(el("strong", `탭 ${candidate.tabId}`), el("small", candidate.url === "https://chatgpt.com/" ? "ChatGPT 시작 화면" : "기존 ChatGPT 대화"), el("small", candidate.url));
    const hinted = !model.mismatch && model.hinted === candidate.tabId;
    if (hinted) { card.classList.add("hinted"); status.textContent = "팝업에서 확인한 탭"; }
    states.push({ card, status, hinted, radio, candidate });
    radio.addEventListener("change", () => {
      if (!isCurrent() || unconfirmed(candidate.tabId) || !model.enabled || submitted || focusState.busy || focusState.needsRefresh || rejection) return;
      selected = candidate.tabId;
      onSelect?.(selected);
      for (const sibling of states) {
        sibling.card.classList.toggle("selected", sibling.card === card);
        sibling.status.textContent = sibling.card === card ? "✓ 선택됨" : sibling.hinted ? "팝업에서 확인한 탭" : "눌러서 선택";
      }
      send.disabled = false; reason.textContent = `선택한 탭 ${selected}. 아래 버튼을 누르면 다시 검사한 뒤 보류된 요청을 전송합니다.`;
    });
    label.append(radio, copy, status); card.append(label);
    if (onView) {
      const view = button("탭 화면 보기", "tab-choice-view", async () => {
        if (!isCurrent() || unconfirmed(candidate.tabId) || view.disabled || focusState.busy || focusState.needsRefresh || submitted) return;
        focusState.recoveryToken = null; focusState.refreshing = false;
        focusState.target = candidate.tabId;
        focusState.busy = true;
        focusState.message = "탭 이동 결과를 확인하는 중입니다.";
        syncFocus();
        try {
          const result = await onView(candidate.tabId);
          if (!isCurrent()) return;
          focusState.needsRefresh = result?.applicable === false;
          focusState.message = result?.applicable === false ? focusOutcomeMessage(result)
            : "탭 화면만 열었습니다. 선택과 전송은 바뀌지 않습니다.";
        } catch (error) {
          if (!isCurrent()) return;
          focusState.needsRefresh = true;
          focusState.unconfirmedTabs.add(candidate.tabId);
          focusState.message = focusOutcomeMessage(error);
        } finally { focusState.busy = false; if (isCurrent()) (focusState.render ?? syncFocus)(); }
      });
      view.focusTabId = candidate.tabId;
      view.disabled = operation !== "IDLE"; card.append(view);
    }
    group.append(card);
  }
  const restored = states.find(item => item.candidate.tabId === selectedTabId);
  if (restored && operation === "IDLE" && !rejection) {
    selected = selectedTabId;
    restored.radio.checked = true;
    restored.card.classList.add("selected"); restored.status.textContent = "✓ 선택됨";
    send.disabled = !model.enabled;
    reason.textContent = model.enabled ? `선택한 탭 ${selected}. 아래 버튼을 누르면 다시 검사한 뒤 보류된 요청을 전송합니다.` : model.reason;
  }
  const dock = el("div", "", "tab-choice-dock"), actions = el("div", "", "tab-choice-actions");
  const back = button("뒤로", "tab-choice-back", () => {
    content.hidden = true; overview.hidden = false;
  }); back.disabled = operation !== "IDLE";
  const refresh = button(rejection ? "후보 다시 보기" : "최신 상태 조회", "tab-choice-refresh", async () => {
    if (!isCurrent() || refresh.disabled || focusState.refreshing) return;
    focusState.refreshing = true; refresh.disabled = true;
    const token = {}; focusState.recoveryToken = token;
    const canApply = () => isCurrent() && focusState.recoveryToken === token;
    const target = focusState.needsRefresh ? focusState.target
      : focusState.unconfirmedTabs.values().next().value ?? focusState.target;
    const inspect = onInspect && target != null;
    try {
      // Start both reads independently, including when either callback throws synchronously.
      const serverRead = Promise.resolve().then(onRefresh).then(() => {
        if (!canApply()) return;
        focusState.needsRefresh = false;
        if (inspect) focusState.unconfirmedTabs.add(target);
        focusState.message = inspect ? "서버 상태를 조회했습니다. 대상 탭 확인은 아직 끝나지 않았습니다."
          : "서버 상태를 조회했습니다. 실제 탭을 확인한 뒤 필요할 때만 다시 이동하세요.";
        (focusState.render ?? syncFocus)();
      });
      const inspection = inspect ? Promise.resolve().then(() => onInspect(target)) : Promise.resolve();
      const [server, tab] = await Promise.allSettled([serverRead, inspection]);
      if (!canApply()) return;
      focusState.needsRefresh = server.status !== "fulfilled";
      if (inspect) {
        if (tab.status === "fulfilled") focusState.unconfirmedTabs.delete(target);
        else focusState.unconfirmedTabs.add(target);
      }
      focusState.message = server.status !== "fulfilled" ? "최신 서버 상태를 불러오지 못했습니다. 다시 조회하세요."
        : tab.status !== "fulfilled" ? "서버 상태는 조회했습니다. 대상 탭은 확인하지 못했습니다. 다른 후보를 확인하거나 연결 복구 후 다시 조회하세요."
          : inspect ? "서버 상태와 현재 대상 탭을 조회했습니다. 이전 이동의 실행 결과를 확정한 것은 아닙니다. 필요할 때만 다시 이동하세요."
            : "서버 상태를 조회했습니다. 실제 탭을 확인한 뒤 필요할 때만 다시 이동하세요.";
    }
    finally {
      if (canApply()) { focusState.refreshing = false; (focusState.render ?? syncFocus)(); }
    }
  }); refresh.disabled = operation === "RUNNING";
  overview.append(el("h2", "탭 선택을 보류했습니다"), el("p", "준비 작업과 전송 기록은 그대로입니다."),
    button("탭 선택으로 돌아가기", "tab-choice-refresh", () => { overview.hidden = true; content.hidden = false; }));
  actions.append(back, send); dock.append(reason, actions,
    el("p", "전송 버튼을 누를 때만 보류된 요청을 계속합니다.", "tab-choice-caption"));
  content.append(group, dock, refresh);
  if (operation !== "IDLE" || rejection) { send.hidden = true; reason.hidden = true; }
  if (operation === "RUNNING") { group.hidden = true; dock.hidden = true; content.append(rail(0)); }
  focusState.render = syncFocus;
  syncFocus();
  return root;
}
export function preparationTransmissionStatus(delivery) {
  if (!delivery) return { title: "전송 확인 대기", detail: "서버의 전송 기록을 기다립니다.", step: 0 };
  if (delivery.state === "ACKNOWLEDGED" && delivery.processingState === "COMPLETE" && !delivery.cancelled) {
    return { title: "응답 저장과 ACK를 확인했습니다", detail: "서버에서 응답 처리 완료를 확인했습니다.", step: 3 };
  }
  if (delivery.processingState === "ACK_PENDING") return { title: "응답 저장됨 · ACK 확인 대기", detail: "전송 정리 확인이 끝날 때까지 완료로 표시하지 않습니다.", step: 2 };
  if (["SUBMITTED", "RESPONSE_STARTED", "RESPONSE_COMPLETED"].includes(delivery.state)) return { title: "요청 전송됨 · 응답 처리 중", detail: "응답 저장과 ACK는 아직 모두 확인되지 않았습니다.", step: 2 };
  if (delivery.state === "RESERVED") return { title: "탭 연결 확인 중", detail: "아직 전송 완료로 확인되지 않았습니다.", step: 0 };
  return { title: "전송 상태 확인 필요", detail: "실제 처리 결과를 단정할 수 없습니다. 최신 상태와 상세 진단을 확인하세요.", step: 0 };
}
export function renderPreparationTransmission(delivery) {
  const state = preparationTransmissionStatus(delivery), { root, body } = shell(3);
  root.setAttribute("role", "status");
  body.append(el("h2", state.title), el("p", state.detail, "tab-choice-note" + (state.step === 3 ? " success" : "")),
    rail(state.step), el("p", "서버가 확인한 단계만 채워집니다.", "tab-choice-caption"));
  return root;
}
