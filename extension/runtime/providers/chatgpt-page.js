(function registerChatGptPageProvider(root) {
  if (root.WebBridgePageProviders?.provider("CHATGPT_WEB")) return;
  const selectorRegistry = root.ChatGptBridgeSelectors;
  const responseText = root.ChatGptBridgeResponseText;
  const pageProviders = root.WebBridgePageProviders;
  const REQUIRED_SELECTOR_GROUPS = Object.freeze([
    "composer",
    "sendButton",
    "stopButton",
    "message",
    "messageContainer",
    "messageContent",
  ]);
  const selectorTelemetry = new Map();

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
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
    return `${url.origin}${path}`;
  }

  function conversationIdFromUrl(value) {
    const canonical = canonicalizeUrl(value);
    if (!canonical) return null;
    const parts = new URL(canonical).pathname.split("/").filter(Boolean);
    const index = Math.max(parts.lastIndexOf("c"), parts.lastIndexOf("uc"));
    if (index < 0 || index + 1 >= parts.length) return null;
    const id = decodeURIComponent(parts[index + 1]);
    return id.length > 0 && !/^(?:WEB|local-chatgpt):/iu.test(id) ? id : null;
  }

  function assertContract() {
    if (!pageProviders?.register || !selectorRegistry || typeof selectorRegistry.version !== "string"
      || !selectorRegistry.groups || typeof responseText?.elementText !== "function") {
      throw new PageProviderError("UI_CONTRACT_CHANGED", "ChatGPT page adapter dependencies are unavailable.");
    }
    for (const group of REQUIRED_SELECTOR_GROUPS) {
      if (!Array.isArray(selectorRegistry.groups[group]) || selectorRegistry.groups[group].length === 0) {
        throw new PageProviderError("UI_CONTRACT_CHANGED", `Selector group ${group} is unavailable.`);
      }
    }
    if (typeof selectorRegistry.resolveSendButtonState !== "function") {
      throw new PageProviderError("UI_CONTRACT_CHANGED", "Send-control state resolver is unavailable.");
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
    if (group === "composer") {
      const match = resolveComposer();
      if (match) selectorTelemetry.set(group, match.selector);
      return match;
    }
    if (group === "sendButton") {
      const composer = resolveComposer();
      if (composer?.fallbackContainer) return fallbackSend(composer.fallbackContainer);
    }
    const match = selectorRegistry.resolveFirst(
      group,
      (selector) => document.querySelectorAll(selector),
      isVisible,
    );
    if (match) selectorTelemetry.set(group, match.selector);
    return match;
  }

  const FALLBACK_COMPOSER = "[contenteditable='true'][role='textbox']";
  const FALLBACK_SEND_SELECTORS = Object.freeze([
    "button[data-testid='send-button']", "button[aria-label='Send prompt']",
    "button[aria-label='Send message']", "button[aria-label='보내기']",
  ]);

  function fallbackSend(container) {
    const elements = new Map();
    for (const selector of FALLBACK_SEND_SELECTORS) {
      for (const element of container.querySelectorAll(selector)) {
        if (isVisible(element)) elements.set(element, { element, selector });
      }
    }
    // A generic submit button and multiple distinct send controls stay blocked.
    const match = elements.size === 1 ? [...elements.values()][0] : null;
    if (match) selectorTelemetry.set("sendButton", match.selector);
    return match;
  }

  function fallbackCandidate(element) {
    if (element.closest?.("[role='dialog'], [role='navigation'], nav, [data-message-author-role]")
      || !isVisible(element) || ["aria-readonly", "aria-disabled", "aria-hidden"].some(name => element.getAttribute?.(name) === "true")) return null;
    const composer = element.closest?.("[data-testid='composer'], #composer, #composer-container");
    if (composer) return { element, fallbackContainer:composer, reason:"KNOWN_COMPOSER_CONTAINER" };
    const form = element.closest?.("form");
    if (!form || !element.closest?.("main, [role='main']")) return null;
    const controls = [...FALLBACK_SEND_SELECTORS, ...(selectorRegistry.groups.dictationButton ?? []),
      ...selectorRegistry.groups.stopButton].filter(selector => !selector.includes("aria-label*="));
    if (!controls.some(selector => [...form.querySelectorAll(selector)].some(isVisible))) return null;
    return { element, fallbackContainer:form, reason:"PROMPT_CONTROL_FORM" };
  }

  function fallbackCandidates() {
    return [...document.querySelectorAll(FALLBACK_COMPOSER)].map(fallbackCandidate).filter(Boolean);
  }

  function resolveComposer() {
    const registered = selectorRegistry.resolveFirst("composer", selector => document.querySelectorAll(selector), isVisible);
    if (registered) return registered;
    const candidates = fallbackCandidates();
    return candidates.length === 1 ? { ...candidates[0], selector:FALLBACK_COMPOSER } : null;
  }

  function evidence() {
    return {
      selectorVersion: selectorRegistry?.version ?? null,
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
      `Could not find a visible ${group} element.`,
      evidence(),
    );
  }

  function readConversationIdentity() {
    const conversationUrl = canonicalizeUrl(location.href);
    return {
      provider:"CHATGPT_WEB",
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
    if (/\/(auth|login)(\/|\?|$)/.test(url)
      || /log in to chatgpt|sign in to chatgpt|로그인.*chatgpt|세션.*만료/.test(combined)) {
      return "SESSION_AUTH_REQUIRED";
    }
    if (/captcha|verify you are human|로봇이 아님/.test(combined)) return "CAPTCHA_REQUIRED";
    if (/cloudflare|checking your browser|security check|보안 확인/.test(combined)) return "SECURITY_CHECK_REQUIRED";
    if (/rate limit|too many requests|요청 한도|try again later/.test(combined)) return "RATE_LIMITED";
    if (/something went wrong|internal server error|문제가 발생|unable to load/.test(combined)) {
      return "CHATGPT_ERROR_PAGE";
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
    return Boolean(firstVisible("stopButton"));
  }

  function assistantTurn(element) {
    if (!element?.isConnected) return null;
    const selector = "[data-talvt-turn-state]";
    const enclosingTurn = element.closest(selector);
    const nestedTurns = enclosingTurn ? [] : element.querySelectorAll(selector);
    return enclosingTurn ?? (nestedTurns.length === 1 ? nestedTurns[0] : null);
  }

  function assistantCompletion(element) {
    return assistantTurn(element)?.getAttribute("data-talvt-turn-state") === "complete" ? "ASSISTANT_TURN_COMPLETE" : null;
  }

  function decisionNodes(assistant) {
    const composer = resolveComposer();
    const send = composer?.fallbackContainer ? fallbackSend(composer.fallbackContainer) : firstVisible("sendButton");
    return { turn:assistantTurn(assistant), composer:composer?.element, send:send?.element,
      stop:firstVisible("stopButton")?.element,
      bodies:assistant ? selectorRegistry.groups.messageContent.flatMap(selector =>
        assistant.matches(selector) ? [assistant] : [...assistant.querySelectorAll(selector)]) : [] };
  }

  function composerDiagnostics() {
    return { selectorVersion:selectorRegistry.version, composerSelectors:selectorRegistry.groups.composer.map((selector) => {
      const matches = [...document.querySelectorAll(selector)];
      return { selector, matched:matches.length, visible:matches.filter(isVisible).length,
        samples:matches.slice(0, 3).map((element) => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return { tagName:element.tagName, display:style.display, visibility:style.visibility,
            width:rect.width, height:rect.height, acceptedByVisibility:isVisible(element),
            connected:element.isConnected, disabled:element.disabled === true,
            readOnly:element.readOnly === true, editable:element.isContentEditable === true };
        }) };
    }), editableCandidates:["textarea", "[contenteditable='true']", "[role='textbox']"].map(selector => {
      // These counts diagnose selector coverage; they never select a composer.
      const matches = [...document.querySelectorAll(selector)];
      return { selector, matched:matches.length, visible:matches.filter(isVisible).length,
        samples:matches.slice(0, 3).map(element => ({ tagName:element.tagName,
          role:element.getAttribute?.("role") ?? null, contentEditable:element.getAttribute?.("contenteditable") ?? null,
          inForm:Boolean(element.closest?.("form")), inMain:Boolean(element.closest?.("main, [role='main']")),
          excludedAncestor:Boolean(element.closest?.("[role='dialog'], [role='navigation'], nav, [data-message-author-role]")),
          readOnly:element.getAttribute?.("aria-readonly") === "true",
          disabled:element.getAttribute?.("aria-disabled") === "true",
          ancestors:(() => {
            const result = [];
            for (let parent = element; parent && result.length < 8; parent = parent.parentElement) {
              result.push({ tagName:parent.tagName, role:parent.getAttribute?.("role") ?? null,
                elementId:String(parent.id ?? "").slice(0, 80), testId:parent.getAttribute?.("data-testid")?.slice(0, 80) ?? null });
            }
            return result;
          })(),
          controls:[...(element.closest?.("form")?.querySelectorAll("button") ?? [])].slice(0, 16).map(button => ({
            tagName:button.tagName, controlLabel:button.getAttribute?.("aria-label")?.slice(0, 160) ?? null,
            testId:button.getAttribute?.("data-testid")?.slice(0, 80) ?? null,
            disabled:button.disabled === true, acceptedByVisibility:isVisible(button),
          })),
          fallbackReason:element.matches?.(FALLBACK_COMPOSER) ? fallbackCandidate(element)?.reason ?? null : null })) };
    }), composerFallback:{ selector:FALLBACK_COMPOSER, eligible:fallbackCandidates().length,
      selected:Boolean(resolveComposer()?.fallbackContainer) } };
  }

  function inspectPageState({ includeDiagnostics = false } = {}) {
    assertContract();
    const composer = detectComposer();
    const generating = detectGeneration();
    const authenticationSignal = composer.present || generating ? null : detectAuthentication();
    const pageState = { readyState:document.readyState ?? null,
      visibilityState:document.visibilityState ?? null, hasFocus:document.hasFocus?.() ?? null,
      authenticationSignal };
    if (composer.present || generating) {
      return { status:"READY", composerPresent:composer.present, pageState,
        diagnostics:composer.present && !includeDiagnostics ? null : composerDiagnostics() };
    }
    return {
      status:authenticationSignal ?? "UI_CONTRACT_CHANGED",
      composerPresent:false,
      pageState,
      diagnostics:composerDiagnostics(),
    };
  }

  function setNativeValue(element, value) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new PageProviderError("UI_CONTRACT_CHANGED", "Composer value setter is unavailable.");
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
    if (!inserted || !(element.innerText || "").trim()) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:value }));
    }
    selection.removeAllRanges();
  }

  function extractAssistantResponse(element) {
    return responseText.elementText(element, selectorRegistry.groups.messageContent, selectorTelemetry);
  }

  function messageContainer(roleNode) {
    for (const selector of selectorRegistry.groups.messageContainer) {
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

  // Only an accessibility heading outside message content can prove its single sibling branch.
  function headingRole(node, content, userSearchBody = false) {
    const labels = new Map([["내가 한 말:", "user"], ["You said:", "user"],
      ["ChatGPT 답변:", "assistant"], ["ChatGPT said:", "assistant"]]);
    for (let parent = content; parent; parent = parent.parentElement) {
      const children = [...(parent.children ?? [])];
      const headings = children.filter(child => child.tagName === "H4" && child.classList?.contains("sr-only"));
      if (!headings.length) continue;
      if (headings.length !== 1 || children.length !== 2) return null;
      const heading = headings[0], branch = children.find(child => child !== heading);
      let label = (heading.textContent ?? "").trim();
      if (label === "내가 한 말:나") label = "내가 한 말:";
      if (label === "ChatGPT 답변:ChatGPT") label = "ChatGPT 답변:";
      const role = labels.get(label);
      const bodySelector = "[data-markdown-text-tone='user-message'], [data-markdown-text-style='assistant-message'], [data-testid='collapsible-user-message-content'], [data-message-content], .markdown"
        + (userSearchBody ? ", [data-search-result-target]" : "");
      if (!role || !content.matches?.(bodySelector) || heading.closest(bodySelector) || !branch?.contains(content) || (node !== parent && !branch.contains(node) && !node.contains(parent))
        || parent.querySelectorAll("h4.sr-only").length !== 1) return null;
      // An outer turn wrapper is eligible only when all message evidence belongs to this one inner block.
      if (node !== parent && node.contains(parent) && (node.querySelectorAll("h4.sr-only").length !== 1
        || [...node.querySelectorAll(bodySelector + ", [data-message-author-role], [data-chatgpt-search-unit-key]")]
          .some(item => !parent.contains(item)))) return null;
      const bodies = [branch, ...branch.querySelectorAll(bodySelector)].filter(item => item.matches(bodySelector));
      const roots = bodies.filter(item => !bodies.some(other => other !== item && other.contains(item)));
      if (roots.length !== 1 || !roots[0].contains(content)) return null;
      const roleNodes = [node, parent, ...parent.querySelectorAll("[data-message-author-role], [data-chatgpt-search-unit-key]")];
      for (const item of roleNodes) {
        const explicit = item.getAttribute("data-message-author-role");
        const suffix = item.getAttribute("data-chatgpt-search-unit-key")?.match(/:(user|assistant)$/u)?.[1];
        if ((explicit && explicit !== role) || (suffix && suffix !== role)) return null;
      }
      // Distinct sibling units under one heading cannot borrow each other's role proof.
      const units = [...branch.querySelectorAll("[data-chatgpt-search-unit-key]")];
      if (branch.getAttribute("data-chatgpt-search-unit-key") !== null) units.unshift(branch);
      if (units.length > 1 || parent.querySelectorAll("[data-message-author-role]").length > 1) return null;
      return { role, content, container:parent, proof:{ source:"PAGE_ACCESSIBILITY_HEADING", tagName:"H4", label,
        relation:"DIRECT_SIBLING_MESSAGE_BRANCH", headingCount:1, messageBranchCount:1 } };
    }
    return null;
  }
  function messageEvidence(roleNode) {
    const content = roleNode.querySelector("[data-markdown-text-tone='user-message'], [data-markdown-text-style='assistant-message'], [data-testid='collapsible-user-message-content'], [data-message-content], .markdown");
    if (content) return headingRole(roleNode, content);
    const body = userSearchMessageBody(roleNode);
    return body ? headingRole(roleNode, body, true) : headingRole(roleNode, roleNode);
  }

  function userSearchMessageBody(node) {
    const key = node.getAttribute("data-chatgpt-search-unit-key");
    const id = node.getAttribute("data-chatgpt-search-message-ids")?.trim();
    if (!key?.endsWith(":user") || !/^[\w-]+$/u.test(id ?? "")) return null;
    const scopes = node.querySelectorAll("[data-content-search-unit-key]");
    const bubbles = node.querySelectorAll("[data-user-message-bubble='true']");
    if (scopes.length !== 1 || scopes[0].getAttribute("data-content-search-unit-key") !== key
      || bubbles.length !== 1 || bubbles[0].getAttribute("data-user-message-has-prompt") !== "true"
      || !scopes[0].contains(bubbles[0])) return null;
    const bodies = bubbles[0].querySelectorAll("[data-search-result-target]");
    return bodies.length === 1 ? bodies[0] : null;
  }

  function readMessages() {
    assertContract();
    // Inspect the union in DOM order: a search unit must not hide a legacy message.
    const selectors = ["[data-chatgpt-search-unit-key]", ...selectorRegistry.groups.message];
    const roleNodes = [...document.querySelectorAll(selectors.join(", "))];
    const seen = new Set(), seenIds = new Set(), messages = [];
    let messageSelectorRecorded = false;
    roleNodes.forEach((roleNode) => {
      const evidence = messageEvidence(roleNode);
      if (!evidence) throw new PageProviderError("UI_CONTRACT_CHANGED", "Message role evidence is unavailable.");
      if (seen.has(evidence.container)) return;
      seen.add(evidence.container);
      const unit = evidence.container.matches?.("[data-chatgpt-search-unit-key]") ? evidence.container
        : evidence.container.querySelector("[data-chatgpt-search-unit-key]");
      let id;
      if (unit) {
        const ids = [...new Set((unit.getAttribute("data-chatgpt-search-message-ids") ?? "").split(/\s+/u).filter(Boolean))];
        if (ids.length !== 1 || seenIds.has(ids[0])) throw new PageProviderError("AMBIGUOUS_PROMPT_BINDING", "Message identity is ambiguous.");
        id = ids[0];
      } else id = messageId(messageContainer(roleNode));
      if (id && seenIds.has(id)) throw new PageProviderError("AMBIGUOUS_PROMPT_BINDING", "Message identity is ambiguous.");
      if (id) seenIds.add(id);
      messages.push({ id, role:evidence.role, text:extractAssistantResponse(evidence.content),
        index:messages.length, element:evidence.content });
      if (!messageSelectorRecorded) {
        const selector = selectors.find(candidate => roleNode.matches(candidate));
        if (selector) {
          selectorTelemetry.set("message", selector);
          messageSelectorRecorded = true;
        }
      }
    });
    return messages;
  }

  function findSendControl() {
    assertContract();
    const composer = resolveComposer();
    if (composer?.fallbackContainer) {
      const match = fallbackSend(composer.fallbackContainer);
      if (!match) return { state:composerText(composer.element).trim() ? "UNKNOWN" : "CONFIRMED_EMPTY_COMPOSER" };
      return { state:match.element.disabled || match.element.getAttribute("aria-disabled") === "true"
        ? "DISABLED" : "ENABLED", selector:match.selector };
    }
    const result = selectorRegistry.resolveSendButtonState({
      isComposerEmpty:() => {
        const composer = detectComposer();
        return composer.present && composer.empty === true;
      },
    });
    if (result?.selector) selectorTelemetry.set("sendButton", result.selector);
    return result;
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
    throw new PageProviderError("MESSAGE_SEND_FAILED", "ChatGPT send control did not become enabled.", evidence());
  }

  async function submitPrompt(text, signal, { assertCanMutate, observe } = {}) {
    const composer = await waitForVisible("composer", 30_000, signal);
    assertCanMutate?.();
    composer.element.focus();
    setNativeValue(composer.element, text);
    observe?.("SEND_CONTROL");
    await sleep(250, signal);
    const sendButton = await waitForEnabledSend(signal);
    assertCanMutate?.();
    const currentComposer = firstVisible("composer");
    if (currentComposer?.element !== composer.element
      || (composer.fallbackContainer && (currentComposer.fallbackContainer !== composer.fallbackContainer
        || fallbackSend(composer.fallbackContainer)?.element !== sendButton.element
        || sendButton.element.disabled || sendButton.element.getAttribute("aria-disabled") === "true"))) {
      throw new PageProviderError("UI_CONTRACT_CHANGED", "Composer or send control changed before prompt dispatch.", evidence());
    }
    observe?.("SEND_ATTEMPTED");
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
    provider:"CHATGPT_WEB",
    rootUrl:"https://chatgpt.com/",
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
    assistantCompletion,
    decisionNodes,
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
