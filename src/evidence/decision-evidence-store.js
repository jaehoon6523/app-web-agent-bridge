import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const maxCharacters = 16 * 1024 * 1024;
const maxChunkCharacters = 64 * 1024;
const digest = text => createHash("sha256").update(text).digest("hex");

function assertLocalWindowsDrive(location, system) {
  const drive = path.parse(location).root;
  if (!/^[a-z]:\\$/iu.test(drive)) throw new Error("Evidence requires a local drive");
  const type = execFileSync(path.join(system,"WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command", "[IO.DriveInfo]::new($env:BRIDGE_EVIDENCE_DRIVE_ROOT).DriveType",
  ], { encoding:"utf8",windowsHide:true,timeout:3000,env:{...process.env,BRIDGE_EVIDENCE_DRIVE_ROOT:drive} }).trim();
  if (type !== "Fixed") throw new Error("Evidence requires a fixed local drive");
}

function privateDirectory(root) {
  const system = path.join(process.env.SystemRoot ?? "C:/Windows", "System32");
  const parent = fs.realpathSync(path.dirname(root));
  if (process.platform === "win32") assertLocalWindowsDrive(parent,system);
  fs.mkdirSync(root, { recursive:true, mode:0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error("Evidence root must be a directory");
  const physicalRoot = fs.realpathSync(root);
  if (process.platform === "win32" && path.parse(physicalRoot).root !== path.parse(parent).root) {
    assertLocalWindowsDrive(physicalRoot,system);
  }
  const directory = fs.mkdtempSync(path.join(physicalRoot, "decision-evidence-"));
  if (process.platform === "win32") {
    const identity = execFileSync(path.join(system,"whoami.exe"), ["/user","/fo","csv","/nh"], { encoding:"utf8", windowsHide:true });
    const sid = identity.match(/"(S-1-[0-9-]+)"/u)?.[1];
    if (!sid) throw new Error("Windows user SID unavailable");
    execFileSync(path.join(system,"icacls.exe"), [directory,"/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`], { windowsHide:true });
  } else {
    fs.chmodSync(directory,0o700);
  }
  return directory;
}

async function persistCapture(directory, record) {
  const {pageHtml,assistantHtml,userHtml,turnHtml,composerHtml,sendHtml,stopHtml,bodyHtml,assistantRawText,extracted,timeline,...decision} = record;
  const rawFiles = {
    "page-raw.html":pageHtml, "assistant-raw.html":assistantHtml, "user-raw.html":userHtml, "turn-raw.html":turnHtml,
    "composer-raw.html":composerHtml, "send-raw.html":sendHtml, "stop-raw.html":stopHtml,
    "response-raw.txt":assistantRawText, "response-extracted.txt":extracted,
  };
  for (const [index, body] of (bodyHtml ?? []).entries()) rawFiles[`body-${index}.html`] = body;
  if (timeline) {
    const { snapshots, ...summary } = timeline;
    decision.timeline = { ...summary, snapshots:snapshots.map(({html,raw,extracted,...snapshot}, index) => {
      const prefix = `sample-${index}`;
      rawFiles[`${prefix}.html`] = html;
      rawFiles[`${prefix}-raw.txt`] = raw;
      rawFiles[`${prefix}-extracted.txt`] = extracted;
      return { ...snapshot, prefix };
    }) };
  }
  const files = Object.fromEntries(Object.entries(rawFiles).filter(([,text]) => typeof text === "string")
    .map(([name,text]) => [name,{utf8Bytes:Buffer.byteLength(text),sha256:digest(text)}]));
  const staging = fs.mkdtempSync(path.join(directory,".staging-"));
  try {
    for (const name of Object.keys(files)) durableWrite(path.join(staging,name),rawFiles[name]);
    const persistedAt = Date.now();
    const metadata = JSON.stringify({...decision,persistedAt,files},null,2) + "\n";
    const manifest = Object.entries({...files,"decision.json":{sha256:digest(metadata)}})
      .map(([name,{sha256}]) => `${sha256}  ${name}\n`).join("");
    durableWrite(path.join(staging,"decision.json"),metadata);
    durableWrite(path.join(staging,"manifest.sha256"),manifest);
    const destination = path.join(directory,record.captureId);
    for (let attempt = 0;; attempt++) {
      try {
        await fs.promises.rename(staging,destination);
        break;
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt === 3) throw error;
        await delay(100 * 2 ** attempt);
      }
    }
    return { persistedAt,page:files["page-raw.html"],response:files["response-extracted.txt"],
      relativePath:`${path.basename(directory)}/${record.captureId}`,manifestSha256:digest(manifest) };
  } catch (error) {
    try { fs.rmSync(staging,{recursive:true,force:true}); }
    catch { /* Preserve the original persistence error for diagnostics. */ }
    throw error;
  }
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
  const ready = new Map();
  const receipt = (requestId, payload, diagnostics) => {
    if (payload.status !== "READY") onReceipt({ ...payload, ...diagnostics });
    try { transport.send({type:"controller.decision-evidence.receipt",requestId,payload}); }
    catch { /* The authenticated relay reports a missing acknowledgement. */ }
  };
  transport.on("state", state => {
    if (!state.authenticated) { upload = null; ready.clear(); }
  });
  transport.on("message", async message => {
    if (!["extension.decision-evidence.prepare","extension.decision-evidence"].includes(message.type)) return;
    const { requestId, payload } = message;
    if (!/^[a-f0-9-]{36}$/u.test(requestId ?? "")) return;
    const fail = (code, storagePhase, error) => {
      if (upload?.requestId === requestId) upload = null;
      ready.delete(requestId);
      receipt(requestId,{status:"FAILED",captureId:requestId,code},
        storagePhase ? { storagePhase, systemCode: error?.code ?? null,
          systemStatus: error?.status ?? null, systemCall: error?.syscall ?? null,
          systemOperation: typeof error?.path === "string" ? path.basename(error.path) : null } : undefined);
    };
    if (message.type === "extension.decision-evidence.prepare") {
      try { directory ??= privateDirectory(root); }
      catch (error) { return fail("EVIDENCE_STORAGE_FAILED", "PREPARE_DIRECTORY", error); }
      for (const [id,expiry] of ready) if (expiry < Date.now()) ready.delete(id);
      if (ready.size >= 16) return fail("EVIDENCE_STORAGE_BUSY");
      ready.set(requestId,Date.now() + 5000);
      return receipt(requestId,{status:"READY",captureId:requestId});
    }
    if ((ready.get(requestId) ?? 0) < Date.now()) return fail("EVIDENCE_STORAGE_UNCONFIRMED");
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
    ready.delete(requestId);
    try {
      const record = JSON.parse(serialized);
      if (!record || record.captureId !== requestId || typeof record.deliveryId !== "string"
        || typeof record.documentId !== "string" || !Number.isSafeInteger(record.capturedAt)
        || record.capturedAt < 0) return fail("EVIDENCE_INVALID_RECORD");
      if (record.phase === "TURN_TIMELINE") {
        const { events, snapshots } = record.timeline ?? {};
        if (!Array.isArray(events) || events.at(-1)?.type !== "OBSERVATION_END"
          || !Array.isArray(snapshots) || snapshots.length > 2056
          || snapshots.some(item => !item || [item.html,item.raw,item.extracted].some(text => typeof text !== "string"))) {
          return fail("EVIDENCE_INVALID_RECORD");
        }
      } else if (!["COMPLETED","UNCONFIRMED","AFTER_CHANGE"].includes(record.phase)
        || record.timeline != null || typeof record.pageHtml !== "string" || typeof record.extracted !== "string"
        || !Array.isArray(record.bodyHtml) || record.bodyHtml.length > 128) return fail("EVIDENCE_INVALID_RECORD");
      receipt(requestId,{ status:"PERSISTED", captureId:requestId, phase:record.phase, deliveryId:record.deliveryId,
        ...await persistCapture(directory,record) });
    } catch (error) {
      fail("EVIDENCE_STORAGE_FAILED", "PERSIST_CAPTURE", error);
    }
  });
}
