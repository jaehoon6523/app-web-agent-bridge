export async function clearLegacyTestDelivery({ store, turnGate, broadcastPopupState }) {
  turnGate.assertIdle("Legacy delivery cleanup");
  const state = await store.clearLegacyTestDelivery();
  broadcastPopupState();
  return state;
}
