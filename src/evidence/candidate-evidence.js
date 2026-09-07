import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { redactForEvidence } from "../security/redaction.js";
import { exactObject, uniqueItems, nonempty } from "../domain/audit-contract.js";

export function validateVerifications(items) {
  uniqueItems(items, "verificationId", "verifications");
  for (const item of items) {
    exactObject(item, ["verificationId", "executable", "args", "cwd", "timeoutMs", "purpose", "environmentId", "resultFiles"]);
    nonempty(item.executable, "executable"); nonempty(item.purpose, "purpose"); nonempty(item.environmentId, "environmentId");
    if (!path.isAbsolute(item.executable) || /\.(?:cmd|bat|ps1)$/iu.test(item.executable)
      || !fs.statSync(item.executable).isFile()) throw new TypeError("Verification requires an existing absolute executable, without a shell wrapper.");
    if (!Array.isArray(item.args) || item.args.some((a) => typeof a !== "string" || a.includes("\0"))) throw new TypeError("Verification args must be literal strings.");
    if (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 2_147_483_647) throw new TypeError("Explicit verification timeout within the timer range required.");
    if (typeof item.cwd !== "string" || path.isAbsolute(item.cwd) || item.cwd.split(/[\\/]/u).includes("..")) throw new TypeError("Verification cwd must be inside the candidate.");
    if (!Array.isArray(item.resultFiles) || item.resultFiles.some((p) => typeof p !== "string" || path.isAbsolute(p) || p.split(/[\\/]/u).includes(".."))) throw new TypeError("Result files must be within verification cwd.");
  }
  return structuredClone(items);
}
export function evidenceRecord(artifactStore, candidateId, kind, content, result = {}, producer = "CONTROLLER") {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { evidenceId: `evidence_${randomUUID()}`, candidateId, kind, producer, result,
    contentRef: artifactStore.put(redactForEvidence(text), { mimeType: "text/plain", redacted: true }),
    valid: true, createdAt: new Date().toISOString() };
}
export function excerpt(text, startLine = 1, endLine = startLine + 199) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 1000) throw new Error("Requested range must contain 1..1000 lines.");
  const lines = text.split(/\r?\n/u);
  return { content: lines.slice(startLine - 1, endLine).join("\n"), startLine, endLine: Math.min(endLine, lines.length), totalLines: lines.length,
    omittedBefore: startLine > 1, omittedAfter: endLine < lines.length };
}
function within(root, filename) {
  const absolute = fs.realpathSync(filename);
  const rel = path.relative(fs.realpathSync(root), absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Verification path escapes candidate.");
  return absolute;
}

// Registered commands are trusted project configuration, never Web-supplied shell text.
// This process boundary restricts dispatch, cwd and inherited environment; it is not an OS sandbox.
export async function executeVerification({ workspace, capture, candidateId, verification, artifactStore, signal }) {
  const startedAt = new Date().toISOString();
  const record = { verificationId: verification.verificationId, executable: verification.executable, args: verification.args,
    environmentId: verification.environmentId, environment: { platform: process.platform, release: os.release(), node: process.version },
    candidateId, cwd: path.resolve(workspace.root, verification.cwd), startedAt, finishedAt: null,
    exitCode: null, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "", outputTruncated: false,
    error: null, candidateUnchanged: false, terminationConfirmed: false, resultFiles: [] };
  try {
    workspace.assertCandidate(capture);
    record.cwd = within(workspace.root, record.cwd);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "PATHEXT"].includes(key.toUpperCase())));
    await new Promise((resolve) => {
      if (signal?.aborted) { record.aborted = true; record.terminationConfirmed = true; resolve(null); return; }
      const child = spawn(verification.executable, verification.args, { cwd: record.cwd, env: environment, windowsHide: true, shell: false });
      const stop = () => { record.aborted = true; child.kill("SIGTERM"); };
      const timer = setTimeout(() => { record.timedOut = true; child.kill("SIGKILL"); }, verification.timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      const output = (key, chunk) => {
        const remaining = 8 * 1024 * 1024 - Buffer.byteLength(record[key]);
        if (chunk.length > remaining) record.outputTruncated = true;
        if (remaining > 0) record[key] += chunk.subarray(0, remaining).toString("utf8");
      };
      child.stdout.on("data", (c) => output("stdout", c)); child.stderr.on("data", (c) => output("stderr", c));
      child.on("error", (error) => { record.error = error.message; });
      child.on("close", (code, killedBy) => {
        clearTimeout(timer); signal?.removeEventListener("abort", stop);
        record.exitCode = code; record.signal = killedBy; record.terminationConfirmed = true; resolve(null);
      });
    });
    try { workspace.assertCandidate(capture); record.candidateUnchanged = true; }
    catch (error) { record.error = error.message; }
    for (const filename of verification.resultFiles) {
      try {
        const absolute = within(record.cwd, path.resolve(record.cwd, filename));
        if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 8 * 1024 * 1024) throw new Error("Result is not a file or exceeds 8 MiB.");
        const content = fs.readFileSync(absolute);
        if (content.includes(0)) throw new Error("Binary result requires a separately approved artifact collector.");
        record.resultFiles.push({ path: filename, evidence: evidenceRecord(artifactStore, candidateId, "ARTIFACT", content.toString("utf8"), { verificationId: verification.verificationId }) });
      } catch (error) { record.resultFiles.push({ path: filename, error: error.message }); }
    }
  } catch (error) { record.error = error.message; }
  record.finishedAt = new Date().toISOString();
  const evidence = evidenceRecord(artifactStore, candidateId, "EXECUTION", record, {
    verificationId: verification.verificationId, exitCode: record.exitCode, timedOut: record.timedOut,
    aborted: record.aborted, error: record.error, candidateUnchanged: record.candidateUnchanged, terminationConfirmed: record.terminationConfirmed,
  });
  evidence.valid = record.candidateUnchanged;
  const artifacts = record.resultFiles.flatMap((r) => r.evidence ? [{ ...r.evidence, valid: evidence.valid, executionEvidenceId: evidence.evidenceId }] : []);
  return { evidence, artifacts, record };
}
