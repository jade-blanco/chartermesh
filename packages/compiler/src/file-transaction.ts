import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const JOURNAL_API_VERSION = "chartermesh.dev/apply-journal/v1alpha1";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_FILES = 10_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export interface FileTransactionInput {
  path: string;
  content: string | Uint8Array;
  beforeHash: string | null;
  afterHash: string;
}

export interface FileTransactionOptions {
  denyHostControlPaths?: boolean;
}

interface JournalEntry {
  target: string;
  nextPath: string;
  backupPath: string | null;
  beforeHash: string | null;
  afterHash: string;
}

interface FileTransactionJournal {
  apiVersion: typeof JOURNAL_API_VERSION;
  transactionId: string;
  targetRoot: string;
  createdAt: string;
  files: JournalEntry[];
}

export interface RecoveryResult {
  transactionId: string;
  action: "rolled_back" | "finalized";
}

interface NormalizedFileTransactionInput extends FileTransactionInput {
  path: string;
}

function assertTransactionId(transactionId: string): void {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("File transaction id contains unsafe characters.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function assertAbsoluteNormalizedPath(path: unknown, label: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  return path;
}

function digestFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Managed path '${path}' is not a regular file.`);
    }
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      digest.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function readBoundedRegularUtf8(
  root: string,
  path: string,
  label: string,
  maxBytes: number,
): string {
  assertSafeManagedPath(root, path, label);
  const beforeOpen = lstatSync(path);
  if (
    !beforeOpen.isFile() ||
    beforeOpen.isSymbolicLink() ||
    beforeOpen.size > maxBytes
  ) {
    throw new Error(`Invalid or oversized ${label.toLowerCase()} '${path}'.`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(`Invalid or oversized ${label.toLowerCase()} '${path}'.`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total += length;
      if (total > maxBytes) {
        throw new Error(
          `Invalid or oversized ${label.toLowerCase()} '${path}'.`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, length)));
    }
  } finally {
    closeSync(descriptor);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total),
    );
  } catch (error) {
    throw new Error(`${label} '${path}' is not valid UTF-8.`, {
      cause: error,
    });
  }
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

function portableTargetPath(root: string, path: string, label: string): string {
  assertOwnedPath(root, path, label);
  const portable = relative(root, path).replaceAll("\\", "/");
  const segments = portable.split("/");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    portable === "" ||
    segments.some(
      (segment) =>
        segment === "" ||
        /[:\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        reserved.test(segment),
    )
  ) {
    throw new Error(`${label} '${portable}' uses an unsafe portable path alias.`);
  }
  const folded = portable.toLocaleLowerCase("en-US");
  if (
    folded === ".chartermesh/.apply-lock" ||
    folded.startsWith(".chartermesh/.apply-lock/") ||
    folded === ".chartermesh/.transactions" ||
    folded.startsWith(".chartermesh/.transactions/")
  ) {
    throw new Error(`${label} '${portable}' overlaps transaction metadata.`);
  }
  return portable;
}

function assertMutationPolicy(
  root: string,
  path: string,
  options: FileTransactionOptions,
): void {
  if (!options.denyHostControlPaths) return;
  let ancestor = path;
  const missingSegments: string[] = [];
  while (!existsSync(ancestor)) {
    missingSegments.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`Cannot resolve governed target '${path}'.`);
    }
    ancestor = parent;
  }
  assertSafeManagedPath(root, ancestor, "Governed target ancestor");
  const canonicalRoot = realpathSync.native(root);
  const canonicalTarget = join(
    realpathSync.native(ancestor),
    ...missingSegments,
  );
  assertOwnedPath(canonicalRoot, canonicalTarget, "Governed target");
  const portable = relative(canonicalRoot, canonicalTarget).replaceAll(
    "\\",
    "/",
  );
  const protectedSegments = new Set([
    ".git",
    ".chartermesh",
    ".codex",
    ".claude",
  ]);
  const protectedSegment = portable
    .split("/")
    .map((segment) => segment.toLocaleLowerCase("en-US"))
    .find((segment) => protectedSegments.has(segment));
  if (protectedSegment) {
    throw new Error(
      `Governed target '${path}' resolves inside protected host-control path '${protectedSegment}'.`,
    );
  }
}

function normalizeTransactionFiles(
  target: string,
  files: FileTransactionInput[],
  options: FileTransactionOptions = {},
): NormalizedFileTransactionInput[] {
  const normalized = files.map((file) => ({
    path: resolve(file.path),
    content:
      typeof file.content === "string"
        ? file.content
        : new Uint8Array(file.content),
    beforeHash: file.beforeHash,
    afterHash: file.afterHash,
  }));
  const targets = new Set<string>();
  for (const file of normalized) {
    const portable = portableTargetPath(
      target,
      file.path,
      "File transaction target",
    );
    assertMutationPolicy(target, file.path, options);
    const folded = portable.toLocaleLowerCase("en-US");
    if (targets.has(folded)) {
      throw new Error(
        `File transaction contains a duplicate case-folded target '${folded}'.`,
      );
    }
    targets.add(folded);
    if (
      (file.beforeHash !== null && !SHA256_PATTERN.test(file.beforeHash)) ||
      !SHA256_PATTERN.test(file.afterHash)
    ) {
      throw new Error(
        "File transaction hashes must be lowercase SHA-256 digests.",
      );
    }
    const suppliedHash = createHash("sha256")
      .update(file.content)
      .digest("hex");
    if (suppliedHash !== file.afterHash) {
      throw new Error(
        `File transaction content hash does not match afterHash for '${folded}'.`,
      );
    }
  }
  return normalized;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertSafeManagedPath(
  root: string,
  path: string,
  label: string,
): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assertOwnedPath(resolvedRoot, resolvedPath, label);
  const filesystemRoot = parse(resolvedRoot).root;
  const rootWithinFilesystem = relative(filesystemRoot, resolvedRoot);
  const rootComponents = [
    filesystemRoot,
    ...(rootWithinFilesystem === ""
      ? []
      : rootWithinFilesystem.split(sep).map((_, index, segments) =>
          join(filesystemRoot, ...segments.slice(0, index + 1)),
        )),
  ];
  const pathWithinRoot = relative(resolvedRoot, resolvedPath);
  const components = [
    ...rootComponents,
    ...(pathWithinRoot === ""
      ? []
      : pathWithinRoot.split(sep).map((_, index, segments) =>
          join(resolvedRoot, ...segments.slice(0, index + 1)),
        )),
  ];
  for (const [index, component] of components.entries()) {
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(component);
    } catch (error) {
      if (isMissingPath(error)) break;
      throw error;
    }
    // Node reports both Windows symbolic links and junctions through lstat's
    // symbolic-link predicate. Rechecking every existing component avoids a
    // slow external-process probe while covering the path-redirection classes
    // that can escape the approved project root.
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `${label} '${path}' traverses symbolic link, junction, or reparse-point component '${component}'.`,
      );
    }
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new Error(
        `${label} '${path}' traverses non-directory component '${component}'.`,
      );
    }
  }
}

function assertSafeTargetRoot(root: string): void {
  assertSafeManagedPath(root, root, "Target root");
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(`Target root '${root}' does not exist.`);
    }
    throw error;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Target root '${root}' is not a directory.`);
  }
}

