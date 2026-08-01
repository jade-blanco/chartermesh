import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import type { CodeCandidate } from "./candidate.ts";
import {
  validateCodeEvaluationProvenance,
  type CodeEvaluationProvenance,
} from "./provenance.ts";
import type {
  CodeEvaluationTask,
  CodeTestCase,
} from "./suite.ts";
import type {
  CodeCaseResult,
  CodeSandboxBackend,
  CodeSandboxJob,
  CodeSandboxProbe,
  CodeSandboxRunOptions,
  CodeSandboxRunResult,
} from "./sandbox.ts";
import { requireSafeSandbox } from "./sandbox.ts";

const execFileAsync = promisify(execFile);
const MAX_RESULT_BYTES = 1_048_576;
const MAX_OUTPUT_TREE_BYTES = 8_388_608;
const MAX_OUTPUT_TREE_ENTRIES = 512;
const MAX_OUTPUT_TREE_DEPTH = 8;
export const PROGRAM_OUTPUT_LIMIT_BYTES = 131_072;
const MAX_AUTHENTICATED_PAYLOAD_BYTES = 98_304;
const MAX_SESSION_JOURNAL_BYTES = 4_096;
const SESSION_JOURNAL_API_VERSION =
  "chartermesh.dev/windows-sandbox-session/v1alpha1";
const UUID_PATTERN =
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const OWNER_NONCE_PATTERN = /^[a-f0-9]{32}$/u;

function sandboxAbortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ?? new Error("CODE_SANDBOX_EVALUATION_CANCELED")
  );
}

function throwIfSandboxAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw sandboxAbortReason(signal);
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSandboxAborted(signal);
  if (!signal) {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, milliseconds),
    );
    return;
  }
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const complete = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveDelay();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rejectDelay(sandboxAbortReason(signal));
    };
    const timer = setTimeout(complete, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function bundledSandboxScript(name: string): string {
  const sourcePath = fileURLToPath(
    new URL(
      `../../../../scripts/windows-sandbox/${name}`,
      import.meta.url,
    ),
  );
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(
    new URL(
      `../../../../../scripts/windows-sandbox/${name}`,
      import.meta.url,
    ),
  );
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function windowsSandboxConfiguration(paths: {
  input: string;
  output: string;
  runtime: string;
  command?: string;
}): string {
  return [
    "<Configuration>",
    "  <VGpu>Disable</VGpu>",
    "  <Networking>Disable</Networking>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <MemoryInMB>4096</MemoryInMB>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${xml(paths.input)}</HostFolder>`,
    "      <SandboxFolder>C:\\CharterMesh\\Input</SandboxFolder>",
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    `      <HostFolder>${xml(paths.output)}</HostFolder>`,
    "      <SandboxFolder>C:\\CharterMesh\\Output</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    `      <HostFolder>${xml(paths.runtime)}</HostFolder>`,
    "      <SandboxFolder>C:\\CharterMesh\\Runtime</SandboxFolder>",
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>${xml(paths.command ?? "cmd.exe /d /c C:\\CharterMesh\\Input\\run-evaluation.cmd")}</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
  ].join("\n");
}

interface GuestCaseResult {
  jobId: string;
  id: string;
  exitCode: number | null;
  signal?: string | null;
  launchError?: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stdoutHash: string;
  stderrHash: string;
  stdoutBytes: number;
  stderrBytes: number;
}

type CandidateEnvelope =
  | {
      kind: "return";
      value: unknown;
      inputMutated: boolean;
    }
  | {
      kind: "throw";
      errorCode: string;
      inputMutated: boolean;
    };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseAuthenticatedCandidateEnvelope(
  stdout: string,
): CandidateEnvelope | null {
  const lines = stdout.split(/\r?\n/u);
  const handshake = /^@@CHARTERMESH_HANDSHAKE_V1@@:([a-f0-9]{32}):([a-f0-9]{64})$/u.exec(
    lines[0] ?? "",
  );
  if (!handshake) return null;
  const [, sessionId, secretHex] = handshake;
  const secret = Buffer.from(secretHex!, "hex");
  const valid: CandidateEnvelope[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@CHARTERMESH_HANDSHAKE_")) return null;
    const result = /^@@CHARTERMESH_RESULT_V1@@:([a-f0-9]{32}):([A-Za-z0-9_-]+):([a-f0-9]{64})$/u.exec(
      line,
    );
    if (!result) {
      if (line.length === 0) continue;
      return null;
    }
    if (result[1] !== sessionId || valid.length > 0) return null;
    const payload = Buffer.from(result[2]!, "base64url");
    if (
      payload.byteLength > MAX_AUTHENTICATED_PAYLOAD_BYTES ||
      payload.toString("base64url") !== result[2]
    ) {
      return null;
    }
    const expected = createHmac("sha256", secret)
      .update(result[2]!)
      .digest();
    const received = Buffer.from(result[3]!, "hex");
    if (
      expected.byteLength !== received.byteLength ||
      !timingSafeEqual(expected, received)
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(payload.toString("utf8")) as unknown;
      const record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const keys = record ? Object.keys(record).sort() : [];
      const expectedKeys =
        record?.kind === "return"
          ? ["inputMutated", "kind", "value"]
          : ["errorCode", "inputMutated", "kind"];
      if (
        !record ||
        !["return", "throw"].includes(String(record.kind)) ||
        !isDeepStrictEqual(keys, expectedKeys) ||
        typeof record.inputMutated !== "boolean" ||
        (record.kind === "throw" &&
          (typeof record.errorCode !== "string" ||
            record.errorCode.length < 1 ||
            record.errorCode.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(record.errorCode)))
      ) {
        return null;
      }
      valid.push(parsed as CandidateEnvelope);
    } catch {
      return null;
    }
  }
  return valid.length === 1 ? valid[0]! : null;
}

async function boundedReadJson(
  path: string,
  allowedRoot: string,
): Promise<unknown> {
  const rootPath = await realpath(allowedRoot);
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > MAX_RESULT_BYTES
  ) {
    throw new Error("SANDBOX_RESULT_LIMIT");
  }
  const resolvedPath = await realpath(path);
  const normalizedRoot = rootPath.toLowerCase();
  const normalizedPath = resolvedPath.toLowerCase();
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error("SANDBOX_RESULT_PATH_ESCAPE");
  }
  const handle = await open(resolvedPath, "r");
  try {
    const handleInfo = await handle.stat();
    const after = await lstat(path);
    const resolvedAfter = await realpath(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !handleInfo.isFile() ||
      handleInfo.size > MAX_RESULT_BYTES ||
      handleInfo.dev !== after.dev ||
      handleInfo.ino !== after.ino ||
      resolvedAfter.toLowerCase() !== normalizedPath
    ) {
      throw new Error("SANDBOX_RESULT_PATH_RACE");
    }
    return JSON.parse(
      await handle.readFile({ encoding: "utf8" }),
    ) as unknown;
  } finally {
    await handle.close();
  }
}

export async function inspectSandboxOutputTree(
  root: string,
): Promise<{ paths: string[]; bytes: number }> {
  const paths: string[] = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (
    directory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_OUTPUT_TREE_DEPTH) {
      throw new Error("SANDBOX_OUTPUT_TREE_DEPTH_LIMIT");
    }
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    })) {
      entries += 1;
      if (entries > MAX_OUTPUT_TREE_ENTRIES) {
        throw new Error("SANDBOX_OUTPUT_TREE_ENTRY_LIMIT");
      }
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1).replaceAll("\\", "/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error("SANDBOX_OUTPUT_LINK");
      }
      if (info.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error("SANDBOX_OUTPUT_SPECIAL_FILE");
      bytes += info.size;
      if (bytes > MAX_OUTPUT_TREE_BYTES) {
        throw new Error("SANDBOX_OUTPUT_TREE_LIMIT");
      }
      paths.push(relative);
    }
  };
  await visit(root, 0);
  return { paths: paths.sort(), bytes };
}

