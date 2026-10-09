import { webConversationProvider, webConversationProviderForUrl } from "./provider-registry.js";
import { WebProtocolError } from "./protocol.js";

export function assertDeliveryDiscardResponse(payload, expected) {
  if (payload?.result !== "discarded" || ["currentDeliveryId", "sessionId", "runId", "conversationUrl"]
    .some(key => payload[key] !== expected?.[key])) {
    throw new WebProtocolError("Discard confirmation identifies a different delivery", "DELIVERY_RECOVERY_MISMATCH");
  }
}

export function socketIsOpen(socket) {
  return socket?.readyState === 1;
}

export function safeParseExtensionJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new WebProtocolError("Extension sent invalid JSON", "INVALID_JSON");
  }
}

export function resolveWebSessionProvider(provider) {
  const providerSpec = webConversationProvider(provider);
  if (!providerSpec) {
    throw new WebProtocolError(
      `WebSessionAdapter provider ${String(provider)} is not registered`,
      "WEB_PROVIDER_UNAVAILABLE",
    );
  }
  return providerSpec.provider;
}

export function assertWebSessionProviderBinding(binding, provider) {
  if (binding?.conversationUrl === null) return binding;
  const owner = webConversationProviderForUrl(binding?.conversationUrl)?.provider ?? null;
  if (owner !== provider) {
    throw new WebProtocolError(
      `Web session binding belongs to ${owner ?? "an unknown provider"}, not ${provider}`,
      "WEB_SESSION_PROVIDER_MISMATCH",
    );
  }
  return binding;
}
