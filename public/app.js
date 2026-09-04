import {
  ACTORS,
  buildCommandEnvelope,
  classifyMessageOrigin,
  deliveryState,
  normalizeDashboardState,
  selectMessagesForActor,
  sessionFieldRows,
  statusKind,
} from "./dashboard-model.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  dashboardStatus: $("#dashboardStatus"),
  runStatus: $("#runStatus"),
  runVersion: $("#runVersion"),
  errorBanner: $("#errorBanner"),
  objective: $("#objective"),
  maxTurns: $("#maxTurns"),
  startRun: $("#startRun"),
  pauseRun: $("#pauseRun"),
  resumeRun: $("#resumeRun"),
  stopRun: $("#stopRun"),
  interruptRun: $("#interruptRun"),
  exportEvidence: $("#exportEvidence"),
  steerForm: $("#steerForm"),
  steerActor: $("#steerActor"),
  steerText: $("#steerText"),
  sendSteer: $("#sendSteer"),
  runMeta: $("#runMeta"),
  codexStatus: $("#codexStatus"),
  chatgptWebStatus: $("#chatgptWebStatus"),
  codexSessionFields: $("#codexSessionFields"),
  chatgptWebSessionFields: $("#chatgptWebSessionFields"),
  codexMessages: $("#codexMessages"),
  chatgptWebMessages: $("#chatgptWebMessages"),
  codexDraft: $("#codexDraft"),
  chatgptWebDraft: $("#chatgptWebDraft"),
  focusWebSession: $("#focusWebSession"),
  rebindWebSession: $("#rebindWebSession"),
  deliveries: $("#deliveries"),
  approvals: $("#approvals"),
  controllerTimeline: $("#controllerTimeline"),
  timelineCursor: $("#timelineCursor"),
  toast: $("#toast"),
};

let socket = null;
let state = normalizeDashboardState(null);
let controllerAvailable = false;
let reconnectDelay = 1_000;
let reconnectTimer = null;
let toastTimer = null;
const drafts = new Map(ACTORS.map((actor) => [actor, ""]));
const pendingCommands = new Map();

function requestId() {
  return `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function setBadge(element, text, kind = "neutral") {
  element.textContent = text;
  element.className = `badge ${kind}`;
}

function showToast(text, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 4_200);
}

function setControllerUnavailable(message) {
  controllerAvailable = false;
  setBadge(elements.dashboardStatus, "오케스트레이션 API 미연결", "bad");
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove("hidden");
  render();
}

function setControllerAvailable() {
  controllerAvailable = true;
  reconnectDelay = 1_000;
  setBadge(elements.dashboardStatus, "Controller 연결됨", "ok");
  elements.errorBanner.classList.add("hidden");
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(15_000, Math.ceil(reconnectDelay * 1.8));
}

async function explainUnavailable() {
  try {
    const response = await fetch("/api/state", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) return;
    const payload = await response.json().catch(() => ({}));
    setControllerUnavailable(
      payload.error || `Controller state API가 HTTP ${response.status}를 반환했습니다.`,
    );
  } catch {
    setControllerUnavailable("Controller state API에 연결할 수 없습니다.");
  }
}

function command(type, payload = {}, { allowWithoutRun = false } = {}) {
  if (!controllerAvailable || socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Controller canonical command channel is unavailable."));
  }
  if (!allowWithoutRun && !state.run) {
    return Promise.reject(new Error(`${type} requires a canonical run.`));
  }

  const envelope = buildCommandEnvelope({
    type,
    requestId: requestId(),
    run: state.run,
    payload,
    allowWithoutRun,
  });

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(envelope.requestId);
      reject(new Error(`${type} command timed out.`));
    }, 120_000);
    pendingCommands.set(envelope.requestId, { resolve, reject, timer });
  });
  socket.send(JSON.stringify(envelope));
  return promise;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws/dashboard`);
  setBadge(elements.dashboardStatus, "Controller 확인 중", "busy");

  socket.addEventListener("open", () => {
    const envelope = buildCommandEnvelope({
      type: "state.get",
      requestId: requestId(),
      run: state.run,
      payload: {},
      allowWithoutRun: true,
    });
    socket.send(JSON.stringify(envelope));
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      setControllerUnavailable("Controller가 유효한 JSON event를 반환하지 않았습니다.");
      return;
    }

    if (message.type === "state.snapshot") {
      try {
        state = normalizeDashboardState(message.payload);
        setControllerAvailable();
        render();
      } catch (error) {
        setControllerUnavailable(`Controller state contract 오류: ${error.message}`);
      }
      return;
    }

    if (message.type === "agent.delta") {
      const actor = message.payload?.actor;
      if (!ACTORS.includes(actor)) return;
      drafts.set(
        actor,
        String(message.payload?.payload?.accumulated ?? message.payload?.payload?.text ?? ""),
      );
      renderDrafts();
      return;
    }

    if (message.type === "command.result" || message.type === "command.error") {
      const pending = pendingCommands.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommands.delete(message.requestId);
      if (message.type === "command.error") {
        pending.reject(new Error(message.payload?.message || "Controller command failed."));
      } else {
        pending.resolve(message.payload);
      }
    }
  });

  socket.addEventListener("close", () => {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Controller disconnected before acknowledging the command."));
    }
    pendingCommands.clear();
    void explainUnavailable();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setBadge(elements.dashboardStatus, "Controller 연결 오류", "bad");
  });
}

