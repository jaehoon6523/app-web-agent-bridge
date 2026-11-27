import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createBridgeServer } from "../src/server.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { CodeChangeStore } from "../src/persistence/code-change-store.js";
import { DatabaseSync } from "../src/persistence/sqlite-database.js";
import { ResourceClosureError } from "../src/persistence/resource-closure.js";
import { fixture, settled } from "./helpers/preparation-service-fixture.js";
import { createExtensionStateStore } from "../extension/runtime/storage.js";
import { createActiveTurnGate } from "../extension/runtime/turn-guard.js";
import { abandonInvalidDelivery } from "../extension/runtime/invalid-delivery-abandonment.js";
import { discardExactDelivery } from "../extension/runtime/delivery-discard.js";
import { ChatGptWebSessionAdapter, WebExtensionTransport, computeWebChallengeHmac } from "../src/runtime/web/index.js";
import { FakeSocket } from "./helpers/web-runtime-socket.js";

test("invalid abandonment uses its own authenticated wire receipt", async () => {
  const secret = "test-only-shared-secret-0123456789abcdef", identity = "extension-test-01";
  const transport = new WebExtensionTransport({sharedSecret:secret, expectedExtensionIdentity:identity});
  const socket = new FakeSocket();
  transport.attach(socket);
  const challenge = socket.sent[0];
  socket.receive({type:"extension.auth.response",protocolVersion:2,challengeId:challenge.challengeId,
    extensionIdentity:identity,hmacSha256:computeWebChallengeHmac(challenge.nonce,secret)});
  assert.equal(transport.authenticated,true);
  const adapter = new ChatGptWebSessionAdapter({transport});
  try {
    const input = {currentDeliveryId:"delivery-one",sessionId:"session-1",runId:"run-1",
      conversationUrl:"https://chatgpt.com/c/conversation-1",requestId:"original-http-request",intentHash:"exact-intent"};
    const reply = (request,payload) => socket.receive({type:"web.delivery.invalid-abandoned",protocolVersion:2,
      requestId:request.requestId,payload});
    let pending = adapter.discardDelivery(input,true);
    let message = socket.sent.at(-1);
    assert.equal(message.type,"web.delivery.abandon-invalid");
    assert.deepEqual(message.payload,input);
    reply(message,{...input,requestId:"wrong-http-request"});
    await assert.rejects(pending,{code:"DELIVERY_RECOVERY_MISMATCH"});
    pending = adapter.discardDelivery(input,true);
    message = socket.sent.at(-1);
    reply(message,input);
    assert.deepEqual(await pending,input);
  } finally { await adapter.close(); }
});

function sqliteFailure(service, nthCommit) {
  const db = service.db;
  const exec = db.exec.bind(db);
  let commits = 0;
  db.exec = sql => {
    if (sql === "COMMIT" && ++commits === nthCommit) throw new Error("injected COMMIT failure");
    return exec(sql);
  };
  return () => { db.exec = exec; };
}

