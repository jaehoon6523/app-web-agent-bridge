export async function clearLegacyTestDelivery({ store, turnGate, broadcastPopupState }) {
  const state = await store.read();
  const isLegacy = /^manual_session_\d+$/u.test(state.lastBoundSessionId || "")
    && /^manual_run_\d+$/u.test(state.lastBoundRunId || "")
    && /^turn_\d+$/u.test(state.currentDeliveryId || "");
  if (!isLegacy) throw new Error("No legacy bridge-test delivery is available.");
  turnGate.assertIdle("Legacy delivery cleanup");
  await store.update({ currentDeliveryId: null, completedDelivery: null,
    bindingStatus: "NEEDS_REBIND", bindingError: "Legacy delivery was cleared by the user." });
  broadcastPopupState();
}
