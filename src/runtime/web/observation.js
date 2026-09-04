import { canonicalConversationUrl } from "./binding.js";
import { hasExactPromptMarkers } from "./markers.js";
import {
  WebCompletionConfidence,
  WebPageStatus,
  WebProtocolError,
} from "./protocol.js";

function normalizedMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new WebProtocolError("messages must be an array", "INVALID_DOM_OBSERVATION");
  }
  return messages.map((message, index) => {
    if (
      message === null
      || typeof message !== "object"
      || !["user", "assistant"].includes(message.role)
      || typeof message.id !== "string"
      || message.id.length === 0
      || typeof message.text !== "string"
    ) {
      throw new WebProtocolError(`Invalid message observation at index ${index}`, "INVALID_DOM_OBSERVATION");
    }
    return { ...message, index: Number.isSafeInteger(message.index) ? message.index : index };
  }).sort((left, right) => left.index - right.index);
}

export function associatePromptResponse({
  messages,
  controllerMessageId,
  runId,
  expectedConversationUrl,
  observedConversationUrl,
}) {
  const expectedUrl = canonicalConversationUrl(expectedConversationUrl);
  const observedUrl = canonicalConversationUrl(observedConversationUrl);
  if (!expectedUrl || observedUrl !== expectedUrl) {
    return Object.freeze({
      status: "MANUAL_INTERVENTION_DETECTED",
      reason: "CONVERSATION_CHANGED",
      userMessageId: null,
      assistantMessageId: null,
    });
  }
  const ordered = normalizedMessages(messages);
  const matchingUsers = ordered.filter((message) => (
    message.role === "user"
    && hasExactPromptMarkers(message.text, { controllerMessageId, runId })
  ));
  if (matchingUsers.length === 0) {
    return Object.freeze({
      status: "MARKER_NOT_FOUND",
      reason: "CONTROLLED_USER_MESSAGE_NOT_OBSERVED",
      userMessageId: null,
      assistantMessageId: null,
    });
  }
  if (matchingUsers.length > 1) {
    return Object.freeze({
      status: "AMBIGUOUS",
      reason: "DUPLICATE_CONTROLLED_USER_MESSAGE",
      userMessageId: null,
      assistantMessageId: null,
    });
  }
  const user = matchingUsers[0];
  const after = ordered.filter((message) => message.index > user.index);
  const unexpectedUser = after.find((message) => message.role === "user");
  if (unexpectedUser) {
    return Object.freeze({
      status: "MANUAL_INTERVENTION_DETECTED",
      reason: "UNEXPECTED_USER_MESSAGE_AFTER_CONTROLLED_PROMPT",
      userMessageId: user.id,
      assistantMessageId: null,
      observedMessageId: unexpectedUser.id,
    });
  }
  const assistant = after.find((message) => message.role === "assistant");
  if (assistant) {
    return Object.freeze({
      status: "MATCHED",
      reason: null,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    });
  }
  return Object.freeze({
    status: "WAITING_FOR_ASSISTANT",
    reason: null,
    userMessageId: user.id,
    assistantMessageId: null,
  });
}

export function assessWebCompletion({
  association,
  assistantMessageId,
  stopButtonVisible,
  sendButtonEnabled,
  stableForMs,
  requiredStableMs,
  expectedConversationUrl,
  observedConversationUrl,
}) {
  const conversationUnchanged = Boolean(
    canonicalConversationUrl(expectedConversationUrl)
    && canonicalConversationUrl(expectedConversationUrl) === canonicalConversationUrl(observedConversationUrl),
  );
  const idMatched = association?.status === "MATCHED"
    && typeof assistantMessageId === "string"
    && assistantMessageId.length > 0
    && association.assistantMessageId === assistantMessageId;
  const stable = Number.isFinite(stableForMs)
    && Number.isFinite(requiredStableMs)
    && requiredStableMs >= 0
    && stableForMs >= requiredStableMs;
  let confidence = WebCompletionConfidence.AMBIGUOUS;
  if (idMatched && conversationUnchanged && stopButtonVisible === false && stable && sendButtonEnabled === true) {
    confidence = WebCompletionConfidence.CONFIRMED_BY_UI_STATE;
  } else if (idMatched && conversationUnchanged && stopButtonVisible === false && stable && sendButtonEnabled === null) {
    confidence = WebCompletionConfidence.HEURISTIC;
  }
  return Object.freeze({
    confidence,
    automaticRelayAllowed: confidence !== WebCompletionConfidence.AMBIGUOUS,
    signals: Object.freeze({
      responseAssociated: idMatched,
      conversationUnchanged,
      generationStopped: stopButtonVisible === false,
      sendButtonEnabled,
      domStable: stable,
    }),
  });
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * @param {{
 *   url?: unknown,
 *   title?: unknown,
 *   pageText?: unknown,
 *   composerPresent?: boolean,
 *   sendFailure?: boolean
 * }} [observation]
 */
export function detectWebPageState({
  url,
  title = "",
  pageText = "",
  composerPresent = false,
  sendFailure = false,
} = {}) {
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedTitle = String(title || "").toLowerCase();
  const normalizedText = String(pageText || "").slice(0, 20_000).toLowerCase();
  const combined = `${normalizedTitle}\n${normalizedText}`;
  if (sendFailure) return WebPageStatus.MESSAGE_SEND_FAILED;
  if (/\/(auth|login)(\/|\?|$)/.test(normalizedUrl) || includesAny(combined, [
    /log in to chatgpt/,
    /sign in to chatgpt/,
    /로그인.*chatgpt/,
    /세션.*만료/,
  ])) return WebPageStatus.SESSION_AUTH_REQUIRED;
  if (includesAny(combined, [/captcha/, /로봇이 아님/, /verify you are human/])) {
    return WebPageStatus.CAPTCHA_REQUIRED;
  }
  if (includesAny(combined, [/cloudflare/, /checking your browser/, /security check/, /보안 확인/])) {
    return WebPageStatus.SECURITY_CHECK_REQUIRED;
  }
  if (includesAny(combined, [/rate limit/, /too many requests/, /요청 한도/, /try again later/])) {
    return WebPageStatus.RATE_LIMITED;
  }
  if (includesAny(combined, [/something went wrong/, /internal server error/, /문제가 발생/, /unable to load/])) {
    return WebPageStatus.CHATGPT_ERROR_PAGE;
  }
  return composerPresent ? WebPageStatus.READY : WebPageStatus.UI_CONTRACT_CHANGED;
}
