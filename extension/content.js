const registry = globalThis.ChatGptBridgeSelectors;
const REQUIRED_SELECTOR_GROUPS = Object.freeze([
  "composer",
  "sendButton",
  "stopButton",
  "message",
  "messageContainer",
  "messageContent",
]);
const CHATGPT_HOSTS = new Set(["chatgpt.com"]);
const selectorTelemetry = new Map();

let currentJob = null;

class ContentContractError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = "ContentContractError";
    this.code = code;
    this.evidence = evidence;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function requireSelectorRegistry() {
  if (!registry || typeof registry.version !== "string" || !registry.groups) {
    throw new ContentContractError("UI_CONTRACT_CHANGED", "ChatGPT selector registry is unavailable.");
  }
  for (const group of REQUIRED_SELECTOR_GROUPS) {
    if (!Array.isArray(registry.groups[group]) || registry.groups[group].length === 0) {
      throw new ContentContractError("UI_CONTRACT_CHANGED", `Selector group ${group} is unavailable.`);
    }
  }
  return registry;
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden"
    && style.display !== "none"
    && rect.width > 0
    && rect.height > 0;
}

function firstVisible(group) {
  requireSelectorRegistry();
  const match = registry.resolveFirst(
    group,
    (selector) => document.querySelectorAll(selector),
    isVisible,
  );
  if (match) selectorTelemetry.set(group, match.selector);
  return match;
}

function selectedSelectorEvidence() {
  return {
    selectorVersion: registry?.version ?? null,
    selectorsUsed: Object.fromEntries([...selectorTelemetry.entries()].sort()),
  };
}

async function waitForVisible(group, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = firstVisible(group);
    if (match) return match;
    await sleep(200, signal);
  }
  throw new ContentContractError(
    "UI_CONTRACT_CHANGED",
    `Could not find a visible ${group} element.`,
    selectedSelectorEvidence(),
  );
}

function canonicalConversationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname)) return null;
  url.search = "";
  url.hash = "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.origin}${path}`;
}

function conversationIdFromUrl(value) {
  const canonical = canonicalConversationUrl(value);
  if (!canonical) return null;
  const parts = new URL(canonical).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("c");
  return index >= 0 && index + 1 < parts.length ? decodeURIComponent(parts[index + 1]) : null;
}

function inspectPageState() {
  const url = String(location.href).toLowerCase();
  const title = String(document.title || "").toLowerCase();
  const composer = firstVisible("composer");
  const stop = firstVisible("stopButton");
  if (composer || stop) return { status: "READY", composerPresent: Boolean(composer) };

  const text = String(document.body?.innerText || "").slice(0, 20_000).toLowerCase();
  const combined = `${title}\n${text}`;
  if (/\/(auth|login)(\/|\?|$)/.test(url) || /log in to chatgpt|sign in to chatgpt|로그인.*chatgpt|세션.*만료/.test(combined)) {
    return { status: "SESSION_AUTH_REQUIRED", composerPresent: false };
  }
  if (/captcha|verify you are human|로봇이 아님/.test(combined)) {
    return { status: "CAPTCHA_REQUIRED", composerPresent: false };
  }
  if (/cloudflare|checking your browser|security check|보안 확인/.test(combined)) {
    return { status: "SECURITY_CHECK_REQUIRED", composerPresent: false };
  }
  if (/rate limit|too many requests|요청 한도|try again later/.test(combined)) {
    return { status: "RATE_LIMITED", composerPresent: false };
  }
  if (/something went wrong|internal server error|문제가 발생|unable to load/.test(combined)) {
    return { status: "CHATGPT_ERROR_PAGE", composerPresent: false };
  }
  return { status: "UI_CONTRACT_CHANGED", composerPresent: false };
}

function assertExpectedConversation(expectedUrl, expectedId) {
  const observedUrl = canonicalConversationUrl(location.href);
  const observedId = conversationIdFromUrl(observedUrl);
  if (observedUrl !== expectedUrl || observedId !== expectedId) {
    throw new ContentContractError(
      "MANUAL_INTERVENTION_DETECTED",
      "The bound tab changed to a different conversation.",
      { expectedUrl, observedUrl, expectedId, observedId },
    );
  }
}

function setNativeValue(element, value) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new ContentContractError("UI_CONTRACT_CHANGED", "Composer value setter is unavailable.");
    setter.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  element.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, value);
  } catch {
    inserted = false;
  }
  if (!inserted || !(element.innerText || "").trim()) {
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
  }
  selection.removeAllRanges();
}

function elementText(element) {
  for (const selector of registry.groups.messageContent) {
    const preferred = element.matches?.(selector) ? element : element.querySelector?.(selector);
    if (preferred instanceof HTMLElement) {
      selectorTelemetry.set("messageContent", selector);
      return (preferred.innerText || preferred.textContent || "").trim();
    }
  }
  return (element.innerText || element.textContent || "").trim();
}

