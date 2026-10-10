// Only identity and processing metadata leave the server; never response bytes.
export function classifyDeliveryOwnership(expected, records) {
  const related = records.filter(record => record.deliveryId === expected.currentDeliveryId
    || (record.sessionId === expected.sessionId && record.active));
  if (!related.length) return { status: "MISSING", records: [] };
  const exact = related.filter(record => record.deliveryId === expected.currentDeliveryId
    && record.sessionId === expected.sessionId && record.runId === expected.runId
    && record.conversationUrl === expected.conversationUrl);
  return { status: exact.length === 1 && related.length === 1 ? "MATCHED" : "MISMATCH", records: related };
}

export async function inspectDeliveryOwnership(expected, getSources) {
  if (!expected || ![expected.currentDeliveryId, expected.sessionId, expected.runId, expected.conversationUrl]
    .every(value => typeof value === "string" && value.length > 0)) throw new Error("Incomplete delivery identity.");
  const { contexts, runs, discussionStore } = await getSources();
  const records = contexts.flatMap(context => (context.deliveries ?? []).map(delivery => ({
    kind: "PREPARATION", deliveryId: delivery.deliveryId,
    sessionId: delivery.sessionId ?? context.webSession.sessionId, runId: context.preparationId,
    conversationUrl: context.webSession.conversationUrl,
    active: context.webSession.activeDeliveryId === delivery.deliveryId,
    state: delivery.state, processingState: delivery.processingState ?? null,
    responseStored: Boolean(delivery.response),
  })));
  for (const run of runs) {
    for (const binding of run.conversationBindings ?? []) {
      const receipts = (run.webDeliveryReceipts ?? []).filter(item => item.sessionId === binding.sessionId);
      if (binding.activeDeliveryId && !receipts.some(item => item.deliveryId === binding.activeDeliveryId)) {
        records.push({ kind: "REVIEW", deliveryId: binding.activeDeliveryId, sessionId: binding.sessionId,
          runId: run.runId, conversationUrl: binding.conversationUrl, active: true,
          state: "UNRESOLVED", processingState: null, responseStored: false, role: binding.role });
      }
      for (const receipt of receipts) records.push({ kind: "REVIEW", deliveryId: receipt.deliveryId,
        sessionId: receipt.sessionId, runId: run.runId, conversationUrl: receipt.conversationUrl,
        active: binding.activeDeliveryId === receipt.deliveryId, state: receipt.state,
        processingState: receipt.state, responseStored: true, role: binding.role });
    }
  }
  const discussion = discussionStore?.getDelivery(expected.currentDeliveryId);
  if (discussion) {
    const session = discussionStore.getAgentSession(discussion.sessionId);
    records.push({ kind: "DISCUSSION", deliveryId: discussion.deliveryId, sessionId: discussion.sessionId,
      runId: discussion.runId, conversationUrl: session?.externalSessionId ?? null,
      active: session?.activeTurnId === discussion.deliveryId, state: discussion.status ?? discussion.state,
      processingState: null, responseStored: false });
  }
  const otherActive = contexts.some(context => context.webSession?.activeDeliveryId
    && context.webSession.activeDeliveryId !== expected.currentDeliveryId)
    || runs.some(run => (run.conversationBindings ?? []).some(binding => binding.activeDeliveryId
      && binding.activeDeliveryId !== expected.currentDeliveryId))
    || (discussionStore?.listRuns?.() ?? []).some(run => discussionStore.listAgentSessions(run.runId)
      .some(session => session.activeTurnId && session.activeTurnId !== expected.currentDeliveryId));
  return { ...classifyDeliveryOwnership(expected, records), expected, otherActive };
}

export function installDeliveryOwnershipInspection({ transport, getSources }) {
  transport?.on("message", message => {
    if (message.type !== "extension.delivery.inspect") return;
    void inspectDeliveryOwnership(message.payload, getSources).then(payload => {
      transport.send({ type: "controller.delivery.inspected", requestId: message.requestId, payload });
    }).catch(() => {
      // Missing is asserted only when every backing store was read successfully.
      try { transport.send({ type: "controller.delivery.inspected", requestId: message.requestId,
        payload: { status: "UNAVAILABLE", records: [], expected: message.payload } }); } catch {}
    });
  });
}