function createManagedDirectory(
  root: string,
  path: string,
  recursive: boolean,
): void {
  assertSafeManagedPath(root, path, "Managed directory");
  mkdirSync(path, { recursive });
  assertSafeManagedPath(root, path, "Managed directory");
}

function durableWrite(
  root: string,
  path: string,
  content: string | Uint8Array,
  exclusive = false,
): void {
  // Recheck immediately before opening because planning-time containment alone
  // does not protect against a directory being replaced with a link.
  assertSafeManagedPath(root, path, "Managed write");
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
  createManagedDirectory(target, root, true);
  const lock = lockDirectory(target);
  try {
    createManagedDirectory(target, lock, false);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    assertSafeManagedPath(target, lock, "Apply lock");
    let owner: { pid?: number } = {};
    try {
      owner = JSON.parse(
        readBoundedRegularUtf8(
          target,
          join(lock, "owner.json"),
          "Apply lock owner",
          4 * 1024,
        ),
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
    assertSafeManagedPath(target, lock, "Apply lock removal");
    rmSync(lock, { recursive: true, force: true });
    createManagedDirectory(target, lock, false);
  }
  durableWrite(
    target,
    join(lock, "owner.json"),
    `${JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    true,
  );
  return () => {
    assertSafeManagedPath(target, lock, "Apply lock removal");
    rmSync(lock, { recursive: true, force: true });
  };
}

function parseJournal(
  target: string,
  directory: string,
): FileTransactionJournal {
  const path = join(directory, "journal.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      readBoundedRegularUtf8(
        target,
        path,
        "Apply journal",
        MAX_JOURNAL_BYTES,
      ),
    ) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      /Invalid or oversized apply journal|not valid UTF-8/u.test(error.message)
    ) {
      throw error;
    }
    throw new Error(`Invalid apply journal '${path}'.`, { cause: error });
  }
  if (
    !isRecord(decoded) ||
    !hasExactKeys(decoded, [
      "apiVersion",
      "transactionId",
      "targetRoot",
      "createdAt",
      "files",
    ]) ||
    decoded.apiVersion !== JOURNAL_API_VERSION ||
    typeof decoded.transactionId !== "string" ||
    !TRANSACTION_ID_PATTERN.test(decoded.transactionId) ||
    decoded.transactionId !== basename(directory) ||
    typeof decoded.createdAt !== "string" ||
    decoded.createdAt.length > 64 ||
    !Number.isFinite(Date.parse(decoded.createdAt)) ||
    new Date(decoded.createdAt).toISOString() !== decoded.createdAt ||
    !Array.isArray(decoded.files) ||
    decoded.files.length === 0 ||
    decoded.files.length > MAX_JOURNAL_FILES
  ) {
    throw new Error(`Invalid apply journal '${path}'.`);
  }
  const targetRoot = assertAbsoluteNormalizedPath(
    decoded.targetRoot,
    "Apply journal targetRoot",
  );
  if (targetRoot !== target) {
    throw new Error(
      `Apply journal '${decoded.transactionId}' targets another project.`,
    );
  }
  const transactionRoot = join(target, ".chartermesh", ".transactions");
  if (dirname(directory) !== transactionRoot) {
    throw new Error(`Invalid apply journal directory '${directory}'.`);
  }

  const targets = new Set<string>();
  const files: JournalEntry[] = decoded.files.map((value, index) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "target",
        "nextPath",
        "backupPath",
        "beforeHash",
        "afterHash",
      ])
    ) {
      throw new Error(`Invalid apply journal entry ${index} in '${path}'.`);
    }
    const entryTarget = assertAbsoluteNormalizedPath(
      value.target,
      `Apply journal entry ${index} target`,
    );
    const foldedTarget = portableTargetPath(
      target,
      entryTarget,
      `Apply journal entry ${index} target`,
    ).toLocaleLowerCase("en-US");
    assertSafeManagedPath(
      target,
      entryTarget,
      `Apply journal entry ${index} target`,
    );
    if (targets.has(foldedTarget)) {
      throw new Error(`Invalid duplicate apply journal target '${entryTarget}'.`);
    }
    targets.add(foldedTarget);

    const nextPath = assertAbsoluteNormalizedPath(
      value.nextPath,
      `Apply journal entry ${index} staged path`,
    );
    if (nextPath !== join(directory, `${index}.next`)) {
      throw new Error(`Invalid apply journal staged layout at entry ${index}.`);
    }
    assertSafeManagedPath(
      target,
      nextPath,
      `Apply journal entry ${index} staged path`,
    );
    if (
      value.beforeHash !== null &&
      (typeof value.beforeHash !== "string" ||
        !SHA256_PATTERN.test(value.beforeHash))
    ) {
      throw new Error(`Invalid apply journal beforeHash at entry ${index}.`);
    }
    if (
      typeof value.afterHash !== "string" ||
      !SHA256_PATTERN.test(value.afterHash)
    ) {
      throw new Error(`Invalid apply journal afterHash at entry ${index}.`);
    }
    if (value.beforeHash === value.afterHash) {
      throw new Error(`Invalid unchanged apply journal entry ${index}.`);
    }
    const expectedBackup =
      value.beforeHash === null ? null : join(directory, `${index}.before`);
    if (value.backupPath !== expectedBackup) {
      throw new Error(`Invalid apply journal backup layout at entry ${index}.`);
    }
    if (expectedBackup) {
      assertSafeManagedPath(
        target,
        expectedBackup,
        `Apply journal entry ${index} backup path`,
      );
    }
    return {
      target: entryTarget,
      nextPath,
      backupPath: expectedBackup,
      beforeHash: value.beforeHash,
      afterHash: value.afterHash,
    };
  });
  const journal: FileTransactionJournal = {
    apiVersion: JOURNAL_API_VERSION,
    transactionId: decoded.transactionId,
    targetRoot,
    createdAt: decoded.createdAt,
    files,
  };
  const committedPath = join(directory, "COMMITTED");
  if (
    existsSync(committedPath) &&
    readBoundedRegularUtf8(
      target,
      committedPath,
      "Commit marker",
      256,
    ) !== `${journal.transactionId}\n`
  ) {
    throw new Error(
      `Committed transaction '${journal.transactionId}' has an invalid commit marker.`,
    );
  }
  return journal;
}

function cleanupTransaction(target: string, directory: string): void {
  assertSafeManagedPath(target, directory, "Transaction cleanup");
  rmSync(directory, { recursive: true, force: true });
}

function removeManagedPath(
  target: string,
  path: string,
  options: { recursive?: boolean; force?: boolean } = {},
): void {
  assertSafeManagedPath(target, path, "Managed removal");
  rmSync(path, options);
}

function renameManagedPath(
  target: string,
  source: string,
  destination: string,
): void {
  // Source and destination are both rechecked at the mutation boundary. Node's
  // path API has no portable openat/renameat equivalent, so this narrows rather
  // than mathematically eliminates the remaining race window.
  assertSafeManagedPath(target, source, "Managed rename source");
  assertSafeManagedPath(target, destination, "Managed rename destination");
  renameSync(source, destination);
}

function managedFileHashOrNull(
  target: string,
  path: string,
  label: string,
): string | null {
  assertSafeManagedPath(target, path, label);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} '${path}' is not a regular file.`);
  }
  try {
    return digestFile(path);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function assertStagedAfterImage(
  target: string,
  entry: JournalEntry,
): void {
  if (
    managedFileHashOrNull(
      target,
      entry.nextPath,
      "Transaction staged file",
    ) !== entry.afterHash
  ) {
    throw new Error(`Staged content changed before apply: '${entry.target}'.`);
  }
}

function assertTargetStillPlanned(
  target: string,
  entry: JournalEntry,
): void {
  const currentHash = managedFileHashOrNull(
    target,
    entry.target,
    "Transaction target",
  );
  if (entry.beforeHash === null) {
    if (currentHash !== null) {
      throw new Error(
        `Target changed after planning: '${entry.target}' now exists.`,
      );
    }
    return;
  }
  if (currentHash === null) {
    throw new Error(
      `Target changed after planning: '${entry.target}' was removed.`,
    );
  }
  if (currentHash !== entry.beforeHash) {
    throw new Error(`Target changed after planning: '${entry.target}'.`);
  }
}

function runTestBoundaryEdit(
  target: string,
  ordinal: number,
): void {
  if (
    process.env.NODE_ENV !== "test" ||
    Number(process.env.CHARTERMESH_TEST_EDIT_BEFORE_RENAME) !== ordinal
  ) {
    return;
  }
  const configuredPath = process.env.CHARTERMESH_TEST_EDIT_PATH;
  if (!configuredPath) {
    throw new Error("Missing CHARTERMESH_TEST_EDIT_PATH for test edit hook.");
  }
  const editPath = resolve(configuredPath);
  portableTargetPath(target, editPath, "Test edit target");
  assertSafeManagedPath(target, editPath, "Test edit target");
  writeFileSync(
    editPath,
    process.env.CHARTERMESH_TEST_EDIT_CONTENT ?? "external edit\n",
    "utf8",
  );
}

function assertJournalMatchesExpectedFiles(
  journal: FileTransactionJournal,
  expectedFiles: NormalizedFileTransactionInput[],
): void {
  const changed = expectedFiles.filter(
    ({ beforeHash, afterHash }) => beforeHash !== afterHash,
  );
  if (journal.files.length !== changed.length) {
    throw new Error(
      `Apply journal '${journal.transactionId}' does not match the approved file set.`,
    );
  }
  for (const [index, entry] of journal.files.entries()) {
    const expected = changed[index]!;
    if (
      entry.target !== expected.path ||
      entry.beforeHash !== expected.beforeHash ||
      entry.afterHash !== expected.afterHash
    ) {
      throw new Error(
        `Apply journal '${journal.transactionId}' does not match the approved file set.`,
      );
    }
  }
}

function recoverJournal(
  target: string,
  directory: string,
  expectedFiles?: NormalizedFileTransactionInput[],
  options: FileTransactionOptions = {},
): RecoveryResult {
  const targetRoot = resolve(target);
  assertSafeManagedPath(targetRoot, directory, "Transaction directory");
  const journal = parseJournal(targetRoot, directory);
  if (expectedFiles) {
    assertJournalMatchesExpectedFiles(journal, expectedFiles);
  }
  if (resolve(journal.targetRoot) !== targetRoot) {
    throw new Error(
      `Apply journal '${journal.transactionId}' targets another project.`,
    );
  }
  for (const entry of journal.files) {
    assertOwnedPath(targetRoot, entry.target, "Journal target");
    assertOwnedPath(targetRoot, entry.nextPath, "Journal staged path");
    assertSafeManagedPath(targetRoot, entry.target, "Journal target");
    assertSafeManagedPath(
      targetRoot,
      entry.nextPath,
      "Journal staged path",
    );
    if (entry.backupPath) {
      assertOwnedPath(targetRoot, entry.backupPath, "Journal backup path");
      assertSafeManagedPath(
        targetRoot,
        entry.backupPath,
        "Journal backup path",
      );
    }
  }

  const committedPath = join(directory, "COMMITTED");
  assertSafeManagedPath(targetRoot, committedPath, "Commit marker");
  const committed = existsSync(committedPath);
  if (committed) {
    const marker = readBoundedRegularUtf8(
      targetRoot,
      committedPath,
      "Commit marker",
      256,
    );
    if (marker !== `${journal.transactionId}\n`) {
      throw new Error(
        `Committed transaction '${journal.transactionId}' has an invalid commit marker.`,
      );
    }
    for (const entry of journal.files) {
      if (
        managedFileHashOrNull(
          targetRoot,
          entry.target,
          "Committed transaction target",
        ) !== entry.afterHash
      ) {
        throw new Error(
          `Committed transaction '${journal.transactionId}' has a changed target '${entry.target}'.`,
        );
      }
    }
    cleanupTransaction(targetRoot, directory);
    return { transactionId: journal.transactionId, action: "finalized" };
  }

  for (const entry of [...journal.files].reverse()) {
    assertMutationPolicy(targetRoot, entry.target, options);
    const stagedHash = managedFileHashOrNull(
      targetRoot,
      entry.nextPath,
      "Recovery staged file",
    );
    if (stagedHash !== null && stagedHash !== entry.afterHash) {
      throw new Error(
        `Recovery staged hash mismatch for '${entry.target}'.`,
      );
    }
    const targetHash = managedFileHashOrNull(
      targetRoot,
      entry.target,
      "Recovery target",
    );
    const backupHash = entry.backupPath
      ? managedFileHashOrNull(
          targetRoot,
          entry.backupPath,
          "Recovery backup",
        )
      : null;
    if (entry.beforeHash === null) {
      if (stagedHash === null && targetHash === entry.afterHash) {
        removeManagedPath(targetRoot, entry.target, { force: true });
      }
      // A different target (or an external deletion) is not ours to undo.
      // Preserve it and continue rolling back earlier transaction effects.
    } else if (backupHash !== null && entry.backupPath) {
      if (backupHash !== entry.beforeHash) {
        throw new Error(
          `Recovery backup hash mismatch for '${entry.target}'.`,
        );
      }
      if (targetHash === entry.afterHash) {
        removeManagedPath(targetRoot, entry.target, { force: true });
      } else if (targetHash === entry.beforeHash) {
        removeManagedPath(targetRoot, entry.backupPath, { force: true });
        continue;
      } else if (targetHash !== null) {
        // The transaction has a valid backup but an external writer replaced
        // the target. Keep the external value, discard our backup during
        // transaction cleanup, and continue rolling back earlier entries.
        continue;
      }
      createManagedDirectory(
        targetRoot,
        dirname(entry.target),
        true,
      );
      renameManagedPath(targetRoot, entry.backupPath, entry.target);
    } else if (
      stagedHash === null &&
      (targetHash === entry.afterHash || targetHash === null)
    ) {
      // A processed replacement must have a valid backup. Do not remove an
      // after-image or recreate a deleted file when restoration is impossible.
      throw new Error(`Recovery cannot restore '${entry.target}'; its backup is missing.`);
    }
    // With no backup and a non-null target that differs from afterHash, the
    // entry was never mutated by us (or was externally edited). Preserve it.
  }
  cleanupTransaction(targetRoot, directory);
  return { transactionId: journal.transactionId, action: "rolled_back" };
}

function recoverUnlocked(target: string): RecoveryResult[] {
  const transactionRoot = join(target, ".chartermesh", ".transactions");
  assertSafeManagedPath(target, transactionRoot, "Transaction root");
  if (!existsSync(transactionRoot)) return [];
  const directories: string[] = [];
  for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
    if (!TRANSACTION_ID_PATTERN.test(entry.name)) {
      throw new Error(
        `Transaction directory '${entry.name}' has an unsafe name.`,
      );
    }
    const directory = join(transactionRoot, entry.name);
    assertSafeManagedPath(target, directory, "Transaction directory");
    if (!entry.isDirectory()) {
      throw new Error(`Transaction entry '${directory}' is not a directory.`);
    }
    if (!existsSync(join(directory, "journal.json"))) {
      throw new Error(`Transaction directory '${directory}' has no journal.`);
    }
    // Validate every journal before recovering any transaction so a crafted
    // sibling directory cannot cause partial all-recovery side effects.
    parseJournal(target, directory);
    directories.push(directory);
  }
  const results = directories.map((directory) =>
    recoverJournal(target, directory),
  );
  if (readdirSync(transactionRoot).length === 0) {
    removeManagedPath(target, transactionRoot, {
      recursive: true,
      force: true,
    });
  }
  return results;
}

function recoverExactUnlocked(
  target: string,
  transactionId: string,
  expectedFiles: NormalizedFileTransactionInput[],
  options: FileTransactionOptions,
): RecoveryResult | null {
  const transactionRoot = join(target, ".chartermesh", ".transactions");
  assertSafeManagedPath(target, transactionRoot, "Transaction root");
  if (!existsSync(transactionRoot)) return null;
  for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
    if (!TRANSACTION_ID_PATTERN.test(entry.name)) {
      throw new Error(
        `Transaction directory '${entry.name}' has an unsafe name.`,
      );
    }
    const candidate = join(transactionRoot, entry.name);
    assertSafeManagedPath(target, candidate, "Transaction directory");
    if (!entry.isDirectory()) {
      throw new Error(`Transaction entry '${candidate}' is not a directory.`);
    }
    if (entry.name !== transactionId) {
      throw new Error(
        `Unrelated pending transaction '${entry.name}' must be recovered explicitly before '${transactionId}'.`,
      );
    }
  }
  const directory = join(transactionRoot, transactionId);
  assertSafeManagedPath(target, directory, "Transaction directory");
  if (!existsSync(directory)) return null;
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Transaction entry '${directory}' is not a directory.`);
  }
  if (!existsSync(join(directory, "journal.json"))) {
    throw new Error(`Transaction directory '${directory}' has no journal.`);
  }
  const result = recoverJournal(
    target,
    directory,
    expectedFiles,
    options,
  );
  if (
    existsSync(transactionRoot) &&
    readdirSync(transactionRoot).length === 0
  ) {
    removeManagedPath(target, transactionRoot, {
      recursive: true,
      force: true,
    });
  }
  return result;
}

export function recoverFileTransactions(target: string): RecoveryResult[] {
  const resolvedTarget = resolve(target);
  assertSafeTargetRoot(resolvedTarget);
  assertSafeManagedPath(
    resolvedTarget,
    join(resolvedTarget, ".chartermesh", ".transactions"),
    "Transaction root",
  );
  assertSafeManagedPath(
    resolvedTarget,
    lockDirectory(resolvedTarget),
    "Apply lock",
  );
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

export function recoverFileTransaction(
  target: string,
  transactionId: string,
  files: FileTransactionInput[],
  options: FileTransactionOptions = {},
): RecoveryResult | null {
  const resolvedTarget = resolve(target);
  assertSafeTargetRoot(resolvedTarget);
  assertTransactionId(transactionId);
  const normalizedFiles = normalizeTransactionFiles(
    resolvedTarget,
    files,
    options,
  );
  const directory = join(
    resolvedTarget,
    ".chartermesh",
    ".transactions",
    transactionId,
  );
  assertSafeManagedPath(resolvedTarget, directory, "Transaction directory");
  if (
    !existsSync(directory) &&
    !existsSync(lockDirectory(resolvedTarget))
  ) {
    return null;
  }
  const release = acquireLock(resolvedTarget);
  try {
    return recoverExactUnlocked(
      resolvedTarget,
      transactionId,
      normalizedFiles,
      options,
    );
  } finally {
    release();
  }
}

export function applyFileTransaction(
  target: string,
  transactionId: string,
  files: FileTransactionInput[],
  options: FileTransactionOptions = {},
): void {
  const resolvedTarget = resolve(target);
  assertSafeTargetRoot(resolvedTarget);
  assertTransactionId(transactionId);
  const normalizedFiles = normalizeTransactionFiles(
    resolvedTarget,
    files,
    options,
  );
  const release = acquireLock(resolvedTarget);
  try {
    recoverExactUnlocked(
      resolvedTarget,
      transactionId,
      normalizedFiles,
      options,
    );
    const changed = normalizedFiles.filter(
      ({ beforeHash, afterHash }) => beforeHash !== afterHash,
    );
    if (changed.length === 0) return;

    const transactionRoot = join(
      resolvedTarget,
      ".chartermesh",
      ".transactions",
    );
    createManagedDirectory(resolvedTarget, transactionRoot, true);
    const directory = join(transactionRoot, transactionId);
    createManagedDirectory(resolvedTarget, directory, false);
    const entries: JournalEntry[] = changed.map((file, index) => ({
      target: file.path,
      nextPath: join(directory, `${index}.next`),
      backupPath:
        file.beforeHash === null ? null : join(directory, `${index}.before`),
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
    }));
    for (const [index, entry] of entries.entries()) {
      durableWrite(
        resolvedTarget,
        entry.nextPath,
        changed[index]!.content,
        true,
      );
      if (digestFile(entry.nextPath) !== entry.afterHash) {
        throw new Error(
          `Staged content hash mismatch for '${entry.target}'.`,
        );
      }
    }
    const journal: FileTransactionJournal = {
      apiVersion: JOURNAL_API_VERSION,
      transactionId,
      targetRoot: resolvedTarget,
      createdAt: new Date().toISOString(),
      files: entries,
    };
    durableWrite(
      resolvedTarget,
      join(directory, "journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
      true,
    );

    let renameCount = 0;
    try {
      for (const [index, entry] of entries.entries()) {
        createManagedDirectory(
          resolvedTarget,
          dirname(entry.target),
          true,
        );
        runTestBoundaryEdit(resolvedTarget, index + 1);
        assertMutationPolicy(resolvedTarget, entry.target, options);
        // Recheck the approved precondition and staged after-image at the
        // mutation boundary, after all staging and journal writes.
        assertTargetStillPlanned(resolvedTarget, entry);
        assertStagedAfterImage(resolvedTarget, entry);
        if (entry.backupPath) {
          assertMutationPolicy(resolvedTarget, entry.target, options);
          renameManagedPath(
            resolvedTarget,
            entry.target,
            entry.backupPath,
          );
          if (
            managedFileHashOrNull(
              resolvedTarget,
              entry.backupPath,
              "Transaction backup",
            ) !== entry.beforeHash
          ) {
            throw new Error(
              `Transaction backup changed before replacement: '${entry.target}'.`,
            );
          }
        }
        // The destination must still be absent immediately before installing
        // the staged file. This also detects an edit racing the backup rename.
        if (
          managedFileHashOrNull(
            resolvedTarget,
            entry.target,
            "Transaction target",
          ) !== null
        ) {
          throw new Error(
            `Target changed during replacement: '${entry.target}'.`,
          );
        }
        assertStagedAfterImage(resolvedTarget, entry);
        assertMutationPolicy(resolvedTarget, entry.target, options);
        renameManagedPath(resolvedTarget, entry.nextPath, entry.target);
        renameCount += 1;
        if (
          process.env.NODE_ENV === "test" &&
          Number(process.env.CHARTERMESH_TEST_CRASH_AFTER_RENAMES) ===
            renameCount
        ) {
          process.exit(86);
        }
      }
      durableWrite(
        resolvedTarget,
        join(directory, "COMMITTED"),
        `${transactionId}\n`,
        true,
      );
      recoverJournal(resolvedTarget, directory);
    } catch (error) {
      recoverJournal(resolvedTarget, directory);
      throw error;
    }
  } finally {
    release();
  }
}
