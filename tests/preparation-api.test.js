import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createBridgeServer } from "../src/server.js";
import { CodeChangeService } from "../src/orchestration/code-change-service.js";
import { computeWebChallengeHmac } from "../src/runtime/web/auth.js";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";
import { DatabaseSync } from "../src/persistence/sqlite-database.js";

test("HTTP canonical preparation, real Git approval, durable Run and RESULT projection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preparation-api-"));
  const target = path.join(root, "project"); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "app.js"), "export const value = 1;\n");
  const incompleteRoot = fs.realpathSync(fs.mkdtempSync(path.join(root, "incomplete-")));
  const preparationFile = path.join(root, "preparations.sqlite");
  const previousMapping = { conversationUrl:"https://chatgpt.com/c/current", conversationId:"current",
    preparationId:"prep-saved", updatedAt:"2026-11-18T00:00:00Z" };
  const seed = new DatabaseSync(preparationFile);
  seed.exec("CREATE TABLE preparation_state (id INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT");
  seed.prepare("INSERT INTO preparation_state VALUES (1, ?)").run(JSON.stringify({
    currentId:null, contexts:{}, receipts:{}, projectConversations:{
      [fs.realpathSync(target)]:previousMapping,
      [incompleteRoot]:{ ...previousMapping, conversationId:null },
    },
  }));
  seed.close();
  const storedPreparation = () => {
    const db = new DatabaseSync(preparationFile, { readOnly:true });
    try { return JSON.parse(db.prepare("SELECT json FROM preparation_state WHERE id=1").get().json); }
    finally { db.close(); }
  };
  const token = "test-token-preparation-api-0123456789", secret = "test-secret-preparation-api-0123456789";
  const config = { host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0", workspace: target, demoMode: false,
    persistence: { databasePath: path.join(root, "controller.sqlite") }, codex: { executablePath: process.execPath },
    dashboard: { token }, webExtension: { enabled: true, sharedSecret: secret, expectedExtensionIdentity: "test" }, relay: { webResponseTimeoutMs: 1000 } };
  let service;
  const create = () => createBridgeServer({ runtimeConfig: config, createLiveRuntime: async ({ webSession }) => {
    service = new CodeChangeService({ filename: path.join(root, "runs.sqlite"), artifactStore: {}, webSession, codex: {} });
    // Exercise real Run persistence without starting an external CLI.
    service.execute = async (runId) => { service.update(runId, { stage: "WORKER_RUNNING" }); };
    return { store: { listRuns: () => [], getRun: () => null }, codeChanges: service, close: () => service.close() };
  } });
  let bridge = create();
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let binding, active = null, count = 0, release, dropAck = false;
  class Socket extends EventEmitter {
    readyState = 1;
    close() { this.readyState = 3; this.emit("close"); }
    send(raw) {
      const message = JSON.parse(raw);
      queueMicrotask(() => {
        const reply = (type, payload) => this.emit("message", JSON.stringify({ type, protocolVersion: 2, requestId: message.requestId, payload }));
        if (message.type === "controller.auth.challenge") this.emit("message", JSON.stringify({ type: "extension.auth.response",
          protocolVersion: 2, challengeId: message.challengeId, extensionIdentity: "test", hmacSha256: computeWebChallengeHmac(message.nonce, secret) }));
        if (message.type === "web.session.prepare") {
          binding = { ...message.payload, tabId: 1, windowId: 1, documentId: "document-1", frameId: 0, title: "Test", bindingStatus: "BOUND", lastObservedUserMessageId: null, lastObservedAssistantMessageId: null };
          delete binding.focus; delete binding.provider; delete binding.openSavedConversation;
          reply("web.session.ready", { session: binding });
        }
        if (message.type === "web.prompt") {
          active = message.requestId; count++;
          const packet = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "질문", questions: ["어떤 기능?"], items: [] }
            : { type: "REQUIREMENTS_PROPOSAL", summary: "값 표시", questions: [], items: [{ statement: "값 표시", acceptanceCriteria: "화면에 1이 표시된다" }] };
          binding.lastObservedUserMessageId = "u" + count; binding.lastObservedAssistantMessageId = "a" + count;
          release = () => reply("web.prompt.result", { text: JSON.stringify(packet),
            confidence: "CONFIRMED_BY_UI_STATE", session: binding,
            evidence: { documentId: binding.documentId, frameId: binding.frameId },
            trace: { requestId: active, actionId: active, result: "success", tabId: binding.tabId,
              bindingId: `${binding.sessionId}:${binding.runId}`, documentId: binding.documentId, frameId: binding.frameId } });
        }
        if (message.type === "web.delivery.inspect" && !binding) reply("web.delivery.inspected", { currentDeliveryId: null,
          sessionId: null, runId: null, conversationUrl: null, conversationId: null,
          pageReachable: true, pageBusy: false, generating: false, extensionBusy: false });
        if (message.type === "web.delivery.inspect" && binding) reply("web.delivery.inspected", {
          currentDeliveryId: active, sessionId: binding.sessionId, runId: binding.runId,
          conversationUrl: binding.conversationUrl, conversationId: binding.conversationId, observedConversationUrl: binding.conversationUrl,
          pageReachable: true, pageBusy: false, generating: false, extensionBusy: false, pageStatus: "READY",
          lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count,
        });
        if (message.type === "web.delivery.ack") {
          if (!dropAck) active = null;
          reply("web.delivery.acknowledged", { currentDeliveryId:active, sessionId:binding.sessionId,
            runId:binding.runId, conversationUrl:binding.conversationUrl, conversationId:binding.conversationId });
        }
      });
    }
  }
  bridge.extensionTransport.attach(new Socket()); await new Promise(setImmediate);
  let base = "http://127.0.0.1:" + (await bridge.listen()).port;
  const restart = async () => {
    await bridge.close(); bridge = create();
    bridge.extensionTransport.attach(new Socket()); await new Promise(setImmediate);
    base = "http://127.0.0.1:" + (await bridge.listen()).port;
  };
  const headers = { authorization: "Bearer " + token, origin: config.baseUrl, "content-type": "application/json" };
  const post = (url, body) => fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) });
  const state = async (query = "") => {
    const response = await fetch(base + "/api/state" + query, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.equal((await state()).workflow.stage, "START");
  assert.equal((await post("/api/project/prepare", { targetRoot: target })).status, 410);
  assert.equal((await post("/api/runs/start", {})).status, 410);
  const invalidStarts = [
    [{}, 400, "INVALID_INPUT"],
    [{ conversationUrl:null }, 400, "INVALID_INPUT"],
    [{ conversationUrl:"" }, 400, "INVALID_INPUT"],
    [{ conversationUrl:"https://example.invalid/c/test" }, 400, "INVALID_INPUT"],
    [{ targetRoot:incompleteRoot, conversationUrl:previousMapping.conversationUrl,
      reuseProjectConversation:true }, 409, "PROJECT_CONVERSATION_UNAVAILABLE"],
    [{ conversationUrl:"https://chatgpt.com/c/old", reuseProjectConversation:true }, 409, "PROJECT_CONVERSATION_CHANGED"],
  ];
  for (const [index, [body, status, code]] of invalidStarts.entries()) {
    const response = await post("/api/preparations", { requestId:"invalid-" + index, objective:"fixture", targetRoot:target, ...body });
    assert.equal(response.status, status);
    const rejected = await response.json();
    assert.equal(rejected.code, code);
    assert.equal(rejected.preparationId, null);
    assert.equal(rejected.runId, null);
  }
  assert.equal(storedPreparation().currentId, null);
  const created = await post("/api/preparations", { requestId: "start",
    objective: "  아무거나\n", targetRoot: target, conversationUrl: "https://chatgpt.com/c/test", reuseProjectConversation:false });
  assert.equal(created.status, 202, await created.clone().text());
  const prep = await created.json();
  assert.match(prep.preparationId, /^prep_/u);
  assert.equal(prep.resultingRunId, null);
  assert.equal(prep.projectConversationSource, null);
  assert.equal(storedPreparation().contexts[prep.preparationId].resultingRunId, null);
  assert.deepEqual(storedPreparation().projectConversations[fs.realpathSync(target)], previousMapping);
  assert.equal(fs.existsSync(path.join(target, ".git")), false);
  const ready = async (expected) => {
    for (let i = 0; i < 50; i++) {
      const result = await state(); if (result.workflow.state === expected) return result;
      await new Promise(setImmediate);
    }
    assert.fail("State did not reach " + expected + ": " + JSON.stringify(await state()));
  };
  await ready("WAITING_WEB_RESPONSE"); release();
  let current = await ready("DISCUSSING");
  assert.equal(current.preparation.preparationId, prep.preparationId);
  const confirmedMapping = storedPreparation().projectConversations[fs.realpathSync(target)];
  assert.equal(confirmedMapping.preparationId, prep.preparationId);
  assert.equal(confirmedMapping.conversationId, "test");
  assert.equal(confirmedMapping.conversationUrl, "https://chatgpt.com/c/test");
  assert.deepEqual(current.projectConversations.find(it => it.targetRoot === fs.realpathSync(target)),
    {targetRoot:fs.realpathSync(target), ...confirmedMapping});
  const identity = { preparationId: prep.preparationId, sessionId: current.preparation.webSession.sessionId,
    conversationId: current.preparation.webSession.conversationId, conversationUrl: current.preparation.webSession.conversationUrl };
  const beforeRestart = current.preparation;
  await restart();
  current = await state("?view=start");
  assert.equal(current.workflow.stage, "PREPARE");
  assert.deepEqual(current.preparation, beforeRestart);
  assert.deepEqual(storedPreparation().projectConversations[fs.realpathSync(target)], confirmedMapping);
  assert.equal(count, 1);
  assert.equal(current.preparation.objective, "  아무거나\n");
  const reply = await post("/api/preparations/" + prep.preparationId + "/reply", {
    requestId: "reply", content: "값 표시", expectedVersion:current.workflow.preparationVersion,
  });
  assert.equal(reply.status, 202, await reply.clone().text());
  await ready("WAITING_WEB_RESPONSE"); dropAck = true; release();
  current = await ready("RECOVERY_REQUIRED");
  const deliveryId = current.preparation.webSession.activeDeliveryId;
  assert.equal(current.preparation.deliveries[1].state, "RESPONSE_COMPLETED");
  assert.deepEqual(storedPreparation().projectConversations[fs.realpathSync(target)], confirmedMapping);
  await restart(); dropAck = false;
  current = await state();
  assert.equal(current.workflow.stage, "PREPARE");
  assert.equal(current.preparation.webSession.activeDeliveryId, deliveryId);
  const reconciled = await post("/api/preparations/web", { ...identity, deliveryId, command: "web.reconcile",
    requestId: "reconcile", expectedVersion:current.workflow.preparationVersion });
  assert.equal(reconciled.status, 200, await reconciled.clone().text());
  current = await ready("AGREEMENT_READY");
  assert.equal(count, 2);
  assert.equal(current.preparation.webSession.sessionId, identity.sessionId);
  assert.equal(current.preparation.webSession.conversationId, identity.conversationId);
  assert.equal(current.preparation.webSession.activeDeliveryId, null);
  assert.deepEqual(current.preparation.deliveries.map((d) => d.state), ["ACKNOWLEDGED", "ACKNOWLEDGED"]);
  assert.equal(fs.existsSync(path.join(target, ".git")), false);
  const input = { requestId: "approve", expectedVersion:current.workflow.preparationVersion };
  const approveUrl = "/api/preparations/" + prep.preparationId + "/approve";
  const [approved, concurrent] = await Promise.all([post(approveUrl, input), post(approveUrl, input)]);
  assert.equal(approved.status, 200, await approved.clone().text());
  const run = await approved.json();
  assert.match(run.runId, /^code_/u);
  assert.notEqual(run.runId, prep.preparationId);
  if (concurrent.status === 200) assert.deepEqual(await concurrent.json(), run);
  else { assert.equal(concurrent.status, 409); assert.equal((await concurrent.json()).code, "UNKNOWN_RESULT"); }
  assert.deepEqual(await (await post("/api/preparations/" + prep.preparationId + "/approve", input)).json(), run);
  assert.equal(service.list().length, 1);
  assert.equal(service.get(run.runId).preparationId, prep.preparationId);
  assert.equal(service.get(run.runId).conversationUrl, confirmedMapping.conversationUrl);
  assert.equal(storedPreparation().contexts[prep.preparationId].resultingRunId, run.runId);
  assert.equal(service.get(run.runId).baseCommit, GitChangeWorkspace.preflight(target).baseCommit);
  current = await state();
  assert.equal(current.workflow.stage, "WORK");
  assert.equal((await state("?view=start")).workflow.stage, "WORK");
  assert.equal((await state("?runId=" + run.runId)).workflow.runId, run.runId);
  service.update(run.runId, { stage: "HOLD" });
  current = await state();
  assert.equal(current.workflow.stage, "WORK"); assert.equal(current.workflow.state, "HOLD");
  assert.equal(current.preparation.resultingRunId, current.workflow.runId);
  assert.equal(current.preparation.agreement.status, "APPROVED");
  await restart(); current = await state();
  assert.equal(current.workflow.stage, "WORK");
  assert.equal(current.workflow.runId, run.runId);
  assert.deepEqual(await (await post(approveUrl, input)).json(), run);
  assert.equal((await state("?requestId=approve")).requestResult.status, "COMPLETED");
  assert.equal(service.list().length, 1);

  service.update(run.runId, { stage:"APPLIED" });
  const continued = await post("/api/preparations", { requestId:"continue", objective:"Follow-up fixture",
    targetRoot:target, conversationUrl:confirmedMapping.conversationUrl, reuseProjectConversation:true, followUpRunId:run.runId });
  assert.equal(continued.status, 202, await continued.clone().text());
  const next = await continued.json();
  assert.notEqual(next.preparationId, prep.preparationId);
  assert.equal(next.followUp.runId, run.runId);
  assert.equal(next.projectConversationSource, prep.preparationId);
  assert.equal(next.resultingRunId, null);
  await ready("WAITING_WEB_RESPONSE"); release();
  current = await ready("AGREEMENT_READY");
  const beforeCancel = storedPreparation().projectConversations[fs.realpathSync(target)];
  assert.equal(beforeCancel.preparationId, next.preparationId);
  const cancelled = await post("/api/preparations/" + next.preparationId + "/cancel", {
    requestId:"cancel-follow-up", expectedVersion:current.workflow.preparationVersion,
  });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await cancelled.json()).lifecycle, "ABANDONED");
  await restart();
  const reopened = storedPreparation();
  assert.equal(reopened.contexts[next.preparationId].resultingRunId, null);
  assert.deepEqual(reopened.projectConversations[fs.realpathSync(target)], beforeCancel);
  assert.equal((await state()).runs.length, 1);

  service.update(run.runId, { stage:"RECOVERY_REQUIRED",
    conversationBindings:[{ role:"JUDGE", conversationUrl:confirmedMapping.conversationUrl, activeDeliveryId:"old-review" }] });
  const recoveryRun = service.get(run.runId);
  const recoveryView = await state("?runId=" + run.runId);
  assert.equal(recoveryView.workflow.state, "RECOVERY_REQUIRED");
  assert.equal(recoveryView.preparationStartBlocked, false);
  assert.equal(recoveryView.preparationApprovalBlocked, true);
  const startView = await state("?view=start");
  assert.equal(startView.workflow.stage, "START");
  assert.ok(startView.commandCapabilities.includes("preparation.start"));
  const request = { objective:"Separate recovery-safe discussion", targetRoot:target };
  const sameConversation = await post("/api/preparations", {
    ...request, requestId:"same-conversation", conversationUrl:confirmedMapping.conversationUrl,
  });
  assert.equal(sameConversation.status, 409);
  assert.equal((await sameConversation.json()).code, "REVIEW_DELIVERY_PENDING");
  const separateConversation = await post("/api/preparations", {
    ...request, requestId:"separate-conversation", conversationUrl:"https://chatgpt.com/c/separate",
  });
  assert.equal(separateConversation.status, 202, await separateConversation.clone().text());
  const separate = await separateConversation.json();
  await ready("WAITING_WEB_RESPONSE"); release();
  current = await ready("AGREEMENT_READY");
  assert.equal(current.preparation.deliveries[0].state, "ACKNOWLEDGED");
  assert.ok(!current.commandCapabilities.includes("preparation.approve"));
  const blockedApproval = await post("/api/preparations/" + separate.preparationId + "/approve", {
    requestId:"blocked-approval", expectedVersion:current.workflow.preparationVersion,
  });
  assert.equal(blockedApproval.status, 409);
  assert.equal((await blockedApproval.json()).code, "RUN_BUSY");
  assert.equal(storedPreparation().contexts[separate.preparationId].agreement.status, "READY");
  assert.deepEqual(service.get(run.runId), recoveryRun);
  await restart();
  current = await state();
  assert.equal(current.preparation.deliveries[0].state, "ACKNOWLEDGED");
  assert.deepEqual(service.get(run.runId), recoveryRun);
});
