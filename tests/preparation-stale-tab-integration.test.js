import * as documentBinding from "../extension/runtime/document-binding.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { PreparationService } from "../src/orchestration/preparation-service.js";
import { createExtensionStateStore } from "../extension/runtime/storage.js";
import { createActiveTurnGate } from "../extension/runtime/turn-guard.js";
import * as conversation from "../extension/runtime/conversation.js";
import { dashboard } from "./public/workflow-runtime.test.js";

test("persisted manual delivery with only root tab: real prepare/recovery preserves delivery and projects diagnostic", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-tab-integration-"));
  let stored = { currentDeliveryId: "turn_123", lastBoundRunId: "manual_run_123", lastBoundSessionId: "manual_session_123",
    tabId: 7, windowId: 1, conversationUrl: "https://chatgpt.com/c/old", conversationId: "old", bindingStatus: "BOUND" };
  const storage = { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } };
  const store = createExtensionStateStore(storage), messages = [];
  let submissions = 0;
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const context = vm.createContext({ ...documentBinding, ...conversation, console, store,
    turnGate: createActiveTurnGate(), CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    chrome: { tabs: { query: async () => [{ id: 8, windowId: 1, url: "https://chatgpt.com/" }],
      sendMessage: async () => { throw new Error("Old tab is closed"); } } },
    send: message => messages.push(message), broadcastPopupState() {},
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    errorPayload: error => ({ code: error.code, message: error.message, details: error.details }),
  });
  vm.runInContext(source.slice(source.indexOf("async function deliveryDetails("), source.indexOf("async function handleFocus(")), context);
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function rebindSession(")), context);
  const web = {
    inspectDelivery: async () => ({ currentDeliveryId: stored.currentDeliveryId,
      sessionId: stored.lastBoundSessionId, runId: stored.lastBoundRunId,
      conversationUrl: stored.conversationUrl, conversationId: stored.conversationId }),
    resume: ({ binding }) => context.prepareBoundSession(binding),
    recoverDelivery: async previous => {
      await context.handleDeliveryRecovery({ requestId: "recover", payload: previous });
      const reply = JSON.parse(JSON.stringify(messages.at(-1)));
      assert.equal(reply.type, "web.session.error");
      throw Object.assign(new Error(reply.payload.message), reply.payload);
    },
    submitTurn: async () => { submissions++; throw new Error("Must not submit"); },
  };
  const filename = path.join(root, "preparation.sqlite");
  const options = { filename, web, available: () => true, assertStart: async () => {}, approve: async () => {}, findRun: async () => null };
  let service = new PreparationService(options);
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(
    service.execute("preparation.start", { requestId: "start", objective: "new work", targetRoot: root, conversationUrl: "https://chatgpt.com/" }),
    error => error.code === "RECOVERY_REQUIRED",
  );
  await Promise.all([...service.jobs.values()].filter(value => value instanceof Promise));
  assert.equal(submissions, 0);
  assert.equal((await store.read()).currentDeliveryId, "turn_123");
  assert.equal(service.current, null);
});
