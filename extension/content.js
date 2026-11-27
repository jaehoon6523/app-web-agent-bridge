(function initializeContentRuntime(root) {
// Reinjection shares the listener, document token and active job in this world.
if (root.ChatGptBridgeContentRuntime) return;
const manualFollowup = globalThis.ChatGptBridgeManualFollowup;
const pageProviders = globalThis.WebBridgePageProviders;

let currentJob = null;
function contentTrace(event, details = {}) {
  console.info(`[bridge:trace:content:${event}]`, { at: new Date().toISOString(), ...details });
}
// A content-script document token, not a Chrome navigation documentId.
const DOCUMENT_ID = crypto.randomUUID();
const RUNTIME_VERSION = chrome.runtime.getManifest?.().version ?? null;
const FRAME_ID = window === window.top ? 0 : null;

function assertExpectedDocument(payload) {
  if (payload?.expectedDocumentId !== DOCUMENT_ID || payload?.expectedFrameId !== 0 || FRAME_ID !== 0) {
    throw new ContentContractError("WEB_DOCUMENT_CHANGED", "The bound Web provider document changed; prepare the session again.");
  }
}

class ContentContractError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = "ContentContractError";
    this.code = code;
    this.evidence = evidence;
  }
}

function requirePageProvider() {
  const provider = pageProviders?.resolve?.(location.href) ?? null;
  if (!provider) {
    throw new ContentContractError("UI_CONTRACT_CHANGED", "No registered Web page provider matches this document.");
  }
  return provider;
}

function requirePageContract() {
  const provider = requirePageProvider();
  provider.assertContract();
  return provider;
}

function selectedSelectorEvidence() {
  try {
    return requirePageProvider().evidence();
  } catch {
    return { selectorVersion:null, selectorsUsed:{} };
  }
}

function canonicalConversationUrl(value) {
  return requirePageProvider().canonicalizeUrl(value);
}

function conversationIdFromUrl(value) {
  return requirePageProvider().conversationIdFromUrl(value);
}

function inspectPageState() {
  return requirePageContract().inspectPageState();
}

function assertExpectedConversation(expectedUrl, expectedId) {
  const observed = requirePageProvider().readConversationIdentity();
  if (observed.conversationUrl !== expectedUrl || observed.conversationId !== expectedId) {
    throw new ContentContractError(
      "MANUAL_INTERVENTION_DETECTED",
      "The bound Web provider tab changed to a different conversation.",
      {
        expectedUrl,
        observedUrl: observed.conversationUrl,
        expectedId,
        observedId: observed.conversationId,
      },
    );
  }
}

function messageSnapshot() {
  return requirePageContract().readMessages();
}

function elementText(element) {
  return requirePageContract().extractAssistantResponse(element);
}

function sendButtonState() {
  return requirePageContract().findSendControl();
}

async function submitPrompt(text, signal, expected, observe) {
  const provider = requirePageContract();
  const assertCanMutate = () => {
    assertExpectedDocument(expected);
    assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
  };
  await provider.submitPrompt(text, signal, { assertCanMutate, observe });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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
  if (expected.plainText !== undefined) return message.text === expected.plainText;
  const markers = parseMarkers(message.text);
  return markers?.controllerMessageId === expected.controllerMessageId
    && markers?.runId === expected.runId;
}

