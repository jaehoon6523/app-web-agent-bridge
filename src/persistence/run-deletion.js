const TERMINAL_PHASES = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

export function deleteRunEntity(database, runId, PersistenceError) {
  const row = database.prepare("SELECT run_json FROM runs WHERE run_id = ?").get(runId);
  if (!row) return false;
  const run = JSON.parse(row.run_json);
  if (!TERMINAL_PHASES.has(run.phase)) {
    throw new PersistenceError("Only terminal runs can be deleted", "RUN_NOT_TERMINAL");
  }
  database.exec("DROP TRIGGER run_limits_cannot_be_deleted");
  database.prepare("UPDATE agent_turn_inputs SET source_message_id = NULL WHERE run_id = ?").run(runId);
  for (const table of [
    "proposal_artifacts", "run_outcomes", "agent_packets", "delivery_attempts", "agent_messages",
    "agent_turn_inputs", "approvals", "recovery_operations", "run_projections", "domain_events",
    "agent_sessions", "run_limits",
  ]) database.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
  database.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
  database.exec(`
    CREATE TRIGGER run_limits_cannot_be_deleted
    BEFORE DELETE ON run_limits
    BEGIN
      SELECT RAISE(ABORT, 'run limit configuration is immutable');
    END;
  `);
  return true;
}
