import { webConversationProvider } from "./provider-registry.js";
import { WebProtocolError } from "./protocol.js";

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