function render() {
  const { run } = state;
  const codex = state.sessions.get("CODEX_AGENT");
  const chatgptWeb = state.sessions.get("CHATGPT_WEB_AGENT");

  setBadge(elements.runStatus, run?.phase || "실행 없음", statusKind(run?.phase));
  setBadge(elements.runVersion, `version ${run?.version ?? "—"}`, "neutral");
  setBadge(elements.codexStatus, codex?.status || "NOT_AVAILABLE", statusKind(codex?.status));
  setBadge(
    elements.chatgptWebStatus,
    chatgptWeb?.status || "NOT_AVAILABLE",
    statusKind(chatgptWeb?.status),
  );

  renderSessionFields(elements.codexSessionFields, sessionFieldRows("CODEX_AGENT", codex));
  renderSessionFields(
    elements.chatgptWebSessionFields,
    sessionFieldRows("CHATGPT_WEB_AGENT", chatgptWeb),
  );

  elements.runMeta.textContent = run
    ? [
        run.runId,
        `turn ${run.currentTurn}/${run.maxTurns}`,
        run.activeActor ? `active ${run.activeActor}` : "active —",
        run.paused ? "paused" : null,
        run.blocker?.type ? `blocker ${run.blocker.type}` : null,
      ].filter(Boolean).join(" · ")
    : "canonical run 없음";

  const phase = run?.phase || "";
  const terminal = ["COMPLETE", "FAILED", "CANCELLED"].includes(phase);
  const active = Boolean(run && !terminal);
  const hasActiveTurn = phase.endsWith("_TURN_RUNNING") || Boolean(run?.activeActor);
  const canMutate = controllerAvailable;

  elements.startRun.disabled = !canMutate || active;
  elements.pauseRun.disabled = !canMutate || !active || run.paused;
  elements.resumeRun.disabled = !canMutate || !active || !run.paused;
  elements.stopRun.disabled = !canMutate || !active;
  elements.interruptRun.disabled = !canMutate || !active || !hasActiveTurn;
  elements.exportEvidence.disabled = !canMutate || !run || !state.commandCapabilities.has("evidence.export");
  elements.steerText.disabled = !canMutate || !active || !hasActiveTurn;
  elements.sendSteer.disabled = elements.steerText.disabled;
  elements.focusWebSession.disabled = !canMutate || hasActiveTurn || !chatgptWeb?.externalLocator;
  elements.rebindWebSession.disabled = !canMutate || hasActiveTurn || !run;

  renderMessages("CODEX_AGENT", elements.codexMessages);
  renderMessages("CHATGPT_WEB_AGENT", elements.chatgptWebMessages);
  renderDrafts();
  renderDeliveries();
  renderApprovals();
  renderTimeline();
}

function renderSessionFields(container, rows) {
  container.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "—";
    container.append(dt, dd);
  }
}

