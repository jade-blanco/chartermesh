import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  acquireMaintenanceLock,
  createControlPlaneBackup,
  listControlPlaneBackups,
  openControlPlaneDatabase,
  readControlPlaneBackup,
} from "../src/index.ts";

test("maintenance lock blocks new and already-open writers until released", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-maintenance-"));
  const databasePath = join(directory, "state.db");
  const database = openControlPlaneDatabase(databasePath);
  const controlPlane = new ControlPlane(
    database,
    join(directory, "artifacts"),
  );
  const release = acquireMaintenanceLock(directory, "restore test");
  try {
    assert.throws(
      () => openControlPlaneDatabase(databasePath),
      /CONTROL_PLANE_MAINTENANCE_ACTIVE/u,
    );
    assert.throws(
      () =>
        controlPlane.intake({
          title: "Blocked during restore",
          summary: "This write must wait.",
          actor: "human:test",
          idempotencyKey: "maintenance:blocked",
        }),
      /CONTROL_PLANE_MAINTENANCE_ACTIVE/u,
    );
    const maintenanceDatabase = openControlPlaneDatabase(databasePath, {
      allowMaintenance: true,
    });
    maintenanceDatabase.close();
  } finally {
    release();
  }
  try {
    assert.equal(
      controlPlane.intake({
        title: "Allowed after restore",
        summary: "The lock has been released.",
        actor: "human:test",
        idempotencyKey: "maintenance:released",
      }).title,
      "Allowed after restore",
    );
  } finally {
    database.close();
  }
});

