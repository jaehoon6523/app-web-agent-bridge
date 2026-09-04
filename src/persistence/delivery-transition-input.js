export function validateSubmittedProviderReceipt(input) {
  if (!Object.hasOwn(input, "providerReceipt")) {
    throw new TypeError("providerReceipt is required for a SUBMITTED delivery");
  }
  const receipt = input.providerReceipt;
  if (
    receipt === null
    || typeof receipt !== "object"
    || Array.isArray(receipt)
  ) {
    throw new TypeError("providerReceipt must be a plain object");
  }
  if (
    typeof receipt.externalTurnId !== "string"
    || receipt.externalTurnId.length === 0
  ) {
    throw new TypeError("providerReceipt.externalTurnId must be a non-empty string");
  }
  const binding = receipt.sessionBinding;
  if (
    binding === null
    || typeof binding !== "object"
    || Array.isArray(binding)
    || Object.getPrototypeOf(binding) !== Object.prototype
    || Object.keys(binding).length !== 4
    || !Object.hasOwn(binding, "sessionId")
    || !Object.hasOwn(binding, "version")
    || !Object.hasOwn(binding, "externalSessionId")
    || !Object.hasOwn(binding, "externalLocator")
  ) {
    throw new TypeError("providerReceipt.sessionBinding must be an exact plain object");
  }
  if (typeof binding.sessionId !== "string" || binding.sessionId.length === 0) {
    throw new TypeError("providerReceipt.sessionBinding.sessionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(binding.version) || binding.version < 1) {
    throw new TypeError("providerReceipt.sessionBinding.version must be a positive safe integer");
  }
  if (
    typeof binding.externalSessionId !== "string"
    || binding.externalSessionId.length === 0
  ) {
    throw new TypeError(
      "providerReceipt.sessionBinding.externalSessionId must be a non-empty string",
    );
  }
  if (
    binding.externalLocator !== null
    && (typeof binding.externalLocator !== "string" || binding.externalLocator.length === 0)
  ) {
    throw new TypeError(
      "providerReceipt.sessionBinding.externalLocator must be null or a non-empty string",
    );
  }
  return receipt;
}
