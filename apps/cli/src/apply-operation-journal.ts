import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
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
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  canonicalJson,
  sha256,
} from "../../../packages/orgspec/src/index.ts";

export const APPLY_OPERATION_JOURNAL_MAX_BYTES = 16 * 1_024 * 1_024;
export const APPLY_OPERATION_FILE_MAX_BYTES = 16 * 1_024 * 1_024;

const APPLY_OPERATION_API_VERSION =
  "chartermesh.dev/apply-operation/v1alpha1" as const;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;
const MAX_OPERATION_DIRECTORY_ENTRIES = 10_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};

export interface ApplyOperationPlannedFile {
  path: string;
  content: string;
  beforeHash: string | null;
  afterHash: string;
}

export interface ApplyOperationPlanLike {
  target: string;
  files: ApplyOperationPlannedFile[];
  planHash: string;
}

export type ApplyOperationStage =
  | "approved"
  | "files_committed"
  | "db_committed"
  | "complete";

export interface ApplyOperationReceipt<
  Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike,
> {
  apiVersion: typeof APPLY_OPERATION_API_VERSION;
  planHash: string;
  targetRoot: string;
  stage: ApplyOperationStage;
  plan: Plan;
  result: JsonValue;
  createdAt: string;
  updatedAt: string;
  receiptHash: string;
}

export type ApplyOperationFileState =
  | "pending"
  | "committed"
  | "mixed"
  | "changed";

interface ReceiptBody<Plan extends ApplyOperationPlanLike> {
  apiVersion: typeof APPLY_OPERATION_API_VERSION;
  planHash: string;
  targetRoot: string;
  stage: ApplyOperationStage;
  plan: Plan;
  result: JsonValue;
  createdAt: string;
  updatedAt: string;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertOwnedPath(root: string, candidate: string, label: string): void {
  if (!isWithin(root, resolve(candidate))) {
    throw new Error(`${label} '${candidate}' escapes the target project.`);
  }
}

function pathComponents(path: string): string[] {
  const resolved = resolve(path);
  const filesystemRoot = parse(resolved).root;
  const withinFilesystem = relative(filesystemRoot, resolved);
  return [
    filesystemRoot,
    ...(withinFilesystem === ""
      ? []
      : withinFilesystem.split(sep).map((_, index, segments) =>
          join(filesystemRoot, ...segments.slice(0, index + 1)),
        )),
  ];
}

function assertSafePath(root: string, candidate: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  assertOwnedPath(resolvedRoot, resolvedCandidate, label);
  const components = pathComponents(resolvedCandidate);
  for (const [index, component] of components.entries()) {
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(component);
    } catch (error) {
      if (isMissingPath(error)) break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `${label} '${candidate}' traverses a symbolic link, junction, or reparse point.`,
      );
    }
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new Error(
        `${label} '${candidate}' traverses non-directory component '${component}'.`,
      );
    }
  }
}

