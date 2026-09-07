import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class ArtifactStoreError extends Error {
  constructor(message, code = "ARTIFACT_STORE_ERROR") {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

function contentBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new TypeError("Artifact content must be a string, Buffer, or Uint8Array.");
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export class ArtifactStore {
  constructor(rootDirectory) {
    if (typeof rootDirectory !== "string" || rootDirectory.trim() === "") {
      throw new TypeError("ArtifactStore rootDirectory must be a non-empty string.");
    }
    this.rootDirectory = path.resolve(rootDirectory);
    fs.mkdirSync(this.rootDirectory, { recursive: true });
  }

  put(content, { mimeType = "application/octet-stream", redacted = false } = {}) {
    if (typeof mimeType !== "string" || mimeType.trim() === "") {
      throw new TypeError("mimeType must be a non-empty string.");
    }
    if (typeof redacted !== "boolean") throw new TypeError("redacted must be a boolean.");
    const buffer = contentBuffer(content);
    const sha256 = digest(buffer);
    const artifactPath = path.join(this.rootDirectory, sha256);

    try {
      fs.writeFileSync(artifactPath, buffer, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = fs.readFileSync(artifactPath);
      if (digest(existing) !== sha256 || !existing.equals(buffer)) {
        throw new ArtifactStoreError(
          `Existing artifact ${sha256} does not match its content address.`,
          "ARTIFACT_HASH_MISMATCH",
        );
      }
    }

    return Object.freeze({
      sha256: `sha256:${sha256}`,
      size: buffer.byteLength,
      mimeType,
      redacted,
    });
  }

  read(sha256) {
    const match = /^sha256:([0-9a-f]{64})$/u.exec(sha256);
    if (!match) throw new TypeError("sha256 must be a sha256:<64 lowercase hex> digest.");
    const artifactPath = path.join(this.rootDirectory, match[1]);
    let content;
    try {
      content = fs.readFileSync(artifactPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ArtifactStoreError(`Artifact ${sha256} does not exist.`, "ARTIFACT_NOT_FOUND");
      }
      throw error;
    }
    if (digest(content) !== match[1]) {
      throw new ArtifactStoreError(`Artifact ${sha256} failed verification.`, "ARTIFACT_HASH_MISMATCH");
    }
    return content;
  }

  verify(sha256) {
    this.read(sha256);
    return true;
  }

  /** Removes an unreferenced content-addressed artifact. */
  removeIfUnreferenced(sha256, referenced = new Set()) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(sha256)) throw new TypeError("sha256 must be a sha256:<64 lowercase hex> digest.");
    if (referenced.has(sha256)) return false;
    const artifactPath = path.join(this.rootDirectory, sha256.slice("sha256:".length));
    try {
      fs.unlinkSync(artifactPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}
