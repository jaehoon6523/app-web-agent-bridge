export const SQLITE_SCHEMA_VERSION = 4;

export const REQUIRED_TABLES = Object.freeze([
  "runs",
  "run_limits",
  "agent_sessions",
  "agent_turn_inputs",
  "agent_messages",
  "delivery_attempts",
  "agent_packets",
  "proposal_artifacts",
  "domain_events",
  "approvals",
  "run_projections",
  "recovery_operations",
]);

export const DeliveryState = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  SUBMITTED: "SUBMITTED",
  RESPONSE_STARTED: "RESPONSE_STARTED",
  RESPONSE_COMPLETED: "RESPONSE_COMPLETED",
  RELAYED: "RELAYED",
  FAILED: "FAILED",
  AMBIGUOUS: "AMBIGUOUS",
});

const DELIVERY_STATE_CHECK = Object.values(DeliveryState)
  .map((state) => `'${state}'`)
  .join(", ");

const PROPOSAL_ARTIFACTS_SQL = `
  CREATE TABLE proposal_artifacts (
    proposal_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    source_message_id TEXT NOT NULL UNIQUE
      REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
    author_actor TEXT NOT NULL,
    source_session_id TEXT NOT NULL
      REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
    source_turn_id TEXT NOT NULL,
    proposal_content_hash TEXT NOT NULL,
    proposal_ref_hash TEXT NOT NULL,
    artifact_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, proposal_ref_hash)
  ) STRICT;
  CREATE INDEX proposal_artifacts_run_idx
    ON proposal_artifacts(run_id, created_at, proposal_id);
`;

const SCHEMA_SQL = `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    run_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    last_event_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (event_count = 0 AND last_event_hash IS NULL)
      OR (event_count > 0 AND last_event_hash IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE run_limits (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    policy_hash TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    max_turns INTEGER NOT NULL CHECK (max_turns >= 1),
    max_protocol_repairs INTEGER NOT NULL CHECK (max_protocol_repairs >= 0),
    max_delivery_attempts INTEGER NOT NULL CHECK (max_delivery_attempts >= 1),
    max_consecutive_actor_failures INTEGER NOT NULL
      CHECK (max_consecutive_actor_failures >= 1),
    protocol_repairs_used INTEGER NOT NULL DEFAULT 0
      CHECK (protocol_repairs_used >= 0 AND protocol_repairs_used <= max_protocol_repairs),
    consecutive_actor_failures INTEGER NOT NULL DEFAULT 0
      CHECK (
        consecutive_actor_failures >= 0
        AND consecutive_actor_failures <= max_consecutive_actor_failures
      ),
    counter_version INTEGER NOT NULL DEFAULT 1 CHECK (counter_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER run_limits_configuration_is_immutable
  BEFORE UPDATE OF
    run_id,
    policy_hash,
    limits_json,
    max_turns,
    max_protocol_repairs,
    max_delivery_attempts,
    max_consecutive_actor_failures,
    created_at
  ON run_limits
  BEGIN
    SELECT RAISE(ABORT, 'run limit configuration is immutable');
  END;

  CREATE TRIGGER run_limits_cannot_be_deleted
  BEFORE DELETE ON run_limits
  BEGIN
    SELECT RAISE(ABORT, 'run limit configuration is immutable');
  END;

  CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    actor TEXT NOT NULL,
    session_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agent_sessions_run_idx ON agent_sessions(run_id, actor);

  CREATE TABLE agent_turn_inputs (
    input_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    target_actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_message_id TEXT REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
    payload_hash TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agent_turn_inputs_run_idx
    ON agent_turn_inputs(run_id, created_at, input_id);

  CREATE TABLE agent_messages (
    message_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    input_id TEXT NOT NULL UNIQUE
      REFERENCES agent_turn_inputs(input_id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    actor TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    message_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, sequence),
    UNIQUE (session_id, turn_id)
  ) STRICT;
  CREATE INDEX agent_messages_run_idx ON agent_messages(run_id, sequence);

  CREATE TABLE delivery_attempts (
    delivery_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    input_id TEXT NOT NULL UNIQUE
      REFERENCES agent_turn_inputs(input_id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN (${DELIVERY_STATE_CHECK})),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    provider_receipt_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX delivery_attempts_dispatch_idx
    ON delivery_attempts(state, created_at, delivery_id);

  CREATE TABLE agent_packets (
    packet_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL UNIQUE REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
    packet_hash TEXT NOT NULL,
    packet_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agent_packets_run_idx ON agent_packets(run_id, created_at);

  ${PROPOSAL_ARTIFACTS_SQL}

  CREATE TABLE domain_events (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_hash TEXT,
    event_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    UNIQUE (run_id, event_id)
  ) STRICT;
  CREATE INDEX domain_events_hash_idx ON domain_events(run_id, event_hash);

  CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX approvals_run_idx ON approvals(run_id, status);

  CREATE TABLE run_projections (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    projection_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
    last_event_hash TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (last_event_sequence = 0 AND last_event_hash IS NULL)
      OR (last_event_sequence > 0 AND last_event_hash IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE recovery_operations (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    operation_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX recovery_operations_run_idx ON recovery_operations(run_id, status);
`;

