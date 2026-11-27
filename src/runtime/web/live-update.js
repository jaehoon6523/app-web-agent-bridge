import { randomUUID } from "node:crypto";
import { isUncertainDeliveryState } from "../../persistence/delivery-state.js";

export function hasUnsettledDeliveries({ contexts, runs, discussionStore }) {
  return contexts.some(context => context.webSession?.activeDeliveryId
    || context.deliveries?.some(delivery => delivery.processingState === "ACK_PENDING"))
    || runs.some(run => run.conversationBindings?.some(binding => binding.activeDeliveryId)
      || run.webDeliveryReceipts?.some(receipt => receipt.state === "ACK_PENDING"))
    || discussionStore.listRuns().some(run => discussionStore.listAgentSessions(run.runId).some(session => session.activeTurnId)
      || discussionStore.listDeliveries?.(run.runId).some(delivery => isUncertainDeliveryState(delivery.state)));
}

export function observeExtensionRelease(transport) {
  let peer = null;
  transport?.on("state", state => { if (!state.authenticated) peer = null; });
  transport?.on("message", message => {
    if (message.type === "extension.hello") {
      const { version, bootId, reloadProtocol } = message.payload ?? {};
      peer = { version, bootId, reloadProtocol };
    }
  });
  return () => transport?.authenticated ? peer : null;
}

export function reloadExtension(transport, previous, version) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, result = undefined) => {
      clearTimeout(deadline);
      transport.off("message", onMessage);
      if (error) reject(error); else resolve(result);
    };
    let accepted = false;
    const onMessage = message => {
      if (message.type === "extension.reload.result" && message.requestId === requestId) {
        if (message.payload?.status === "BUSY") finish(null, {status:"BUSY", reason:"EXTENSION_DELIVERY"});
        else if (message.payload?.status === "READY" && !accepted) {
          accepted = true;
          try { transport.send({type:"controller.extension.reload", requestId, payload:{phase:"COMMIT"}}); }
          catch (error) { finish(error); }
        }
        else finish(new Error("Extension rejected the reload."));
      }
      if (message.type === "extension.hello" && accepted && message.payload?.bootId !== previous.bootId
        && typeof message.payload?.bootId === "string") {
        if (message.payload.version === version) finish(null, {status:"RELOADED", bootId:message.payload.bootId});
        else finish(new Error("Reloaded extension reported a different version."));
      }
    };
    const deadline = setTimeout(() => {
      try { transport.send({type:"controller.extension.reload", requestId, payload:{phase:"CANCEL"}}); } catch {}
      finish(new Error("Extension reload or authenticated reconnect was not confirmed."));
    }, 30_000);
    transport.on("message", onMessage);
    try { transport.send({type:"controller.extension.reload", requestId}); }
    catch (error) { finish(error); }
  });
}