for (const mode of ["normal", "intent-failure", "extension-failure", "lost-response", "final-failure"]) test(
  "explicit invalid-response abandonment: " + mode, async t => {
  const f = fixture(t);
  const start = await f.start();
  await settled(f.service);
  const c = f.service.current, d = c.deliveries[0], s = c.webSession;
  assert.equal(d.state, "ACKNOWLEDGED");
  const normalVersion = c.version;
  await assert.rejects(f.service.execute("preparation.discard", {requestId:"valid-response", preparationId:c.preparationId,
    expectedVersion:normalVersion, abandonInvalidResponseConfirmed:true}), {code:"INVALID_ABANDONMENT_UNAVAILABLE"});
  const original = mode === "normal" ? '{"type":"REQUIREMENTS_PROPOSAL"' : "synthetic response without a controller packet";
  Object.assign(c, {state:"RECOVERY_REQUIRED"});
  Object.assign(d, {state:"RESPONSE_COMPLETED", processingState:null, validation:{status:"CONFIRMED", format:"INVALID",
    formatError:{code:mode === "normal" ? "INVALID_PACKET_JSON" : "CONTROLLER_PACKET_MISSING"}}, response:{...d.response, rawText:original}});
  s.activeDeliveryId = d.deliveryId;
  f.service.saveSync();
  let saved = {currentDeliveryId:d.deliveryId, completedDelivery:structuredClone(d.response),
    lastBoundSessionId:s.sessionId, lastBoundRunId:c.preparationId, conversationId:s.conversationId, conversationUrl:s.conversationUrl};
  let remoteCalls = 0, writes = 0, failExtension = false, loseReply = false;
  const store = createExtensionStateStore({get:async () => structuredClone(saved), set:async value => {
    if (failExtension) throw new Error("injected extension write failure");
    writes++;
    saved = structuredClone(value);
  }});
  const turnGate = createActiveTurnGate();
  const tabs = {sendMessage:async () => { throw new Error("Receiving end does not exist"); }};
  const legacy = [];
  await discardExactDelivery({store, turnGate, tabs, message:{requestId:"legacy", payload:{
    currentDeliveryId:d.deliveryId, unresolvedResultConfirmed:true, noAutomaticResendConfirmed:true, reason:"test discard"}},
  send:value => legacy.push(value)});
  assert.equal(legacy[0].payload.code, "DELIVERY_RESPONSE_REQUIRED");
  f.web.discardDelivery = async (intent, invalid) => {
    assert.equal(invalid, true);
    remoteCalls++;
    let reply;
    await abandonInvalidDelivery({store, turnGate, tabs, onChange() {}, send:value => { reply = value; },
      message:{requestId:"remote-"+remoteCalls,payload:intent}});
    if (loseReply) throw Object.assign(new Error("injected lost extension reply"), {code:"WEB_RESPONSE_TIMEOUT"});
    if (reply.type === "web.session.error") throw Object.assign(new Error(reply.payload.message), reply.payload);
    return reply.payload;
  };
  f.observe({invalidAbandonmentProtocol:1, currentDeliveryId:d.deliveryId, completedDelivery:d.response, pageReachable:false, pageBusy:null, generating:null});
  const input = {requestId:"abandon-once", preparationId:start.preparationId, expectedVersion:c.version,
    deliveryId:d.deliveryId, sessionId:s.sessionId, runId:c.preparationId, conversationId:s.conversationId,
    conversationUrl:s.conversationUrl, abandonInvalidResponseConfirmed:true, noAutomaticResendConfirmed:true,
    pageStateUnconfirmedConfirmed:true, reason:"Preserve invalid response and end preparation"};
  await assert.rejects(f.service.execute("preparation.discard", {...input, requestId:"stale", expectedVersion:c.version-1}),
    {code:"PREPARATION_VERSION_CONFLICT"});
  for (const field of ["deliveryId","sessionId","runId","conversationId","conversationUrl"]) {
    await assert.rejects(f.service.execute("preparation.discard", {...input, requestId:"wrong-"+field,[field]:"different"}),
      {code:"DELIVERY_RECOVERY_MISMATCH"});
  }
  assert.equal(remoteCalls, 0);
  if (mode === "normal") {
    const command = patch => f.service.execute("preparation.discard", {...input,...patch});
    await assert.rejects(command({pageStateUnconfirmedConfirmed:false}), {code:"ABANDONMENT_CONFIRMATION_REQUIRED"});
    f.observe({currentDeliveryId:d.deliveryId, completedDelivery:d.response});
    await assert.rejects(command({}), {code:"EXTENSION_UPDATE_REQUIRED"});
    f.observe({invalidAbandonmentProtocol:1,currentDeliveryId:d.deliveryId, completedDelivery:{...d.response,rawText:"different response"}});
    await assert.rejects(command({}), {code:"DELIVERY_RESPONSE_MISMATCH"});
    assert.equal(f.service.receipt(input.requestId).status,"NOT_FOUND");
    assert.equal(writes,0);
    f.observe({invalidAbandonmentProtocol:1,currentDeliveryId:d.deliveryId, completedDelivery:d.response});
  }
  if (mode !== "normal") {
    const restore = mode === "intent-failure" || mode === "final-failure" ? sqliteFailure(f.service, mode === "intent-failure" ? 1 : 2) : () => {};
    failExtension = mode === "extension-failure";
    loseReply = mode === "lost-response";
    await assert.rejects(f.service.execute("preparation.discard", input), /injected|has not confirmed/i);
    restore();
    assert.equal(f.service.current.lifecycle,"ACTIVE");
    assert.equal(f.service.current.webSession.activeDeliveryId,d.deliveryId);
    assert.equal(f.service.receipt(input.requestId).status, mode === "intent-failure" ? "NOT_FOUND" : "PROCESSING");
    if (mode === "intent-failure") assert.equal(remoteCalls, 0);
    else {
      await assert.rejects(f.service.execute("preparation.discard", {...input, requestId:"different"}),
        {code:"REQUEST_ID_CONFLICT"});
      f.restart();
      assert.equal(f.service.receipt(input.requestId).status,"PROCESSING");
    }
    assert.equal(saved.currentDeliveryId, ["lost-response","final-failure"].includes(mode) ? null : d.deliveryId);
    failExtension = false;
    loseReply = false;
  }
  const result = await f.service.execute("preparation.discard", input);
  assert.equal(result.lifecycle, "ABANDONED");
  assert.equal(f.service.current.webSession.activeDeliveryId, null);
  assert.equal(f.service.current.deliveries[0].response.rawText, original);
  assert.deepEqual(await f.service.execute("preparation.discard", input), result);
  await assert.rejects(f.service.execute("preparation.discard", {...input, reason:"different body"}),
    {code:"REQUEST_ID_CONFLICT"});
  assert.equal(writes, 1);
  assert.equal(saved.invalidDeliveryArchives[d.deliveryId].response.rawText, original);
  assert.equal(saved.invalidDeliveryArchives[d.deliveryId].receipt.pageIdentityConfirmed, false);
  assert.equal(saved.currentDeliveryId, null);
  assert.equal(saved.lastAcknowledgedDelivery, null);
  f.restart();
  assert.deepEqual(await f.service.execute("preparation.discard", input), result);
  assert.ok(f.service.capabilities().includes("preparation.start"));
  assert.notEqual((await f.start({requestId:"next-preparation"})).preparationId, c.preparationId);
  await settled(f.service);
});