function messageContainer(roleNode) {
  for (const selector of registry.groups.messageContainer) {
    const container = roleNode.closest(selector);
    if (container) {
      selectorTelemetry.set("messageContainer", selector);
      return container;
    }
  }
  return roleNode;
}

function messageId(container) {
  return container.getAttribute("data-message-id")
    || container.getAttribute("data-testid")
    || container.id
    || null;
}

function messageSnapshot() {
  requireSelectorRegistry();
  let roleNodes = [];
  for (const selector of registry.groups.message) {
    roleNodes = [...document.querySelectorAll(selector)].filter((node) => {
      const role = node.getAttribute("data-message-author-role")
        || node.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role");
      return role === "user" || role === "assistant";
    });
    if (roleNodes.length) {
      selectorTelemetry.set("message", selector);
      break;
    }
  }
  const seen = new Set();
  const messages = [];
  roleNodes.forEach((roleNode, index) => {
    const container = messageContainer(roleNode);
    if (seen.has(container)) return;
    seen.add(container);
    const role = roleNode.getAttribute("data-message-author-role")
      || roleNode.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role");
    messages.push({
      id: messageId(container),
      role,
      text: elementText(container),
      index,
      element: container,
    });
  });
  return messages;
}

function parseMarkers(text) {
  const value = String(text);
  const controller = [...value.matchAll(/^\[controller_message_id:([^\]\r\n]+)\]$/gm)];
  const run = [...value.matchAll(/^\[run_id:([^\]\r\n]+)\]$/gm)];
  return controller.length === 1 && run.length === 1
    ? { controllerMessageId: controller[0][1], runId: run[0][1] }
    : null;
}

function isExpectedUser(message, expected) {
  if (message.role !== "user") return false;
  const markers = parseMarkers(message.text);
  return markers?.controllerMessageId === expected.controllerMessageId
    && markers?.runId === expected.runId;
}

async function waitForEnabledSend(signal) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = firstVisible("sendButton");
    if (
      match
      && !match.element.disabled
      && match.element.getAttribute("aria-disabled") !== "true"
    ) return match;
    await sleep(150, signal);
  }
  throw new ContentContractError(
    "MESSAGE_SEND_FAILED",
    "ChatGPT send control did not become enabled.",
    selectedSelectorEvidence(),
  );
}

async function submitPrompt(text, signal) {
  const composer = await waitForVisible("composer", 30_000, signal);
  composer.element.focus();
  setNativeValue(composer.element, text);
  await sleep(250, signal);
  const sendButton = await waitForEnabledSend(signal);
  sendButton.element.click();
}

async function waitForControlledUserMessage(expected, baseline, signal) {
  const deadline = Date.now() + 15_000;
  const baselineUserIds = new Set(baseline.filter((message) => message.role === "user").map((message) => message.id));
  const baselineUserElements = new Set(
    baseline.filter((message) => message.role === "user").map((message) => message.element),
  );
  while (Date.now() < deadline) {
    assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
    const messages = messageSnapshot();
    const matches = messages.filter((message) => isExpectedUser(message, expected));
    if (matches.length > 1) {
      throw new ContentContractError("AMBIGUOUS_PROMPT_BINDING", "The controlled prompt appears more than once.");
    }
    const unexpected = messages.find((message) => (
      message.role === "user"
      && !baselineUserElements.has(message.element)
      && (!message.id || !baselineUserIds.has(message.id))
      && !isExpectedUser(message, expected)
    ));
    if (unexpected) {
      throw new ContentContractError(
        "MANUAL_INTERVENTION_DETECTED",
        "A manual user message appeared while the controlled prompt was being submitted.",
        { observedMessageId: unexpected.id },
      );
    }
    if (matches.length === 1) {
      if (!matches[0].id) {
        throw new ContentContractError(
          "AMBIGUOUS_PROMPT_BINDING",
          "The controlled user message has no stable DOM message ID.",
        );
      }
      return matches[0];
    }
    await sleep(200, signal);
  }
  throw new ContentContractError("MESSAGE_SEND_FAILED", "The controlled user message was not observed after send.");
}

