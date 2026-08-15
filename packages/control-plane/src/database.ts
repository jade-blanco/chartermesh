import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createControlPlaneBackup } from "./backup.ts";
import { assertMaintenanceInactive } from "./maintenance.ts";

export function openControlPlaneDatabase(
  path: string,
  options: { allowMaintenance?: boolean } = {},
): DatabaseSync {
  const existed = existsSync(path);
  const stateDirectory = dirname(path);
  mkdirSync(stateDirectory, { recursive: true });
  if (!options.allowMaintenance) {
    assertMaintenanceInactive(stateDirectory);
  }
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);
  if (existed) {
    const hasMigrations = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_migrations'`,
      )
      .get() as { count: number };
    if (Number(hasMigrations.count) > 0) {
      const row = database
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number };
      const priorVersion = Number(row.version);
      if (priorVersion > 0 && priorVersion < 15) {
        createControlPlaneBackup(
          database,
          join(dirname(path), "backups"),
          "migration",
        );
      }
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      execution_target TEXT NOT NULL,
      status TEXT NOT NULL,
      availability TEXT NOT NULL,
      priority INTEGER NOT NULL,
      version INTEGER NOT NULL,
      wait_type TEXT,
      wait_reason TEXT,
      wait_reference TEXT,
      resume_at TEXT,
      wait_created_by TEXT,
      next_action TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      work_item_id TEXT NOT NULL,
      predecessor_id TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'after',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY(work_item_id, predecessor_id),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(predecessor_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      execution_target TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      cancel_requested_at TEXT,
      cancel_requested_by TEXT,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_attempt_id TEXT,
      role_id TEXT,
      kind TEXT NOT NULL DEFAULT 'primary',
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(parent_attempt_id) REFERENCES attempts(id)
    );

    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      generation INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      storage_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      producer_report_json TEXT,
      producer_report_hash TEXT,
      producer_report_byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, sha256),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      note TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS model_invocations (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      engine_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost REAL,
      measurement_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      work_item_id TEXT,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS command_results (
      idempotency_key TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error_code TEXT,
      dead_lettered_at TEXT,
      claimed_at TEXT,
      claim_owner TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS schedule_ticks (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      tick_key TEXT NOT NULL,
      status TEXT NOT NULL,
      work_item_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      UNIQUE(schedule_id, tick_key),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE INDEX IF NOT EXISTS work_items_status_idx
      ON work_items(status, availability, priority, updated_at);
    CREATE INDEX IF NOT EXISTS dependencies_predecessor_idx
      ON dependencies(predecessor_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_generation
      ON runs(work_item_id, generation)
      WHERE status IN ('running', 'waiting');
    CREATE INDEX IF NOT EXISTS schedule_ticks_schedule_idx
      ON schedule_ticks(schedule_id, started_at DESC);
  `);
  const workItemColumns = database
    .prepare("PRAGMA table_info(work_items)")
    .all() as Array<{ name: string }>;
  if (!workItemColumns.some(({ name }) => name === "wait_created_by")) {
    database.exec("ALTER TABLE work_items ADD COLUMN wait_created_by TEXT");
  }
  if (!workItemColumns.some(({ name }) => name === "archived_at")) {
    database.exec("ALTER TABLE work_items ADD COLUMN archived_at TEXT");
  }
  const attemptColumns = database
    .prepare("PRAGMA table_info(attempts)")
    .all() as Array<{ name: string }>;
  if (!attemptColumns.some(({ name }) => name === "error_code")) {
    database.exec("ALTER TABLE attempts ADD COLUMN error_code TEXT");
  }
  if (!attemptColumns.some(({ name }) => name === "error_message")) {
    database.exec("ALTER TABLE attempts ADD COLUMN error_message TEXT");
  }
  if (!attemptColumns.some(({ name }) => name === "parent_attempt_id")) {
    database.exec(
      "ALTER TABLE attempts ADD COLUMN parent_attempt_id TEXT REFERENCES attempts(id)",
    );
  }
  if (!attemptColumns.some(({ name }) => name === "role_id")) {
    database.exec("ALTER TABLE attempts ADD COLUMN role_id TEXT");
  }
  if (!attemptColumns.some(({ name }) => name === "kind")) {
    database.exec(
      "ALTER TABLE attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'primary'",
    );
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS attempts_parent_idx
      ON attempts(run_id, parent_attempt_id, attempt_no);
  `);
  const leaseColumns = database
    .prepare("PRAGMA table_info(leases)")
    .all() as Array<{ name: string }>;
  if (!leaseColumns.some(({ name }) => name === "heartbeat_at")) {
    database.exec("ALTER TABLE leases ADD COLUMN heartbeat_at TEXT");
  }
  const runColumns = database
    .prepare("PRAGMA table_info(runs)")
    .all() as Array<{ name: string }>;
  if (!runColumns.some(({ name }) => name === "cancel_requested_at")) {
    database.exec("ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT");
  }
  if (!runColumns.some(({ name }) => name === "cancel_requested_by")) {
    database.exec("ALTER TABLE runs ADD COLUMN cancel_requested_by TEXT");
  }
  const outboxColumns = database
    .prepare("PRAGMA table_info(outbox)")
    .all() as Array<{ name: string }>;
  const outboxAdditions = [
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["next_attempt_at", "TEXT"],
    ["last_error_code", "TEXT"],
    ["dead_lettered_at", "TEXT"],
    ["claimed_at", "TEXT"],
    ["claim_owner", "TEXT"],
  ] as const;
  for (const [name, type] of outboxAdditions) {
    if (!outboxColumns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${type}`);
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS outbox_pending_idx
      ON outbox(dispatched_at, dead_lettered_at, next_attempt_at, id);
  `);
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, ?)
    `)
    .run(new Date().toISOString());
  const artifactMigration = database
    .prepare("SELECT version FROM schema_migrations WHERE version = 3")
    .get();
  if (!artifactMigration) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE artifacts_v3 (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sha256),
        FOREIGN KEY(work_item_id) REFERENCES work_items(id),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      INSERT INTO artifacts_v3(
        id, work_item_id, run_id, sha256, storage_name,
        media_type, byte_size, created_at
      )
      SELECT
        id, work_item_id, run_id, sha256, storage_name,
        media_type, byte_size, created_at
      FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_v3 RENAME TO artifacts;
      COMMIT;
    `);
    database
      .prepare(`
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (3, ?)
      `)
      .run(new Date().toISOString());
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      call_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_item_id, call_hash),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS tool_denials (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      call_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      packet_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_item_id, call_hash),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS tool_evidence (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      call_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT,
      paths_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE INDEX IF NOT EXISTS tool_evidence_work_idx
      ON tool_evidence(work_item_id, created_at);

    CREATE TABLE IF NOT EXISTS tool_evidence_receipts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      call_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      consumed_at TEXT,
      evidence_id TEXT UNIQUE,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE INDEX IF NOT EXISTS tool_evidence_receipts_lineage_idx
      ON tool_evidence_receipts(work_item_id, run_id, attempt_id, status);

    CREATE TABLE IF NOT EXISTS pending_tool_calls (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      call_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      executed_at TEXT,
      UNIQUE(work_item_id, call_hash),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE INDEX IF NOT EXISTS pending_tool_calls_work_idx
      ON pending_tool_calls(work_item_id, status, created_at);

    CREATE TABLE IF NOT EXISTS work_item_required_tools (
      work_item_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(work_item_id, tool_name),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS work_item_decision_contracts (
      work_item_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS decision_packets (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      evidence_set_hash TEXT NOT NULL,
      packet_hash TEXT NOT NULL UNIQUE,
      packet_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS work_item_user_inputs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      wait_reference TEXT NOT NULL,
      response TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE INDEX IF NOT EXISTS decision_packets_work_idx
      ON decision_packets(work_item_id, superseded_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS work_item_user_inputs_work_idx
      ON work_item_user_inputs(work_item_id, created_at DESC);
  `);
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (4, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (5, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (6, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (7, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (8, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (9, ?)
    `)
    .run(new Date().toISOString());
  const approvalColumns = database
    .prepare("PRAGMA table_info(approvals)")
    .all() as Array<{ name: string }>;
  if (!approvalColumns.some(({ name }) => name === "packet_hash")) {
    database.exec("ALTER TABLE approvals ADD COLUMN packet_hash TEXT");
  }
  const toolApprovalColumns = database
    .prepare("PRAGMA table_info(tool_approvals)")
    .all() as Array<{ name: string }>;
  if (!toolApprovalColumns.some(({ name }) => name === "packet_hash")) {
    database.exec("ALTER TABLE tool_approvals ADD COLUMN packet_hash TEXT");
  }
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (10, ?)
    `)
    .run(new Date().toISOString());
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (11, ?)
    `)
    .run(new Date().toISOString());
  const artifactReportColumns = database
    .prepare("PRAGMA table_info(artifacts)")
    .all() as Array<{ name: string }>;
  if (
    !artifactReportColumns.some(
      ({ name }) => name === "producer_report_json",
    )
  ) {
    database.exec("ALTER TABLE artifacts ADD COLUMN producer_report_json TEXT");
  }
  if (
    !artifactReportColumns.some(
      ({ name }) => name === "producer_report_hash",
    )
  ) {
    database.exec("ALTER TABLE artifacts ADD COLUMN producer_report_hash TEXT");
  }
  if (
    !artifactReportColumns.some(
      ({ name }) => name === "producer_report_byte_size",
    )
  ) {
    database.exec(
      "ALTER TABLE artifacts ADD COLUMN producer_report_byte_size INTEGER NOT NULL DEFAULT 0",
    );
  }
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (12, ?)
    `)
    .run(new Date().toISOString());
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_host_runs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      host_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_event_cursor TEXT,
      error_code TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(host_id, host_run_id),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(run_id) REFERENCES runs(id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id)
    );

    CREATE INDEX IF NOT EXISTS agent_host_runs_work_idx
      ON agent_host_runs(work_item_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS agent_host_runs_status_idx
      ON agent_host_runs(status, updated_at);
  `);
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (13, ?)
    `)
    .run(new Date().toISOString());
  const commandResultColumns = database
    .prepare("PRAGMA table_info(command_results)")
    .all() as Array<{ name: string }>;
  if (!commandResultColumns.some(({ name }) => name === "request_hash")) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE command_results_v14 (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO command_results_v14(
        idempotency_key, command, request_hash, response_json, created_at
      )
      SELECT
        idempotency_key, command, 'legacy-unbound-pre-v14', response_json, created_at
      FROM command_results;
      DROP TABLE command_results;
      ALTER TABLE command_results_v14 RENAME TO command_results;
      COMMIT;
    `);
  }
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (14, ?)
    `)
    .run(new Date().toISOString());
  const pendingToolColumns = database
    .prepare("PRAGMA table_info(pending_tool_calls)")
    .all() as Array<{ name: string }>;
  const addPendingToolColumn = (name: string, declaration: string): void => {
    if (!pendingToolColumns.some((column) => column.name === name)) {
      database.exec(
        `ALTER TABLE pending_tool_calls ADD COLUMN ${name} ${declaration}`,
      );
    }
  };
  addPendingToolColumn("summary_json", "TEXT");
  addPendingToolColumn("reservation_id", "TEXT");
  addPendingToolColumn("reservation_run_id", "TEXT");
  addPendingToolColumn("reservation_attempt_id", "TEXT");
  addPendingToolColumn("reservation_lease_id", "TEXT");
  addPendingToolColumn("reservation_generation", "INTEGER");
  addPendingToolColumn("reservation_actor", "TEXT");
  addPendingToolColumn("reserved_at", "TEXT");
  addPendingToolColumn("evidence_id", "TEXT");
  addPendingToolColumn("effect_hash", "TEXT");
  addPendingToolColumn("outcome_message", "TEXT");
  database
    .prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (15, ?)
    `)
    .run(new Date().toISOString());
  return database;
}