function readSchemaVersion(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version);
}

function assertRequiredTables(database) {
  const present = new Set(database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(`database schema is missing required table(s): ${missing.join(", ")}`);
  }
}

function migrateVersion2ToVersion3(database) {
  const legacyCounts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM relay_messages) AS messages,
      (SELECT COUNT(*) FROM delivery_attempts) AS deliveries,
      (SELECT COUNT(*) FROM agent_packets) AS packets
  `).get();
  if (
    Number(legacyCounts.messages) !== 0
    || Number(legacyCounts.deliveries) !== 0
    || Number(legacyCounts.packets) !== 0
  ) {
    throw new Error(
      "schema v2 contains legacy relay data whose AgentTurnInput provenance cannot be inferred; explicit recovery is required",
    );
  }

  database.exec(`
    DROP TABLE agent_packets;
    DROP TABLE delivery_attempts;
    DROP TABLE relay_messages;

    CREATE TABLE agent_turn_inputs (
      input_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      target_actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_message_id TEXT REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
      payload_hash TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX agent_turn_inputs_run_idx
      ON agent_turn_inputs(run_id, created_at, input_id);

    CREATE TABLE agent_messages (
      message_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      input_id TEXT NOT NULL UNIQUE
        REFERENCES agent_turn_inputs(input_id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      actor TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence),
      UNIQUE (session_id, turn_id)
    ) STRICT;
    CREATE INDEX agent_messages_run_idx ON agent_messages(run_id, sequence);

    CREATE TABLE delivery_attempts (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      input_id TEXT NOT NULL UNIQUE
        REFERENCES agent_turn_inputs(input_id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (${DELIVERY_STATE_CHECK})),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      provider_receipt_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX delivery_attempts_dispatch_idx
      ON delivery_attempts(state, created_at, delivery_id);

    CREATE TABLE agent_packets (
      packet_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      message_id TEXT NOT NULL UNIQUE REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
      packet_hash TEXT NOT NULL,
      packet_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX agent_packets_run_idx ON agent_packets(run_id, created_at);
  `);
}

function migrateVersion3ToVersion4(database) {
  database.exec(PROPOSAL_ARTIFACTS_SQL);
}

export function initializeSqliteSchema(database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  const version = readSchemaVersion(database);
  if (version > SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than supported version ${SQLITE_SCHEMA_VERSION}`,
    );
  }
  if (version === SQLITE_SCHEMA_VERSION) {
    assertRequiredTables(database);
    return version;
  }
  if (version !== 0 && version !== 2 && version !== 3) {
    throw new Error(`no migration exists from database schema version ${version}`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      database.exec(SCHEMA_SQL);
    } else {
      if (version === 2) migrateVersion2ToVersion3(database);
      migrateVersion3ToVersion4(database);
    }
    assertRequiredTables(database);
    database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return SQLITE_SCHEMA_VERSION;
}

export function readSqliteSchemaVersion(database) {
  return readSchemaVersion(database);
}
