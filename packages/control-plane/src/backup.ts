import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BackupReason = "manual" | "migration" | "pre_restore";

export interface ControlPlaneBackupArtifact {
  sha256: string;
  storageName: string;
  byteSize: number;
}

export interface ControlPlaneBackupManifest {
  apiVersion: "chartermesh.dev/control-plane-backup/v1alpha1";
  id: string;
  createdAt: string;
  reason: BackupReason;
  sha256: string;
  byteSize: number;
  schemaVersion: number;
  workItemCount: number;
  artifacts?: ControlPlaneBackupArtifact[];
  artifactSetSha256?: string;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBackupId(id: string): void {
  if (!/^backup-[a-zA-Z0-9._-]{1,100}$/u.test(id)) {
    throw new Error("Invalid backup id.");
  }
}

function scalar(
  database: DatabaseSync,
  query: string,
  key: string,
): number {
  try {
    const row = database.prepare(query).get() as Record<string, unknown>;
    return Number(row?.[key] ?? 0);
  } catch {
    return 0;
  }
}

export function validateControlPlaneDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (row.integrity_check !== "ok") {
      throw new Error("CONTROL_PLANE_BACKUP_INTEGRITY_FAILED");
    }
  } finally {
    database.close();
  }
}

export function createControlPlaneBackup(
  database: DatabaseSync,
  backupDirectory: string,
  reason: BackupReason,
  artifactDirectory = join(dirname(backupDirectory), "artifacts"),
): ControlPlaneBackupManifest {
  mkdirSync(backupDirectory, { recursive: true });
  const blobDirectory = join(backupDirectory, "blobs");
  mkdirSync(blobDirectory, { recursive: true });
  let bytes: Buffer;
  let artifactRows: ControlPlaneBackupArtifact[];
  database.exec("BEGIN IMMEDIATE");
  try {
    const artifactTable = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'artifacts'`,
      )
      .get() as { count: number };
    artifactRows =
      Number(artifactTable.count) === 0
        ? []
        : (
            database
              .prepare(
                `SELECT DISTINCT
                   sha256,
                   storage_name AS storageName,
                   byte_size AS byteSize
                 FROM artifacts
                 ORDER BY sha256`,
              )
              .all() as Array<{
              sha256: string;
              storageName: string;
              byteSize: number;
            }>
          ).map((row) => ({
            sha256: String(row.sha256),
            storageName: String(row.storageName),
            byteSize: Number(row.byteSize),
          }));
    bytes = Buffer.from(database.serialize());
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original backup failure.
    }
    throw error;
  }

  for (const artifact of artifactRows) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      artifact.storageName !== `${artifact.sha256}.txt` ||
      !Number.isSafeInteger(artifact.byteSize) ||
      artifact.byteSize < 0
    ) {
      throw new Error("CONTROL_PLANE_BACKUP_ARTIFACT_INVALID");
    }
    const artifactBytes = readFileSync(
      join(artifactDirectory, artifact.storageName),
    );
    if (
      artifactBytes.byteLength !== artifact.byteSize ||
      digest(artifactBytes) !== artifact.sha256
    ) {
      throw new Error("CONTROL_PLANE_BACKUP_ARTIFACT_HASH_MISMATCH");
    }
    const blobPath = join(blobDirectory, artifact.storageName);
    if (existsSync(blobPath)) {
      const existing = readFileSync(blobPath);
      if (
        existing.byteLength !== artifact.byteSize ||
        digest(existing) !== artifact.sha256
      ) {
        throw new Error("CONTROL_PLANE_BACKUP_BLOB_HASH_MISMATCH");
      }
    } else {
      writeFileSync(blobPath, artifactBytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
  }

  const sha256 = digest(bytes);
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(/[:.]/gu, "-");
  const id =
    `backup-${timestamp}-${sha256.slice(0, 10)}-` +
    randomUUID().slice(0, 8);
  const manifest: ControlPlaneBackupManifest = {
    apiVersion: "chartermesh.dev/control-plane-backup/v1alpha1",
    id,
    createdAt,
    reason,
    sha256,
    byteSize: bytes.byteLength,
    schemaVersion: scalar(
      database,
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      "version",
    ),
    workItemCount: scalar(
      database,
      "SELECT COUNT(*) AS count FROM work_items",
      "count",
    ),
    artifacts: artifactRows,
    artifactSetSha256: digest(
      Buffer.from(JSON.stringify(artifactRows), "utf8"),
    ),
  };
  const databasePath = join(backupDirectory, `${id}.db`);
  const manifestPath = join(backupDirectory, `${id}.json`);
  writeFileSync(databasePath, bytes, { flag: "wx", mode: 0o600 });
  try {
    validateControlPlaneDatabase(databasePath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    rmSync(databasePath, { force: true });
    throw new Error(
      `CONTROL_PLANE_BACKUP_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return manifest;
}

export function readControlPlaneBackup(
  backupDirectory: string,
  id: string,
): {
  manifest: ControlPlaneBackupManifest;
  databasePath: string;
  bytes: Buffer;
  artifacts: Array<{
    manifest: ControlPlaneBackupArtifact;
    bytes: Buffer;
  }>;
} {
  assertBackupId(id);
  const manifestPath = join(backupDirectory, `${id}.json`);
  const databasePath = join(backupDirectory, `${id}.db`);
  if (!existsSync(manifestPath) || !existsSync(databasePath)) {
    throw new Error(`Unknown backup '${id}'.`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ControlPlaneBackupManifest;
  if (
    manifest.apiVersion !==
      "chartermesh.dev/control-plane-backup/v1alpha1" ||
    manifest.id !== id ||
    basename(databasePath) !== `${id}.db`
  ) {
    throw new Error("Invalid backup manifest.");
  }
  const bytes = readFileSync(databasePath);
  if (
    bytes.byteLength !== manifest.byteSize ||
    digest(bytes) !== manifest.sha256
  ) {
    throw new Error("CONTROL_PLANE_BACKUP_HASH_MISMATCH");
  }
  validateControlPlaneDatabase(databasePath);
  const artifacts = manifest.artifacts ?? [];
  if (
    manifest.artifactSetSha256 !== undefined &&
    digest(Buffer.from(JSON.stringify(artifacts), "utf8")) !==
      manifest.artifactSetSha256
  ) {
    throw new Error("CONTROL_PLANE_BACKUP_ARTIFACT_SET_HASH_MISMATCH");
  }
  const artifactBytes = artifacts.map((artifact) => {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      artifact.storageName !== `${artifact.sha256}.txt` ||
      !Number.isSafeInteger(artifact.byteSize) ||
      artifact.byteSize < 0
    ) {
      throw new Error("Invalid backup artifact manifest.");
    }
    const value = readFileSync(
      join(backupDirectory, "blobs", artifact.storageName),
    );
    if (
      value.byteLength !== artifact.byteSize ||
      digest(value) !== artifact.sha256
    ) {
      throw new Error("CONTROL_PLANE_BACKUP_ARTIFACT_HASH_MISMATCH");
    }
    return { manifest: artifact, bytes: value };
  });
  return {
    manifest,
    databasePath,
    bytes,
    artifacts: artifactBytes,
  };
}

export function listControlPlaneBackups(
  backupDirectory: string,
): ControlPlaneBackupManifest[] {
  if (!existsSync(backupDirectory)) return [];
  return readdirSync(backupDirectory)
    .filter((name) => /^backup-.+\.json$/u.test(name))
    .flatMap((name) => {
      try {
        const manifest = JSON.parse(
          readFileSync(join(backupDirectory, name), "utf8"),
        ) as ControlPlaneBackupManifest;
        return manifest.apiVersion ===
            "chartermesh.dev/control-plane-backup/v1alpha1" &&
          `${manifest.id}.json` === name
          ? [manifest]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
