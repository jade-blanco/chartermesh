import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
      content: "Artifact bytes must be part of the backup set.",
      generation: claim.generation,
      actor: "role:operator",
      idempotencyKey: "backup:submit",
    });
    const manifest = createControlPlaneBackup(
      database,
      backupDirectory,
      "manual",
    );
    assert.equal(manifest.schemaVersion, 11);
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
    assert.equal(Number(version.version), 11);
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
