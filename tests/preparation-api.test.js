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

test("HTTP canonical preparation, real Git approval, durable Run and RESULT projection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preparation-api-"));
  const target = path.join(root, "project"); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "app.js"), "export const value = 1;\n");
  const token = "test-token-preparation-api-0123456789", secret = "test-secret-preparation-api-0123456789";
  const config = { host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0", workspace: target, demoMode: false,
    persistence: { databasePath: path.join(root, "controller.sqlite") }, codex: { executablePath: process.execPath },
    dashboard: { token }, webExtension: { sharedSecret: secret, expectedExtensionIdentity: "test" }, relay: { webResponseTimeoutMs: 1000 } };
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
          binding = { ...message.payload, tabId: 1, windowId: 1, title: "Test", bindingStatus: "BOUND", lastObservedUserMessageId: null, lastObservedAssistantMessageId: null };
          delete binding.focus; reply("web.session.ready", { session: binding });
        }
        if (message.type === "web.prompt") {
          active = message.requestId; count++;
          const packet = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "질문", questions: ["어떤 기능?"], items: [] }
            : { type: "REQUIREMENTS_PROPOSAL", summary: "값 표시", questions: [], items: [{ statement: "값 표시", acceptanceCriteria: "화면에 1이 표시된다" }] };
          binding.lastObservedUserMessageId = "u" + count; binding.lastObservedAssistantMessageId = "a" + count;
          release = () => reply("web.prompt.result", { text: "<controller_packet>\n" + JSON.stringify(packet) + "\n</controller_packet>",
            confidence: "CONFIRMED_BY_UI_STATE", session: binding });
        }
        if (message.type === "web.delivery.inspect") reply("web.delivery.inspected", {
          currentDeliveryId: active, sessionId: binding.sessionId, runId: binding.runId,
          conversationUrl: binding.conversationUrl, conversationId: binding.conversationId, observedConversationUrl: binding.conversationUrl,
          pageReachable: true, pageBusy: false, generating: false, extensionBusy: false, pageStatus: "READY",
          lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count,
        });
        if (message.type === "web.delivery.ack" && !dropAck) active = null;
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
  const created = await post("/api/preparations", { requestId: "start", expectedVersion: 0,
    objective: "  아무거나\n", targetRoot: target, conversationUrl: "https://chatgpt.com/c/test" });
  assert.equal(created.status, 202, await created.clone().text());
  const prep = await created.json();
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
  const identity = { preparationId: prep.preparationId, sessionId: current.preparation.webSession.sessionId,
    conversationId: current.preparation.webSession.conversationId, conversationUrl: current.preparation.webSession.conversationUrl };
  const beforeRestart = current.preparation;
  await restart();
  current = await state("?view=start");
  assert.equal(current.workflow.stage, "PREPARE");
  assert.deepEqual(current.preparation, beforeRestart);
  assert.equal(count, 1);
  assert.equal(current.preparation.objective, "  아무거나\n");
  const reply = await post("/api/preparations/" + prep.preparationId + "/reply", {
    requestId: "reply", expectedVersion: current.workflow.preparationVersion, content: "값 표시",
  });
  assert.equal(reply.status, 202, await reply.clone().text());
  await ready("WAITING_WEB_RESPONSE"); dropAck = true; release();
  current = await ready("RECOVERY_REQUIRED");
  const deliveryId = current.preparation.webSession.activeDeliveryId;
  assert.equal(current.preparation.deliveries[1].state, "RESPONSE_COMPLETED");
  await restart(); dropAck = false;
  current = await state();
  assert.equal(current.workflow.stage, "PREPARE");
  assert.equal(current.preparation.webSession.activeDeliveryId, deliveryId);
  const reconciled = await post("/api/preparations/web", { ...identity, deliveryId, command: "web.reconcile",
    requestId: "reconcile", expectedVersion: current.workflow.preparationVersion });
  assert.equal(reconciled.status, 200, await reconciled.clone().text());
  current = await ready("AGREEMENT_READY");
  assert.equal(count, 2);
  assert.equal(current.preparation.webSession.sessionId, identity.sessionId);
  assert.equal(current.preparation.webSession.conversationId, identity.conversationId);
  assert.equal(current.preparation.webSession.activeDeliveryId, null);
  assert.deepEqual(current.preparation.deliveries.map((d) => d.state), ["ACKNOWLEDGED", "ACKNOWLEDGED"]);
  assert.equal(fs.existsSync(path.join(target, ".git")), false);
  const input = { requestId: "approve", expectedVersion: current.workflow.preparationVersion };
  const approveUrl = "/api/preparations/" + prep.preparationId + "/approve";
  const [approved, concurrent] = await Promise.all([post(approveUrl, input), post(approveUrl, input)]);
  assert.equal(approved.status, 200, await approved.clone().text());
  const run = await approved.json();
  if (concurrent.status === 200) assert.deepEqual(await concurrent.json(), run);
  else { assert.equal(concurrent.status, 409); assert.equal((await concurrent.json()).code, "UNKNOWN_RESULT"); }
  assert.deepEqual(await (await post("/api/preparations/" + prep.preparationId + "/approve", input)).json(), run);
  assert.equal(service.list().length, 1);
  assert.equal(service.get(run.runId).baseCommit, GitChangeWorkspace.preflight(target).baseCommit);
  current = await state();
  assert.equal(current.workflow.stage, "WORK");
  assert.equal((await state("?view=start")).workflow.stage, "WORK");
  assert.equal((await state("?runId=" + run.runId)).workflow.runId, run.runId);
  service.update(run.runId, { stage: "HOLD" });
  current = await state();
  assert.equal(current.workflow.stage, "RESULT"); assert.equal(current.workflow.state, "HOLD");
  assert.equal(current.preparation.resultingRunId, current.workflow.runId);
  assert.equal(current.preparation.agreement.status, "APPROVED");
  await restart(); current = await state();
  assert.equal(current.workflow.stage, "RESULT");
  assert.equal(current.workflow.runId, run.runId);
  assert.deepEqual(await (await post(approveUrl, input)).json(), run);
  assert.equal((await state("?requestId=approve")).requestResult.status, "COMPLETED");
  assert.equal(service.list().length, 1);
});
