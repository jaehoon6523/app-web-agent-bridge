import { errorPayload } from "./document-binding.js";

export async function handleDeliveryAcknowledgement({ store, message, send, broadcastPopupState }) {
  try {
    console.info("[bridge:delivery:ack-received]", { deliveryId: message.requestId });
    const before = await store.read();
    await store.clearDelivery(message.requestId, message.payload?.sessionId ?? null);
    const after = await store.read();
    console.info("[bridge:delivery:ack-cleared]", { deliveryId: message.requestId });
    broadcastPopupState();
    send({
      type: "web.delivery.acknowledged",
      requestId: message.requestId,
      payload: {
        currentDeliveryId: after.currentDeliveryId,
        sessionId: before.lastBoundSessionId,
        runId: before.lastBoundRunId,
        conversationUrl: before.conversationUrl,
        conversationId: before.conversationId,
      },
    });
  } catch (error) {
    send({ type: "web.prompt.error", requestId: message.requestId, payload: errorPayload(error) });
  }
}