async function waitForControlledUserMessage(expected, baseline, signal) {
  const deadline = Date.now() + 15_000;
  let lastMessages = baseline;
  const baselineUserIds = new Set(baseline.filter((message) => message.role === "user").map((message) => message.id));
  const baselineUserElements = new Set(
    baseline.filter((message) => message.role === "user").map((message) => message.element),
  );
  while (Date.now() < deadline) {
    assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
    const messages = messageSnapshot();
    lastMessages = messages;
    const matches = messages.filter((message) => isExpectedUser(message, expected)
      && (expected.plainText === undefined || (!baselineUserElements.has(message.element)
        && (!message.id || !baselineUserIds.has(message.id)))));
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
  throw new ContentContractError(
    "MESSAGE_SEND_FAILED",
    "The controlled user message was not observed after send.",
    {
      conversationUrl: canonicalConversationUrl(location.href),
      observedMessageCount: lastMessages.length,
      observedUserCount: lastMessages.filter((message) => message.role === "user").length,
      observedAssistantCount: lastMessages.filter((message) => message.role === "assistant").length,
      ...selectedSelectorEvidence(),
    },
  );
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
    && (expected.plainText !== undefined || !isExpectedUser(message, expected))
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

  // Virtualized histories may remove the user turn. Recover the association only
  // when the submitted turn produced exactly one new assistant and that
  // assistant is the last visible message. This keeps the fallback tied to the
  // current turn instead of treating an arbitrary new assistant as a match.
  const candidates = messages.filter((message) => (
    message.role === "assistant" && message.id && !baselineAssistantIds.has(message.id)
  ));
  if (candidates.length > 1) return { status: "AMBIGUOUS" };
  if (candidates.length === 1) {
    const candidate = candidates[0];
    const isLastVisibleMessage = messages.at(-1) === candidate;
    const hasLaterUserMessage = messages.some((message) => (
      message.role === "user" && message.index > candidate.index
    ));
    if (isLastVisibleMessage && !hasLaterUserMessage) {
      return {
        status: "MATCHED",
        message: candidate,
        virtualizedUser: true,
        virtualizedAssociationConfirmed: true,
      };
    }
  }
  return { status: "WAITING" };
}

// Delegates to the selectors module's resolveSendButtonState(), which treats
// "no send button because the composer is empty" as a confirmable state
// (ChatGPT shows dictation/voice controls instead of a send button in that
// case) rather than an ambiguous one. Any other missing-button case is an
// unexpected selector/UI-contract mismatch and is reported there via
// console.warn.
function captureDecision({ phase, requestId, assistantElement, assistantId, userMessage, extracted, observation }) {
  const unavailable = { status:"FAILED", code:"EVIDENCE_CAPTURE_UNAVAILABLE" };
  try {
    const provider = requirePageContract();
    if (!provider.decisionNodes) return Promise.resolve(null);
    const { turn, composer, send, stop, bodies } = provider.decisionNodes(assistantElement);
    const html = element => element?.isConnected ? element.outerHTML : null;
    const at = Date.now();
    const payload = { phase, capturedAt:at, dataUrl:location.href, documentId:DOCUMENT_ID,
      conversationId:conversationIdFromUrl(location.href), assistantMessageId:assistantId, userMessageId:userMessage?.id ?? null,
      pageHtml:document.documentElement.outerHTML, assistantHtml:html(assistantElement), userHtml:html(userMessage?.element),
      turnHtml:html(turn), turnAttributes:turn ? [...turn.attributes].map(({name,value})=>[name,value]) : [],
      composerHtml:html(composer), sendHtml:html(send), stopHtml:html(stop), bodyHtml:bodies.map(html),
      assistantRawText:assistantElement?.isConnected ? assistantElement.textContent : null, extracted,
      observation:{ ...observation, ...selectedSelectorEvidence() } };
    return chrome.runtime.sendMessage({ type:"agent.decision-evidence", requestId, payload })
      .then(receipt => receipt ?? unavailable, () => unavailable);
  } catch {
    return Promise.resolve(unavailable);
  }
}

function watchCompletedResponse({ requestId, assistantId, userMessage, extracted, documentUrl, previousCaptureId }) {
  if (!assistantId) return;
  let timer;
  const check = () => {
    if (location.href !== documentUrl) return stop();
    let matches;
    try { matches = messageSnapshot().filter(message => message.role === "assistant" && message.id === assistantId); }
    catch { return stop(); }
    if (matches.length !== 1 || matches[0].text === extracted) return;
    stop();
    const current = matches[0];
    void captureDecision({ phase:"AFTER_CHANGE", requestId, assistantElement:current.element, assistantId,
      userMessage, extracted:current.text, observation:{ previousCaptureId } })
      .then(receipt => { if (receipt?.status === "FAILED") contentTrace("decision-evidence-failed", { requestId, code:receipt.code }); });
  };
  const observer = new MutationObserver(check);
  function stop() { observer.disconnect(); clearTimeout(timer); }
  observer.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
  timer = setTimeout(stop, 10000);
  check();
}

async function waitForAssistantResponse({ expected, baseline, userMessage, timeoutMs, stableMs, signal, requestId, preparationVersion, settlingRoot = false }) {
  const deadline = Date.now() + timeoutMs;
  const rootReadyDeadline = Math.min(deadline, Date.now() + stableMs);
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
  let virtualizedAssociationConfirmed = false;
  let lastDomMutationAt = Date.now();
  let observation = {};
  let timelineData, anchor;
  async function publishTimeline() {
    if (!timelineData || anchor?.status !== "PERSISTED") return;
    const payload = timelineData;
    timelineData = null;
    const receipt = await chrome.runtime.sendMessage({ type:"agent.decision-evidence", requestId, payload:{
      phase:"TURN_TIMELINE", capturedAt:payload.events.at(-1).capturedAt, ...payload.identity,
      observation:{ previousCaptureId:anchor.captureId },
      timeline:payload,
    } }).catch(() => null);
    if (receipt?.status !== "PERSISTED") contentTrace("turn-timeline-incomplete", {
      requestId, captureId:anchor.captureId, code:receipt?.code ?? "EVIDENCE_DISCONNECTED",
    });
  }
  const targetUrl = location.href;
  const timeline = Number.isSafeInteger(preparationVersion) && requirePageProvider().provider === "CHATGPT_WEB"
    ? root.WebBridgeTurnTimeline?.create({
      read() {
        if (signal.aborted || location.href !== targetUrl) return { stopReason:"DOCUMENT_OR_TURN_CHANGED" };
        const messages = messageSnapshot();
        const users = messages.filter(message => message.id === userMessage.id && message.role === "user" && isExpectedUser(message, expected));
        const match = locateAssociatedAssistant(messages, expected, userMessage.id,
          baselineAssistantIds, baselineUserIds, baselineUserElements);
        if (match.status === "AMBIGUOUS" || match.status === "MANUAL_INTERVENTION_DETECTED" || users.length > 1) {
          return { stopReason:"AMBIGUOUS_TURN" };
        }
        const candidate = match.message;
        if (users.length !== 1 || !candidate?.id) return null;
        if (messages.filter(message => message.id === candidate.id).length !== 1) return { stopReason:"AMBIGUOUS_TURN" };
        const provider = requirePageProvider();
        const element = candidate.element;
        const turn = provider.decisionNodes(element).turn;
        return { identity:{ preparationId:expected.runId, preparationVersion, deliveryId:requestId,
          documentId:DOCUMENT_ID, frameId:FRAME_ID, userMessageId:userMessage.id, assistantMessageId:candidate.id,
          conversationId:conversationIdFromUrl(targetUrl), dataUrl:targetUrl },
          element, raw:element.textContent ?? "", text:elementText(element),
          completionAttribute:turn?.getAttribute("data-talvt-turn-state") ?? null,
          completionSignal:provider.assistantCompletion?.(element) ?? null, stopVisible:provider.detectGeneration() };
      },
      onFinish(data) { timelineData = data; return publishTimeline(); },
    }) : null;
  timeline?.sample();
  const capture = async phase => {
    const receipt = await captureDecision({ phase, requestId, assistantElement, assistantId, userMessage,
      extracted:lastText, observation:{ ...observation, lastTextChangeAt, lastDomMutationAt, requiredStableMs:stableMs,
        ...(timeline ? { sameTurnTimelineExpected:true, timelineIdentity:{ preparationId:expected.runId, preparationVersion } } : {}) } });
    anchor = receipt;
    void publishTimeline();
    return receipt;
  };
  const observer = new MutationObserver(() => {
    lastDomMutationAt = Date.now();
  });
  observer.observe(requirePageContract().mutationRoot(), {
    childList: true,
    subtree: true,
    characterData: true,
  });

  try {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      assertExpectedDocument(expected);
      assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
      const page = inspectPageState();
      if (page.status !== "READY") {
        if (settlingRoot && page.status === "UI_CONTRACT_CHANGED" && Date.now() < rootReadyDeadline) {
          lastDomMutationAt = Date.now();
          await sleep(Math.min(250, rootReadyDeadline - Date.now()), signal);
          continue;
        }
        throw new ContentContractError(page.status, `Web provider page is not ready (${page.status}).`);
      }
      settlingRoot = false;
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
        contentTrace("manual-intervention", { requestId: expected?.requestId ?? null, observedMessageId: association.observedMessageId ?? null, expectedConversationId: expected?.expectedConversationId ?? null });
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
// Allow ID reconciliation during streaming DOM updates
        if (assistantId && assistantId !== candidate.id) {
          console.log("[Bridge] Assistant message ID updated:", assistantId, "->", candidate.id);
        }
        assistantId = candidate.id;
        assistantElement = candidate.element;
        virtualizedUser ||= association.virtualizedUser;
        virtualizedAssociationConfirmed ||= association.virtualizedAssociationConfirmed === true;
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
              documentId: DOCUMENT_ID,
              frameId: FRAME_ID,
              userMessageId: userMessage.id,
              assistantMessageId: assistantId,
              conversationUrl: canonicalConversationUrl(location.href),
            },
          },
        }).catch(() => {});
      }

      const stopVisible = requirePageContract().detectGeneration();
      const sendState = sendButtonState();
      // ENABLED: a real, clickable send button is visible -> composer has
      // content and ChatGPT is ready for another turn.
      // CONFIRMED_EMPTY_COMPOSER: no send button because the composer is
      // empty -- ChatGPT's normal post-response state, not ambiguity.
      // DISABLED / UNKNOWN do not confirm completion; UNKNOWN in particular
      // means the composer has content but no send button was found, which
      // is an unexpected selector/UI-contract mismatch (already logged by
      // resolveSendButtonState()) and must keep polling/eventually time out
      // rather than being silently treated as done.
      const sendConfirmed = sendState.state === "ENABLED" || sendState.state === "CONFIRMED_EMPTY_COMPOSER";
      const stable = assistantId
        && lastText
        && Date.now() - lastTextChangeAt >= stableMs
        && Date.now() - lastDomMutationAt >= stableMs;
      const completionSignal = stable && requirePageContract().assistantCompletion?.(assistantElement);
      timeline?.sample();
      observation = { decisionAt:Date.now(), stopButtonVisible:stopVisible, sendButtonState:sendState.state,
        composerPresent:page.composerPresent, completionSignal:completionSignal || null,
        stableForMs:Math.min(Date.now() - lastTextChangeAt, Date.now() - lastDomMutationAt) };
      if (stable && !stopVisible && sendConfirmed
        && (!requirePageContract().assistantCompletion || completionSignal)) {
        const confidence = virtualizedUser && !virtualizedAssociationConfirmed
          ? "HEURISTIC"
          : "CONFIRMED_BY_UI_STATE";
        observation.responseAssociation = virtualizedUser
          ? virtualizedAssociationConfirmed ? "VIRTUALIZED_USER_LAST_ASSISTANT" : "VIRTUALIZED_USER_HEURISTIC"
          : "DIRECT_DOM_ORDER";
        const documentUrl = location.href;
        timeline?.freeze(lastText, observation);
        const decisionEvidence = await capture("COMPLETED");
        if (!timeline && decisionEvidence?.status === "PERSISTED") watchCompletedResponse({ requestId, assistantId,
          userMessage, extracted:lastText, documentUrl, previousCaptureId:decisionEvidence.captureId });
        if (decisionEvidence?.status === "FAILED") contentTrace("decision-evidence-failed", { requestId, code:decisionEvidence.code });
        return {
          text: lastText,
          confidence,
          confidenceReason: virtualizedUser
            ? (virtualizedAssociationConfirmed
              ? "VIRTUALIZED_USER_RECOVERED_BY_LAST_ASSISTANT"
              : "VIRTUALIZED_USER_DOM_UNCERTAIN")
            : "DIRECT_DOM_ORDER_CONFIRMED",
          evidence: {
            documentId: DOCUMENT_ID,
            frameId: FRAME_ID,
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
            conversationUrl: canonicalConversationUrl(location.href),
            conversationId: conversationIdFromUrl(location.href),
            responseAssociation: virtualizedUser
              ? (virtualizedAssociationConfirmed
                ? "VIRTUALIZED_USER_LAST_ASSISTANT"
                : "VIRTUALIZED_USER_HEURISTIC")
              : "DIRECT_DOM_ORDER",
            stopButtonVisible: stopVisible,
            ...(completionSignal ? { completionSignal } : {}),
            ...(decisionEvidence ? { decisionEvidence } : {}),
            sendButtonState: sendState.state,
            sendButtonEnabled: sendState.state === "ENABLED" ? true : sendState.state === "DISABLED" ? false : null,
            stableForMs: observation.stableForMs,
            ...selectedSelectorEvidence(),
          },
        };
      }
      await sleep(250, signal);
    }
  } catch (error) {
    observation.errorCode = error?.code ?? error?.name ?? "RESPONSE_FAILED";
    timeline?.finish(observation.errorCode);
    const receipt = await capture("UNCONFIRMED");
    if (receipt) contentTrace("decision-evidence-unconfirmed", { requestId, code:receipt.code ?? receipt.status });
    throw error;
  } finally {
    observer.disconnect();
  }

  observation.errorCode = settlingRoot ? "UI_CONTRACT_CHANGED" : assistantId ? "AMBIGUOUS_COMPLETION" : "RESPONSE_TIMEOUT";
  timeline?.finish(observation.errorCode);
  const receipt = await capture("UNCONFIRMED");
  if (receipt) contentTrace("decision-evidence-unconfirmed", { requestId, code:receipt.code ?? receipt.status });
  if (settlingRoot) {
    throw new ContentContractError("UI_CONTRACT_CHANGED", "Web provider page did not become ready after the first prompt.");
  }
  throw new ContentContractError(
    assistantId ? "AMBIGUOUS_COMPLETION" : "RESPONSE_TIMEOUT",
    assistantId
      ? "Assistant output was observed, but completion could not be confirmed."
      : `Web provider response did not appear within ${timeoutMs} ms.`,
    {
      userMessageId: userMessage.id,
      assistantMessageId: assistantId,
      conversationUrl: canonicalConversationUrl(location.href),
      ...selectedSelectorEvidence(),
    },
  );
}

