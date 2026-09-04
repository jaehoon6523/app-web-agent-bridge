export const MIN_SHARED_SECRET_BYTES = 32;

export function requireStrongSharedSecret(value, label = "sharedSecret") {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < MIN_SHARED_SECRET_BYTES
  ) {
    throw new TypeError(`${label} must contain at least ${MIN_SHARED_SECRET_BYTES} UTF-8 bytes.`);
  }
  return value;
}
