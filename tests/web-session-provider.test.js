import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatGptWebSessionAdapter,
  WebExtensionTransport,
  WebSessionAdapter,
} from "../src/runtime/web/session-adapter.js";

const SECRET = "provider-adapter-test-0123456789abcdef";
const IDENTITY = "provider-adapter-test-extension";

function boundClaudeSession() {
  return {
    sessionId:"session-claude",
    runId:"run-claude",
    tabId:7,
    documentId:"document-claude",
    frameId:0,
    windowId:3,
    conversationUrl:"https://claude.ai/chat/conversation-1",
    conversationId:"conversation-1",
    title:"Claude",
    lastObservedUserMessageId:null,
    lastObservedAssistantMessageId:null,
    bindingStatus:"BOUND",
  };
}

class CapturingTransport extends WebExtensionTransport {
  lastMessage = null;

  constructor() {
    super({ sharedSecret:SECRET, expectedExtensionIdentity:IDENTITY });
  }

  get authenticated() {
    return true;
  }

  send(message) {
    this.lastMessage = structuredClone(message);
    queueMicrotask(() => {
      this.emit("message", {
        type:"web.session.ready",
        protocolVersion:2,
        requestId:message.requestId,
        payload:{ session:boundClaudeSession() },
      });
    });
  }
}

test("generic Web session adapter exposes the configured provider and sends it to the extension", async () => {
  const transport = new CapturingTransport();
  const adapter = new WebSessionAdapter({
    transport,
    provider:"CLAUDE_WEB",
    responseTimeoutMs:500,
  });

  assert.equal(adapter.runtimeIdentity.actor, "CHATGPT_WEB_AGENT");
  assert.equal(adapter.runtimeIdentity.provider, "CLAUDE_WEB");

  const binding = boundClaudeSession();
  const returned = await adapter.start({ binding });

  assert.equal(transport.lastMessage.type, "web.session.rebind");
  assert.equal(transport.lastMessage.payload.provider, "CLAUDE_WEB");
  assert.equal(returned.conversationId, binding.conversationId);
  await adapter.close();
});

test("generic Web session adapter fails closed for an unregistered provider", () => {
  const transport = new CapturingTransport();
  assert.throws(
    () => new WebSessionAdapter({ transport, provider:"UNKNOWN_WEB" }),
    (error) => error?.code === "WEB_PROVIDER_UNAVAILABLE",
  );
  transport.close();
});

test("ChatGPT compatibility adapter preserves the existing runtime identity", async () => {
  const transport = new CapturingTransport();
  const adapter = new ChatGptWebSessionAdapter({ transport, responseTimeoutMs:500 });

  assert.equal(adapter.runtimeIdentity.actor, "CHATGPT_WEB_AGENT");
  assert.equal(adapter.runtimeIdentity.provider, "CHATGPT_WEB");
  await adapter.close();
});