export async function stageNodeRuntime(
  runtimeExecutable: string,
  root: string,
  expectedSha256: string,
): Promise<string> {
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  await stageProvenanceFile(
    runtimeExecutable,
    join(runtime, "node.exe"),
    expectedSha256,
  );
  return runtime;
}

export interface StagedProvenanceFile {
  path: string;
  sha256: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COPY_BUFFER_BYTES = 1_048_576;

async function hashFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), bytes: position };
}

async function stableFileIdentity(
  path: string,
): Promise<{
  resolved: string;
  dev: number | bigint;
  ino: number | bigint;
  size: number;
}> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("SANDBOX_PROVENANCE_FILE_INVALID");
  }
  return {
    resolved: await realpath(path),
    dev: info.dev,
    ino: info.ino,
    size: info.size,
  };
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof stableFileIdentity>>,
  right: Awaited<ReturnType<typeof stableFileIdentity>>,
): boolean {
  return (
    left.resolved.toLowerCase() === right.resolved.toLowerCase() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

export interface WindowsSandboxLauncherAttestation {
  resolved: string;
  dev: number | bigint;
  ino: number | bigint;
  size: number;
}

export async function attestWindowsSandboxLauncher(
  path: string,
  expectedSha256: string,
  previous?: WindowsSandboxLauncherAttestation,
): Promise<WindowsSandboxLauncherAttestation> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("SANDBOX_WSB_PROVENANCE_HASH_INVALID");
  }
  if (!isAbsolute(path)) {
    throw new Error("SANDBOX_WSB_PROVENANCE_PATH_NOT_ABSOLUTE");
  }
  const absolutePath = resolve(path);
  const before = await stableFileIdentity(absolutePath);
  // GitHub's Windows runners and some managed Windows installations expose
  // workspace ancestors through directory junctions. Pin the fully resolved
  // file identity instead of rejecting a stable ancestor alias. A link at the
  // launcher itself is still rejected by stableFileIdentity, and the
  // before/open/after identity plus expected digest detect retargeting.
  if (previous && !sameFileIdentity(previous, before)) {
    throw new Error("SANDBOX_WSB_PROVENANCE_IDENTITY_CHANGED");
  }
  const handle = await open(before.resolved, "r");
  try {
    const opened = await handle.stat();
    const digest = await hashFileHandle(handle);
    const after = await stableFileIdentity(absolutePath);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      digest.bytes !== opened.size ||
      !sameFileIdentity(before, after)
    ) {
      throw new Error("SANDBOX_WSB_PROVENANCE_RACE");
    }
    if (digest.sha256 !== expectedSha256) {
      throw new Error("SANDBOX_WSB_PROVENANCE_HASH_MISMATCH");
    }
    return before;
  } finally {
    await handle.close();
  }
}

interface WindowsSandboxExecutionOptions {
  timeout: number;
  windowsHide: boolean;
  signal?: AbortSignal;
}

type WindowsSandboxProcessExecutor = (
  executable: string,
  args: string[],
  options: WindowsSandboxExecutionOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export async function executeAttestedWindowsSandboxLauncher(input: {
  executable: string;
  expectedSha256?: string;
  args: string[];
  options: WindowsSandboxExecutionOptions;
  executeFile?: WindowsSandboxProcessExecutor;
}): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const before = input.expectedSha256 !== undefined
    ? await attestWindowsSandboxLauncher(
        input.executable,
        input.expectedSha256,
      )
    : undefined;
  try {
    return await (input.executeFile ?? execFileAsync)(
      before?.resolved ?? input.executable,
      input.args,
      input.options,
    );
  } finally {
    if (before && input.expectedSha256 !== undefined) {
      await attestWindowsSandboxLauncher(
        input.executable,
        input.expectedSha256,
        before,
      );
    }
  }
}

export interface WindowsSandboxSessionJournalRecord {
  apiVersion: typeof SESSION_JOURNAL_API_VERSION;
  sandboxId: string;
  ownerPid: number;
  ownerNonce: string;
  createdAtMs: number;
  launcherSha256: string | null;
  checksum: string;
}

type WindowsSandboxSessionJournalPayload = Omit<
  WindowsSandboxSessionJournalRecord,
  "checksum"
>;

function sessionJournalPayload(
  input: Omit<
    WindowsSandboxSessionJournalPayload,
    "apiVersion"
  >,
): WindowsSandboxSessionJournalPayload {
  return {
    apiVersion: SESSION_JOURNAL_API_VERSION,
    sandboxId: input.sandboxId,
    ownerPid: input.ownerPid,
    ownerNonce: input.ownerNonce,
    createdAtMs: input.createdAtMs,
    launcherSha256: input.launcherSha256,
  };
}

function sessionJournalChecksum(
  payload: WindowsSandboxSessionJournalPayload,
): string {
  return sha256(JSON.stringify(payload));
}

export function createWindowsSandboxSessionJournal(
  input: Omit<
    WindowsSandboxSessionJournalPayload,
    "apiVersion"
  >,
): WindowsSandboxSessionJournalRecord {
  const payload = sessionJournalPayload(input);
  // Validate values through the same parser used after a crash. This keeps
  // the on-disk recovery contract narrower than the constructor's types.
  return parseWindowsSandboxSessionJournal(
    `${JSON.stringify({
      ...payload,
      checksum: sessionJournalChecksum(payload),
    })}\n`,
    input.launcherSha256 ?? undefined,
  );
}

export function parseWindowsSandboxSessionJournal(
  raw: string,
  expectedLauncherSha256?: string,
): WindowsSandboxSessionJournalRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_SESSION_JOURNAL_BYTES) {
    throw new Error("SANDBOX_SESSION_JOURNAL_LIMIT");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SANDBOX_SESSION_JOURNAL_INVALID");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "apiVersion",
      "sandboxId",
      "ownerPid",
      "ownerNonce",
      "createdAtMs",
      "launcherSha256",
      "checksum",
    ]) ||
    value.apiVersion !== SESSION_JOURNAL_API_VERSION ||
    typeof value.sandboxId !== "string" ||
    !UUID_PATTERN.test(value.sandboxId) ||
    typeof value.ownerPid !== "number" ||
    !Number.isSafeInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    value.ownerPid > 4_294_967_295 ||
    typeof value.ownerNonce !== "string" ||
    !OWNER_NONCE_PATTERN.test(value.ownerNonce) ||
    typeof value.createdAtMs !== "number" ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 1 ||
    !(
      value.launcherSha256 === null ||
      (typeof value.launcherSha256 === "string" &&
        SHA256_PATTERN.test(value.launcherSha256))
    ) ||
    typeof value.checksum !== "string" ||
    !SHA256_PATTERN.test(value.checksum)
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_INVALID");
  }
  const record = value as unknown as WindowsSandboxSessionJournalRecord;
  const payload = sessionJournalPayload({
    sandboxId: record.sandboxId,
    ownerPid: record.ownerPid,
    ownerNonce: record.ownerNonce,
    createdAtMs: record.createdAtMs,
    launcherSha256: record.launcherSha256,
  });
  if (record.checksum !== sessionJournalChecksum(payload)) {
    throw new Error("SANDBOX_SESSION_JOURNAL_CHECKSUM_MISMATCH");
  }
  const expectedLauncher = expectedLauncherSha256 ?? null;
  if (record.launcherSha256 !== expectedLauncher) {
    throw new Error("SANDBOX_SESSION_JOURNAL_LAUNCHER_MISMATCH");
  }
  return { ...record };
}