function renderMessages(actor, container) {
  const messages = selectMessagesForActor(state.messages, actor, state.run?.runId);
  const keepBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  container.replaceChildren();

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = actor === "CODEX_AGENT"
      ? "Codex app-server thread의 canonical transcript가 여기에 표시됩니다."
      : "결박된 ChatGPT conversation의 canonical transcript가 여기에 표시됩니다.";
    container.append(empty);
    return;
  }

  for (const message of messages.slice(-100)) {
    const origin = classifyMessageOrigin(message);
    const article = document.createElement("article");
    article.className = `message origin-${origin.cssClass}`;

    const head = document.createElement("div");
    head.className = "message-head";
    const identity = document.createElement("span");
    identity.textContent = `${origin.label} · ${message.kind || "MESSAGE"}`;
    const metadata = document.createElement("span");
    metadata.textContent = [
      message.sequence != null ? `#${message.sequence}` : null,
      message.deliveryState || message.delivery?.state || null,
      message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : null,
    ].filter(Boolean).join(" · ");
    head.append(identity, metadata);

    const body = document.createElement("pre");
    body.className = "message-body";
    body.textContent = String(message.content ?? message.text ?? "");
    article.append(head, body);

    const facts = [
      ["message ID", message.messageId],
      ["content hash", message.contentHash],
      ["reply to", message.inReplyTo],
      ["proposal", message.normalizedPacket?.proposal_sha256
        || message.normalizedPacket?.accepted_proposal_sha256
        || message.normalizedPacket?.target_proposal_sha256],
    ].filter(([, value]) => value != null);
    if (facts.length || message.normalizedPacket || message.rawContent) {
      const details = document.createElement("details");
      details.className = "message-details";
      const summary = document.createElement("summary");
      summary.textContent = "Raw / normalized facts";
      details.append(summary);
      for (const [label, value] of facts) {
        const row = document.createElement("div");
        row.textContent = `${label}: ${value}`;
        details.append(row);
      }
      if (message.normalizedPacket) {
        const packet = document.createElement("pre");
        packet.textContent = JSON.stringify(message.normalizedPacket, null, 2);
        details.append(packet);
      }
      article.append(details);
    }
    container.append(article);
  }
  if (keepBottom) container.scrollTop = container.scrollHeight;
}

function renderDrafts() {
  for (const [actor, element] of [
    ["CODEX_AGENT", elements.codexDraft],
    ["CHATGPT_WEB_AGENT", elements.chatgptWebDraft],
  ]) {
    const text = drafts.get(actor) || "";
    element.textContent = text;
    element.classList.toggle("hidden", !text);
  }
}

function renderDeliveries() {
  elements.deliveries.replaceChildren();
  if (!state.deliveries.length) {
    elements.deliveries.append(emptyLine("delivery projection 없음"));
    return;
  }
  for (const delivery of state.deliveries) {
    const card = document.createElement("article");
    card.className = "data-card delivery-card";
    const stateName = deliveryState(delivery);
    const title = document.createElement("div");
    title.className = "data-card-title";
    const label = document.createElement("strong");
    label.textContent = delivery.deliveryId || "delivery";
    const badge = document.createElement("span");
    badge.className = `badge ${statusKind(stateName)}`;
    badge.textContent = stateName;
    title.append(label, badge);
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [delivery.actor, delivery.messageId, `attempt ${delivery.attemptCount ?? 0}`]
      .filter(Boolean).join(" · ");
    card.append(title, meta);
    if (stateName === "FAILED") {
      const button = document.createElement("button");
      button.className = "small danger";
      button.textContent = "Retry failed delivery";
      button.disabled = !controllerAvailable || !state.run;
      button.addEventListener("click", () => {
        void execute("delivery.retry", { deliveryId: delivery.deliveryId }, "재시도 요청을 보냈습니다.");
      });
      card.append(button);
    } else if (stateName === "AMBIGUOUS") {
      const warning = document.createElement("p");
      warning.className = "meta warning";
      warning.textContent = "Recovery decision required · automatic retry blocked";
      card.append(warning);
    }
    elements.deliveries.append(card);
  }
}

