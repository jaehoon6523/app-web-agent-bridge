import {
  ControllerPacketEnvelopeError,
  parseFinalControllerPacketEnvelope,
} from "../../domain/controller-packet-envelope.js";

export class WebPacketError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WebPacketError";
    this.code = code;
  }
}

export function parseFinalControllerPacket(rawText, options = undefined) {
  try {
    return parseFinalControllerPacketEnvelope(rawText, options);
  } catch (cause) {
    if (!(cause instanceof ControllerPacketEnvelopeError)) throw cause;
    const code = cause.code === "EMPTY_AGENT_RESPONSE" ? "EMPTY_WEB_RESPONSE" : cause.code;
    const error = new WebPacketError(cause.message, code);
    error.cause = cause;
    throw error;
  }
}