interface StableSessionJournal {
  record: WindowsSandboxSessionJournalRecord;
  resolved: string;
  dev: number | bigint;
  ino: number | bigint;
  size: number;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function validatedSessionJournalPath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error("SANDBOX_SESSION_JOURNAL_PATH_NOT_ABSOLUTE");
  }
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const before = await lstat(parent);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("SANDBOX_SESSION_JOURNAL_PARENT_INVALID");
  }
  const resolvedParent = await realpath(parent);
  const after = await lstat(parent);
  const resolved = await lstat(resolvedParent);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    resolved.isSymbolicLink() ||
    !resolved.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.dev !== resolved.dev ||
    before.ino !== resolved.ino
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_PARENT_REDIRECT");
  }
  // Continue through the canonical parent. This supports stable Windows
  // runner junctions while preventing retargeting of the original alias from
  // changing the ensuing filesystem operation. The journal entry itself is
  // separately required to be a regular, identity-stable file and is never
  // removed recursively.
  return join(resolvedParent, basename(absolutePath));
}

async function readWindowsSandboxSessionJournal(
  path: string,
  expectedLauncherSha256?: string,
): Promise<StableSessionJournal | null> {
  const absolutePath = await validatedSessionJournalPath(path);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(absolutePath);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 1 ||
    before.size > MAX_SESSION_JOURNAL_BYTES
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_FILE_INVALID");
  }
  const resolvedPath = await realpath(absolutePath);
  if (resolvedPath.toLowerCase() !== absolutePath.toLowerCase()) {
    throw new Error("SANDBOX_SESSION_JOURNAL_PATH_REDIRECT");
  }
  const handle = await open(absolutePath, "r");
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(absolutePath);
    const resolvedAfter = await realpath(absolutePath);
    if (
      !opened.isFile() ||
      opened.size !== bytes.byteLength ||
      bytes.byteLength > MAX_SESSION_JOURNAL_BYTES ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      resolvedAfter.toLowerCase() !== resolvedPath.toLowerCase()
    ) {
      throw new Error("SANDBOX_SESSION_JOURNAL_RACE");
    }
    return {
      record: parseWindowsSandboxSessionJournal(
        bytes.toString("utf8"),
        expectedLauncherSha256,
      ),
      resolved: resolvedPath,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
    };
  } finally {
    await handle.close();
  }
}

export async function persistWindowsSandboxSessionJournal(
  path: string,
  record: WindowsSandboxSessionJournalRecord,
): Promise<void> {
  const absolutePath = await validatedSessionJournalPath(path);
  const validated = parseWindowsSandboxSessionJournal(
    `${JSON.stringify(record)}\n`,
    record.launcherSha256 ?? undefined,
  );
  const serialized = `${JSON.stringify(validated)}\n`;
  const temporary = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // A hard link publishes the completely flushed inode and, unlike
      // rename on Windows, cannot replace an existing live journal.
      await link(temporary, absolutePath);
    } catch (error) {
      if (filesystemErrorCode(error) === "EEXIST") {
        throw new Error("SANDBOX_SESSION_JOURNAL_BUSY");
      }
      throw error;
    }
    const observed = await readWindowsSandboxSessionJournal(
      absolutePath,
      record.launcherSha256 ?? undefined,
    );
    if (
      !observed ||
      !isDeepStrictEqual(observed.record, validated)
    ) {
      throw new Error("SANDBOX_SESSION_JOURNAL_PERSIST_FAILED");
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearWindowsSandboxSessionJournal(
  path: string,
  expected: WindowsSandboxSessionJournalRecord,
): Promise<void> {
  const observed = await readWindowsSandboxSessionJournal(
    path,
    expected.launcherSha256 ?? undefined,
  );
  if (
    !observed ||
    !isDeepStrictEqual(observed.record, expected)
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_CHANGED");
  }
  const immediatelyBefore = await lstat(observed.resolved);
  if (
    immediatelyBefore.isSymbolicLink() ||
    !immediatelyBefore.isFile() ||
    immediatelyBefore.dev !== observed.dev ||
    immediatelyBefore.ino !== observed.ino ||
    immediatelyBefore.size !== observed.size
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_RACE");
  }
  // Never recurse here: the journal contains no filesystem path and a
  // substituted directory or link must not become a deletion target.
  await unlink(observed.resolved);
}

function processAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return filesystemErrorCode(error) !== "ESRCH";
  }
}

export async function recoverWindowsSandboxSessionJournal(options: {
  path: string;
  expectedLauncherSha256?: string;
  currentOwnerNonce: string;
  recoverableOwnedSandboxId?: string;
  stopAndAttest: (sandboxId: string) => Promise<void>;
  ownerAppearsAlive?: (pid: number) => boolean | Promise<boolean>;
}): Promise<string | null> {
  if (!OWNER_NONCE_PATTERN.test(options.currentOwnerNonce)) {
    throw new Error("SANDBOX_SESSION_JOURNAL_OWNER_INVALID");
  }
  const observed = await readWindowsSandboxSessionJournal(
    options.path,
    options.expectedLauncherSha256,
  );
  if (!observed) return null;
  const ownedByCaller =
    observed.record.ownerNonce === options.currentOwnerNonce;
  if (
    (ownedByCaller &&
      observed.record.sandboxId !==
        options.recoverableOwnedSandboxId) ||
    (!ownedByCaller &&
      (await (options.ownerAppearsAlive ?? processAppearsAlive)(
        observed.record.ownerPid,
      )))
  ) {
    throw new Error("SANDBOX_SESSION_JOURNAL_BUSY");
  }
  // stopAndAttest must include both the stop request and a structured `list`
  // observation proving that this exact ID is absent or stopped.
  await options.stopAndAttest(observed.record.sandboxId);
  await clearWindowsSandboxSessionJournal(
    options.path,
    observed.record,
  );
  return observed.record.sandboxId;
}

export async function stageProvenanceFile(
  source: string,
  destination: string,
  expectedSha256: string,
): Promise<StagedProvenanceFile> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("SANDBOX_PROVENANCE_HASH_INVALID");
  }
  const before = await stableFileIdentity(source);
  const sourceHandle = await open(before.resolved, "r");
  let destinationHandle:
    | Awaited<ReturnType<typeof open>>
    | undefined;
  let destinationCreated = false;
  try {
    const opened = await sourceHandle.stat();
    const afterOpen = await stableFileIdentity(source);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !sameFileIdentity(before, afterOpen)
    ) {
      throw new Error("SANDBOX_PROVENANCE_SOURCE_RACE");
    }
    await mkdir(dirname(destination), { recursive: true });
    destinationHandle = await open(destination, "wx", 0o600);
    destinationCreated = true;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let sourcePosition = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.byteLength,
        sourcePosition,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten < 1) {
          throw new Error("SANDBOX_PROVENANCE_STAGE_WRITE_FAILED");
        }
        written += result.bytesWritten;
      }
      sourcePosition += bytesRead;
    }
    await destinationHandle.sync();
    const afterCopy = await stableFileIdentity(source);
    const actualSha256 = hash.digest("hex");
    if (
      sourcePosition !== opened.size ||
      !sameFileIdentity(before, afterCopy)
    ) {
      throw new Error("SANDBOX_PROVENANCE_SOURCE_RACE");
    }
    if (actualSha256 !== expectedSha256) {
      throw new Error("SANDBOX_PROVENANCE_SOURCE_MISMATCH");
    }
    await destinationHandle.close();
    destinationHandle = undefined;
    await chmod(destination, 0o444);
    const staged = { path: destination, sha256: expectedSha256 };
    await verifyStagedProvenanceFiles([staged]);
    return staged;
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    if (destinationCreated) {
      await rm(destination, { force: true });
    }
    throw error;
  } finally {
    await sourceHandle.close();
  }
}