test("Control Plane backups are hashed, integrity-checked snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-backup-"));
  const databasePath = join(directory, "state.db");
  const backupDirectory = join(directory, "backups");
  const database = openControlPlaneDatabase(databasePath);
  try {
    const controlPlane = new ControlPlane(
      database,
      join(directory, "artifacts"),
    );
    const item = controlPlane.intake({
      title: "Snapshot this work",
      summary: "The backup must contain one work item.",
      actor: "human:test",
      idempotencyKey: "backup:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "backup:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "role:operator",
      idempotencyKey: "backup:claim",
    });
    const submission = controlPlane.submitArtifact({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      content: "Artifact bytes must be part of the backup set.",
      generation: claim.generation,
      actor: "role:operator",
      idempotencyKey: "backup:submit",
    });
    database.prepare(`
      INSERT INTO pending_tool_calls(
        id, work_item_id, run_id, attempt_id, call_hash, tool_name,
        arguments_json, summary_json, status, created_at, executed_at,
        reservation_id, reservation_run_id, reservation_attempt_id,
        reservation_lease_id, reservation_generation, reservation_actor,
        reserved_at, evidence_id, effect_hash, outcome_message
      ) VALUES (?, ?, ?, ?, ?, 'workspace.write_file', '{}', NULL,
                'executing', ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(
      "pending-backup",
      item.id,
      claim.runId,
      claim.attemptId,
      "a".repeat(64),
      new Date().toISOString(),
      "reservation-backup",
      claim.runId,
      claim.attemptId,
      claim.leaseId,
      claim.generation,
      "role:operator",
      new Date().toISOString(),
      "b".repeat(64),
    );
    const manifest = createControlPlaneBackup(
      database,
      backupDirectory,
      "manual",
    );
    assert.equal(manifest.schemaVersion, 15);
    assert.equal(manifest.workItemCount, 1);
    assert.equal(manifest.artifacts?.length, 1);
    assert.equal(manifest.artifacts?.[0]?.sha256, submission.sha256);
    assert.match(manifest.artifactSetSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(listControlPlaneBackups(backupDirectory), [manifest]);
    const selected = readControlPlaneBackup(backupDirectory, manifest.id);
    assert.equal(selected.bytes.byteLength, manifest.byteSize);
    assert.equal(
      selected.artifacts[0]?.bytes.toString("utf8"),
      "Artifact bytes must be part of the backup set.",
    );
    const restoredPath = join(directory, "restored.db");
    writeFileSync(restoredPath, selected.bytes);
    const restored = openControlPlaneDatabase(restoredPath);
    try {
      const pending = restored
        .prepare(`
          SELECT status, reservation_id, reservation_lease_id, effect_hash
          FROM pending_tool_calls WHERE id = 'pending-backup'
        `)
        .get() as {
          status: string;
          reservation_id: string;
          reservation_lease_id: string;
          effect_hash: string;
        };
      assert.deepEqual({ ...pending }, {
        status: "executing",
        reservation_id: "reservation-backup",
        reservation_lease_id: claim.leaseId,
        effect_hash: "b".repeat(64),
      });
    } finally {
      restored.close();
    }
    const blobPath = join(
      backupDirectory,
      "blobs",
      `${submission.sha256}.txt`,
    );
    assert.equal(existsSync(blobPath), true);
    rmSync(blobPath);
    assert.throws(
      () => readControlPlaneBackup(backupDirectory, manifest.id),
      /ENOENT|ARTIFACT_HASH_MISMATCH/u,
    );
  } finally {
    database.close();
  }
});

test("opening an older schema creates a migration safety backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-migration-"));
  const databasePath = join(directory, "state.db");
  const initial = openControlPlaneDatabase(databasePath);
  initial.prepare("DELETE FROM schema_migrations WHERE version > 1").run();
  initial
    .prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)",
    )
    .run(new Date().toISOString());
  initial.exec(`
    DROP INDEX attempts_parent_idx;
    PRAGMA foreign_keys = OFF;
    CREATE TABLE attempts_legacy (
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
    DROP TABLE attempts;
    ALTER TABLE attempts_legacy RENAME TO attempts;
    PRAGMA foreign_keys = ON;
  `);
  initial.exec("DROP TABLE artifacts");
  initial.close();

  const migrated = openControlPlaneDatabase(databasePath);
  try {
    const version = migrated
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(Number(version.version), 15);
    const attemptColumns = migrated
      .prepare("PRAGMA table_info(attempts)")
      .all() as Array<{ name: string }>;
    assert.equal(
      ["parent_attempt_id", "role_id", "kind"].every((expected) =>
        attemptColumns.some(({ name }) => name === expected),
      ),
      true,
    );
    const backups = listControlPlaneBackups(join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.reason, "migration");
    assert.equal(backups[0]?.schemaVersion, 1);
  } finally {
    migrated.close();
  }
});

test("opening a schema-v13 database backs up and fails closed for legacy idempotency rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-v13-migration-"));
  const databasePath = join(directory, "state.db");
  const initial = openControlPlaneDatabase(databasePath);
  const controlPlane = new ControlPlane(initial, join(directory, "artifacts"));
  const originalInput = {
    title: "Legacy idempotency response",
    summary: "The pre-v14 row has no actor or payload binding.",
    actor: "human:test",
    idempotencyKey: "v13:idempotency:intake",
  };
  controlPlane.intake(originalInput);
  initial.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
  initial.exec(`
    CREATE TABLE command_results_v13 (
      idempotency_key TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO command_results_v13(
      idempotency_key, command, response_json, created_at
    )
    SELECT idempotency_key, command, response_json, created_at
    FROM command_results;
    DROP TABLE command_results;
    ALTER TABLE command_results_v13 RENAME TO command_results;
  `);
  initial.close();

  const migrated = openControlPlaneDatabase(databasePath);
  try {
    const version = migrated
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(Number(version.version), 15);
    const columns = migrated
      .prepare("PRAGMA table_info(command_results)")
      .all() as Array<{ name: string }>;
    assert.equal(columns.some(({ name }) => name === "request_hash"), true);
    const legacy = migrated
      .prepare(
        "SELECT request_hash FROM command_results WHERE idempotency_key = ?",
      )
      .get(originalInput.idempotencyKey) as { request_hash: string };
    assert.equal(legacy.request_hash, "legacy-unbound-pre-v14");
    const migratedControlPlane = new ControlPlane(
      migrated,
      join(directory, "artifacts"),
    );
    assert.throws(
      () => migratedControlPlane.intake(originalInput),
      /different request input/u,
    );
    assert.equal(migratedControlPlane.list().length, 1);
    const backups = listControlPlaneBackups(join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.reason, "migration");
    assert.equal(backups[0]?.schemaVersion, 13);
  } finally {
    migrated.close();
  }
});

test("opening a schema-v11 database backs up before producer-sidecar migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-sidecar-migration-"));
  const databasePath = join(directory, "state.db");
  const initial = openControlPlaneDatabase(databasePath);
  const controlPlane = new ControlPlane(initial, join(directory, "artifacts"));
  const item = controlPlane.intake({
    title: "Preserve v11 artifact",
    summary: "The sidecar migration must preserve existing artifact rows.",
    actor: "human:test",
    idempotencyKey: "v11-sidecar:intake",
  });
  controlPlane.triage({
    id: item.id,
    ownerRole: "operator",
    executionTarget: "local",
    actor: "human:test",
    idempotencyKey: "v11-sidecar:triage",
  });
  const claim = controlPlane.claim({
    id: item.id,
    actor: "runner:test",
    idempotencyKey: "v11-sidecar:claim",
  });
  const submitted = controlPlane.submitArtifact({
    id: item.id,
    runId: claim.runId,
    attemptId: claim.attemptId,
    leaseId: claim.leaseId,
    content: "legacy artifact bytes",
    generation: claim.generation,
    actor: "runner:test",
    idempotencyKey: "v11-sidecar:submit",
  });
  initial.prepare("DELETE FROM schema_migrations WHERE version >= 12").run();
  initial.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE artifacts_v11 (
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
    INSERT INTO artifacts_v11(
      id, work_item_id, run_id, sha256, storage_name,
      media_type, byte_size, created_at
    )
    SELECT
      id, work_item_id, run_id, sha256, storage_name,
      media_type, byte_size, created_at
    FROM artifacts;
    DROP TABLE artifacts;
    ALTER TABLE artifacts_v11 RENAME TO artifacts;
    PRAGMA foreign_keys = ON;
  `);
  initial.close();

  const migrated = openControlPlaneDatabase(databasePath);
  try {
    const version = migrated
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(Number(version.version), 15);
    const backups = listControlPlaneBackups(join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.reason, "migration");
    assert.equal(backups[0]?.schemaVersion, 11);
    const columns = migrated
      .prepare("PRAGMA table_info(artifacts)")
      .all() as Array<{ name: string }>;
    assert.equal(
      [
        "producer_report_json",
        "producer_report_hash",
        "producer_report_byte_size",
      ].every((name) => columns.some((column) => column.name === name)),
      true,
    );
    const migratedControlPlane = new ControlPlane(
      migrated,
      join(directory, "artifacts"),
    );
    const artifact = migratedControlPlane.latestArtifact(item.id);
    assert.equal(artifact?.sha256, submitted.sha256);
    assert.equal(artifact?.content, "legacy artifact bytes");
    assert.equal(artifact?.producerReport, undefined);
    const row = migrated
      .prepare(`
        SELECT producer_report_json, producer_report_hash,
               producer_report_byte_size
        FROM artifacts WHERE work_item_id = ?
      `)
      .get(item.id) as Record<string, unknown>;
    assert.equal(row.producer_report_json, null);
    assert.equal(row.producer_report_hash, null);
    assert.equal(Number(row.producer_report_byte_size), 0);
  } finally {
    migrated.close();
  }
});
