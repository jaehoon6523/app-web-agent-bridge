import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { hasUnsettledDeliveries, observeExtensionRelease, reloadExtension } from "../src/runtime/web/live-update.js";

test("updates are blocked by persisted owners or an ACK that has not settled", () => {
  const idle = {contexts:[], runs:[], discussionStore:{listRuns:() => []}};
  assert.equal(hasUnsettledDeliveries(idle), false);
  for (const source of [
    {contexts:[{webSession:{activeDeliveryId:"prep"}}]},
    {contexts:[{deliveries:[{processingState:"ACK_PENDING"}]}]},
    {runs:[{conversationBindings:[{activeDeliveryId:"review"}]}]},
    {runs:[{webDeliveryReceipts:[{state:"ACK_PENDING"}]}]},
    {discussionStore:{listRuns:() => [{runId:"r"}], listAgentSessions:() => [{activeTurnId:"discussion"}]}},
  ]) assert.equal(hasUnsettledDeliveries({...idle, ...source}), true);
});

test("an update commits only after an idle reservation and waits for a new authenticated extension", async () => {
  const transport = new EventEmitter();
  transport.authenticated = true;
  const sent = [];
  transport.send = message => sent.push(message);
  const release = observeExtensionRelease(transport);
  const hello = (version, bootId) => transport.emit("message", {type:"extension.hello", payload:{version, bootId, reloadProtocol:1}});
  const reply = status => transport.emit("message", {type:"extension.reload.result", requestId:sent.at(-1).requestId, payload:{status}});
  hello("0.2.24", "old");
  const busy = reloadExtension(transport, release(), "0.2.25");
  reply("BUSY");
  assert.deepEqual(await busy, {status:"BUSY", reason:"EXTENSION_DELIVERY"});
  assert.equal(sent.length, 1);

  const changed = reloadExtension(transport, release(), "0.2.25");
  reply("READY");
  assert.equal(sent.at(-1).payload.phase, "COMMIT");
  hello("0.2.25", "old");
  assert.equal(transport.listenerCount("message"), 2);
  transport.authenticated = false;
  transport.emit("state", {authenticated:false});
  assert.equal(release(), null);
  transport.authenticated = true;
  hello("0.2.25", "new");
  assert.deepEqual(await changed, {status:"RELOADED", bootId:"new"});
});
