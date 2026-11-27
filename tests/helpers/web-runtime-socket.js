import { EventEmitter } from "node:events";

export class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.failOnType = null;
  }

  send(raw) {
    const message = JSON.parse(String(raw));
    if (message.type === this.failOnType) throw new Error(`send failed for ${message.type}`);
    this.sent.push(message);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  receive(message) {
    // Simulate the extension's success envelope; explicit trace values are never replaced.
    if (message.type === "web.prompt.result" && message.payload?.trace === undefined) {
      const session = message.payload.session;
      message = { ...message, payload: { ...message.payload,
        trace: { requestId: message.requestId, actionId: message.requestId, result: "success",
          tabId: session?.tabId, bindingId: `${session?.sessionId}:${session?.runId}`,
          documentId: session?.documentId, frameId: session?.frameId },
        evidence: { documentId: session?.documentId, frameId: session?.frameId, ...message.payload.evidence },
      } };
    }
    this.emit("message", JSON.stringify(message));
  }
}
