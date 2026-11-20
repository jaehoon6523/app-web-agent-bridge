import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreparationService } from "../../src/orchestration/preparation-service.js";
import { validateWebSessionBinding } from "../../src/runtime/web/binding.js";

export const tick = () => new Promise(setImmediate);
export async function settled(service) {
  for (let i = 0; i < 50 && service.jobs.size; i++) await tick();
  assert.equal(service.jobs.size, 0);
}
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-preparation-"));
  const runs = new Map(), calls = [], prompts = [];
  let binding, active = null, count = 0, failAck = false, inspection = {}, afterAck = {}, discarded = null;
  const web = {
    async inspect() {
      return { binding: binding ?? null };
    },
    async resume(input) {
      validateWebSessionBinding(input.binding);
      binding = input.binding.conversationUrl === null
        ? { ...input.binding, conversationUrl: "https://chatgpt.com/", conversationId: null, bindingStatus: "ROOT_READY", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 }
        : { ...input.binding, bindingStatus: "BOUND", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 };
      calls.push(binding.sessionId); return binding;
    },
    async rebind(input) {
      validateWebSessionBinding(input.binding);
      binding = input.binding.conversationUrl === null
        ? { ...input.binding, conversationUrl:"https://chatgpt.com/", conversationId:null,
          bindingStatus:"ROOT_READY", tabId:input.tabId, windowId:2, documentId:`document-${input.tabId}`, frameId:0 }
        : { ...input.binding, bindingStatus:"BOUND", tabId:input.tabId, windowId:2,
          documentId:`document-${input.tabId}`, frameId:0 };
      calls.push(`rebind:${input.tabId}`); return binding;
    },
    async submitTurn(input) {
      prompts.push(input.text);
      if (binding.bindingStatus === "ROOT_READY") binding = { ...binding, conversationUrl: "https://chatgpt.com/c/new-conversation", conversationId: "new-conversation", bindingStatus: "BOUND" };
      active = input.turnId; count++;
      const parsed = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "무엇을 만들까요?", questions: ["원하는 기능?"], items: [] }
        : { type: "REQUIREMENTS_PROPOSAL", summary: "채팅", questions: [], items: [{ statement: "메시지 전송", acceptanceCriteria: "목록에 한 번 표시" }] };
      binding = { ...binding, lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count };
      return { completion: Promise.resolve({ turnId: active, binding, confidence: "CONFIRMED_BY_UI_STATE",
        trace: { requestId: active, actionId: active, bindingId: `${binding.sessionId}:${binding.runId}`,
          tabId: binding.tabId, documentId: binding.documentId, frameId: binding.frameId, result: "success" },
        rawText: JSON.stringify(parsed) }) };
    },
    async inspectDelivery() { if (!binding) return { currentDeliveryId: null }; return { currentDeliveryId: active, sessionId: binding.sessionId, runId: binding.runId,
      conversationId: binding.conversationId, conversationUrl: binding.conversationUrl, observedConversationUrl: binding.conversationUrl,
      pageReachable: true, generating: false, pageBusy: false, extensionBusy: false,
      lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count, ...inspection }; },
    async acknowledgeDelivery() { if (failAck) throw new Error("lost ACK"); active = null; Object.assign(inspection, afterAck); },
    async discardDelivery(expected) {
      discarded = structuredClone(expected);
      active = null;
      Object.assign(inspection, { currentDeliveryId: null });
      return { ...expected, result: "discarded" };
    },
  };
  const options = { filename: path.join(root, "state.sqlite"), web, available: () => true, assertStart: async () => {},
    assertInvalidAbandonment() {},
    findRun: async (id) => runs.get(id),
    approve: async (context) => {
      assert.equal(context.agreement.status, "APPROVED");
      assert.equal(context.webSession.activeDeliveryId, null);
      const run = { runId: context.reservedRunId, preparationId: context.preparationId, baseCommit: "base", version: 1, phase: "WORKER_RUNNING" };
      runs.set(run.runId, run); return { ...run, repository: { baseCommit: "base" } };
    } };
  let service = new PreparationService(options);
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, calls, prompts, web, get service() { return service; }, ackFailure(value) { failAck = value; },
    get discarded() { return discarded; },
    observe(value) { inspection = value; }, afterAck(value) { afterAck = value; },
    restart() { service.close(); service = new PreparationService(options); },
    start(extras = {}) { return service.execute("preparation.start", { requestId: "start",
      objective: "  아무거나\n", targetRoot: root, conversationUrl: "https://chatgpt.com/c/test", ...extras }); },
    command(type, extras = {}) { return service.execute(type, { requestId: type + Math.random(),
      preparationId: service.current.preparationId, expectedVersion:service.current.version, ...extras }); },
  };
}
