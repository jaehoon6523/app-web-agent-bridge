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
export function renderPreparationTabChoice({ candidates, hint, operation, allowed, onSubmit, onRefresh, onView, selectedTabId = null, onSelect, rejection = "" }) {
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
    if (send.disabled || submitted || selected === null || !model.enabled) return;
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
  const states = [];
  for (const candidate of candidates) {
    const card = el("div", "", "tab-choice-candidate"), label = el("label"), radio = el("input");
    radio.type = "radio"; radio.name = "preparation-tab-choice"; radio.value = String(candidate.tabId);
    radio.disabled = !model.enabled || Boolean(rejection);
    const copy = el("span", "", "tab-choice-copy"), status = el("span", "눌러서 선택", "tab-choice-state");
    copy.append(el("strong", `탭 ${candidate.tabId}`), el("small", candidate.url === "https://chatgpt.com/" ? "ChatGPT 시작 화면" : "기존 ChatGPT 대화"), el("small", candidate.url));
    const hinted = !model.mismatch && model.hinted === candidate.tabId;
    if (hinted) { card.classList.add("hinted"); status.textContent = "팝업에서 확인한 탭"; }
    states.push({ card, status, hinted, radio, candidate });
    radio.addEventListener("change", () => {
      if (!model.enabled || submitted || rejection) return;
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
        view.disabled = true;
        try { await onView(candidate.tabId); reason.textContent = "탭 화면만 열었습니다. 선택과 전송은 바뀌지 않습니다."; }
        catch { reason.textContent = "탭을 열지 못했습니다. 탭이 닫히거나 바뀌었을 수 있습니다. 최신 상태를 확인하세요."; }
        finally { view.disabled = submitted; }
      });
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
    refresh.disabled = true;
    try { await onRefresh(); }
    catch { notice.hidden = false; notice.textContent = "최신 상태를 불러오지 못했습니다. 다시 조회하세요."; }
    finally { refresh.disabled = false; }
  }); refresh.disabled = operation === "RUNNING";
  overview.append(el("h2", "탭 선택을 보류했습니다"), el("p", "준비 작업과 전송 기록은 그대로입니다."),
    button("탭 선택으로 돌아가기", "tab-choice-refresh", () => { overview.hidden = true; content.hidden = false; }));
  actions.append(back, send); dock.append(reason, actions,
    el("p", "전송 버튼을 누를 때만 보류된 요청을 계속합니다.", "tab-choice-caption"));
  content.append(group, dock, refresh);
  if (operation !== "IDLE" || rejection) { send.hidden = true; reason.hidden = true; }
  if (operation === "RUNNING") { group.hidden = true; dock.hidden = true; content.append(rail(0)); }
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
