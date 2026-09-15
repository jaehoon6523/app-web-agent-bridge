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

const SETTLED_STATES = new Set([DeliveryState.RESPONSE_COMPLETED, DeliveryState.RELAYED]);
const RECEIPT_REQUIRED_STATES = new Set([
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.RESPONSE_COMPLETED,
  DeliveryState.RELAYED,
]);
const UNCERTAIN_STATES = new Set([
  DeliveryState.DISPATCHING,
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.AMBIGUOUS,
]);

export function canTransitionDelivery(from, to) {
  return ALLOWED_DELIVERY_TRANSITIONS[from]?.has(to) === true;
}

export function isSettledDeliveryState(state) {
  return SETTLED_STATES.has(state);
}

export function requiresDeliveryReceipt(state) {
  return RECEIPT_REQUIRED_STATES.has(state);
}

export function forbidsDeliveryReceipt(state) {
  return state === DeliveryState.PENDING || state === DeliveryState.DISPATCHING;
}

export function isUncertainDeliveryState(state) {
  return UNCERTAIN_STATES.has(state);
}

export function isResponsePendingDeliveryState(state) {
  return state === DeliveryState.SUBMITTED || state === DeliveryState.RESPONSE_STARTED;
}
