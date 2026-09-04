const encoder = new TextEncoder();
export const MIN_EXTENSION_SHARED_SECRET_BYTES = 32;

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeChallengeHmac(nonce, sharedSecret) {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new TypeError("nonce must be a non-empty string");
  }
  if (typeof sharedSecret !== "string" || sharedSecret.length === 0) {
    throw new TypeError("sharedSecret must be a non-empty string");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(nonce));
  return bytesToHex(new Uint8Array(signature));
}

export function assertStrongExtensionSharedSecret(sharedSecret) {
  if (
    typeof sharedSecret !== "string"
    || encoder.encode(sharedSecret).byteLength < MIN_EXTENSION_SHARED_SECRET_BYTES
  ) {
    throw new TypeError(
      `sharedSecret must contain at least ${MIN_EXTENSION_SHARED_SECRET_BYTES} UTF-8 bytes`,
    );
  }
  return sharedSecret;
}