function canonicalTargetRoot(target: string): string {
  const root = resolve(target);
  assertSafePath(root, root, "Apply operation target");
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(`Apply operation target '${root}' does not exist.`);
    }
    throw error;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Apply operation target '${root}' is not a directory.`);
  }
  const canonical = realpathSync(root);
  if (resolve(canonical) !== root) {
    throw new Error(
      `Apply operation target '${root}' does not resolve to its approved path.`,
    );
  }
  return canonical;
}

function operationDirectory(root: string): string {
  return join(root, ".chartermesh", "operations");
}

function receiptPath(root: string, planHash: string): string {
  assertPlanHash(planHash, "Approved plan hash");
  return join(operationDirectory(root), `${planHash}.json`);
}

function assertPlanHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !PLAN_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp.`);
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (entry: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new Error(`${label} contains too many JSON values.`);
    }
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds the maximum JSON depth.`);
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new Error(`${path} must be a finite JSON number.`);
      }
      return;
    }
    if (!entry || typeof entry !== "object") {
      throw new Error(`${path} is not JSON-serializable.`);
    }
    if (active.has(entry)) {
      throw new Error(`${path} contains a circular JSON reference.`);
    }
    active.add(entry);
    if (Array.isArray(entry)) {
      const ownKeys = Reflect.ownKeys(entry);
      if (
        Object.keys(entry).length !== entry.length ||
        ownKeys.some(
          (key) => {
            if (typeof key !== "string") return true;
            if (key === "length") return false;
            const descriptor = Object.getOwnPropertyDescriptor(entry, key);
            return (
              !/^(0|[1-9]\d*)$/u.test(key) ||
              !descriptor?.enumerable ||
              !("value" in descriptor)
            );
          },
        )
      ) {
        throw new Error(`${path} must be a dense JSON array.`);
      }
      for (let index = 0; index < entry.length; index += 1) {
        visit(entry[index], `${path}[${index}]`, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} must be a plain JSON object.`);
      }
      for (const key of Reflect.ownKeys(entry)) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (
          typeof key !== "string" ||
          !descriptor?.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(`${path} contains a non-JSON object property.`);
        }
      }
      for (const [key, nested] of Object.entries(entry)) {
        visit(nested, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(entry);
  };
  visit(value, label, 0);
}

function planBody(plan: ApplyOperationPlanLike): Record<string, unknown> {
  const { planHash: _planHash, ...body } = plan;
  return body;
}

function assertPlan<Plan extends ApplyOperationPlanLike>(
  root: string,
  approvedPlanHash: string,
  plan: Plan,
): void {
  assertJsonValue(plan, "Apply operation plan");
  assertPlanHash(approvedPlanHash, "Approved plan hash");
  assertPlanHash(plan.planHash, "Plan hash");
  if (plan.planHash !== approvedPlanHash) {
    throw new Error("Approved plan hash does not match the stored plan.");
  }
  if (sha256(planBody(plan)) !== plan.planHash) {
    throw new Error("Apply operation plan hash does not match its exact payload.");
  }
  if (typeof plan.target !== "string" || !plan.target) {
    throw new Error("Apply operation plan target is invalid.");
  }
  assertSafePath(root, plan.target, "Apply operation plan target");
  if (realpathSync(resolve(plan.target)) !== root) {
    throw new Error("Apply operation plan targets another project.");
  }
  if (!Array.isArray(plan.files) || plan.files.length > 10_000) {
    throw new Error("Apply operation plan files are invalid or too numerous.");
  }
  const plannedPaths = new Set<string>();
  for (const [index, file] of plan.files.entries()) {
    if (!file || typeof file !== "object") {
      throw new Error(`Apply operation plan file ${index} is invalid.`);
    }
    if (typeof file.path !== "string" || !file.path) {
      throw new Error(`Apply operation plan file ${index} path is invalid.`);
    }
    if (!isAbsolute(file.path)) {
      throw new Error(`Apply operation plan file ${index} path must be absolute.`);
    }
    assertOwnedPath(root, file.path, `Apply operation plan file ${index}`);
    assertSafePath(root, file.path, `Apply operation plan file ${index}`);
    const pathKey = process.platform === "win32"
      ? resolve(file.path).toLowerCase()
      : resolve(file.path);
    if (plannedPaths.has(pathKey)) {
      throw new Error(`Apply operation plan file ${index} duplicates another path.`);
    }
    plannedPaths.add(pathKey);
    if (isWithin(operationDirectory(root), resolve(file.path))) {
      throw new Error(
        `Apply operation plan file ${index} overlaps the operation journal namespace.`,
      );
    }
    if (typeof file.content !== "string") {
      throw new Error(`Apply operation plan file ${index} content is invalid.`);
    }
    if (
      Buffer.byteLength(file.content, "utf8") >
      APPLY_OPERATION_FILE_MAX_BYTES
    ) {
      throw new Error(`Apply operation plan file ${index} is too large.`);
    }
    if (
      file.beforeHash !== null &&
      (typeof file.beforeHash !== "string" ||
        !PLAN_HASH_PATTERN.test(file.beforeHash))
    ) {
      throw new Error(`Apply operation plan file ${index} beforeHash is invalid.`);
    }
    assertPlanHash(
      file.afterHash,
      `Apply operation plan file ${index} afterHash`,
    );
    const actualAfterHash = sha256Bytes(file.content);
    if (actualAfterHash !== file.afterHash) {
      throw new Error(
        `Apply operation plan file ${index} content does not match afterHash.`,
      );
    }
  }
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createManagedDirectory(root: string, path: string): void {
  assertSafePath(root, path, "Apply operation directory");
  mkdirSync(path, { recursive: true });
  assertSafePath(root, path, "Apply operation directory");
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Apply operation directory '${path}' is not a plain directory.`);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EPERM", "EACCES", "EINVAL"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWrite(root: string, path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > APPLY_OPERATION_JOURNAL_MAX_BYTES) {
    throw new Error("Apply operation receipt exceeds the maximum byte size.");
  }
  const directory = dirname(path);
  createManagedDirectory(root, directory);
  assertSafePath(root, path, "Apply operation receipt");
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`Apply operation receipt '${path}' is not a regular file.`);
    }
  }
  const temporary = join(
    directory,
    `.${planHashFromReceiptPath(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  assertSafePath(root, temporary, "Apply operation temporary receipt");
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    const staged = lstatSync(temporary);
    if (!staged.isFile() || staged.isSymbolicLink()) {
      throw new Error("Apply operation temporary receipt is not a regular file.");
    }
    assertSafePath(root, directory, "Apply operation directory");
    assertSafePath(root, path, "Apply operation receipt");
    renameSync(temporary, path);
    assertSafePath(root, path, "Apply operation receipt");
    const committed = lstatSync(path);
    if (!committed.isFile() || committed.isSymbolicLink()) {
      throw new Error("Apply operation receipt commit is not a regular file.");
    }
    fsyncDirectory(directory);
  } catch (error) {
    assertSafePath(root, temporary, "Apply operation temporary receipt");
    rmSync(temporary, { force: true });
    throw error;
  }
}

function planHashFromReceiptPath(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const match = name.match(/^([a-f0-9]{64})\.json$/u);
  if (!match?.[1]) {
    throw new Error("Apply operation receipt path is invalid.");
  }
  return match[1];
}

function sameIdentity(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readExactFile(descriptor: number, byteSize: number): Buffer {
  const bytes = Buffer.alloc(byteSize);
  let offset = 0;
  while (offset < byteSize) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      byteSize - offset,
      offset,
    );
    if (count === 0) {
      throw new Error("Apply operation file became shorter while it was read.");
    }
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, byteSize) !== 0) {
    throw new Error("Apply operation file became larger while it was read.");
  }
  return bytes;
}