async function executePrompt(requestId, payload) {
  assertExpectedDocument(payload);
  if (currentJob) throw new ContentContractError("WEB_SESSION_BUSY", "Another Web provider prompt is active in this tab.");
  requirePageContract();
  const text = String(payload?.text || "");
  const expected = {
    ...(payload.plainText === true ? {plainText:text.trim()} : {}),
    controllerMessageId: String(payload?.controllerMessageId || ""),
    runId: String(payload?.runId || ""),
    expectedConversationUrl: canonicalConversationUrl(payload?.expectedConversationUrl),
    expectedConversationId: payload?.expectedConversationId || null,
    expectedDocumentId: payload.expectedDocumentId,
    expectedFrameId: payload.expectedFrameId,
  };
  const bootstrap = expected.expectedConversationUrl === requirePageProvider().rootUrl && expected.expectedConversationId === null;
  if (!text.trim() || !expected.controllerMessageId || !expected.runId || !expected.expectedConversationUrl || (!expected.expectedConversationId && !bootstrap)) {
    throw new ContentContractError("INVALID_DELIVERY", "Prompt and exact delivery binding are required.");
  }
  const markers = parseMarkers(text);
  if (
    expected.plainText === undefined
    && (markers?.controllerMessageId !== expected.controllerMessageId
      || markers?.runId !== expected.runId)
  ) {
    throw new ContentContractError("DELIVERY_MARKER_MISMATCH", "Prompt markers do not match the delivery identity.");
  }
  assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
  const page = inspectPageState();
  if (page.status !== "READY") {
    throw new ContentContractError(page.status, `Web provider page is not ready (${page.status}).`);
  }

  const abortController = new AbortController();
  currentJob = { requestId, abortController, expected };
  requirePageProvider().resetEvidence();
  let stageStartedAt = Date.now(), stage = "BASELINE_CAPTURE", sendAttempted = false, userMessageId = null;
  const enter = next => { stage = next; stageStartedAt = Date.now(); };
  try {
    const baseline = messageSnapshot();
    if (bootstrap && expected.plainText !== undefined && baseline.length) {
      throw new ContentContractError("INVALID_DELIVERY", "A new plain-text conversation requires an empty history.");
    }
    enter("COMPOSER_INPUT");
    await submitPrompt(text, abortController.signal, expected, event => {
      if (event === "SEND_ATTEMPTED") sendAttempted = true;
      else enter(event);
    });
    enter("SUBMISSION_CONFIRMATION");
    if (bootstrap) {
      const deadline = Date.now() + 30_000;
      while (!conversationIdFromUrl(location.href) && Date.now() < deadline) {
        if (abortController.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const id = conversationIdFromUrl(location.href);
      if (!id) throw new ContentContractError("NEW_CONVERSATION_TIMEOUT", "첫 메시지 전송 후 대화 주소가 생성되지 않았습니다. 자동 재전송하지 않습니다.");
      expected.expectedConversationUrl = canonicalConversationUrl(location.href);
      expected.expectedConversationId = id;
    }
    const userMessage = await waitForControlledUserMessage(expected, baseline, abortController.signal);
    userMessageId = userMessage.id;
    enter("RESPONSE_COMPLETION");
    return await waitForAssistantResponse({
      expected,
      baseline,
      userMessage,
      timeoutMs: Number.isSafeInteger(payload.timeoutMs) ? payload.timeoutMs : 300_000,
      stableMs: Number.isSafeInteger(payload.stableMs) ? Math.max(payload.stableMs, 1000) : 3500,
      signal: abortController.signal,
      requestId,
      preparationVersion: payload.preparationVersion,
      settlingRoot: bootstrap && requirePageProvider().provider === "CHATGPT_WEB",
    });
  } catch (error) {
    if (error?.code === "MANUAL_INTERVENTION_DETECTED") {
      const safe = root.WebBridgeDiagnosticProjection.projectedError(error);
      void chrome.runtime.sendMessage({
        type: "agent.manualIntervention",
        requestId,
        payload: {
          documentId: DOCUMENT_ID,
          frameId: FRAME_ID,
          code: safe.code,
          message: safe.message,
          evidence: safe.details,
        },
      }).catch(() => {});
    }
    if (error?.name === "AbortError") throw error;
    throw new ContentContractError(error?.code ?? "CONTENT_SCRIPT_FAILURE", error?.message, {
      ...(error?.details ?? error?.evidence ?? selectedSelectorEvidence()), stage, stageStartedAt, stageEndedAt:Date.now(),
      sendAttempted, userMessageId, documentId:DOCUMENT_ID, frameId:FRAME_ID,
    });
  } finally {
    currentJob = null;
  }
}

async function observeSubmittedPrompt(requestId, payload) {
  assertExpectedDocument(payload);
  if (currentJob) throw new ContentContractError("WEB_SESSION_BUSY", "Another Web provider prompt is active in this tab.");
  requirePageContract();
  const expected = {
    controllerMessageId: String(payload?.controllerMessageId || ""),
    runId: String(payload?.runId || ""),
    expectedConversationUrl: canonicalConversationUrl(payload?.expectedConversationUrl),
    expectedConversationId: payload?.expectedConversationId || null,
    expectedDocumentId: payload.expectedDocumentId,
    expectedFrameId: payload.expectedFrameId,
  };
  if (!expected.controllerMessageId || !expected.runId || !expected.expectedConversationUrl || !expected.expectedConversationId) {
    throw new ContentContractError("INVALID_DELIVERY", "An exact submitted-prompt binding is required.");
  }
  assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
  const page = inspectPageState();
  if (page.status !== "READY") {
    throw new ContentContractError(page.status, `Web provider page is not ready (${page.status}).`);
  }

  const abortController = new AbortController();
  currentJob = { requestId, abortController, expected };
  requirePageProvider().resetEvidence();
  try {
    // The prompt was submitted by the previous root document. Never click send here.
    const baseline = messageSnapshot();
    const userMessage = await waitForControlledUserMessage(expected, baseline, abortController.signal);
    return await waitForAssistantResponse({
      expected,
      baseline,
      userMessage,
      timeoutMs: Number.isSafeInteger(payload.timeoutMs) ? payload.timeoutMs : 300_000,
      stableMs: Number.isSafeInteger(payload.stableMs) ? Math.max(payload.stableMs, 1000) : 3500,
      signal: abortController.signal,
      requestId,
      preparationVersion: payload.preparationVersion,
    });
  } finally {
    currentJob = null;
  }
}

function cancelCurrentJob(requestId) {
  if (!currentJob || (requestId && currentJob.requestId !== requestId)) return false;
  currentJob.abortController.abort();
  requirePageContract().cancelGeneration();
  return true;
}

async function waitForExplicitManualFollowup(expected) {
  if (!manualFollowup?.selectExplicitManualFollowup) {
    throw new ContentContractError("UI_CONTRACT_CHANGED", "Manual follow-up selector is unavailable.");
  }
  const deadline = Date.now() + 15_000;
  let assistantId = null, assistantElement = null, userMessage = null;
  let lastText = "", lastTextChangeAt = Date.now(), lastDomMutationAt = Date.now();
  let observation = {};
  const requestId = expected.controllerMessageId;
  const capture = phase => captureDecision({ phase,requestId,assistantElement,assistantId,userMessage,extracted:lastText,
    observation:{ ...observation,lastTextChangeAt,lastDomMutationAt,requiredStableMs:3500 } });
  const observer = new MutationObserver(() => { lastDomMutationAt = Date.now(); });
  observer.observe(requirePageContract().mutationRoot(), {
    childList: true, subtree: true, characterData: true,
  });
  try {
    while (Date.now() < deadline) {
      assertExpectedDocument(expected);
      assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
      const page = inspectPageState();
      if (page.status !== "READY") {
        throw new ContentContractError(page.status, `Web provider page is not ready (${page.status}).`);
      }
      const messages = messageSnapshot();
      const selected = manualFollowup.selectExplicitManualFollowup(messages, expected.assistantMessageId);
      if (selected.status === "NONE") return null;
      if (selected.status === "UNAVAILABLE") {
        throw new ContentContractError("AMBIGUOUS_COMPLETION", "The original assistant response is no longer uniquely visible.");
      }
      if (selected.status === "AMBIGUOUS") {
        throw new ContentContractError("AMBIGUOUS_COMPLETION",
          "More than one manual follow-up turn exists after the controlled response.");
      }
      if (selected.status === "MATCHED") {
        const assistant = messages.find((message) =>
          message.role === "assistant" && message.id === selected.assistantMessageId);
        assistantElement = assistant?.element ?? null;
        userMessage = messages.find(message => message.role === "user" && message.id === selected.userMessageId) ?? null;
        const text = assistant?.element ? elementText(assistant.element) : "";
        if (assistantId !== selected.assistantMessageId || text !== lastText) {
          assistantId = selected.assistantMessageId;
          lastText = text;
          lastTextChangeAt = Date.now();
        }
        const stopVisible = requirePageContract().detectGeneration();
        const sendState = sendButtonState();
        const sendConfirmed = sendState.state === "ENABLED"
          || sendState.state === "CONFIRMED_EMPTY_COMPOSER";
        const stable = assistantId && lastText
          && Date.now() - lastTextChangeAt >= 3500
          && Date.now() - lastDomMutationAt >= 3500;
        const completionSignal = stable && requirePageContract().assistantCompletion?.(assistant?.element);
        observation = { decisionAt:Date.now(),stopButtonVisible:stopVisible,sendButtonState:sendState.state,
          composerPresent:page.composerPresent,completionSignal:completionSignal || null,
          stableForMs:Math.min(Date.now() - lastTextChangeAt,Date.now() - lastDomMutationAt),
          responseAssociation:"EXPLICIT_MANUAL_FOLLOWUP" };
        if (stable && !stopVisible && sendConfirmed
          && (!requirePageContract().assistantCompletion || completionSignal)) {
          const documentUrl = location.href;
          const decisionEvidence = await capture("COMPLETED");
          if (decisionEvidence?.status === "PERSISTED") watchCompletedResponse({ requestId,assistantId,userMessage,
            extracted:lastText,documentUrl,previousCaptureId:decisionEvidence.captureId });
          return {
            text: lastText,
            confidence: "CONFIRMED_BY_UI_STATE",
            confidenceReason: "EXPLICIT_MANUAL_FOLLOWUP",
            evidence: {
              documentId: DOCUMENT_ID,
              frameId: FRAME_ID,
              userMessageId: selected.userMessageId,
              assistantMessageId: selected.assistantMessageId,
              originalAssistantMessageId: expected.assistantMessageId,
              conversationUrl: canonicalConversationUrl(location.href),
              conversationId: conversationIdFromUrl(location.href),
              responseAssociation: "EXPLICIT_MANUAL_FOLLOWUP",
              stopButtonVisible: stopVisible,
              ...(completionSignal ? { completionSignal } : {}),
              ...(decisionEvidence ? { decisionEvidence } : {}),
              sendButtonState: sendState.state,
              sendButtonEnabled: sendState.state === "ENABLED" ? true
                : sendState.state === "DISABLED" ? false : null,
              stableForMs: observation.stableForMs,
              ...selectedSelectorEvidence(),
            },
          };
        }
      }
      await sleep(250);
    }
  } catch (error) {
    observation.errorCode = error?.code ?? "RESPONSE_FAILED";
    await capture("UNCONFIRMED");
    throw error;
  } finally {
    observer.disconnect();
  }
  observation.errorCode = "AMBIGUOUS_COMPLETION";
  await capture("UNCONFIRMED");
  throw new ContentContractError("AMBIGUOUS_COMPLETION",
    "The explicit manual follow-up was observed but completion could not be confirmed.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "agent.ping") {
    let page;
    let identity = { conversationUrl:null, conversationId:null, title:document.title };
    let provider = null;
    let generating = false;
    let selectorVersion = null;
    let inspectionError = null;
    try {
      const adapter = requirePageProvider();
      provider = adapter.provider;
      selectorVersion = adapter.evidence().selectorVersion ?? null;
      adapter.assertContract();
      page = adapter.inspectPageState({ includeDiagnostics:message.includeDiagnostics === true });
      identity = adapter.readConversationIdentity();
      generating = adapter.detectGeneration();
    } catch (error) {
      const safe = root.WebBridgeDiagnosticProjection.projectedError(error, "UI_CONTRACT_CHANGED");
      page = { status:safe.code, composerPresent:null };
      inspectionError = { code:safe.code, message:safe.message, stack:safe.stack ?? null, evidence:safe.details };
    }
    sendResponse({
      ok: true,
      url: identity.conversationUrl,
      conversationId: identity.conversationId,
      title: identity.title ?? document.title,
      ready: page.status === "READY" && page.composerPresent,
      pageUrl: location.href,
      composerPresent: page.composerPresent,
      diagnostics: page.diagnostics ?? null,
      pageState: page.pageState ?? { readyState:document.readyState ?? null,
        visibilityState:document.visibilityState ?? null, hasFocus:document.hasFocus?.() ?? null },
      inspectionError,
      busy: currentJob !== null,
      activeRequestId: currentJob?.requestId ?? null,
      generating,
      pageStatus: page.status,
      provider,
      selectorVersion,
      documentId: DOCUMENT_ID,
      frameId: FRAME_ID,
      runtimeVersion: RUNTIME_VERSION,
    });
    return false;
  }

  if (message?.type === "agent.recheck") {
    const expected = { ...message.payload };
    let recoveryJob = null;
    void (async () => {
      if (currentJob) throw new ContentContractError("WEB_SESSION_BUSY", "페이지가 다른 요청을 처리 중입니다.");
      if (expected.recoverSubmitted === true) currentJob = recoveryJob = { requestId:expected.controllerMessageId,
        abortController:new AbortController(), expected };
      assertExpectedDocument(expected);
      assertExpectedConversation(expected.expectedConversationUrl, expected.expectedConversationId);
      if (expected.allowManualFollowup === true) {
        const manual = await waitForExplicitManualFollowup(expected);
        if (manual) {
          contentTrace("manual-followup-adopted", { requestId: expected.controllerMessageId,
            userMessageId: manual.evidence.userMessageId, assistantMessageId: manual.evidence.assistantMessageId });
          return manual;
        }
      }
      const baseline = messageSnapshot();
      const matches = baseline.filter(item => isExpectedUser(item, expected)
        && (expected.recoverSubmitted === true || item.id === expected.userMessageId));
      if (matches.length !== 1) throw new ContentContractError("AMBIGUOUS_PROMPT_BINDING", "원래 요청 메시지를 확인할 수 없습니다.");
      if (expected.recoverSubmitted === true) {
        const users = baseline.filter(item => item.role === "user");
        const assistants = baseline.filter(item => item.role === "assistant" && item.index > matches[0].index);
        if (baseline.length !== 2 || users.length !== 1 || assistants.length !== 1 || !matches[0].id || !assistants[0].id
          || (expected.userMessageId != null && expected.userMessageId !== matches[0].id)
          || (expected.assistantMessageId != null && expected.assistantMessageId !== assistants[0].id)) {
          throw new ContentContractError("AMBIGUOUS_COMPLETION", "원본 요청 한 개와 바로 뒤 응답 한 개만 복구할 수 있습니다.");
        }
        expected.assistantMessageId = assistants[0].id;
      }
      const result = await waitForAssistantResponse({ expected, baseline, userMessage: matches[0],
        timeoutMs: 15000, stableMs: 3500, signal: (recoveryJob?.abortController ?? new AbortController()).signal, requestId: expected.controllerMessageId });
      if (result.evidence.assistantMessageId !== expected.assistantMessageId) {
        throw new ContentContractError("AMBIGUOUS_COMPLETION", "원래 답변과 다른 메시지가 관측됐습니다.");
      }
      return result;
    })().finally(() => { if (recoveryJob && currentJob === recoveryJob) currentJob = null; })
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, code: error.code, error: error.message }));
    return true;
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
          const safe = root.WebBridgeDiagnosticProjection.projectedError(error, "CONTENT_SCRIPT_FAILURE");
          sendResponse({
            ok: false,
            code: safe.code,
            error: safe.message,
            evidence: safe.details ?? selectedSelectorEvidence(),
            confidence: safe.code === "AMBIGUOUS_COMPLETION" ? "AMBIGUOUS" : null,
          });
        }
      });
    return true;
  }
  if (message?.type === "agent.observeSubmittedPrompt") {
    void observeSubmittedPrompt(message.requestId, message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        if (error?.name === "AbortError") {
          sendResponse({ ok: false, code: "TURN_INTERRUPTED", error: "Prompt observation cancelled." });
        } else {
          const safe = root.WebBridgeDiagnosticProjection.projectedError(error, "CONTENT_SCRIPT_FAILURE");
          sendResponse({
            ok: false,
            code: safe.code,
            error: safe.message,
            evidence: safe.details ?? selectedSelectorEvidence(),
            confidence: safe.code === "AMBIGUOUS_COMPLETION" ? "AMBIGUOUS" : null,
          });
        }
      });
    return true;
  }

  return false;
});
root.ChatGptBridgeContentRuntime = Object.freeze({ documentId: DOCUMENT_ID });
})(globalThis);
