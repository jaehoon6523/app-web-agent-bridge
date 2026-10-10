import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { diagnosticId, diagnosticToken } from "./diagnostic-schema.js";

// Free-form reasons and URLs are fingerprinted, never copied into diagnostic logs.
export function createDeliveryRecoveryAudit({ directory, observe = async record => { void record; } }) {
  return async event => {
    const input = event.input ?? {};
    const digest = value => createHash("sha256").update(String(value ?? "")).digest("hex");
    const record = { source:"DELIVERY_RECONCILIATION", diagnosticId:randomUUID(), observedAt:new Date().toISOString(),
      phase:diagnosticToken(event.phase), code:diagnosticToken(event.code),
      deliveryId:diagnosticId(input.currentDeliveryId), sessionId:diagnosticId(input.sessionId), runId:diagnosticId(input.runId),
      targetHash:digest(JSON.stringify([input.currentDeliveryId,input.sessionId,input.runId,input.conversationUrl])),
      reasonHash:digest(input.reason?.trim()), noAutomaticResend:input.noAutomaticResendConfirmed === true,
      terminalDiscardConfirmed:input.terminalDiscardConfirmed === true,
      pageStateUnconfirmedConfirmed:input.pageStateUnconfirmedConfirmed === true,
      resultStatus:"UNKNOWN", disposalStatus:event.phase === "COMPLETED" ? "BOTH_DISCARDED" : "UNVERIFIED",
      idempotent:event.idempotent === true };
    try {
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const file = await fs.open(path.join(directory,"events.jsonl"),"a",0o600);
      try { await file.writeFile(JSON.stringify(record)+"\n"); await file.sync(); }
      finally { await file.close(); }
    } catch {
      await observe({...record,phase:"FAILED",code:"DELIVERY_AUDIT_WRITE_FAILED",disposalStatus:"UNVERIFIED"});
      throw Object.assign(new Error("Recovery audit could not be persisted; inspect this target before retrying."),{code:"DELIVERY_AUDIT_WRITE_FAILED"});
    }
    await observe(record);
  };
}