function locateAssociatedAssistant(
  messages,
  expected,
  userMessageId,
  baselineAssistantIds,
  baselineUserIds,
  baselineUserElements,
) {
  const userIndex = messages.findIndex((message) => (
    message.id === userMessageId && isExpectedUser(message, expected)
  ));
  const unexpectedUser = messages.find((message) => (
    message.role === "user"
    && message.id !== userMessageId
    && !isExpectedUser(message, expected)
    && !baselineUserElements.has(message.element)
    && (!message.id || !baselineUserIds.has(message.id))
    && (userIndex < 0 || message.index > userIndex)
  ));
  if (unexpectedUser) {
    return {
      status: "MANUAL_INTERVENTION_DETECTED",
      observedMessageId: unexpectedUser.id,
    };
  }
  if (userIndex >= 0) {
    const candidates = messages.filter((message) => message.role === "assistant" && message.index > userIndex);
    if (candidates.length > 1) return { status: "AMBIGUOUS" };
    if (candidates.length === 1) return { status: "MATCHED", message: candidates[0], virtualizedUser: false };
    return { status: "WAITING" };
  }

  // Virtualized histories may remove the user turn. Only one new assistant DOM ID is safe enough for HEURISTIC evidence.
  const candidates = messages.filter((message) => (
    message.role === "assistant" && message.id && !baselineAssistantIds.has(message.id)
  ));
  if (candidates.length > 1) return { status: "AMBIGUOUS" };
  if (candidates.length === 1) return { status: "MATCHED", message: candidates[0], virtualizedUser: true };
  return { status: "WAITING" };
}

function sendButtonEnabledState() {
  const match = firstVisible("sendButton");
  if (!match) return null;
  return !match.element.disabled && match.element.getAttribute("aria-disabled") !== "true";
}

async function waitForAssistantResponse({ expected, baseline, userMessage, timeoutMs, stableMs, signal, requestId }) {
  const deadline = Date.now() + timeoutMs;
  const baselineAssistantIds = new Set(
    baseline.filter((message) => message.role === "assistant" && message.id).map((message) => message.id),
  );
  const baselineUserIds = new Set(
    baseline.filter((message) => message.role === "user" && message.id).map((message) => message.id),
  );
  const baselineUserElements = new Set(
    baseline.filter((message) => message.role === "user").map((message) => message.element),
  );
  let assistantId = null;
  let assistantElement = null;
  let lastText = "";
  let lastTextChangeAt = Date.now();
  let lastProgressAt = 0;
  let virtualizedUser = false;
  let lastDomMutationAt = Date.now();
  const observer = new MutationObserver(() => {
    lastDomMutationAt = Date.now();
  });
  observer.observe(document.querySelector("main") || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  try {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
      const page = inspectPageState();
      if (page.status !== "READY") {
        throw new ContentContractError(page.status, `ChatGPT page is not ready (${page.status}).`);
      }
      const messages = messageSnapshot();
      const association = locateAssociatedAssistant(
        messages,
        expected,
        userMessage.id,
        baselineAssistantIds,
        baselineUserIds,
        baselineUserElements,
      );
      if (association.status === "MANUAL_INTERVENTION_DETECTED") {
        throw new ContentContractError(
          "MANUAL_INTERVENTION_DETECTED",
          "A manual user message appeared in the bound conversation.",
          { observedMessageId: association.observedMessageId },
        );
      }
      if (association.status === "AMBIGUOUS") {
        throw new ContentContractError(
          "AMBIGUOUS_COMPLETION",
          "More than one assistant message could be associated with the controlled prompt.",
        );
      }
      if (association.status === "MATCHED") {
        const candidate = association.message;
        if (!candidate.id) {
          throw new ContentContractError("AMBIGUOUS_COMPLETION", "Assistant response has no stable DOM message ID.");
        }
        if (assistantId && assistantId !== candidate.id) {
          throw new ContentContractError("AMBIGUOUS_COMPLETION", "Associated assistant message ID changed.");
        }
        assistantId = candidate.id;
        assistantElement = candidate.element;
        virtualizedUser ||= association.virtualizedUser;
        const text = elementText(assistantElement);
        if (text !== lastText) {
          lastText = text;
          lastTextChangeAt = Date.now();
        }
      }

      if (assistantId && lastText && Date.now() - lastProgressAt >= 500) {
        lastProgressAt = Date.now();
        void chrome.runtime.sendMessage({
          type: "agent.progress",
          requestId,
          payload: {
            text: lastText,
            evidence: {
              userMessageId: userMessage.id,
              assistantMessageId: assistantId,
              conversationUrl: canonicalConversationUrl(location.href),
            },
          },
        }).catch(() => {});
      }

      const stopVisible = Boolean(firstVisible("stopButton"));
      const sendEnabled = sendButtonEnabledState();
      const stable = assistantId
        && lastText
        && Date.now() - lastTextChangeAt >= stableMs
        && Date.now() - lastDomMutationAt >= stableMs;
      if (stable && !stopVisible && (sendEnabled === true || sendEnabled === null)) {
        const confidence = virtualizedUser || sendEnabled === null
          ? "HEURISTIC"
          : "CONFIRMED_BY_UI_STATE";
        return {
          text: lastText,
          confidence,
          evidence: {
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
            conversationUrl: canonicalConversationUrl(location.href),
            conversationId: conversationIdFromUrl(location.href),
            responseAssociation: virtualizedUser ? "VIRTUALIZED_USER_HEURISTIC" : "DIRECT_DOM_ORDER",
            stopButtonVisible: stopVisible,
            sendButtonEnabled: sendEnabled,
            stableForMs: Math.min(Date.now() - lastTextChangeAt, Date.now() - lastDomMutationAt),
            ...selectedSelectorEvidence(),
          },
        };
      }
      await sleep(250, signal);
    }
  } finally {
    observer.disconnect();
  }

  throw new ContentContractError(
    assistantId ? "AMBIGUOUS_COMPLETION" : "RESPONSE_TIMEOUT",
    assistantId
      ? "Assistant output was observed, but completion could not be confirmed."
      : `ChatGPT response did not appear within ${timeoutMs} ms.`,
    {
      userMessageId: userMessage.id,
      assistantMessageId: assistantId,
      conversationUrl: canonicalConversationUrl(location.href),
      ...selectedSelectorEvidence(),
    },
  );
}

