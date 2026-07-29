import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface FileTransactionInput {
  path: string;
  content: string | Uint8Array;
  beforeHash: string | null;
  afterHash: string;
}

interface JournalEntry {
  target: string;
  nextPath: string;
  backupPath: string | null;
  beforeHash: string | null;
  afterHash: string;
}

interface FileTransactionJournal {
  apiVersion: "chartermesh.dev/apply-journal/v1alpha1";
  transactionId: string;
  targetRoot: string;
  createdAt: string;
  files: JournalEntry[];
}

export interface RecoveryResult {
  transactionId: string;
  action: "rolled_back" | "finalized";
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertOwnedPath(root: string, path: string, label: string): void {
  if (!isWithin(root, resolve(path))) {
    throw new Error(`${label} '${path}' escapes the target project.`);
  }
}

function durableWrite(
  path: string,
  content: string | Uint8Array,
  exclusive = false,
): void {
  const descriptor = openSync(path, exclusive ? "wx" : "w", 0o600);
  try {
    if (typeof content === "string") {
      writeFileSync(descriptor, content, { encoding: "utf8" });
    } else {
      writeFileSync(descriptor, content);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function lockDirectory(target: string): string {
  return join(target, ".chartermesh", ".apply-lock");
}

function acquireLock(target: string): () => void {
  const root = join(target, ".chartermesh");
  mkdirSync(root, { recursive: true });
  const lock = lockDirectory(target);
  try {
    mkdirSync(lock);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    let owner: { pid?: number } = {};
    try {
      owner = JSON.parse(
        readFileSync(join(lock, "owner.json"), "utf8"),
      ) as { pid?: number };
    } catch {
      // A process may have terminated between the atomic mkdir and owner write.
    }
    const lockAgeMs = Date.now() - statSync(lock).mtimeMs;
    if (
      (owner.pid && processIsAlive(owner.pid)) ||
      (!owner.pid && lockAgeMs < 30_000)
    ) {
      throw new Error(
        `Another CharterMesh apply is active for '${target}'` +
          (owner.pid ? ` (pid ${owner.pid}).` : "."),
      );
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  durableWrite(
    join(lock, "owner.json"),
    `${JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    true,
  );
  return () => rmSync(lock, { recursive: true, force: true });
}

function parseJournal(directory: string): FileTransactionJournal {
  const path = join(directory, "journal.json");
  const journal = JSON.parse(
    readFileSync(path, "utf8"),
  ) as FileTransactionJournal;
  if (
    journal.apiVersion !== "chartermesh.dev/apply-journal/v1alpha1" ||
    !Array.isArray(journal.files) ||
    !journal.transactionId
  ) {
    throw new Error(`Invalid apply journal '${path}'.`);
  }
  return journal;
}

function cleanupTransaction(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

function recoverJournal(
  target: string,
  directory: string,
): RecoveryResult {
  const targetRoot = resolve(target);
  const journal = parseJournal(directory);
  if (resolve(journal.targetRoot) !== targetRoot) {
    throw new Error(
      `Apply journal '${journal.transactionId}' targets another project.`,
    );
  }
  for (const entry of journal.files) {
    assertOwnedPath(targetRoot, entry.target, "Journal target");
    assertOwnedPath(targetRoot, entry.nextPath, "Journal staged path");
    if (entry.backupPath) {
      assertOwnedPath(targetRoot, entry.backupPath, "Journal backup path");
    }
  }

  const committed = existsSync(join(directory, "COMMITTED"));
  if (committed) {
    for (const entry of journal.files) {
      if (
        !existsSync(entry.target) ||
        digestFile(entry.target) !== entry.afterHash
      ) {
        throw new Error(
          `Committed transaction '${journal.transactionId}' has a changed target '${entry.target}'.`,
        );
      }
    }
    cleanupTransaction(directory);
    return { transactionId: journal.transactionId, action: "finalized" };
  }

  for (const entry of [...journal.files].reverse()) {
    const targetExists = existsSync(entry.target);
    const targetHash = targetExists ? digestFile(entry.target) : null;
    const backupExists = Boolean(
      entry.backupPath && existsSync(entry.backupPath),
    );
    if (entry.beforeHash === null) {
      if (targetHash === entry.afterHash) {
        rmSync(entry.target, { force: true });
      } else if (targetExists) {
        throw new Error(
          `Recovery stopped because '${entry.target}' no longer matches the transaction.`,
        );
      }
    } else if (backupExists && entry.backupPath) {
      if (digestFile(entry.backupPath) !== entry.beforeHash) {
        throw new Error(
          `Recovery backup hash mismatch for '${entry.target}'.`,
        );
      }
      if (targetHash === entry.afterHash) {
        rmSync(entry.target, { force: true });
      } else if (targetHash === entry.beforeHash) {
        rmSync(entry.backupPath, { force: true });
        continue;
      } else if (targetExists) {
        throw new Error(
          `Recovery stopped because '${entry.target}' was changed externally.`,
        );
      }
      mkdirSync(dirname(entry.target), { recursive: true });
      renameSync(entry.backupPath, entry.target);
    } else if (targetHash !== entry.beforeHash) {
      throw new Error(
        `Recovery cannot restore '${entry.target}'; its backup is missing.`,
      );
    }
  }
  cleanupTransaction(directory);
  return { transactionId: journal.transactionId, action: "rolled_back" };
}

function recoverUnlocked(target: string): RecoveryResult[] {
  const transactionRoot = join(target, ".chartermesh", ".transactions");
  if (!existsSync(transactionRoot)) return [];
  const results: RecoveryResult[] = [];
  for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(transactionRoot, entry.name);
    if (!existsSync(join(directory, "journal.json"))) {
      cleanupTransaction(directory);
      continue;
    }
    results.push(recoverJournal(target, directory));
  }
  if (readdirSync(transactionRoot).length === 0) {
    rmSync(transactionRoot, { recursive: true, force: true });
  }
  return results;
}

export function recoverFileTransactions(target: string): RecoveryResult[] {
  const resolvedTarget = resolve(target);
  if (
    !existsSync(join(resolvedTarget, ".chartermesh", ".transactions")) &&
    !existsSync(lockDirectory(resolvedTarget))
  ) {
    return [];
  }
  const release = acquireLock(resolvedTarget);
  try {
    return recoverUnlocked(resolvedTarget);
  } finally {
    release();
  }
}

export function applyFileTransaction(
  target: string,
  transactionId: string,
  files: FileTransactionInput[],
): void {
  const resolvedTarget = resolve(target);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(transactionId)) {
    throw new Error("File transaction id contains unsafe characters.");
  }
  const release = acquireLock(resolvedTarget);
  try {
    recoverUnlocked(resolvedTarget);
    for (const file of files) {
      assertOwnedPath(resolvedTarget, file.path, "Transaction target");
      if (file.beforeHash === null && existsSync(file.path)) {
        throw new Error(
          `Target changed after planning: '${file.path}' now exists.`,
        );
      }
      if (file.beforeHash !== null) {
        if (!existsSync(file.path)) {
          throw new Error(
            `Target changed after planning: '${file.path}' was removed.`,
          );
        }
        if (digestFile(file.path) !== file.beforeHash) {
          throw new Error(`Target changed after planning: '${file.path}'.`);
        }
      }
    }
    const changed = files.filter(
      ({ beforeHash, afterHash }) => beforeHash !== afterHash,
    );
    if (changed.length === 0) return;

    const transactionRoot = join(
      resolvedTarget,
      ".chartermesh",
      ".transactions",
    );
    mkdirSync(transactionRoot, { recursive: true });
    const directory = join(transactionRoot, transactionId);
    mkdirSync(directory);
    const entries: JournalEntry[] = changed.map((file, index) => ({
      target: file.path,
      nextPath: join(directory, `${index}.next`),
      backupPath:
        file.beforeHash === null ? null : join(directory, `${index}.before`),
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
    }));
    for (const [index, entry] of entries.entries()) {
      durableWrite(entry.nextPath, changed[index]!.content, true);
      if (digestFile(entry.nextPath) !== entry.afterHash) {
        throw new Error(
          `Staged content hash mismatch for '${entry.target}'.`,
        );
      }
    }
    const journal: FileTransactionJournal = {
      apiVersion: "chartermesh.dev/apply-journal/v1alpha1",
      transactionId,
      targetRoot: resolvedTarget,
      createdAt: new Date().toISOString(),
      files: entries,
    };
    durableWrite(
      join(directory, "journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
      true,
    );

    let renameCount = 0;
    try {
      for (const entry of entries) {
        mkdirSync(dirname(entry.target), { recursive: true });
        if (entry.backupPath) {
          renameSync(entry.target, entry.backupPath);
        }
        renameSync(entry.nextPath, entry.target);
        renameCount += 1;
        if (
          process.env.NODE_ENV === "test" &&
          Number(process.env.CHARTERMESH_TEST_CRASH_AFTER_RENAMES) ===
            renameCount
        ) {
          process.exit(86);
        }
      }
      durableWrite(join(directory, "COMMITTED"), `${transactionId}\n`, true);
      recoverJournal(resolvedTarget, directory);
    } catch (error) {
      recoverJournal(resolvedTarget, directory);
      throw error;
    }
  } finally {
    release();
  }
}