function boundedRegularFile(root: string, path: string): Uint8Array {
  assertSafePath(root, path, "Apply operation receipt");
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(`Apply operation receipt '${path}' does not exist.`);
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Apply operation receipt '${path}' is not a regular file.`);
  }
  if (before.size > APPLY_OPERATION_JOURNAL_MAX_BYTES) {
    throw new Error("Apply operation receipt exceeds the maximum byte size.");
  }
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > APPLY_OPERATION_JOURNAL_MAX_BYTES ||
      !sameIdentity(before, opened)
    ) {
      throw new Error("Apply operation receipt changed while it was opened.");
    }
    const bytes = readExactFile(descriptor, opened.size);
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameIdentity(after, opened) ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error("Apply operation receipt changed while it was read.");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function receiptBody<Plan extends ApplyOperationPlanLike>(
  receipt: ApplyOperationReceipt<Plan>,
): ReceiptBody<Plan> {
  const { receiptHash: _receiptHash, ...body } = receipt;
  return body;
}

function sealReceipt<Plan extends ApplyOperationPlanLike>(
  body: ReceiptBody<Plan>,
): ApplyOperationReceipt<Plan> {
  return { ...body, receiptHash: sha256(body) };
}

function serializeReceipt<Plan extends ApplyOperationPlanLike>(
  receipt: ApplyOperationReceipt<Plan>,
): Uint8Array {
  assertJsonValue(receipt, "Apply operation receipt");
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (bytes.byteLength > APPLY_OPERATION_JOURNAL_MAX_BYTES) {
    throw new Error("Apply operation receipt exceeds the maximum byte size.");
  }
  return bytes;
}

function parseReceipt<Plan extends ApplyOperationPlanLike>(
  root: string,
  approvedPlanHash: string,
  bytes: Uint8Array,
): ApplyOperationReceipt<Plan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("Apply operation receipt is not valid JSON.");
  }
  assertJsonValue(parsed, "Apply operation receipt");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Apply operation receipt must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = new Set([
    "apiVersion",
    "planHash",
    "targetRoot",
    "stage",
    "plan",
    "result",
    "createdAt",
    "updatedAt",
    "receiptHash",
  ]);
  if (
    Object.keys(record).length !== expectedKeys.size ||
    Object.keys(record).some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Apply operation receipt fields are invalid.");
  }
  if (record.apiVersion !== APPLY_OPERATION_API_VERSION) {
    throw new Error("Apply operation receipt API version is invalid.");
  }
  assertPlanHash(record.planHash, "Receipt plan hash");
  if (record.planHash !== approvedPlanHash) {
    throw new Error("Apply operation receipt is keyed by another plan hash.");
  }
  if (record.targetRoot !== root) {
    throw new Error("Apply operation receipt targets another project.");
  }
  if (
    !["approved", "files_committed", "db_committed", "complete"].includes(
      String(record.stage),
    )
  ) {
    throw new Error("Apply operation receipt stage is invalid.");
  }
  assertTimestamp(record.createdAt, "Apply operation createdAt");
  assertTimestamp(record.updatedAt, "Apply operation updatedAt");
  assertPlanHash(record.receiptHash, "Receipt hash");
  const receipt = record as unknown as ApplyOperationReceipt<Plan>;
  if (sha256(receiptBody(receipt)) !== receipt.receiptHash) {
    throw new Error("Apply operation receipt hash does not match its payload.");
  }
  assertPlan(root, approvedPlanHash, receipt.plan);
  return receipt;
}

function operationLockDirectory(root: string, planHash: string): string {
  return join(operationDirectory(root), `${planHash}.lock`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
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

function readLockOwner(root: string, path: string): { pid?: number } {
  const ownerPath = join(path, "owner.json");
  if (!existsSync(ownerPath)) return {};
  try {
    const bytes = boundedRegularFile(root, ownerPath);
    if (bytes.byteLength > 4_096) return {};
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      pid?: unknown;
    };
    return typeof value.pid === "number" && Number.isSafeInteger(value.pid)
      ? { pid: value.pid }
      : {};
  } catch {
    return {};
  }
}

function withOperationLock<T>(
  root: string,
  planHash: string,
  operation: () => T,
): T {
  createManagedDirectory(root, operationDirectory(root));
  const lock = operationLockDirectory(root, planHash);
  assertSafePath(root, lock, "Apply operation lock");
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
    assertSafePath(root, lock, "Apply operation lock");
    const metadata = lstatSync(lock);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Apply operation lock is not a plain directory.");
    }
    const owner = readLockOwner(root, lock);
    const ageMs = Date.now() - statSync(lock).mtimeMs;
    if (
      (typeof owner.pid === "number" && processIsAlive(owner.pid)) ||
      (owner.pid === undefined && ageMs < 30_000)
    ) {
      throw new Error(`Another apply operation is active for plan ${planHash}.`);
    }
    assertSafePath(root, lock, "Apply operation stale lock");
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  try {
    const owner = Buffer.from(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    const ownerPath = join(lock, "owner.json");
    assertSafePath(root, ownerPath, "Apply operation lock owner");
    const descriptor = openSync(ownerPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, owner);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return operation();
  } finally {
    assertSafePath(root, lock, "Apply operation lock cleanup");
    rmSync(lock, { recursive: true, force: true });
  }
}

function writeReceipt<Plan extends ApplyOperationPlanLike>(
  root: string,
  receipt: ApplyOperationReceipt<Plan>,
): void {
  atomicWrite(
    root,
    receiptPath(root, receipt.planHash),
    serializeReceipt(receipt),
  );
}

export function validateApplyOperationPlan<Plan extends ApplyOperationPlanLike>(
  target: string, approvedPlanHash: string, plan: Plan,
): void {
  assertPlan(canonicalTargetRoot(target), approvedPlanHash, plan);
}

export function beginApplyOperation<Plan extends ApplyOperationPlanLike>(
  target: string,
  approvedPlanHash: string,
  plan: Plan,
  initialResult: JsonValue = null,
): ApplyOperationReceipt<Plan> {
  const root = canonicalTargetRoot(target);
  assertPlan(root, approvedPlanHash, plan);
  assertJsonValue(initialResult, "Apply operation initial result");
  return withOperationLock(root, approvedPlanHash, () => {
    const path = receiptPath(root, approvedPlanHash);
    if (existsSync(path)) {
      const existing = loadApplyOperation<Plan>(root, approvedPlanHash);
      if (canonicalJson(existing.plan) !== canonicalJson(plan)) {
        throw new Error("Approved plan receipt contains another exact plan payload.");
      }
      return existing;
    }
    const stamp = new Date().toISOString();
    const receipt = sealReceipt<Plan>({
      apiVersion: APPLY_OPERATION_API_VERSION,
      planHash: approvedPlanHash,
      targetRoot: root,
      stage: "approved",
      plan,
      result: initialResult,
      createdAt: stamp,
      updatedAt: stamp,
    });
    writeReceipt(root, receipt);
    return receipt;
  });
}

export function loadApplyOperation<Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike>(
  target: string,
  approvedPlanHash: string,
): ApplyOperationReceipt<Plan> {
  const root = canonicalTargetRoot(target);
  const path = receiptPath(root, approvedPlanHash);
  return parseReceipt<Plan>(
    root,
    approvedPlanHash,
    boundedRegularFile(root, path),
  );
}

export function findApplyOperation<Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike>(
  target: string,
  approvedPlanHash: string,
): ApplyOperationReceipt<Plan> | null {
  const root = canonicalTargetRoot(target);
  const path = receiptPath(root, approvedPlanHash);
  assertSafePath(root, path, "Apply operation receipt");
  if (!existsSync(path)) return null;
  return parseReceipt<Plan>(
    root,
    approvedPlanHash,
    boundedRegularFile(root, path),
  );
}

const STAGE_ORDER: ApplyOperationStage[] = [
  "approved",
  "files_committed",
  "db_committed",
  "complete",
];

function markApplyOperationStage<Plan extends ApplyOperationPlanLike>(
  target: string,
  approvedPlanHash: string,
  stage: ApplyOperationStage,
  result?: JsonValue,
): ApplyOperationReceipt<Plan> {
  const root = canonicalTargetRoot(target);
  assertPlanHash(approvedPlanHash, "Approved plan hash");
  if (result !== undefined) {
    assertJsonValue(result, "Apply operation result");
  }
  return withOperationLock(root, approvedPlanHash, () => {
    const current = loadApplyOperation<Plan>(root, approvedPlanHash);
    const currentIndex = STAGE_ORDER.indexOf(current.stage);
    const nextIndex = STAGE_ORDER.indexOf(stage);
    if (current.stage === stage) {
      if (
        result !== undefined &&
        canonicalJson(result) !== canonicalJson(current.result)
      ) {
        throw new Error(
          `Apply operation stage '${stage}' already has another result.`,
        );
      }
      return current;
    }
    if (nextIndex !== currentIndex + 1) {
      throw new Error(
        `Apply operation cannot advance from '${current.stage}' to '${stage}'.`,
      );
    }
    const updated = sealReceipt<Plan>({
      ...receiptBody(current),
      stage,
      result: result === undefined ? current.result : result,
      updatedAt: new Date().toISOString(),
    });
    writeReceipt(root, updated);
    return updated;
  });
}

export function markApplyOperationFilesCommitted<
  Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike,
>(
  target: string,
  approvedPlanHash: string,
  result?: JsonValue,
): ApplyOperationReceipt<Plan> {
  return markApplyOperationStage<Plan>(
    target,
    approvedPlanHash,
    "files_committed",
    result,
  );
}

export function markApplyOperationDatabaseCommitted<
  Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike,
>(
  target: string,
  approvedPlanHash: string,
  result?: JsonValue,
): ApplyOperationReceipt<Plan> {
  return markApplyOperationStage<Plan>(
    target,
    approvedPlanHash,
    "db_committed",
    result,
  );
}

export function completeApplyOperation<
  Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike,
>(
  target: string,
  approvedPlanHash: string,
  result?: JsonValue,
): ApplyOperationReceipt<Plan> {
  return markApplyOperationStage<Plan>(
    target,
    approvedPlanHash,
    "complete",
    result,
  );
}

export function listPendingApplyOperations<
  Plan extends ApplyOperationPlanLike = ApplyOperationPlanLike,
>(target: string): ApplyOperationReceipt<Plan>[] {
  const root = canonicalTargetRoot(target);
  const directory = operationDirectory(root);
  assertSafePath(root, directory, "Apply operation directory");
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Apply operation directory is not a plain directory.");
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > MAX_OPERATION_DIRECTORY_ENTRIES) {
    throw new Error("Apply operation directory contains too many entries.");
  }
  const pending: ApplyOperationReceipt<Plan>[] = [];
  for (const entry of entries) {
    const match = entry.name.match(/^([a-f0-9]{64})\.json$/u);
    if (!match?.[1]) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Apply operation entry '${entry.name}' is not a regular file.`);
    }
    const receipt = loadApplyOperation<Plan>(root, match[1]);
    if (receipt.stage !== "complete") pending.push(receipt);
  }
  return pending.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.planHash.localeCompare(right.planHash),
  );
}