function renderApprovals() {
  elements.approvals.replaceChildren();
  if (!state.approvals.length) {
    elements.approvals.append(emptyLine("대기 중인 승인 없음"));
    return;
  }
  for (const approval of state.approvals) {
    const card = document.createElement("article");
    card.className = "data-card approval";
    const title = document.createElement("strong");
    title.textContent = approval.type || approval.method || "APPROVAL";
    const detail = document.createElement("pre");
    detail.textContent = [
      approval.approvalId ? `approval: ${approval.approvalId}` : null,
      approval.scopeHash ? `scope hash: ${approval.scopeHash}` : null,
      approval.reason ? `reason: ${approval.reason}` : null,
      approval.actor ? `actor: ${approval.actor}` : null,
      approval.turnId ? `turn: ${approval.turnId}` : null,
    ].filter(Boolean).join("\n") || "Controller가 상세 정보를 제공하지 않았습니다.";
    const actions = document.createElement("div");
    actions.className = "buttons";
    for (const [decision, label] of [["ACCEPT", "승인"], ["DECLINE", "거절"], ["CANCEL", "취소"]]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.disabled = !controllerAvailable || !state.run;
      if (decision !== "ACCEPT") button.classList.add("danger");
      button.addEventListener("click", () => {
        void execute(
          "approval.resolve",
          { approvalId: approval.approvalId, decision, scopeHash: approval.scopeHash },
          "승인 결정을 보냈습니다.",
        );
      });
      actions.append(button);
    }
    card.append(title, detail, actions);
    elements.approvals.append(card);
  }
}

function renderTimeline() {
  elements.controllerTimeline.replaceChildren();
  const events = [...state.events].sort((left, right) => left.sequence - right.sequence);
  const last = events.at(-1);
  elements.timelineCursor.textContent = `sequence ${last?.sequence ?? "—"}`;
  if (!events.length) {
    elements.controllerTimeline.append(emptyLine("canonical event를 기다리는 중입니다."));
    return;
  }
  for (const event of events.slice(-150).reverse()) {
    const article = document.createElement("article");
    article.className = "timeline-event";
    const marker = document.createElement("span");
    marker.className = "timeline-sequence";
    marker.textContent = `#${event.sequence}`;
    const body = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = event.eventType || event.type || "EVENT";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [event.actor, event.createdAt, event.eventHash].filter(Boolean).join(" · ");
    body.append(name, meta);
    article.append(marker, body);
    elements.controllerTimeline.append(article);
  }
}

function emptyLine(text) {
  const element = document.createElement("p");
  element.className = "empty-inline";
  element.textContent = text;
  return element;
}

async function execute(type, payload, successText, options) {
  try {
    const result = await command(type, payload, options);
    if (successText) showToast(successText);
    return result;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  }
}

elements.startRun.addEventListener("click", () => {
  const objective = elements.objective.value.trim();
  if (!objective) {
    showToast("objective를 입력하세요.", true);
    return;
  }
  void execute("run.start", {
    mode: "DISCUSSION",
    objective,
    maxTurns: Number(elements.maxTurns.value),
  }, "실행 시작 요청을 보냈습니다.", { allowWithoutRun: true }).catch(() => {});
});

elements.pauseRun.addEventListener("click", () => {
  void execute("run.pause", {}, "다음 delivery 전에 일시정지합니다.").catch(() => {});
});
elements.resumeRun.addEventListener("click", () => {
  void execute("run.resume", {}, "재개 요청을 보냈습니다.").catch(() => {});
});
elements.stopRun.addEventListener("click", () => {
  void execute("run.stop", {}, "run 중단 요청을 보냈습니다.").catch(() => {});
});
elements.interruptRun.addEventListener("click", () => {
  void execute("run.interrupt", {
    actor: state.run?.activeActor,
    turnId: state.sessions.get(state.run?.activeActor)?.activeTurnId || null,
  }, "active turn interrupt 요청을 보냈습니다.").catch(() => {});
});
elements.exportEvidence.addEventListener("click", () => {
  void execute("evidence.export", {}, "evidence export 요청을 보냈습니다.").catch(() => {});
});
elements.focusWebSession.addEventListener("click", () => {
  void execute("web.session.focus", {
    sessionId: state.sessions.get("CHATGPT_WEB_AGENT")?.sessionId,
  }, "결박된 ChatGPT 탭을 여는 요청을 보냈습니다.").catch(() => {});
});
elements.rebindWebSession.addEventListener("click", () => {
  void execute("web.session.rebind", {
    sessionId: state.sessions.get("CHATGPT_WEB_AGENT")?.sessionId,
  }, "session rebind 요청을 보냈습니다.").catch(() => {});
});
elements.steerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.steerText.value.trim();
  if (!text) return;
  void execute("run.steer", {
    actor: elements.steerActor.value,
    text,
    turnId: state.sessions.get(elements.steerActor.value)?.activeTurnId || null,
  }, "사람의 steer 메시지를 보냈습니다.")
    .then(() => { elements.steerText.value = ""; })
    .catch(() => {});
});

render();
void explainUnavailable();
connect();
