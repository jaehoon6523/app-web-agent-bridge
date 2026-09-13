export const WEB_BRIDGE_PROTOCOL_VERSION = 2;

function enumObject(values) {
  return Object.freeze(Object.fromEntries(values.map((value) => [value, value])));
}

export const WebAuthenticationState = enumObject([
  "DISCONNECTED",
  "CHALLENGE_SENT",
  "AUTHENTICATED",
  "REJECTED",
]);

export const WebBindingStatus = enumObject([
  "ROOT_READY",
  "BOUND",
  "NEEDS_REBIND",
  "AUTH_REQUIRED",
  "AMBIGUOUS",
]);

export const WebCompletionConfidence = enumObject([
  "CONFIRMED_BY_UI_STATE",
  "HEURISTIC",
  "AMBIGUOUS",
]);

export const WebPageStatus = enumObject([
  "READY",
  "SESSION_AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SECURITY_CHECK_REQUIRED",
  "RATE_LIMITED",
  "CHATGPT_ERROR_PAGE",
  "MESSAGE_SEND_FAILED",
  "UI_CONTRACT_CHANGED",
]);

export const WebProtocolMessageType = enumObject([
  "controller.auth.challenge",
  "controller.auth.accepted",
  "controller.auth.rejected",
  "extension.auth.response",
  "extension.hello",
  "extension.state",
  "extension.heartbeat",
  "controller.ping",
  "web.session.prepare",
  "web.session.rebind",
  "web.session.focus",
  "web.session.ready",
  "web.session.error",
  "web.prompt",
  "web.prompt.progress",
  "web.prompt.result",
  "web.prompt.error",
  "web.prompt.cancelled",
  "web.cancel",
  "web.delivery.ack",
  "web.delivery.discard",
  "web.delivery.discarded",
  "web.delivery.inspect",
  "web.delivery.inspected",
  "web.delivery.focus",
  "web.delivery.focused",
  "web.delivery.stop",
  "web.delivery.stopped",
  "web.delivery.recover",
  "web.delivery.recovered",
  "web.manual-intervention",
]);

export class WebProtocolError extends Error {
  constructor(message, code = "WEB_PROTOCOL_ERROR", details = null) {
    super(message);
    this.name = "WebProtocolError";
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertProtocolEnvelope(message) {
  if (!isPlainObject(message)) {
    throw new WebProtocolError("Web bridge message must be a plain object", "INVALID_MESSAGE");
  }
  if (message.protocolVersion !== WEB_BRIDGE_PROTOCOL_VERSION) {
    throw new WebProtocolError(
      `Unsupported web bridge protocol version: ${JSON.stringify(message.protocolVersion)}`,
      "UNSUPPORTED_PROTOCOL_VERSION",
    );
  }
  if (typeof message.type !== "string" || message.type.length === 0) {
    throw new WebProtocolError("Web bridge message type is required", "INVALID_MESSAGE");
  }
  if (!Object.hasOwn(WebProtocolMessageType, message.type)) {
    throw new WebProtocolError(
      `Unknown web bridge message type: ${JSON.stringify(message.type)}`,
      "UNKNOWN_MESSAGE_TYPE",
    );
  }
  return message;
}
