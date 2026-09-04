export class PersistenceError extends Error {
  constructor(message, code = "PERSISTENCE_ERROR", options = undefined) {
    super(message, options);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export class OptimisticConcurrencyError extends PersistenceError {
  constructor(message) {
    super(message, "VERSION_CONFLICT");
    this.name = "OptimisticConcurrencyError";
  }
}

export class EventChainIntegrityError extends PersistenceError {
  constructor(message, options = undefined) {
    super(message, "EVENT_CHAIN_INTEGRITY_FAILURE", options);
    this.name = "EventChainIntegrityError";
  }
}

export class DeliveryTransitionError extends PersistenceError {
  constructor(message, code = "INVALID_DELIVERY_TRANSITION") {
    super(message, code);
    this.name = "DeliveryTransitionError";
  }
}
