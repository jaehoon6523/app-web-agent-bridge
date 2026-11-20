import { isTerminalRunPhase } from "../domain/run-state-machine.js";
import { sha256CanonicalJson } from "../domain/canonical-json.js";
import { terminalCodeChangeStages } from "./code-change-store.js";
import { DatabaseSync } from "./sqlite-database.js";

export function hasPersistedWorkForAbandonment(databasePath) {
  try {
    const db = new DatabaseSync(databasePath, {readOnly:true});
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN");
      const phases = db.prepare("SELECT DISTINCT json_extract(run_json, '$.phase') AS phase FROM runs").all();
      if (phases.some(({phase}) => !isTerminalRunPhase(phase))) return true;
      if (db.prepare("SELECT 1 FROM agent_sessions WHERE json_extract(session_json, '$.activeTurnId') IS NOT NULL LIMIT 1").get()
        || db.prepare("SELECT 1 FROM audit_command_receipts WHERE status IS NOT 'COMPLETED' LIMIT 1").get()) return true;
      const runs = db.prepare("SELECT run_id, version, record_json, record_hash FROM code_change_runs").all();
      return runs.some(row => {
        const run = JSON.parse(String(row.record_json));
        if (run.runId !== row.run_id || run.version !== row.version || sha256CanonicalJson(run) !== row.record_hash) {
          throw new Error("Invalid current code change record.");
        }
        return !terminalCodeChangeStages.has(run.stage)
          || run.conversationBindings?.some(binding => binding.activeDeliveryId)
          || run.webDeliveryReceipts?.some(receipt => receipt.state === "ACK_PENDING");
      });
    } finally { db.close(); }
  } catch (cause) {
    throw Object.assign(new Error("Could not verify whether another run owns active work.", {cause}),
      {code:"ABANDONMENT_SAFETY_UNAVAILABLE"});
  }
}
