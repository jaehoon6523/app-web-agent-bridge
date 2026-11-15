import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const maxCharacters = 16 * 1024 * 1024;
const maxChunkCharacters = 64 * 1024;
const digest = text => createHash("sha256").update(text).digest("hex");

function privateDirectory(root) {
  if (process.platform === "win32" && path.resolve(root).startsWith("\\\\")) throw new Error("Evidence requires a local directory");
  fs.mkdirSync(root, { recursive:true, mode:0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error("Evidence root must be a directory");
  const directory = fs.mkdtempSync(path.join(root, "decision-evidence-"));
  if (process.platform === "win32") {
    const system = path.join(process.env.SystemRoot ?? "C:/Windows", "System32");
    const identity = execFileSync(path.join(system,"whoami.exe"), ["/user","/fo","csv","/nh"], { encoding:"utf8", windowsHide:true });
    const sid = identity.match(/"(S-1-[0-9-]+)"/u)?.[1];
    if (!sid) throw new Error("Windows user SID unavailable");
    execFileSync(path.join(system,"icacls.exe"), [directory,"/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`], { windowsHide:true });
  } else {
    fs.chmodSync(directory,0o700);
  }
  return directory;
}

function persistCapture(directory, record) {
  const {pageHtml,assistantHtml,userHtml,turnHtml,composerHtml,sendHtml,stopHtml,bodyHtml,assistantRawText,extracted,...decision} = record;
  const rawFiles = {
    "page-raw.html":pageHtml, "assistant-raw.html":assistantHtml, "user-raw.html":userHtml, "turn-raw.html":turnHtml,
    "composer-raw.html":composerHtml, "send-raw.html":sendHtml, "stop-raw.html":stopHtml,
    "response-raw.txt":assistantRawText, "response-extracted.txt":extracted,
  };
  for (const [index, body] of bodyHtml.entries()) rawFiles[`body-${index}.html`] = body;
  const files = Object.fromEntries(Object.entries(rawFiles).filter(([,text]) => typeof text === "string")
    .map(([name,text]) => [name,{utf8Bytes:Buffer.byteLength(text),sha256:digest(text)}]));
  const metadata = JSON.stringify({...decision,files},null,2) + "\n";
  const manifest = Object.entries({...files,"decision.json":{sha256:digest(metadata)}})
    .map(([name,{sha256}]) => `${sha256}  ${name}\n`).join("");
  const staging = fs.mkdtempSync(path.join(directory,".staging-"));
  try {
    for (const name of Object.keys(files)) durableWrite(path.join(staging,name),rawFiles[name]);
    durableWrite(path.join(staging,"decision.json"),metadata);
    durableWrite(path.join(staging,"manifest.sha256"),manifest);
    fs.renameSync(staging,path.join(directory,record.captureId));
  } catch (error) {
    fs.rmSync(staging,{recursive:true,force:true});
    throw error;
  }
  return { page:files["page-raw.html"],response:files["response-extracted.txt"],
    relativePath:`${path.basename(directory)}/${record.captureId}`,manifestSha256:digest(manifest) };
}

function durableWrite(filename, text) {
  const descriptor = fs.openSync(filename,"wx",0o600);
  try {
    fs.writeFileSync(descriptor,text,"utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

/** @param {(receipt: Record<string, unknown>) => void} [onReceipt] */
export function installDecisionEvidenceStorage(transport, root, onReceipt = () => {}) {
  let upload = null;
  let directory;
  const receipt = (requestId, payload) => {
    onReceipt(payload);
    try { transport.send({type:"controller.decision-evidence.receipt",requestId,payload}); }
    catch { /* The authenticated relay reports a missing acknowledgement. */ }
  };
  transport.on("state", state => { if (!state.authenticated) upload = null; });
  transport.on("message", message => {
    if (message.type !== "extension.decision-evidence") return;
    const { requestId, payload } = message;
    if (!/^[a-f0-9-]{36}$/u.test(requestId ?? "")) return;
    const fail = code => {
      upload = null;
      receipt(requestId,{status:"FAILED",captureId:requestId,code});
    };
    const { index, final, chunk } = payload ?? {};
    if (!Number.isSafeInteger(index) || index < 0 || typeof final !== "boolean"
      || typeof chunk !== "string" || !chunk.length || chunk.length > maxChunkCharacters) return fail("EVIDENCE_INVALID_CHUNK");
    if (index === 0) upload = {requestId,chunks:[],characters:0};
    if (!upload || upload.requestId !== requestId || upload.chunks.length !== index
      || upload.characters + chunk.length > maxCharacters) return fail("EVIDENCE_INCOMPLETE");
    upload.chunks.push(chunk);
    upload.characters += chunk.length;
    if (!final) return;
    const serialized = upload.chunks.join("");
    upload = null;
    try {
      const record = JSON.parse(serialized);
      if (!record || record.captureId !== requestId || !["COMPLETED","UNCONFIRMED","AFTER_CHANGE"].includes(record.phase)
        || typeof record.deliveryId !== "string" || typeof record.pageHtml !== "string"
        || typeof record.extracted !== "string" || typeof record.documentId !== "string"
        || !Array.isArray(record.bodyHtml) || record.bodyHtml.length > 128) return fail("EVIDENCE_INVALID_RECORD");
      directory ??= privateDirectory(root);
      receipt(requestId,{ status:"PERSISTED", captureId:requestId, phase:record.phase, deliveryId:record.deliveryId,
        ...persistCapture(directory,record) });
    } catch {
      fail("EVIDENCE_STORAGE_FAILED");
    }
  });
}