export async function verifyStagedProvenanceFiles(
  files: StagedProvenanceFile[],
): Promise<void> {
  for (const file of files) {
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error("SANDBOX_PROVENANCE_HASH_INVALID");
    }
    const before = await stableFileIdentity(file.path);
    const handle = await open(before.resolved, "r");
    try {
      const opened = await handle.stat();
      const digest = await hashFileHandle(handle);
      const after = await stableFileIdentity(file.path);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        digest.bytes !== opened.size ||
        !sameFileIdentity(before, after)
      ) {
        throw new Error("SANDBOX_STAGED_SNAPSHOT_RACE");
      }
      if (digest.sha256 !== file.sha256) {
        throw new Error("SANDBOX_STAGED_SNAPSHOT_MISMATCH");
      }
    } finally {
      await handle.close();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function exactKeys(
  record: Record<string, unknown>,
  keys: string[],
): boolean {
  return isDeepStrictEqual(Object.keys(record).sort(), [...keys].sort());
}

interface ValidatedCanaryReport {
  evidence: {
    networkDenied: boolean;
    hostReadDenied: boolean;
    hostWriteDenied: boolean;
    childEscapeDenied: boolean;
    timeoutEnforced: boolean;
    outputAllowlistCanaryCreated: boolean;
  };
  issues: string[];
  unexpectedOutputRelativePath: string;
}

export function validateCanaryArtifacts(
  completeValue: unknown,
  reportValue: unknown,
): ValidatedCanaryReport {
  if (
    !isRecord(completeValue) ||
    !exactKeys(completeValue, [
      "apiVersion",
      "complete",
    ]) ||
    completeValue.apiVersion !==
      "chartermesh.dev/windows-sandbox-canary-complete/v1alpha1" ||
    completeValue.complete !== true
  ) {
    throw new Error("CANARY_COMPLETE_INVALID");
  }
  if (
    !isRecord(reportValue) ||
    !exactKeys(reportValue, [
      "apiVersion",
      "candidateObservations",
      "evidence",
      "issues",
      "timeoutObservation",
      "unexpectedOutputRelativePath",
    ]) ||
    reportValue.apiVersion !==
      "chartermesh.dev/windows-sandbox-canary-report/v1alpha1" ||
    reportValue.unexpectedOutputRelativePath !==
      "unexpected-output-canary.txt" ||
    !Array.isArray(reportValue.issues) ||
    !reportValue.issues.every(
      (issue) => typeof issue === "string" && issue.length > 0,
    ) ||
    !isRecord(reportValue.evidence) ||
    !exactKeys(reportValue.evidence, [
      "networkDenied",
      "hostReadDenied",
      "hostWriteDenied",
      "childEscapeDenied",
      "timeoutEnforced",
      "outputAllowlistCanaryCreated",
    ]) ||
    !Object.values(reportValue.evidence).every(
      (value) => typeof value === "boolean",
    ) ||
    !isRecord(reportValue.timeoutObservation) ||
    !exactKeys(reportValue.timeoutObservation, [
      "requestedMs",
      "durationMs",
      "exitCode",
      "signal",
    ]) ||
    typeof reportValue.timeoutObservation.requestedMs !== "number" ||
    !Number.isFinite(reportValue.timeoutObservation.requestedMs) ||
    reportValue.timeoutObservation.requestedMs < 1 ||
    typeof reportValue.timeoutObservation.durationMs !== "number" ||
    !Number.isFinite(reportValue.timeoutObservation.durationMs) ||
    reportValue.timeoutObservation.durationMs < 0 ||
    !(
      reportValue.timeoutObservation.exitCode === null ||
      (typeof reportValue.timeoutObservation.exitCode === "number" &&
        Number.isInteger(reportValue.timeoutObservation.exitCode))
    ) ||
    !(
      reportValue.timeoutObservation.signal === null ||
      typeof reportValue.timeoutObservation.signal === "string"
    )
  ) {
    throw new Error("CANARY_REPORT_INVALID");
  }
  return {
    evidence: reportValue.evidence as ValidatedCanaryReport["evidence"],
    issues: [...reportValue.issues] as string[],
    unexpectedOutputRelativePath:
      reportValue.unexpectedOutputRelativePath,
  };
}

function validateSandboxCompletion(
  value: unknown,
  expectedJobIds: string[],
  expectedCases: number,
): void {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "apiVersion",
      "jobCount",
      "jobIds",
      "caseCount",
    ]) ||
    value.apiVersion !==
      "chartermesh.dev/sandbox-complete/v1alpha1" ||
    value.jobCount !== expectedJobIds.length ||
    !isDeepStrictEqual(value.jobIds, expectedJobIds) ||
    value.caseCount !== expectedCases
  ) {
    throw new Error("SANDBOX_COMPLETION_MISMATCH");
  }
}

function validateGuestCaseResult(
  value: unknown,
  expectedJobId: string,
  expectedId: string,
): GuestCaseResult {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "id",
        "jobId",
        "exitCode",
        "signal",
        "launchError",
        "timedOut",
        "outputLimitExceeded",
        "stdout",
        "stdoutHash",
        "stderrHash",
        "stdoutBytes",
        "stderrBytes",
      ].includes(key),
    ) ||
    value.jobId !== expectedJobId ||
    value.id !== expectedId ||
    !(
      value.exitCode === null ||
      (typeof value.exitCode === "number" &&
        Number.isInteger(value.exitCode))
    ) ||
    !(
      value.signal === undefined ||
      value.signal === null ||
      typeof value.signal === "string"
    ) ||
    !(
      value.launchError === undefined ||
      typeof value.launchError === "string"
    ) ||
    typeof value.timedOut !== "boolean" ||
    typeof value.outputLimitExceeded !== "boolean" ||
    typeof value.stdout !== "string" ||
    typeof value.stdoutHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.stdoutHash) ||
    typeof value.stderrHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.stderrHash) ||
    typeof value.stdoutBytes !== "number" ||
    !Number.isInteger(value.stdoutBytes) ||
    value.stdoutBytes < 0 ||
    typeof value.stderrBytes !== "number" ||
    !Number.isInteger(value.stderrBytes) ||
    value.stderrBytes < 0 ||
    Buffer.byteLength(value.stdout, "utf8") !== value.stdoutBytes ||
    value.stdoutBytes + value.stderrBytes >
      PROGRAM_OUTPUT_LIMIT_BYTES
  ) {
    throw new Error("SANDBOX_CASE_RESULT_INVALID");
  }
  return value as unknown as GuestCaseResult;
}

