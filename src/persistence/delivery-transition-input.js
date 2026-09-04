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
  return receipt;
}
