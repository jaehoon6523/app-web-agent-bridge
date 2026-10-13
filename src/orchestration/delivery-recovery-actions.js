import { isTerminalDiscard, reconcileTerminalDiscard } from "./terminal-delivery-reconciliation.js";
import { inspectDeliveryOwnership } from "./delivery-ownership.js";
import { webBinding } from "./audit-round.js";

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function exact(owner, expected) {
  return owner?.currentDeliveryId === expected.currentDeliveryId && owner?.sessionId === expected.sessionId
    && owner?.runId === expected.runId && owner?.conversationUrl === expected.conversationUrl;
}
function receiptMatches(observed, name, expected) {
  const receipt = observed[name];
  return observed.currentDeliveryId === null && exact({ ...observed, currentDeliveryId: expected.currentDeliveryId }, expected)
    && exact({ ...receipt, currentDeliveryId: receipt?.deliveryId }, expected);
}

export function createDeliveryRecoveryActions({ getSources, getServices, web, audit = async () => {} }) {
  let mutation = false;
  async function inspect(expected) {
    const server = await inspectDeliveryOwnership(expected, getSources);
    const observed = await web.inspectDelivery();
    const completed = observed.completedDelivery?.turnId === expected.currentDeliveryId;
    const durableAck = server.status === "MATCHED" && server.records[0]?.processingState === "ACK_PENDING"
      && server.records[0]?.responseStored === true;
    const settled = server.status === "MATCHED" && !server.records[0]?.active;
    return { server, extension: { currentDeliveryId: observed.currentDeliveryId,
      sessionId: observed.sessionId, runId: observed.runId, conversationUrl: observed.conversationUrl,
      terminalDiscardProtocol: observed.terminalDiscardProtocol,
      tabId: observed.tabId, documentId: observed.documentId, frameId: observed.frameId,
      pageReachable: observed.pageReachable,
      pageIdentityConfirmed: observed.pageReachable === true && observed.observedConversationUrl === expected.conversationUrl
        && observed.observedDocumentId === observed.documentId && typeof observed.documentId === "string", pageBusy: observed.pageBusy, generating: observed.generating,
      otherActive: (observed.scopedDeliveries ?? []).some(slot => slot.deliveryId),
      hasCompletedDelivery: observed.hasCompletedDelivery,
      resultStatus: server.records[0]?.responseStored ? "RESPONSE_STORED" : "UNKNOWN",
      extensionBusy: observed.extensionBusy, exact: exact(observed, expected),
      discardConfirmed: receiptMatches(observed, "lastDeliveryDiscard", expected),
      ackConfirmed: receiptMatches(observed, "lastAcknowledgedDelivery", expected),
      recordMissing: observed.currentDeliveryId === null && exact({ ...observed, currentDeliveryId: expected.currentDeliveryId }, expected)
        && !(observed.scopedDeliveries ?? []).some(slot => slot.deliveryId === expected.currentDeliveryId || slot.sessionId === expected.sessionId)
        && !receiptMatches(observed, "lastDeliveryDiscard", expected) && !receiptMatches(observed, "lastAcknowledgedDelivery", expected),
      phase: settled && isTerminalDiscard(server.records[0])
        && !["ACK_PENDING", "ACKNOWLEDGED"].includes(server.records[0]?.processingState) && receiptMatches(observed, "lastDeliveryDiscard", expected) ? "DISCARDED"
        : settled && server.records[0]?.state === "ACKNOWLEDGED" && receiptMatches(observed, "lastAcknowledgedDelivery", expected) ? "ACKNOWLEDGED"
          : durableAck ? "ACK_PENDING" : completed ? "RESPONSE_OBSERVED" : "UNRESOLVED" } };
  }
  async function discard(input) {
    if (mutation) fail("WEB_SESSION_BUSY", "Another delivery recovery action is active.");
    if (input.unresolvedResultConfirmed !== true || input.noAutomaticResendConfirmed !== true
      || typeof input.reason !== "string" || input.reason.trim().length < 3) {
      fail("DISCARD_CONFIRMATION_REQUIRED", "Confirm the unresolved result, no automatic resend and a discard reason.");
    }
    mutation = true;
    try {
      const inspected = await inspect(input), record = inspected.server.records[0];
      if (inspected.server.status === "MATCHED" && (record?.responseStored === true
        || ["ACK_PENDING", "ACKNOWLEDGED"].includes(record?.processingState)
        || ["ACK_PENDING", "ACKNOWLEDGED"].includes(record?.state))) {
        fail("DELIVERY_RESPONSE_REQUIRED", "A stored response or ACK state requires response review, not delivery discard.");
      }
      if (inspected.extension.phase === "RESPONSE_OBSERVED") {
        fail("DELIVERY_RESPONSE_REQUIRED", "A response remains in the extension. Review it before discarding ownership.");
      }
      if (inspected.extension.hasCompletedDelivery !== false) {
        fail(inspected.extension.hasCompletedDelivery === true ? "DELIVERY_RESPONSE_REQUIRED" : "EXTENSION_UPDATE_REQUIRED",
          "The extension must confirm that no completed response is held before a discard intent is recorded.");
      }
      if (inspected.server.otherActive === true || inspected.extension.otherActive === true) {
        fail("WEB_SESSION_BUSY", "Another delivery owns an active server or extension session.");
      }
      if (input.terminalDiscardConfirmed !== true && inspected.server.status === "MATCHED"
        && isTerminalDiscard(record) && inspected.extension.discardConfirmed) {
        return { discarded: true, deliveryId: input.currentDeliveryId };
      }
      if (inspected.server.status === "MATCHED" && isTerminalDiscard(record)) {
        return await reconcileTerminalDiscard({ input, inspect, getServices, web, audit });
      }
      if (inspected.server.status !== "MATCHED" || !record?.active
        || (!inspected.extension.exact && !inspected.extension.discardConfirmed
          && !(inspected.extension.recordMissing && input.extensionRecordMissingConfirmed === true))) {
        fail("DELIVERY_RECOVERY_MISMATCH", "Server and extension do not own this exact pending delivery.");
      }
      if (inspected.extension.extensionBusy || inspected.extension.pageBusy || inspected.extension.generating) {
        fail("WEB_SESSION_BUSY", "Stop the active generation and inspect it before discarding.");
      }
      if ((!inspected.extension.pageReachable || inspected.extension.pageBusy !== false || inspected.extension.generating !== false)
        && input.pageStateUnconfirmedConfirmed !== true) fail("PAGE_STATE_CONFIRMATION_REQUIRED", "Confirm the unobserved page state.");
      const { preparationService, codeChanges } = await getServices();
      const at = new Date().toISOString(), reason = input.reason.trim();
      if (record.kind === "PREPARATION") {
        if (preparationService.jobs.size) fail("WEB_SESSION_BUSY", "A preparation operation is active.");
        const context = preparationService.data.contexts[input.runId];
        const delivery = context?.deliveries.find(item => item.deliveryId === input.currentDeliveryId);
        if (!delivery || context.webSession.activeDeliveryId !== input.currentDeliveryId) fail("DELIVERY_RECOVERY_MISMATCH", "Preparation owner changed.");
        delivery.discardIntent = { at, reason, status: "PENDING_VERIFICATION" };
        await preparationService.touch(context);
        try { await web.discardDelivery({ ...input, reason }); }
        catch (error) {
          // The extension may have persisted the receipt despite a lost reply.
          delivery.discardIntent = { ...delivery.discardIntent, status: "VERIFY_REQUIRED", lastErrorCode: error.code ?? "DISCARD_UNCONFIRMED" };
          try { await preparationService.touch(context); } catch { /* Keep the durable pending intent and original failure. */ }
          throw error;
        }
        if (context.webSession.activeDeliveryId !== input.currentDeliveryId) fail("DELIVERY_RECOVERY_MISMATCH", "Preparation owner changed during discard.");
        delivery.state = "RECOVERY_DISCARDED"; delivery.discardedAt = at; delivery.discardReason = reason;
        delivery.discardIntent = { ...delivery.discardIntent, status: "CONFIRMED" };
        context.webSession.activeDeliveryId = null; context.lifecycle = "ABANDONED";
        context.state = "RECOVERY_REQUIRED"; context.error = { code: "RECOVERY_DISCARDED", message: "The operator discarded this exact delivery." };
        await preparationService.touch(context);
      } else if (record.kind === "REVIEW") {
        if (codeChanges.jobs.has(input.runId) || codeChanges.workers.has(input.runId) || codeChanges.reviewerWebBusy()) {
          fail("WEB_SESSION_BUSY", "A reviewer or worker operation is active.");
        }
        const run = codeChanges.get(input.runId);
        const binding = run?.conversationBindings.find(item => item.sessionId === input.sessionId);
        if (!binding || binding.activeDeliveryId !== input.currentDeliveryId) fail("DELIVERY_RECOVERY_MISMATCH", "Reviewer owner changed.");
        codeChanges.update(input.runId, { webDeliveryDiscardIntent: { ...input, reason, at, status: "PENDING_VERIFICATION" } });
        try { await web.discardDelivery({ ...input, reason }); }
        catch (error) {
          // Preserve uncertainty: an extension write may have succeeded before the reply failed.
          try { codeChanges.update(input.runId, { webDeliveryDiscardIntent: {
            ...input, reason, at, status: "VERIFY_REQUIRED", lastErrorCode: error.code ?? "DISCARD_UNCONFIRMED" } }); }
          catch { /* Keep the durable pending intent and original failure. */ }
          throw error;
        }
        const latest = codeChanges.get(input.runId);
        if (!latest.conversationBindings.some(item => item.sessionId === input.sessionId && item.activeDeliveryId === input.currentDeliveryId)) {
          fail("DELIVERY_RECOVERY_MISMATCH", "Reviewer owner changed during discard.");
        }
        codeChanges.update(input.runId, { stage: "HOLD", terminationReason: "WEB_DELIVERY_DISCARDED",
          error: "The operator discarded an unresolved reviewer delivery. Inspect the run before continuing.",
          conversationBindings: latest.conversationBindings.map(item => item.sessionId === input.sessionId
            ? { ...item, activeDeliveryId: null, bindingStatus: "NEEDS_REBIND" } : item),
          webDeliveryDiscardIntent: { ...input, reason, at, status: "CONFIRMED", confirmed: true },
          webDeliveryReceipts: (latest.webDeliveryReceipts ?? []).map(item => item.deliveryId === input.currentDeliveryId
            ? { ...item, state: "DISCARDED" } : item) });
      } else fail("DELIVERY_RECOVERY_UNAVAILABLE", "Use the existing discussion recovery controls for this delivery.");
      return { discarded: true, deliveryId: input.currentDeliveryId };
    } finally { mutation = false; }
  }
  async function acknowledge(input) {
    if (mutation) fail("WEB_SESSION_BUSY", "Another delivery recovery action is active.");
    mutation = true;
    try {
      const inspected = await inspect(input), record = inspected.server.records[0];
      if (inspected.server.status === "MATCHED" && !record?.active && record?.state === "ACKNOWLEDGED"
        && inspected.extension.ackConfirmed) return { acknowledged: true, deliveryId: input.currentDeliveryId };
      if (inspected.server.status !== "MATCHED" || record?.kind !== "REVIEW" || !record.active
        || record.processingState !== "ACK_PENDING" || !record.responseStored
        || (!inspected.extension.exact && !inspected.extension.ackConfirmed)) {
        fail("DELIVERY_RESPONSE_REQUIRED", "Only this durably stored reviewer response can be acknowledged.");
      }
      if (inspected.extension.extensionBusy || inspected.extension.pageBusy || inspected.extension.generating) fail("WEB_SESSION_BUSY", "A generation is active.");
      if (inspected.server.otherActive || inspected.extension.otherActive) fail("WEB_SESSION_BUSY", "Another delivery owns an active session.");
      const { codeChanges } = await getServices(), run = codeChanges.get(input.runId);
      const receipt = run.webDeliveryReceipts.find(item => item.deliveryId === input.currentDeliveryId);
      if (codeChanges.jobs.has(input.runId) || codeChanges.workers.has(input.runId) || codeChanges.reviewerWebBusy()) fail("WEB_SESSION_BUSY", "A reviewer operation is active.");
      if (!receipt || !codeChanges.artifactStore.verify(receipt.responseRef.sha256)
        || !codeChanges.artifactStore.verify(receipt.packetRef.sha256)) fail("DELIVERY_RESPONSE_REQUIRED", "Durable response evidence is unavailable.");
      const owner = run.conversationBindings.find(item => item.sessionId === input.sessionId);
      if (!owner || owner.activeDeliveryId !== input.currentDeliveryId || owner.conversationUrl !== input.conversationUrl) fail("DELIVERY_RECOVERY_MISMATCH", "The reviewer owner changed before ACK.");
      const reviewer = codeChanges.reviewerWeb?.(record.role, owner.provider ?? null) ?? web;
      let binding = (await reviewer.inspect()).binding;
      // Process restart loses the adapter binding, not the durable delivery.
      if (binding === null) {
        await reviewer.resume({ binding: webBinding(owner) });
        binding = (await reviewer.inspect()).binding;
        const restored = await inspect(input);
        if (restored.server.otherActive || restored.extension.otherActive) fail("WEB_SESSION_BUSY", "Another delivery owns an active session.");
      }
      if (!exact({ ...binding, currentDeliveryId: input.currentDeliveryId }, input)) fail("DELIVERY_RECOVERY_MISMATCH", "The adapter binding differs from this receipt.");
      if (!codeChanges.get(input.runId).conversationBindings.some(item => item.sessionId === input.sessionId
        && item.activeDeliveryId === input.currentDeliveryId)) fail("DELIVERY_RECOVERY_MISMATCH", "The reviewer owner changed while restoring ACK.");
      const ack = await reviewer.acknowledgeDelivery({ turnId: input.currentDeliveryId });
      if (ack.currentDeliveryId !== null || !exact({ ...ack, currentDeliveryId: input.currentDeliveryId }, input)) fail("ACK_UNCONFIRMED", "The exact acknowledgement was not confirmed.");
      await reviewer.confirmDeliveryAcknowledgement?.({ turnId: input.currentDeliveryId,
        sessionId: input.sessionId, runId: input.runId, conversationUrl: input.conversationUrl });
      const latest = codeChanges.get(input.runId);
      if (!latest.conversationBindings.some(item => item.sessionId === input.sessionId && item.activeDeliveryId === input.currentDeliveryId)) fail("DELIVERY_RECOVERY_MISMATCH", "The reviewer owner changed during ACK.");
      codeChanges.update(input.runId, { stage: "HOLD", terminationReason: "WEB_DELIVERY_ACK_RECOVERED",
        error: "The stored response was acknowledged. Inspect its review evidence before continuing the run.",
        conversationBindings: latest.conversationBindings.map(item => item.sessionId === input.sessionId ? { ...item, activeDeliveryId: null } : item),
        webDeliveryReceipts: latest.webDeliveryReceipts.map(item => item.deliveryId === input.currentDeliveryId ? { ...item, state: "ACKNOWLEDGED" } : item) });
      return { acknowledged: true, deliveryId: input.currentDeliveryId };
    } finally { mutation = false; }
  }
  return { inspect, discard, acknowledge };
}
