const discarded = record => record?.active === false && ["DISCARDED", "RECOVERY_DISCARDED"].includes(record.state);
export function isTerminalDiscard(record) { return discarded(record); }
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Reconcile ownership only. This cannot establish whether the remote prompt ran.
export async function reconcileTerminalDiscard({ input, inspect, getServices, web, audit }) {
  const check = async () => {
    const seen = await inspect(input), record = seen.server.records[0], ext = seen.extension;
    if (seen.server.status !== "MATCHED" || !discarded(record) || record.responseStored
      || !["PREPARATION", "REVIEW"].includes(record.kind)
      || record.processingState === "ACK_PENDING" || record.processingState === "ACKNOWLEDGED"
      || ext.ackConfirmed || (!ext.exact && !ext.discardConfirmed)) {
      fail("DELIVERY_RECOVERY_MISMATCH", "The exact discarded server record and extension ownership must still match; response evidence requires separate review.");
    }
    if (ext.terminalDiscardProtocol !== 1) fail("EXTENSION_UPDATE_REQUIRED", "Reload the updated extension before reconciling this terminal delivery.");
    const { preparationService, codeChanges } = await getServices();
    if (seen.server.otherActive || ext.otherActive || ext.extensionBusy || ext.pageBusy || ext.generating
      || preparationService?.jobs.size || codeChanges?.jobs.size || codeChanges?.workers.size || codeChanges?.reviewerWebBusy()) {
      fail("WEB_SESSION_BUSY", "Another delivery, operation or generation is active. Preserve its ownership.");
    }
    if (!ext.discardConfirmed && (!ext.pageReachable || !ext.pageIdentityConfirmed || ext.pageBusy !== false || ext.generating !== false)
      && input.pageStateUnconfirmedConfirmed !== true) fail("PAGE_STATE_CONFIRMATION_REQUIRED", "Confirm that the original page and generation state cannot be verified.");
    return seen;
  };
  let started = false;
  try {
    if (input.terminalDiscardConfirmed !== true) fail("DISCARD_CONFIRMATION_REQUIRED", "Confirm this exact server discard record and remaining extension ownership.");
    const seen = await check();
    await audit({ phase: "STARTED", input }); started = true;
    // Repeat after durable intent recording; never act on the page's old observation.
    const latest = await check();
    if (!latest.extension.discardConfirmed) await web.discardDelivery({ ...input, ownerSnapshot: {
      tabId: latest.extension.tabId, documentId: latest.extension.documentId, frameId: latest.extension.frameId,
    } });
    const confirmed = await check();
    if (!confirmed.extension.discardConfirmed) fail("DISCARD_UNCONFIRMED", "The extension's persisted discard receipt was not confirmed. Inspect and retry this same target.");
    await audit({ phase: "COMPLETED", input, idempotent: seen.extension.discardConfirmed });
    return { discarded: true, deliveryId: input.currentDeliveryId, resultStatus: "UNKNOWN", disposalStatus: "BOTH_DISCARDED" };
  } catch (error) {
    // A failed completion write also remains retryable from the durable receipt.
    try { await audit({ phase: "FAILED", input, code: error.code ?? "DISCARD_UNCONFIRMED", started }); }
    catch { /* Preserve the original error; a durable STARTED event remains unresolved. */ }
    throw error;
  }
}
