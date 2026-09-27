(function registerClaudePageProvider(root) {
  const pageProviders = root.WebBridgePageProviders;
  const SELECTOR_VERSION = "claude-dom-2026-09";
  const SELECTORS = Object.freeze({
    composer:Object.freeze([
      '[data-testid="chat-input"][contenteditable="true"]',
      '[data-testid="chat-input-ssr"][contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ]),
    sendButton:Object.freeze([
      'button[data-testid="chat-input-send"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
    ]),
    stopButton:Object.freeze([
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop Response"]',
    ]),
    streaming:Object.freeze([
      '[data-is-streaming="true"]',
    ]),
    userMessage:Object.freeze([
      '[data-testid="user-message"]',
      '[data-testid="human-message"]',
      '[data-user-message-bubble="true"]',
    ]),
    assistantMessage:Object.freeze([
      '.font-claude-response',
      '[data-testid="chat-message-content"]',
      '[data-testid="ai-message"]',
      '.font-claude-message',
    ]),
    messageContainer:Object.freeze([
      '[data-test-render-count]',
      '[data-message-id]',
      '[data-message-uuid]',
      'article',
    ]),
    messageContent:Object.freeze([
      '.standard-markdown',
      '.progressive-markdown',
      '[data-testid="chat-message-content"]',
      '.font-claude-response',
      '.font-claude-message',
      '.prose',
    ]),
  });
  const selectorTelemetry = new Map();
  const ephemeralMessageIds = new WeakMap();
  let nextEphemeralMessageId = 1;

  class PageProviderError extends Error {
    constructor(code, message, evidence = null) {
      super(message);
      this.name = "PageProviderError";
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
      }, { once:true });
    });
  }

  function canonicalizeUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname !== "claude.ai") return null;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
    if (path !== "/new" && !/^\/chat\/[^/]+$/u.test(path)) return null;
    return `${url.origin}${path}`;
  }

  function conversationIdFromUrl(value) {
    const canonical = canonicalizeUrl(value);
    if (!canonical) return null;
    const parts = new URL(canonical).pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "chat") return null;
    try {
      const id = decodeURIComponent(parts[1]);
      return id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  function assertContract() {
    if (!pageProviders?.register || typeof document?.querySelectorAll !== "function"
      || typeof root.HTMLElement !== "function") {
      throw new PageProviderError("UI_CONTRACT_CHANGED", "Claude page adapter dependencies are unavailable.");
    }
    return true;
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function firstVisible(group) {
    assertContract();
    for (const selector of SELECTORS[group] ?? []) {
      const element = [...document.querySelectorAll(selector)].find(isVisible) ?? null;
      if (element) {
        selectorTelemetry.set(group, selector);
        return { element, selector };
      }
    }
    return null;
  }

  function evidence() {
    return {
      selectorVersion:SELECTOR_VERSION,
      selectorsUsed:Object.fromEntries([...selectorTelemetry.entries()].sort()),
    };
  }

  function resetEvidence() {
    selectorTelemetry.clear();
  }

  async function waitForVisible(group, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = firstVisible(group);
      if (match) return match;
      await sleep(200, signal);
    }
    throw new PageProviderError(
      "UI_CONTRACT_CHANGED",
      `Could not find a visible Claude ${group} element.`,
      evidence(),
    );
  }

  function readConversationIdentity() {
    const conversationUrl = canonicalizeUrl(location.href);
    return {
      provider:"CLAUDE_WEB",
      conversationUrl,
      conversationId:conversationIdFromUrl(conversationUrl),
      title:document.title,
    };
  }

  function identifyPage() {
    const identity = readConversationIdentity();
    return identity.conversationUrl ? identity : null;
  }

  function detectAuthentication() {
    const url = String(location.href).toLowerCase();
    const title = String(document.title || "").toLowerCase();
    const text = String(document.body?.innerText || "").slice(0, 20_000).toLowerCase();
    const combined = `${title}\n${text}`;
    if (/\/(login|oauth|auth)(\/|\?|$)/u.test(url)
      || /log in to claude|sign in to claude|continue with google|continue with email/u.test(combined)) {
      return "SESSION_AUTH_REQUIRED";
    }
    if (/captcha|verify you are human|로봇이 아님/u.test(combined)) return "CAPTCHA_REQUIRED";
    if (/cloudflare|checking your browser|security check|보안 확인/u.test(combined)) return "SECURITY_CHECK_REQUIRED";
    if (/rate limit|too many requests|try again later|usage limit/u.test(combined)) return "RATE_LIMITED";
    if (/something went wrong|internal server error|unable to load|문제가 발생/u.test(combined)) {
      return "CLAUDE_ERROR_PAGE";
    }
    return null;
  }

  function composerText(element) {
    return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : (element.innerText || element.textContent || "");
  }

  function detectComposer() {
    const match = firstVisible("composer");
    return {
      present:Boolean(match),
      empty:match ? composerText(match.element).trim().length === 0 : null,
      element:match?.element ?? null,
    };
  }

  function detectGeneration() {
    return Boolean(firstVisible("stopButton") || firstVisible("streaming"));
  }

  function inspectPageState() {
    assertContract();
    const composer = detectComposer();
    const generating = detectGeneration();
    if (composer.present || generating) {
      return { status:"READY", composerPresent:composer.present };
    }
    return {
      status:detectAuthentication() ?? "UI_CONTRACT_CHANGED",
      composerPresent:false,
    };
  }

  function setNativeValue(element, value) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new PageProviderError("UI_CONTRACT_CHANGED", "Claude composer value setter is unavailable.");
      setter.call(element, value);
      element.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:value }));
      element.dispatchEvent(new Event("change", { bubbles:true }));
      return;
    }
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, value); } catch { inserted = false; }
    if (!inserted || !(element.innerText || element.textContent || "").trim()) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:value }));
    }
    selection.removeAllRanges();
  }

  function messageContainer(node) {
    for (const selector of SELECTORS.messageContainer) {
      const container = node.closest?.(selector);
      if (container) {
        selectorTelemetry.set("messageContainer", selector);
        return container;
      }
    }
    return node;
  }

  function messageId(container) {
    const stable = container.getAttribute?.("data-message-id")
      || container.getAttribute?.("data-message-uuid")
      || container.id
      || null;
    if (stable) return stable;
    let ephemeral = ephemeralMessageIds.get(container);
    if (!ephemeral) {
      ephemeral = `claude-dom:${nextEphemeralMessageId++}`;
      ephemeralMessageIds.set(container, ephemeral);
    }
    return ephemeral;
  }

  function extractAssistantResponse(element) {
    for (const selector of SELECTORS.messageContent) {
      const content = element.matches?.(selector) ? element : element.querySelector?.(selector);
      if (!content) continue;
      selectorTelemetry.set("messageContent", selector);
      return String(content.innerText || content.textContent || "").trim();
    }
    return String(element.innerText || element.textContent || "").trim();
  }

  function readMessages() {
    assertContract();
    const collected = [];
    const seen = new Set();

    function collect(group, role) {
      for (const selector of SELECTORS[group]) {
        for (const node of document.querySelectorAll(selector)) {
          const container = messageContainer(node);
          if (seen.has(container)) continue;
          seen.add(container);
          selectorTelemetry.set(group, selector);
          collected.push({ role, element:container });
        }
      }
    }

    collect("userMessage", "user");
    collect("assistantMessage", "assistant");
    collected.sort((a, b) => {
      if (a.element === b.element) return 0;
      const position = a.element.compareDocumentPosition?.(b.element) ?? 0;
      if (position & 4) return -1;
      if (position & 2) return 1;
      return 0;
    });

    return collected.map((entry, index) => ({
      id:messageId(entry.element),
      role:entry.role,
      text:extractAssistantResponse(entry.element),
      index,
      element:entry.element,
    }));
  }

  function findSendControl() {
    assertContract();
    const match = firstVisible("sendButton");
    if (match) {
      const disabled = Boolean(match.element.disabled)
        || match.element.getAttribute("aria-disabled") === "true";
      return { state:disabled ? "DISABLED" : "ENABLED", selector:match.selector };
    }
    const composer = detectComposer();
    if (composer.present && composer.empty === true) {
      return { state:"CONFIRMED_EMPTY_COMPOSER", selector:null };
    }
    return { state:"UNKNOWN", selector:null };
  }

  async function waitForEnabledSend(signal) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = findSendControl();
      if (state.state === "ENABLED") {
        const match = firstVisible("sendButton");
        if (match && !match.element.disabled && match.element.getAttribute("aria-disabled") !== "true") {
          return match;
        }
      }
      await sleep(150, signal);
    }
    throw new PageProviderError("MESSAGE_SEND_FAILED", "Claude send control did not become enabled.", evidence());
  }

  async function submitPrompt(text, signal, { assertCanMutate } = {}) {
    const composer = await waitForVisible("composer", 30_000, signal);
    assertCanMutate?.();
    composer.element.focus();
    setNativeValue(composer.element, text);
    await sleep(250, signal);
    const sendButton = await waitForEnabledSend(signal);
    assertCanMutate?.();
    sendButton.element.click();
  }

  function cancelGeneration() {
    const stop = firstVisible("stopButton");
    if (!stop) return false;
    stop.element.click();
    return true;
  }

  function mutationRoot() {
    return document.querySelector("main") || document.body;
  }

  pageProviders.register({
    provider:"CLAUDE_WEB",
    rootUrl:"https://claude.ai/new",
    matches:(value) => canonicalizeUrl(value) !== null,
    assertContract,
    identifyPage,
    detectAuthentication,
    detectComposer,
    readConversationIdentity,
    readMessages,
    findSendControl,
    submitPrompt,
    detectGeneration,
    cancelGeneration,
    extractAssistantResponse,
    inspectPageState,
    evidence,
    resetEvidence,
    mutationRoot,
    canonicalizeUrl,
    conversationIdFromUrl,
  });
})(globalThis);
