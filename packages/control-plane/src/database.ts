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
      if (priorVersion > 0 && priorVersion < 6) {
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
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id)
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
      FOREIGN KEY(event_id) REFERENCES events(id)
    );

    CREATE INDEX IF NOT EXISTS work_items_status_idx
      ON work_items(status, availability, priority, updated_at);
    CREATE INDEX IF NOT EXISTS dependencies_predecessor_idx
      ON dependencies(predecessor_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_generation
      ON runs(work_item_id, generation)
      WHERE status IN ('running', 'waiting');
  `);
  const workItemColumns = database
    .prepare("PRAGMA table_info(work_items)")
    .all() as Array<{ name: string }>;
  if (!workItemColumns.some(({ name }) => name === "wait_created_by")) {
    database.exec("ALTER TABLE work_items ADD COLUMN wait_created_by TEXT");
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
  const leaseColumns = database
    .prepare("PRAGMA table_info(leases)")
    .all() as Array<{ name: string }>;
  if (!leaseColumns.some(({ name }) => name === "heartbeat_at")) {
    database.exec("ALTER TABLE leases ADD COLUMN heartbeat_at TEXT");
  }
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
  return database;
}