function digestBoundedFile(root: string, path: string): string | null {
  assertSafePath(root, path, "Apply operation planned file");
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Apply operation planned path '${path}' is not a regular file.`);
  }
  if (metadata.size > APPLY_OPERATION_FILE_MAX_BYTES) {
    throw new Error(`Apply operation planned file '${path}' is too large.`);
  }
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > APPLY_OPERATION_FILE_MAX_BYTES ||
      !sameIdentity(metadata, opened)
    ) {
      throw new Error(`Apply operation planned file '${path}' changed while opening.`);
    }
    const bytes = readExactFile(descriptor, opened.size);
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameIdentity(after, opened) ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error(`Apply operation planned file '${path}' changed while reading.`);
    }
    return sha256Bytes(bytes);
  } finally {
    closeSync(descriptor);
  }
}

export function inspectApplyOperationFiles(
  receipt: ApplyOperationReceipt,
): ApplyOperationFileState {
  assertJsonValue(receipt, "Apply operation receipt");
  if (
    receipt.apiVersion !== APPLY_OPERATION_API_VERSION ||
    !PLAN_HASH_PATTERN.test(receipt.receiptHash) ||
    sha256(receiptBody(receipt)) !== receipt.receiptHash
  ) {
    throw new Error("Apply operation receipt hash does not match its payload.");
  }
  const root = canonicalTargetRoot(receipt.targetRoot);
  assertPlan(root, receipt.planHash, receipt.plan);
  let beforeOnly = 0;
  let afterOnly = 0;
  for (const file of receipt.plan.files) {
    const digest = digestBoundedFile(root, file.path);
    const matchesBefore = digest === file.beforeHash;
    const matchesAfter = digest === file.afterHash;
    if (!matchesBefore && !matchesAfter) return "changed";
    if (matchesBefore && !matchesAfter) beforeOnly += 1;
    if (matchesAfter && !matchesBefore) afterOnly += 1;
  }
  if (beforeOnly > 0 && afterOnly > 0) return "mixed";
  if (beforeOnly > 0) return "pending";
  return "committed";
}