async function executePrompt(requestId, payload) {
  if (currentJob) throw new ContentContractError("WEB_SESSION_BUSY", "Another ChatGPT prompt is active in this tab.");
  requireSelectorRegistry();
  const text = String(payload?.text || "");
  const expected = {
    controllerMessageId: String(payload?.controllerMessageId || ""),
    runId: String(payload?.runId || ""),
    expectedConversationUrl: canonicalConversationUrl(payload?.expectedConversationUrl),
    expectedConversationId: String(payload?.expectedConversationId || ""),
  };
  if (!text.trim() || !expected.controllerMessageId || !expected.runId || !expected.expectedConversationUrl || !expected.expectedConversationId) {
    throw new ContentContractError("INVALID_DELIVERY", "Prompt and exact delivery binding are required.");
  }
  const markers = parseMarkers(text);
  if (
    markers?.controllerMessageId !== expected.controllerMessageId
    || markers?.runId !== expected.runId
  ) {
    throw new ContentContractError("DELIVERY_MARKER_MISMATCH", "Prompt markers do not match the delivery identity.");
  }
  assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
  const page = inspectPageState();
  if (page.status !== "READY") {
    throw new ContentContractError(page.status, `ChatGPT page is not ready (${page.status}).`);
  }

  const abortController = new AbortController();
  currentJob = { requestId, abortController, expected };
  selectorTelemetry.clear();
  try {
    const baseline = messageSnapshot();
    await submitPrompt(text, abortController.signal);
    const userMessage = await waitForControlledUserMessage(expected, baseline, abortController.signal);
    return await waitForAssistantResponse({
      expected,
      baseline,
      userMessage,
      timeoutMs: Number.isSafeInteger(payload.timeoutMs) ? payload.timeoutMs : 300_000,
      stableMs: Number.isSafeInteger(payload.stableMs) ? Math.max(payload.stableMs, 1000) : 3500,
      signal: abortController.signal,
      requestId,
    });
  } catch (error) {
    if (error?.code === "MANUAL_INTERVENTION_DETECTED") {
      void chrome.runtime.sendMessage({
        type: "agent.manualIntervention",
        requestId,
        payload: {
          code: error.code,
          message: error.message,
          evidence: error.evidence,
        },
      }).catch(() => {});
    }
    throw error;
  } finally {
    currentJob = null;
  }
}

function cancelCurrentJob(requestId) {
  if (!currentJob || (requestId && currentJob.requestId !== requestId)) return false;
  currentJob.abortController.abort();
  firstVisible("stopButton")?.element.click();
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "agent.ping") {
    let page;
    try {
      requireSelectorRegistry();
      page = inspectPageState();
    } catch (error) {
      page = { status: error.code || "UI_CONTRACT_CHANGED", composerPresent: false };
    }
    sendResponse({
      ok: true,
      url: canonicalConversationUrl(location.href),
      conversationId: conversationIdFromUrl(location.href),
      title: document.title,
      ready: page.status === "READY" && page.composerPresent,
      pageStatus: page.status,
      selectorVersion: registry?.version ?? null,
    });
    return false;
  }

  if (message?.type === "agent.cancel") {
    sendResponse({ ok: true, cancelled: cancelCurrentJob(message.requestId) });
    return false;
  }

  if (message?.type === "agent.prompt") {
    void executePrompt(message.requestId, message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        if (error?.name === "AbortError") {
          sendResponse({ ok: false, code: "TURN_INTERRUPTED", error: "Prompt cancelled." });
        } else {
          sendResponse({
            ok: false,
            code: error?.code || "CONTENT_SCRIPT_FAILURE",
            error: error?.message || String(error),
            evidence: error?.evidence ?? selectedSelectorEvidence(),
            confidence: error?.code === "AMBIGUOUS_COMPLETION" ? "AMBIGUOUS" : null,
          });
        }
      });
    return true;
  }

  return false;
});