export function compareSandboxCase(
  testCase: CodeTestCase,
  guest: GuestCaseResult,
): CodeCaseResult {
  const common = {
    id: testCase.id,
    exitCode: guest.exitCode,
    latencyMs: 0,
    outputHash: guest.stdoutHash,
  };
  if (guest.timedOut) {
    return {
      ...common,
      passed: false,
      errorCode: "SANDBOX_TIMEOUT",
    };
  }
  if (guest.outputLimitExceeded) {
    return {
      ...common,
      passed: false,
      errorCode: "PROGRAM_OUTPUT_LIMIT",
    };
  }
  if (guest.launchError) {
    return {
      ...common,
      passed: false,
      errorCode: "SANDBOX_LAUNCH_FAILED",
    };
  }
  if (guest.exitCode !== 0) {
    return {
      ...common,
      passed: false,
      errorCode: "PROGRAM_EXIT_NONZERO",
    };
  }
  if (sha256(guest.stdout) !== guest.stdoutHash) {
    return {
      ...common,
      passed: false,
      errorCode: "PROGRAM_OUTPUT_INVALID",
    };
  }
  const envelope = parseAuthenticatedCandidateEnvelope(guest.stdout);
  if (!envelope) {
    return {
      ...common,
      passed: false,
      errorCode: "PROGRAM_OUTPUT_INVALID",
    };
  }
  if (envelope.inputMutated) {
    return {
      ...common,
      passed: false,
      errorCode: "INPUT_MUTATED",
    };
  }
  if ("expectedErrorCode" in testCase) {
    const errorCode =
      envelope.kind === "throw" ? envelope.errorCode : undefined;
    return {
      ...common,
      output:
        envelope.kind === "throw"
          ? { errorCode: envelope.errorCode }
          : envelope.value,
      passed: errorCode === testCase.expectedErrorCode,
      ...(errorCode === testCase.expectedErrorCode
        ? {}
        : { errorCode: "EXPECTED_ERROR_MISMATCH" as const }),
    };
  }
  return {
    ...common,
    output: envelope.kind === "return" ? envelope.value : undefined,
    passed:
      envelope.kind === "return" &&
      isDeepStrictEqual(envelope.value, testCase.expected),
    ...(envelope.kind === "return" &&
    isDeepStrictEqual(envelope.value, testCase.expected)
      ? {}
      : { errorCode: "EXPECTED_OUTPUT_MISMATCH" as const }),
  };
}

export class SandboxContainmentError extends Error {
  constructor(scope: string) {
    super(
      `SANDBOX_CONTAINMENT_UNATTESTED: '${scope}' remains quarantined because VM stop could not be confirmed.`,
    );
    this.name = "SandboxContainmentError";
  }
}

export function windowsSandboxListAttestsStopped(
  raw: string,
  sandboxId: string,
): boolean {
  const normalizeId = (value: string): string | null => {
    const normalized = value
      .trim()
      .replace(/^\{|\}$/gu, "")
      .toLowerCase();
    return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      normalized,
    )
      ? normalized
      : null;
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  const collections = isRecord(value)
    ? Object.entries(value).filter(
        ([key, candidate]) =>
          /^(?:items|sandboxes|sessions|value)$/iu.test(key) &&
          Array.isArray(candidate),
      )
    : [];
  const records = Array.isArray(value)
    ? value
    : collections.length === 1
      ? collections[0]![1]
      : undefined;
  if (!Array.isArray(records)) return false;
  const normalizedId = normalizeId(sandboxId);
  if (!normalizedId) return false;
  const matchingStates: string[] = [];
  for (const record of records) {
    if (!isRecord(record)) return false;
    const entries = Object.entries(record);
    const id = entries.find(
      ([key, candidate]) =>
        /^(?:id|sandboxid)$/iu.test(key) &&
        typeof candidate === "string",
    )?.[1];
    const state = entries.find(
      ([key, candidate]) =>
        /^(?:state|status)$/iu.test(key) &&
        typeof candidate === "string",
    )?.[1];
    if (typeof id !== "string" || typeof state !== "string") {
      return false;
    }
    const recordId = normalizeId(id);
    const recordState = state.trim().toLowerCase();
    if (
      !recordId ||
      !["running", "stopped"].includes(recordState)
    ) {
      return false;
    }
    if (recordId === normalizedId) {
      matchingStates.push(recordState);
    }
  }
  if (matchingStates.length > 0) {
    return matchingStates.every((state) => state === "stopped");
  }
  return true;
}

export async function cleanupSandboxSession(options: {
  root: string;
  sandboxMayBeRunning: boolean;
  sandboxStopped: boolean;
  stop: () => Promise<void>;
  beforeRemove?: () => Promise<void>;
}): Promise<void> {
  let stopConfirmed =
    !options.sandboxMayBeRunning || options.sandboxStopped;
  if (!stopConfirmed) {
    try {
      await options.stop();
      stopConfirmed = true;
    } catch {
      throw new SandboxContainmentError(options.root);
    }
  }
  if (stopConfirmed) {
    let validationError: unknown;
    try {
      await options.beforeRemove?.();
    } catch (error) {
      validationError = error;
    }
    await rm(options.root, { recursive: true, force: true });
    if (validationError) throw validationError;
  }
}

