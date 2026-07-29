import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openControlPlaneDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      generation INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
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
      UNIQUE(work_item_id, sha256),
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
  return database;
}
