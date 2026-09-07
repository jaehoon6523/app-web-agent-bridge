import { canonicalJson } from "../domain/canonical-json.js";
import { EventChainIntegrityError } from "./errors.js";

export function decodeCanonicalJson(text, context) {
  if (typeof text !== "string") throw new EventChainIntegrityError(`${context} is not stored as JSON text`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (cause) { throw new EventChainIntegrityError(`${context} contains invalid JSON`, { cause }); }
  let encoded;
  try { encoded = canonicalJson(parsed); }
  catch (cause) { throw new EventChainIntegrityError(`${context} is not canonical JSON data`, { cause }); }
  if (encoded !== text) throw new EventChainIntegrityError(`${context} is not stored in canonical JSON form`);
  return parsed;
}