export class WindowsSandboxCodeBackend
  implements CodeSandboxBackend
{
  readonly manifest = {
    id: "windows-sandbox-protected-client",
    isolation: "vm",
    network: "disabled",
    hostFilesystem: "mapped-allowlist",
    generatedCodeExecution: true,
  } as const;

  private readonly wsbExecutable: string;
  private readonly wsbExecutableSha256?: string;
  private readonly guestRunner: string;
  private readonly candidateExecutor: string;
  private readonly candidateWorker: string;
  private readonly guestCanary: string;
  private readonly canaryCandidate: string;
  private readonly runtimeExecutable: string;
  private readonly runtimeExecutableSha256: string;
  private readonly guestFileHashes: ReadonlyMap<string, string>;
  private readonly sessionJournalPath: string;
  private readonly sessionOwnerNonce = randomUUID().replaceAll("-", "");
  private recoverableOwnedSessionId?: string;
  private probeCache?: CodeSandboxProbe;

  constructor(
    options: {
      provenance: CodeEvaluationProvenance;
      wsbExecutable?: string;
      wsbExecutableSha256?: string;
      guestRunner?: string;
      candidateExecutor?: string;
      candidateWorker?: string;
      guestCanary?: string;
      canaryCandidate?: string;
      runtimeExecutable?: string;
      runtimeDirectory?: string;
      sessionJournalPath?: string;
    },
  ) {
    validateCodeEvaluationProvenance(options.provenance);
    if (options.provenance.node.version !== process.version) {
      throw new Error(
        "SANDBOX_PROVENANCE_RUNTIME_VERSION_MISMATCH",
      );
    }
    this.wsbExecutable = options.wsbExecutable ?? "wsb.exe";
    const commandNameOnly =
      !isAbsolute(this.wsbExecutable) &&
      !/[\\/]/u.test(this.wsbExecutable);
    if (!commandNameOnly && !options.wsbExecutableSha256) {
      throw new Error("SANDBOX_WSB_PROVENANCE_HASH_REQUIRED");
    }
    if (options.wsbExecutableSha256) {
      if (!isAbsolute(this.wsbExecutable)) {
        throw new Error("SANDBOX_WSB_PROVENANCE_PATH_NOT_ABSOLUTE");
      }
      if (!SHA256_PATTERN.test(options.wsbExecutableSha256)) {
        throw new Error("SANDBOX_WSB_PROVENANCE_HASH_INVALID");
      }
      this.wsbExecutableSha256 = options.wsbExecutableSha256;
    }
    this.guestRunner =
      options.guestRunner ??
      bundledSandboxScript("guest-runner.mjs");
    this.candidateExecutor =
      options.candidateExecutor ??
      bundledSandboxScript("candidate-executor.mjs");
    this.candidateWorker =
      options.candidateWorker ??
      bundledSandboxScript("candidate-worker.mjs");
    this.guestCanary =
      options.guestCanary ??
      bundledSandboxScript("guest-canary.mjs");
    this.canaryCandidate =
      options.canaryCandidate ??
      bundledSandboxScript("canary-candidate.mjs");
    this.runtimeExecutable =
      options.runtimeExecutable ??
      (options.runtimeDirectory
        ? join(options.runtimeDirectory, "node.exe")
        : process.execPath);
    this.runtimeExecutableSha256 =
      options.provenance.node.runtimeExecutableSha256;
    this.guestFileHashes = new Map(
      options.provenance.sandboxGuestBundle.files.map(
        ({ path, sha256: fileSha256 }) => [
          path.split("/").at(-1)!,
          fileSha256,
        ],
      ),
    );
    this.sessionJournalPath =
      options.sessionJournalPath ??
      join(tmpdir(), "chartermesh-wsb-session-v1.json");
    if (!isAbsolute(this.sessionJournalPath)) {
      throw new Error("SANDBOX_SESSION_JOURNAL_PATH_NOT_ABSOLUTE");
    }
  }

  private async recoverStaleSandboxSession(): Promise<void> {
    let recovered: string | null;
    try {
      recovered = await recoverWindowsSandboxSessionJournal({
        path: this.sessionJournalPath,
        ...(this.wsbExecutableSha256
          ? {
              expectedLauncherSha256:
                this.wsbExecutableSha256,
            }
          : {}),
        currentOwnerNonce: this.sessionOwnerNonce,
        ...(this.recoverableOwnedSessionId
          ? {
              recoverableOwnedSandboxId:
                this.recoverableOwnedSessionId,
            }
          : {}),
        stopAndAttest: (sandboxId) =>
          this.stopSandbox(sandboxId),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("SANDBOX_STOP_UNATTESTED")
      ) {
        throw new SandboxContainmentError(
          "journaled Windows Sandbox session",
        );
      }
      throw error;
    }
    if (recovered) this.recoverableOwnedSessionId = undefined;
  }

  private async beginSandboxSession(
    sandboxId: string,
  ): Promise<WindowsSandboxSessionJournalRecord> {
    await this.recoverStaleSandboxSession();
    const record = createWindowsSandboxSessionJournal({
      sandboxId,
      ownerPid: process.pid,
      ownerNonce: this.sessionOwnerNonce,
      createdAtMs: Date.now(),
      launcherSha256: this.wsbExecutableSha256 ?? null,
    });
    await persistWindowsSandboxSessionJournal(
      this.sessionJournalPath,
      record,
    );
    return record;
  }

  private async cleanupJournaledSandboxSession(options: {
    root: string;
    sandboxId: string;
    journal?: WindowsSandboxSessionJournalRecord;
    sandboxMayBeRunning: boolean;
    sandboxStopped: boolean;
    beforeRemove?: () => Promise<void>;
  }): Promise<void> {
    try {
      await cleanupSandboxSession({
        root: options.root,
        sandboxMayBeRunning: options.sandboxMayBeRunning,
        sandboxStopped: options.sandboxStopped,
        stop: () => this.stopSandbox(options.sandboxId),
        ...(options.beforeRemove
          ? { beforeRemove: options.beforeRemove }
          : {}),
      });
      if (options.journal) {
        await clearWindowsSandboxSessionJournal(
          this.sessionJournalPath,
          options.journal,
        );
      }
    } catch (error) {
      if (options.journal) {
        this.recoverableOwnedSessionId = options.sandboxId;
      }
      throw error;
    }
  }

  private async stageRuntime(root: string): Promise<{
    directory: string;
    file: StagedProvenanceFile;
  }> {
    const directory = await stageNodeRuntime(
      this.runtimeExecutable,
      root,
      this.runtimeExecutableSha256,
    );
    return {
      directory,
      file: {
        path: join(directory, "node.exe"),
        sha256: this.runtimeExecutableSha256,
      },
    };
  }

  private async stageGuestFile(
    source: string,
    destination: string,
  ): Promise<StagedProvenanceFile> {
    const name = source.split(/[\\/]/u).at(-1);
    const expectedSha256 = name
      ? this.guestFileHashes.get(name)
      : undefined;
    if (!expectedSha256) {
      throw new Error("SANDBOX_GUEST_PROVENANCE_MISSING");
    }
    return stageProvenanceFile(
      source,
      destination,
      expectedSha256,
    );
  }

  private async executeWsb(
    args: string[],
    options: {
      timeout: number;
      windowsHide: boolean;
      signal?: AbortSignal;
    },
  ) {
    return executeAttestedWindowsSandboxLauncher({
      executable: this.wsbExecutable,
      ...(this.wsbExecutableSha256
        ? { expectedSha256: this.wsbExecutableSha256 }
        : {}),
      args,
      options,
    });
  }

  private async stopSandbox(sandboxId: string): Promise<void> {
    let stopFailed = false;
    try {
      await this.executeWsb(
        ["stop", "--raw", "--id", sandboxId],
        { timeout: 30_000, windowsHide: true },
      );
    } catch {
      // A repeated stop can report "not found". Only list absence can
      // distinguish that safe case from an unconfirmed live sandbox.
      stopFailed = true;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.executeWsb(
          ["list", "--raw"],
          { timeout: 15_000, windowsHide: true },
        );
        if (
          windowsSandboxListAttestsStopped(
            String(stdout),
            sandboxId,
          )
        ) {
          return;
        }
      } catch {
        // Transient list failures remain untrusted and are retried.
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 250),
      );
    }
    throw new Error(
      `SANDBOX_STOP_UNATTESTED: '${sandboxId}' remained active or its state was ambiguous after ${stopFailed ? "a failed" : "the"} stop command.`,
    );
  }

  async probe(
    options: CodeSandboxRunOptions = {},
  ): Promise<CodeSandboxProbe> {
    throwIfSandboxAborted(options.signal);
    await this.recoverStaleSandboxSession();
    throwIfSandboxAborted(options.signal);
    if (this.probeCache) return structuredClone(this.probeCache);
    const issues: string[] = [];
    try {
      const { stdout, stderr } = await this.executeWsb(
        ["--help"],
        {
          timeout: 15_000,
          windowsHide: true,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const help = `${stdout}\n${stderr}`.toLowerCase();
      for (const command of ["start", "stop", "list"]) {
        if (!help.includes(command)) {
          issues.push(`WSB_CLI_MISSING_${command.toUpperCase()}`);
        }
      }
    } catch {
      throwIfSandboxAborted(options.signal);
      issues.push("WSB_CLI_UNAVAILABLE");
    }
    const evidence: CodeSandboxProbe["evidence"] = {
      networkDenied: false,
      hostReadDenied: false,
      hostWriteDenied: false,
      childEscapeDenied: false,
      timeoutEnforced: false,
      outputAllowlistEnforced: false,
    };
    if (issues.length === 0) {
      const root = await mkdtemp(
        join(tmpdir(), "chartermesh-wsb-canary-"),
      );
      const input = join(root, "input");
      const output = join(root, "output");
      const sentinel = join(root, "host-sentinel.txt");
      const sentinelText = `chartermesh-host-sentinel:${randomUUID()}\n`;
      const sandboxId = randomUUID();
      let sandboxMayBeRunning = false;
      let sandboxStopped = false;
      let sessionJournal:
        | WindowsSandboxSessionJournalRecord
        | undefined;
      let stagedProvenanceFiles: StagedProvenanceFile[] = [];
      try {
        throwIfSandboxAborted(options.signal);
        await mkdir(input, { recursive: true });
        await mkdir(output, { recursive: true });
        const runtime = await this.stageRuntime(root);
        stagedProvenanceFiles = [runtime.file];
        await writeFile(sentinel, sentinelText, "utf8");
        stagedProvenanceFiles.push(
          await this.stageGuestFile(
            this.guestCanary,
            join(input, "guest-canary.mjs"),
          ),
          await this.stageGuestFile(
            this.canaryCandidate,
            join(input, "canary-candidate.mjs"),
          ),
        );
        await writeFile(
          join(input, "canary-manifest.json"),
          `${JSON.stringify(
            {
              apiVersion:
                "chartermesh.dev/windows-sandbox-canary/v1alpha1",
              hostSentinelPath: sentinel,
              timeoutMs: 1_000,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await writeFile(
          join(input, "run-canary.cmd"),
          [
            "@echo off",
            "C:\\CharterMesh\\Runtime\\node.exe --permission --allow-child-process --allow-fs-read=C:\\CharterMesh\\Input --allow-fs-write=C:\\CharterMesh\\Output C:\\CharterMesh\\Input\\guest-canary.mjs",
          ].join("\r\n"),
          "utf8",
        );
        const configuration = windowsSandboxConfiguration({
          input,
          output,
          runtime: runtime.directory,
          command:
            "cmd.exe /d /c C:\\CharterMesh\\Input\\run-canary.cmd",
        });
        await verifyStagedProvenanceFiles(
          stagedProvenanceFiles,
        );
        throwIfSandboxAborted(options.signal);
        sessionJournal = await this.beginSandboxSession(sandboxId);
        sandboxMayBeRunning = true;
        await this.executeWsb(
          [
            "start",
            "--raw",
            "--id",
            sandboxId,
            "--config",
            configuration,
          ],
          {
            timeout: 120_000,
            windowsHide: true,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          throwIfSandboxAborted(options.signal);
          const complete = await stat(
            join(output, "canary-complete.json"),
          ).then(
            (info) => info.isFile(),
            () => false,
          );
          if (complete) break;
          await abortableDelay(250, options.signal);
        }
        await this.stopSandbox(sandboxId);
        sandboxStopped = true;
        throwIfSandboxAborted(options.signal);
        await verifyStagedProvenanceFiles(
          stagedProvenanceFiles,
        );
        const completeValue = await boundedReadJson(
          join(output, "canary-complete.json"),
          output,
        );
        const reportValue = await boundedReadJson(
          join(output, "canary-report.json"),
          output,
        );
        const report = validateCanaryArtifacts(
          completeValue,
          reportValue,
        );
        issues.push(...report.issues);
        const outputTree = await inspectSandboxOutputTree(output);
        const unexpectedOutputs = outputTree.paths.filter(
          (path) =>
            ![
              "canary-complete.json",
              "canary-report.json",
            ].includes(path),
        );
        const sentinelAfter = await readFile(sentinel, "utf8");
        evidence.networkDenied =
          report.evidence.networkDenied;
        evidence.hostReadDenied =
          report.evidence.hostReadDenied;
        evidence.hostWriteDenied =
          report.evidence.hostWriteDenied &&
          sentinelAfter === sentinelText;
        evidence.childEscapeDenied =
          report.evidence.childEscapeDenied;
        evidence.timeoutEnforced =
          report.evidence.timeoutEnforced;
        evidence.outputAllowlistEnforced =
          report.evidence.outputAllowlistCanaryCreated &&
          unexpectedOutputs.length === 1 &&
          unexpectedOutputs[0] ===
            report.unexpectedOutputRelativePath;
        if (sentinelAfter !== sentinelText) {
          issues.push("CANARY_HOST_SENTINEL_CHANGED");
        }
        if (!evidence.outputAllowlistEnforced) {
          issues.push("CANARY_OUTPUT_ALLOWLIST_NOT_ENFORCED");
        }
      } catch {
        throwIfSandboxAborted(options.signal);
        issues.push("WSB_CANARY_FAILED");
      } finally {
        try {
          await this.cleanupJournaledSandboxSession({
            root,
            sandboxId,
            ...(sessionJournal
              ? { journal: sessionJournal }
              : {}),
            sandboxMayBeRunning,
            sandboxStopped,
            ...(sandboxMayBeRunning
              ? {
                  beforeRemove: () =>
                    verifyStagedProvenanceFiles(
                      stagedProvenanceFiles,
                    ),
                }
              : {}),
          });
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof SandboxContainmentError) {
            throw error;
          } else {
            issues.push("WSB_CANARY_CLEANUP_FAILED");
          }
        }
      }
    }
    throwIfSandboxAborted(options.signal);
    const allEvidence = Object.values(evidence).every(Boolean);
    this.probeCache = {
      ok: issues.length === 0 && allEvidence,
      backendId: this.manifest.id,
      evidence,
      issues,
    };
    return structuredClone(this.probeCache);
  }

  async run(
    task: Pick<
      CodeEvaluationTask,
      "id" | "baseFiles" | "editablePaths"
    >,
    candidate: CodeCandidate,
    cases: CodeTestCase[],
    jobId = task.id,
    options: CodeSandboxRunOptions = {},
  ): Promise<CodeSandboxRunResult> {
    const [result] = await this.runBatch([
      { id: jobId, task, candidate, cases },
    ], options);
    if (!result) throw new Error("SANDBOX_RESULT_MISSING");
    return result;
  }

  async runBatch(
    jobs: CodeSandboxJob[],
    options: CodeSandboxRunOptions = {},
  ): Promise<CodeSandboxRunResult[]> {
    throwIfSandboxAborted(options.signal);
    if (jobs.length === 0) return [];
    await requireSafeSandbox(this, options);
    throwIfSandboxAborted(options.signal);
    const root = await mkdtemp(join(tmpdir(), "chartermesh-wsb-eval-"));
    const input = join(root, "input");
    const output = join(root, "output");
    const requests = join(input, "requests");
    const sandboxId = randomUUID();
    let sandboxMayBeRunning = false;
    let sandboxStopped = false;
    let sessionJournal:
      | WindowsSandboxSessionJournalRecord
      | undefined;
    let stagedProvenanceFiles: StagedProvenanceFile[] = [];
    const started = performance.now();
    const totalCaseCount = jobs.reduce(
      (sum, job) => sum + job.cases.length,
      0,
    );
    try {
      throwIfSandboxAborted(options.signal);
      const seenJobIds = new Set<string>();
      await mkdir(requests, { recursive: true });
      await mkdir(output, { recursive: true });
      const runtime = await this.stageRuntime(root);
      stagedProvenanceFiles = [
        runtime.file,
        await this.stageGuestFile(
          this.guestRunner,
          join(input, "guest-runner.mjs"),
        ),
        await this.stageGuestFile(
          this.candidateExecutor,
          join(input, "candidate-executor.mjs"),
        ),
        await this.stageGuestFile(
          this.candidateWorker,
          join(input, "candidate-worker.mjs"),
        ),
      ];
      const manifestJobs: Array<{
        id: string;
        key: string;
        entrypoint: string;
        cases: Array<{ id: string; key: string; file: string }>;
      }> = [];
      for (const [jobIndex, job] of jobs.entries()) {
        if (!job.id || seenJobIds.has(job.id)) {
          throw new Error("SANDBOX_JOB_ID_INVALID");
        }
        seenJobIds.add(job.id);
        const entrypoint = job.task.editablePaths[0];
        if (!entrypoint) {
          throw new Error("SANDBOX_ENTRYPOINT_MISSING");
        }
        const key = `job-${String(jobIndex + 1).padStart(4, "0")}`;
        const jobRoot = join(input, "jobs", key);
        const requestRoot = join(requests, key);
        const allowed = new Set(job.task.editablePaths);
        const candidateByPath = new Map(
          job.candidate.files.map((file) => [
            file.path,
            file.content,
          ]),
        );
        for (const file of job.task.baseFiles) {
          if (
            file.path.includes("\\") ||
            file.path.startsWith("/") ||
            file.path
              .split("/")
              .some((part) => !part || part === "..")
          ) {
            throw new Error(`Unsafe fixture path '${file.path}'.`);
          }
          const content = allowed.has(file.path)
            ? candidateByPath.get(file.path)
            : file.content;
          if (content === undefined) {
            throw new Error(`Missing candidate file '${file.path}'.`);
          }
          const destination = join(
            jobRoot,
            ...file.path.split("/"),
          );
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content, "utf8");
        }
        await mkdir(requestRoot, { recursive: true });
        const seenCaseIds = new Set<string>();
        const manifestCases = job.cases.map(
          (testCase, caseIndex) => {
            if (
              !testCase.id ||
              seenCaseIds.has(testCase.id)
            ) {
              throw new Error("SANDBOX_CASE_ID_INVALID");
            }
            seenCaseIds.add(testCase.id);
            return {
              id: testCase.id,
              key: `case-${String(caseIndex + 1).padStart(4, "0")}`,
              file: `${String(caseIndex + 1).padStart(4, "0")}.json`,
            };
          },
        );
        for (const [caseIndex, testCase] of job.cases.entries()) {
          await writeFile(
            join(requestRoot, manifestCases[caseIndex]!.file),
            `${JSON.stringify(testCase.input)}\n`,
            "utf8",
          );
        }
        manifestJobs.push({
          id: job.id,
          key,
          entrypoint: `jobs/${key}/${entrypoint}`,
          cases: manifestCases,
        });
      }
      const manifest = {
        apiVersion: "chartermesh.dev/sandbox-job/v1alpha1",
        caseTimeoutMs: 15_000,
        maxOutputBytes: PROGRAM_OUTPUT_LIMIT_BYTES,
        jobs: manifestJobs,
      };
      await writeFile(
        join(input, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(input, "run-evaluation.cmd"),
        [
          "@echo off",
          "C:\\CharterMesh\\Runtime\\node.exe --permission --allow-child-process --allow-fs-read=C:\\CharterMesh\\Input --allow-fs-write=C:\\CharterMesh\\Output C:\\CharterMesh\\Input\\guest-runner.mjs",
        ].join("\r\n"),
        "utf8",
      );
      const configuration = windowsSandboxConfiguration({
        input,
        output,
        runtime: runtime.directory,
      });
      await verifyStagedProvenanceFiles(stagedProvenanceFiles);
      throwIfSandboxAborted(options.signal);
      sessionJournal = await this.beginSandboxSession(sandboxId);
      sandboxMayBeRunning = true;
      await this.executeWsb(
        [
          "start",
          "--raw",
          "--id",
          sandboxId,
          "--config",
          configuration,
        ],
        {
          timeout: 120_000,
          windowsHide: true,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        throwIfSandboxAborted(options.signal);
        const complete = await stat(join(output, "complete.json")).then(
          (info) => info.isFile(),
          () => false,
        );
        if (complete) break;
        await abortableDelay(250, options.signal);
      }
      const completeExists = await stat(
        join(output, "complete.json"),
      ).then(
        (info) => info.isFile(),
        () => false,
      );
      if (!completeExists) {
        await this.stopSandbox(sandboxId);
        sandboxStopped = true;
        throwIfSandboxAborted(options.signal);
        await verifyStagedProvenanceFiles(
          stagedProvenanceFiles,
        );
        throw new Error("SANDBOX_SESSION_TIMEOUT");
      }
      await this.stopSandbox(sandboxId);
      sandboxStopped = true;
      throwIfSandboxAborted(options.signal);
      await verifyStagedProvenanceFiles(stagedProvenanceFiles);
      const complete = await boundedReadJson(
        join(output, "complete.json"),
        output,
      );
      validateSandboxCompletion(
        complete,
        jobs.map(({ id }) => id),
        totalCaseCount,
      );
      const tree = await inspectSandboxOutputTree(output);
      const allowedOutputs = new Set([
        "complete.json",
        ...manifestJobs.flatMap((manifestJob) =>
          manifestJob.cases.map(
            ({ key }) => `results/${manifestJob.key}/${key}.json`,
          ),
        ),
      ]);
      const policyViolations = tree.paths
        .filter((path) => !allowedOutputs.has(path))
        .map((path) => `UNEXPECTED_OUTPUT:${path}`);
      const elapsed = Math.round(performance.now() - started);
      const results: CodeSandboxRunResult[] = [];
      for (const [jobIndex, job] of jobs.entries()) {
        throwIfSandboxAborted(options.signal);
        const manifestJob = manifestJobs[jobIndex]!;
        const caseResults: CodeCaseResult[] = [];
        for (const [caseIndex, testCase] of job.cases.entries()) {
          const guest = validateGuestCaseResult(
            await boundedReadJson(
              join(
                output,
                "results",
                manifestJob.key,
                `${manifestJob.cases[caseIndex]!.key}.json`,
              ),
              output,
            ),
            job.id,
            testCase.id,
          );
          const result = compareSandboxCase(testCase, guest);
          result.latencyMs = Math.round(
            elapsed / Math.max(totalCaseCount, 1),
          );
          caseResults.push(result);
        }
        const jobTree = await inspectSandboxOutputTree(
          join(output, "results", manifestJob.key),
        );
        results.push({
          jobId: job.id,
          taskId: job.task.id,
          passed:
            policyViolations.length === 0 &&
            caseResults.every(({ passed }) => passed),
          cases: caseResults,
          changedPaths: job.candidate.files
            .map(({ path }) => path)
            .sort(),
          policyViolations: [...policyViolations],
          survivorProcesses: 0,
          outputBytes: jobTree.bytes,
        });
      }
      throwIfSandboxAborted(options.signal);
      return results;
    } catch (error) {
      if (options.signal?.aborted) {
        throw sandboxAbortReason(options.signal);
      }
      if (
        error instanceof Error &&
        /^SANDBOX_[A-Z0-9_]+$/u.test(error.message)
      ) {
        throw error;
      }
      throw new Error("SANDBOX_INFRASTRUCTURE_FAILURE", { cause: error });
    } finally {
      await this.cleanupJournaledSandboxSession({
        root,
        sandboxId,
        ...(sessionJournal ? { journal: sessionJournal } : {}),
        sandboxMayBeRunning,
        sandboxStopped,
        ...(sandboxMayBeRunning
          ? {
              beforeRemove: () =>
                verifyStagedProvenanceFiles(
                  stagedProvenanceFiles,
                ),
            }
          : {}),
      });
    }
  }
}
