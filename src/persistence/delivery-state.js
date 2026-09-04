import { DeliveryState } from "./schema.js";

const ALLOWED_DELIVERY_TRANSITIONS = Object.freeze({
  [DeliveryState.PENDING]: new Set([DeliveryState.DISPATCHING, DeliveryState.FAILED]),
  [DeliveryState.DISPATCHING]: new Set([
    DeliveryState.SUBMITTED,
    DeliveryState.FAILED,
    DeliveryState.AMBIGUOUS,
  ]),
  [DeliveryState.SUBMITTED]: new Set([
    DeliveryState.RESPONSE_STARTED,
    DeliveryState.RESPONSE_COMPLETED,
    DeliveryState.FAILED,
    DeliveryState.AMBIGUOUS,
  ]),
  [DeliveryState.RESPONSE_STARTED]: new Set([
    DeliveryState.RESPONSE_COMPLETED,
    DeliveryState.FAILED,
    DeliveryState.AMBIGUOUS,
  ]),
  [DeliveryState.RESPONSE_COMPLETED]: new Set([
    DeliveryState.RELAYED,
    DeliveryState.FAILED,
  ]),
  [DeliveryState.FAILED]: new Set([DeliveryState.PENDING]),
  [DeliveryState.AMBIGUOUS]: new Set(),
  [DeliveryState.RELAYED]: new Set(),
});

export function canTransitionDelivery(from, to) {
  return ALLOWED_DELIVERY_TRANSITIONS[from]?.has(to) === true;
}

export { ALLOWED_DELIVERY_TRANSITIONS };