for (const closureUnconfirmed of [false, true]) test(closureUnconfirmed
  ? "HTTP invalid abandonment blocks an unconfirmed runtime resource closure"
  : "HTTP invalid abandonment bypasses failed runtime initialization and protects persisted work", async t => {
  const f = fixture(t);
  await f.start();
  await settled(f.service);
  const c = f.service.current, d = c.deliveries[0], s = c.webSession;
  const original = "synthetic response without a controller packet";
  c.state = "RECOVERY_REQUIRED";
  Object.assign(d, {state:"RESPONSE_COMPLETED", processingState:null, validation:{status:"CONFIRMED", format:"INVALID",
    formatError:{code:"CONTROLLER_PACKET_MISSING"}}, response:{...d.response, rawText:original}});
  s.activeDeliveryId = d.deliveryId;
  f.service.saveSync();
  const preparationPath = path.join(f.root, "preparations.sqlite");
  fs.copyFileSync(path.join(f.root, "state.sqlite"), preparationPath);
  const databasePath = path.join(f.root, "controller.sqlite");
  new SqliteStore({filename:databasePath}).close();
  if (closureUnconfirmed) await new CodeChangeStore(databasePath).close();
  let initializationCalls = 0, remoteCalls = 0;
  const unavailable = Object.assign(new Error("injected runtime initialization failure"), {code:"LIVE_RUNTIME_INITIALIZATION_FAILED"});
  const startupError = closureUnconfirmed ? new ResourceClosureError({
    resourceOwner:"LiveDiscussionRuntime", failureStage:"initialization.cleanup", operationError:unavailable,
    cleanupErrors:[new Error("injected handle close failure")], code:"LIVE_RUNTIME_CLEANUP_FAILED",
  }) : unavailable;
  const baseUrl = "http://127.0.0.1:0", token = "test-preparation-token-0123456789";
  const bridge = createBridgeServer({runtimeConfig:{host:"127.0.0.1", port:0, baseUrl, workspace:f.root,
    demoMode:false, persistence:{databasePath}, dashboard:{token},
    webExtension:{enabled:true, sharedSecret:"test-extension-secret-0123456789", expectedExtensionIdentity:"test"},
    relay:{webResponseTimeoutMs:1000}}, createLiveRuntime:async () => {
    initializationCalls++;
    if (closureUnconfirmed && initializationCalls > 1) return {close() {}};
    throw startupError;
  }});
  try {
    const base = "http://127.0.0.1:" + (await bridge.listen()).port;
    await assert.rejects(bridge.getLiveRuntime(), {code:startupError.code});
    const headers = {authorization:"Bearer " + token, origin:baseUrl, "content-type":"application/json"};
    const owner = {sessionId:s.sessionId, runId:c.preparationId, conversationId:s.conversationId, conversationUrl:s.conversationUrl};
    const inspectDelivery = async () => ({...owner, invalidAbandonmentProtocol:1,
      currentDeliveryId:d.deliveryId, completedDelivery:d.response, extensionBusy:false});
    bridge.webSession.inspectDelivery = inspectDelivery;
    bridge.webSession.discardDelivery = async (intent, invalid) => {
      assert.equal(invalid, true);
      const persisted = readPreparation();
      assert.equal(persisted.receipt.status, "PROCESSING");
      assert.equal(persisted.delivery.invalidAbandonmentIntent.intentHash, intent.intentHash);
      remoteCalls++;
      return {...intent, abandonedAt:new Date().toISOString(), pageReachable:false, pageIdentityConfirmed:false};
    };
    const input = {...owner, preparationId:c.preparationId, expectedVersion:c.version+1, deliveryId:d.deliveryId,
      requestId:"abandon-original", abandonInvalidResponseConfirmed:true, noAutomaticResendConfirmed:true,
      pageStateUnconfirmedConfirmed:true, reason:"Preserve invalid response and end preparation"};
    function readPreparation() {
      const db = new DatabaseSync(preparationPath, {readOnly:true});
      try {
        const saved = JSON.parse(db.prepare("SELECT json FROM preparation_state WHERE id=1").get().json);
        const prep = saved.contexts[c.preparationId];
        return {prep, delivery:prep.deliveries[0], receipt:saved.receipts[input.requestId]};
      } finally { db.close(); }
    }
    const post = async (url = "/api/preparations/" + c.preparationId + "/discard", body = input) => {
      const response = await fetch(base + url, {method:"POST", headers, body:JSON.stringify(body)});
      return {status:response.status, body:await response.json()};
    };
    const assertPreserved = () => {
      const saved = readPreparation();
      assert.equal(saved.prep.webSession.activeDeliveryId, d.deliveryId);
      assert.equal(saved.delivery.response.rawText, original);
      assert.equal(saved.delivery.invalidAbandonmentIntent, undefined);
      assert.equal(saved.receipt, undefined);
      assert.equal(remoteCalls, 0);
    };
    const unknown = await post(); // Code change schema is not available yet.
    assertPreserved();
    if (closureUnconfirmed) {
      assert.equal(unknown.status, 409);
      assert.equal(unknown.body.code, "ABANDONMENT_OWNER_UNCONFIRMED", JSON.stringify(unknown));
      assert.equal(initializationCalls, 1);
      assert.ok(await bridge.getLiveRuntime());
      assert.equal((await post()).body.code, "ABANDONMENT_OWNER_UNCONFIRMED");
      assertPreserved();
      return;
    }
    const codes = new CodeChangeStore(databasePath);
    try {
      codes.save({runId:"another-run", stage:"WORKER_RUNNING"});
      const busy = await post();
      assertPreserved();
      codes.save({runId:"another-run", stage:"CANCELLED"}, 1);
      const enteredInspection = Promise.withResolvers();
      const resumeInspection = Promise.withResolvers();
      bridge.webSession.inspectDelivery = async () => {
        enteredInspection.resolve();
        await resumeInspection.promise;
        return inspectDelivery();
      };
      const pending = post();
      try {
        await Promise.race([enteredInspection.promise, pending.then(result => {
          assert.fail("Abandonment ended before inspection: " + JSON.stringify(result));
        })]);
        assert.equal((await post()).body.code, "RUN_BUSY");
        assert.equal((await post("/api/commands", {type:"run.retry", requestId:"concurrent", payload:{runId:"another-run"}})).body.payload.code, "RUN_BUSY");
        codes.save({runId:"another-run", stage:"WORKER_RUNNING"}, 2);
      } finally { resumeInspection.resolve(); }
      const lateBusy = await pending;
      assert.equal(lateBusy.body.code, "RUN_BUSY", JSON.stringify(lateBusy));
      assertPreserved();
      codes.save({runId:"another-run", stage:"CANCELLED"}, 3);
      bridge.webSession.inspectDelivery = async () => ({...await inspectDelivery(),
        scopedDeliveries:[{deliveryId:"another-delivery"}]});
      assert.equal((await post()).body.code, "WEB_SESSION_BUSY");
      assertPreserved();
      bridge.webSession.inspectDelivery = inspectDelivery;
      const completed = await post();
      assert.equal(completed.status, 200, JSON.stringify(completed));
      assert.equal(unknown.body.code, "ABANDONMENT_SAFETY_UNAVAILABLE", JSON.stringify(unknown));
      assert.equal(busy.body.code, "RUN_BUSY", JSON.stringify(busy));
      assert.equal(completed.body.lifecycle, "ABANDONED");
      assert.deepEqual(await post(), completed);
      const saved = readPreparation();
      assert.equal(saved.prep.webSession.activeDeliveryId, null);
      assert.equal(saved.delivery.response.rawText, original);
      assert.equal(saved.delivery.validation.formatError.code, "CONTROLLER_PACKET_MISSING");
      assert.equal(saved.delivery.invalidAbandonmentReceipt.intentHash, saved.delivery.invalidAbandonmentIntent.intentHash);
      assert.equal(saved.receipt.status, "COMPLETED");
      assert.equal(remoteCalls, 1);
      assert.equal(initializationCalls, 1);
    } finally { await codes.close(); }
  } finally {
    if (closureUnconfirmed) await assert.rejects(bridge.close(), /Shutdown failed at runtime initialization/);
    else await bridge.close();
  }
});
