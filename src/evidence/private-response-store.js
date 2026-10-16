import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/canonical-json.js";

const STORAGE = "PRIVATE_WEB_RESPONSE_V1";
const digest = content => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const fail = code => { throw Object.assign(new Error("Private response evidence is unavailable or invalid."), {code}); };

function directory(root, create = false) {
  const target = path.join(root, "private-web-responses");
  if (create) fs.mkdirSync(target, {recursive:true, mode:0o700});
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PRIVATE_RESPONSE_STORAGE_INVALID");
  if (create && process.platform !== "win32") fs.chmodSync(target, 0o700);
  return target;
}

function filename(root, ref) {
  if (ref?.storage !== STORAGE || ref.redacted !== false || !/^sha256:[a-f0-9]{64}$/u.test(ref.sha256)) {
    fail("PRIVATE_RESPONSE_REFERENCE_INVALID");
  }
  return path.join(directory(root), ref.sha256.slice(7));
}

export function putPrivateResponse(root, record) {
  const content = Buffer.from(canonicalJson(record), "utf8");
  const ref = {storage:STORAGE, sha256:digest(content), size:content.length,
    mimeType:"application/json", redacted:false};
  const target = path.join(directory(root, true), ref.sha256.slice(7));
  let descriptor;
  try {
    descriptor = fs.openSync(target, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    readPrivateResponse(root, ref);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  return Object.freeze(ref);
}

export function readPrivateResponse(root, ref) {
  const target = filename(root, ref), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("PRIVATE_RESPONSE_STORAGE_INVALID");
  const content = fs.readFileSync(target);
  if (digest(content) !== ref.sha256 || content.length !== ref.size) fail("PRIVATE_RESPONSE_HASH_MISMATCH");
  return JSON.parse(content.toString("utf8"));
}

export function removePrivateResponseIfUnreferenced(root, sha256, referenced) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(sha256)) fail("PRIVATE_RESPONSE_REFERENCE_INVALID");
  if (referenced.has(sha256)) return false;
  try { fs.unlinkSync(path.join(directory(root), sha256.slice(7))); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
