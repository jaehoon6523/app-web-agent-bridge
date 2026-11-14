export function isUnsentFailure(delivery, error) {
  return delivery?.state === "FAILED" && !delivery.response && delivery.processingState == null
    && error?.details?.browserDispatchStarted !== true
    && (delivery.unsent === true || error?.details?.browserDispatchStarted === false);
}

export function canCancelUnsentDelivery(observed, deliveryId) {
  return observed?.extensionBusy === false && observed.currentDeliveryId === null
    && observed.hasCompletedDelivery === false && Array.isArray(observed.scopedDeliveries)
    && observed.scopedDeliveries.every(slot => slot && slot.deliveryId === null)
    && observed.completedDelivery == null
    && observed.lastAcknowledgedDelivery?.deliveryId !== deliveryId
    && observed.lastDeliveryDiscard?.deliveryId !== deliveryId;
}
