import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function identity(value) {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/u.test(value)) throw failure("PAIRING_IDENTITY_INVALID", "A valid extension identity is required.");
  return value;
}

// The fingerprint binds a local approval to the current bootstrap configuration.
export function createExtensionIdentityPairing({ directory, configuredIdentity, sharedSecret, now = () => new Date() }) {
  identity(configuredIdentity);
  const fingerprint = createHmac("sha256", sharedSecret).update("extension-pairing-v1\0" + configuredIdentity).digest("hex");
  const filename = path.join(directory, "extension-pairing.json");
  const auditFile = path.join(directory, "extension-pairing", "events.jsonl");
  let currentIdentity = configuredIdentity;
  try {
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (saved.schemaVersion !== 1 || typeof saved.fingerprint !== "string" || typeof saved.identity !== "string") {
      throw failure("PAIRING_RECORD_INVALID", "The extension pairing record is invalid.");
    }
    if (saved.fingerprint === fingerprint) currentIdentity = identity(saved.identity);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  function audit(phase, candidate, previousIdentity, code = null) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditFile, JSON.stringify({ phase, candidateIdentity: candidate,
      previousIdentity, code, at: now().toISOString() }) + "\n", { mode: 0o600 });
  }
  return {
    get identity() { return currentIdentity; },
    approve(candidate, expectedCurrentIdentity) {
      identity(candidate);
      if (expectedCurrentIdentity !== currentIdentity) throw failure("PAIRING_CHANGED", "The expected extension identity changed; inspect again.");
      if (candidate === currentIdentity) return { identity: currentIdentity, idempotent: true };
      const previousIdentity = currentIdentity;
      audit("STARTED", candidate, previousIdentity);
      const temporary = filename + "." + randomUUID() + ".tmp";
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, fingerprint, identity: candidate }) + "\n");
          fs.fsyncSync(file);
        } finally { fs.closeSync(file); }
        fs.renameSync(temporary, filename);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        try { audit("FAILED", candidate, previousIdentity, "PAIRING_STORAGE_FAILED"); } catch {}
        throw failure("PAIRING_STORAGE_FAILED", "The approved extension identity could not be stored.");
      }
      currentIdentity = candidate;
      let auditConfirmed = true;
      try { audit("COMPLETED", candidate, previousIdentity); } catch { auditConfirmed = false; }
      return { identity: currentIdentity, idempotent: false, auditConfirmed };
    },
  };
}
