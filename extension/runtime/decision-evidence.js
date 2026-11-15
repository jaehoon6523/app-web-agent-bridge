const maxCharacters = 16 * 1024 * 1024;
const chunkCharacters = 64 * 1024;
const failed = code => ({ status:"FAILED", code });

export function createDecisionEvidenceRelay({ store, send, getConnection }) {
  const awaiting = new Map();
  const observed = new Map();
  async function exchange(captureId, transmit, deadline) {
    let timeout;
    try {
      const receipt = new Promise(resolve => {
        awaiting.set(captureId, resolve);
        timeout = setTimeout(() => resolve(failed("EVIDENCE_RECEIPT_TIMEOUT")), Math.max(0,deadline - Date.now()));
      });
      return transmit() ? await receipt : failed("EVIDENCE_DISCONNECTED");
    } finally {
      clearTimeout(timeout);
      awaiting.delete(captureId);
    }
  }
  return {
    accept(message) {
      if (message.type !== "controller.decision-evidence.receipt") return false;
      awaiting.get(message.requestId)?.(message.payload);
      return true;
    },
    async record(message, sender) {
      const { requestId, payload } = message;
      if (!payload || !["COMPLETED","UNCONFIRMED","AFTER_CHANGE"].includes(payload.phase)) return failed("EVIDENCE_INVALID");
      const state = await store.read();
      const owner = JSON.stringify([sender.tab?.id, sender.frameId, payload.documentId]);
      const previous = observed.get(requestId);
      if (payload.phase === "AFTER_CHANGE" ? previous?.owner !== owner
          || payload.observation?.previousCaptureId !== previous.captureId || Date.now() > previous.expires
        : state.currentDeliveryId !== requestId || sender.tab?.id !== state.tabId
          || sender.frameId !== 0 || payload.documentId !== state.documentId) return failed("EVIDENCE_OWNER_MISMATCH");
      if (payload.phase === "AFTER_CHANGE") observed.delete(requestId);
      const captureId = crypto.randomUUID();
      const serialized = JSON.stringify({ ...payload, deliveryId:requestId, captureId, tabId:sender.tab.id, frameId:sender.frameId });
      if (serialized.length > maxCharacters) return failed("EVIDENCE_TOO_LARGE");
      const connection = getConnection();
      const deadline = Date.now() + 5000;
      const readiness = await exchange(captureId,
        () => send({ type:"extension.decision-evidence.prepare",requestId:captureId }),deadline);
      if (readiness?.status !== "READY") return failed(readiness?.code ?? "EVIDENCE_STORAGE_UNCONFIRMED");
      if (!connection || getConnection() !== connection) return failed("EVIDENCE_DISCONNECTED");
      const result = await exchange(captureId, () => {
        for (let start = 0; start < serialized.length; start += chunkCharacters) {
          if (!send({ type:"extension.decision-evidence", requestId:captureId, payload:{
            index:start / chunkCharacters, final:start + chunkCharacters >= serialized.length,
            chunk:serialized.slice(start, start + chunkCharacters),
          } })) return false;
        }
        return true;
      },deadline);
      if (result?.status === "PERSISTED" && payload.phase === "COMPLETED") {
        const entry = {owner, captureId, expires:Date.now() + 12000};
        observed.set(requestId, entry);
        setTimeout(() => { if (observed.get(requestId) === entry) observed.delete(requestId); }, 12000);
      }
      return result?.status === "PERSISTED" ? result : failed(result?.code ?? "EVIDENCE_STORAGE_FAILED");
    },
  };
}
