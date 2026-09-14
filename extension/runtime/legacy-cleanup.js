export async function clearLegacyTestDelivery({ store, turnGate, broadcastPopupState }) {
  const state = await store.read();
  if (!state.currentDeliveryId) throw new Error("No active delivery is available.");
  turnGate.assertIdle("Legacy delivery cleanup");
  await store.update({ currentDeliveryId: null, completedDelivery: null,
    bindingStatus: "NEEDS_REBIND", bindingError: "Previous delivery was cleared by the user." });
  broadcastPopupState();
}
