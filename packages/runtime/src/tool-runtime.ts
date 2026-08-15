import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyFileTransaction } from "../../compiler/src/index.ts";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelTool,
  ModelToolCall,
  ModelUsage,
  PermissionClass,
} from "../../adapter-sdk/src/types.ts";
import type { ToolPolicy } from "../../orgspec/src/types.ts";

export type ToolExecutionStatus =
  | "succeeded"
  | "approval_required"
  | "denied"
  | "failed";

export interface ToolExecutionEvidence {
  id: string;
  callHash: string;
  toolName: string;
  status: ToolExecutionStatus;
  inputHash: string;
  outputHash: string | null;
  paths: string[];
  durationMs: number;
  createdAt: string;
}

export interface ToolEvidenceIntent {
  callHash: string;
  toolName: string;
  inputHash: string;
}

export interface ToolEvidencePreparation {
  id: string;
  token: string;
}

export interface ToolEvidenceReceipt extends ToolEvidencePreparation {
  runtimeProof: string;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface RuntimeTool {
  modelTool: ModelTool;
  permission: PermissionClass;
  execute(
    argumentsValue: unknown,
    context: ToolExecutionContext,
  ): Promise<{ output: string; paths?: string[] }>;
}

export interface ToolRuntimeOptions {
  workspaceRoot: string;
  workItemId: string;
  policy: ToolPolicy;
  tools: RuntimeTool[];
  isApproved?: (callHash: string, toolName: string) => boolean;
  prepareEvidence?: (
    intent: ToolEvidenceIntent,
  ) => ToolEvidencePreparation | Promise<ToolEvidencePreparation>;
  onEvidence?: (
    evidence: ToolExecutionEvidence,
    receipt?: ToolEvidenceReceipt,
  ) => void | Promise<void>;
}

export interface ToolLoopResult {
  inference: InferenceResult;
  evidence: ToolExecutionEvidence[];
  iterations: number;
}

export interface ApprovedToolCallResult {
  output: string;
  evidence: ToolExecutionEvidence;
}

export interface WorkspaceWriteRequestSummary {
  title: string;
  changeCount: 1;
  totalBytes: number;
  changes: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string;
    byteSize: number;
  }>;
}

export class ToolApprovalRequiredError extends Error {
  readonly code = "TOOL_APPROVAL_REQUIRED";
  readonly callHash: string;
  readonly toolName: string;
  readonly call: ModelToolCall;
  readonly summary: WorkspaceWriteRequestSummary | null;

  constructor(
    callHash: string,
    toolName: string,
    call: ModelToolCall,
    summary: WorkspaceWriteRequestSummary | null = null,
  ) {
    super(
      `TOOL_APPROVAL_REQUIRED: approve exact call hash ${callHash} for '${toolName}'.`,
    );
    this.name = "ToolApprovalRequiredError";
    this.callHash = callHash;
    this.toolName = toolName;
    this.call = {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
    this.summary = summary;
  }
}

export class ToolIterationLimitError extends Error {
  readonly code = "TOOL_ITERATION_LIMIT";

  constructor(limit: number) {
    super(`TOOL_ITERATION_LIMIT: model exceeded ${limit} tool iterations.`);
    this.name = "ToolIterationLimitError";
  }
}

export class ToolEvidenceCommitError extends Error {
  readonly code = "TOOL_OUTCOME_UNKNOWN";
  readonly callHash: string;
  readonly toolName: string;

  constructor(callHash: string, toolName: string, cause: unknown) {
    super(
      `TOOL_OUTCOME_UNKNOWN: '${toolName}' returned, but its execution evidence could not be committed.`,
      { cause },
    );
    this.name = "ToolEvidenceCommitError";
    this.callHash = callHash;
    this.toolName = toolName;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  const content =
    typeof value === "string"
      ? value
      : JSON.stringify(stableValue(value));
  return createHash("sha256").update(content).digest("hex");
}

const runtimeReceiptProofs = new WeakMap<ToolEvidenceReceipt, string>();

function createRuntimeReceipt(
  workItemId: string,
  evidence: ToolExecutionEvidence,
  preparation: ToolEvidencePreparation,
): ToolEvidenceReceipt {
  const receipt = Object.freeze({
    ...preparation,
    runtimeProof: randomUUID(),
  });
  runtimeReceiptProofs.set(
    receipt,
    digest({ workItemId, evidence, receipt }),
  );
  return receipt;
}

export function verifyToolRuntimeReceipt(
  workItemId: string,
  evidence: ToolExecutionEvidence,
  receipt: ToolEvidenceReceipt,
): boolean {
  return (
    runtimeReceiptProofs.get(receipt) ===
    digest({ workItemId, evidence, receipt })
  );
}

function declaredPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const paths = [
    ...(typeof record.path === "string" ? [record.path] : []),
    ...(Array.isArray(record.paths)
      ? record.paths.filter((entry): entry is string =>
          typeof entry === "string"
        )
      : []),
  ];
  return [...new Set(paths)].slice(0, 32);
}

function malformedToolArguments(
  value: unknown,
  toolName?: string,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Tool arguments must be a JSON object.";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.unparsed === "string") {
    return "The model returned tool arguments that were not valid complete JSON.";
  }
  if (toolName === "workspace.write_file") {
    if (record.changeSet !== undefined) {
      if (
        !record.changeSet ||
        typeof record.changeSet !== "object" ||
        Array.isArray(record.changeSet)
      ) {
        return "workspace.write_file changeSet must be an object.";
      }
      const changeSet = record.changeSet as Record<string, unknown>;
      if (
        changeSet.apiVersion !== "chartermesh.dev/workspace-change-set/v1alpha1" ||
        !Array.isArray(changeSet.changes) ||
        changeSet.changes.length < 1 ||
        changeSet.changes.length > 50
      ) {
        return "workspace.write_file changeSet requires version v1alpha1 and 1 through 50 changes.";
      }
      let totalBytes = 0;
      const seenPaths = new Set<string>();
      for (const value of changeSet.changes) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return "Each workspace.write_file change must be an object.";
        }
        const change = value as Record<string, unknown>;
        if (
          typeof change.path !== "string" ||
          !change.path.trim() ||
          typeof change.content !== "string" ||
          (change.beforeSha256 !== null &&
            (typeof change.beforeSha256 !== "string" ||
              !/^[a-f0-9]{64}$/u.test(change.beforeSha256)))
        ) {
          return "Each workspace.write_file change requires path, content, and a SHA-256 or null beforeSha256.";
        }
        try {
          const path = governedWritePath(change.path);
          const key = path.toLocaleLowerCase("en-US");
          if (seenPaths.has(key)) {
            return "workspace.write_file changeSet paths must be case-folded unique.";
          }
          seenPaths.add(key);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        totalBytes += Buffer.byteLength(change.content, "utf8");
      }
      if (totalBytes > 1_048_576) {
        return "workspace.write_file changeSet content exceeds 1048576 UTF-8 bytes.";
      }
      return null;
    }
    if (typeof record.path !== "string" || !record.path.trim()) {
      return "workspace.write_file requires a non-empty path.";
    }
    try {
      governedWritePath(record.path);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const hasContent = typeof record.content === "string";
    const hasReplacements = Array.isArray(record.replacements);
    if (hasContent === hasReplacements) {
      return "workspace.write_file requires exactly one mode: content or replacements.";
    }
    if (
      hasContent &&
      Buffer.byteLength(record.content as string, "utf8") > 262_144
    ) {
      return "workspace.write_file content exceeds 262144 UTF-8 bytes.";
    }
    if (
      hasContent &&
      record.beforeSha256 !== null &&
      (typeof record.beforeSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.beforeSha256))
    ) {
      return "Content mode requires beforeSha256 as the complete current-file SHA-256, or null only when the target is absent.";
    }
    if (hasReplacements) {
      if (
        typeof record.expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.expectedSha256)
      ) {
        return "Replacement mode requires a lowercase 64-character expectedSha256.";
      }
      const replacements = record.replacements as unknown[];
      if (replacements.length < 1 || replacements.length > 20) {
        return "Replacement mode requires from 1 through 20 replacements.";
      }
      for (const replacement of replacements) {
        if (
          !replacement ||
          typeof replacement !== "object" ||
          Array.isArray(replacement)
        ) {
          return "Each replacement must be a JSON object.";
        }
        const edit = replacement as Record<string, unknown>;
        if (
          typeof edit.oldText !== "string" ||
          edit.oldText.length === 0 ||
          typeof edit.newText !== "string"
        ) {
          return "Each replacement requires non-empty oldText and string newText.";
        }
        const expectedOccurrences = edit.expectedOccurrences ?? 1;
        if (
          !Number.isInteger(expectedOccurrences) ||
          Number(expectedOccurrences) < 1 ||
          Number(expectedOccurrences) > 100
        ) {
          return "Replacement expectedOccurrences must be an integer from 1 through 100.";
        }
      }
    }
  }
  return null;
}

export function toolCallHash(
  workItemId: string,
  call: Pick<ModelToolCall, "name" | "arguments">,
): string {
  return digest({
    apiVersion: "chartermesh.dev/tool-call/v1alpha1",
    workItemId,
    toolName: call.name,
    arguments: call.arguments,
  });
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus: "unknown",
  };
}

function mergeUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const sum = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens),
    outputTokens: sum(left.outputTokens, right.outputTokens),
    cacheReadTokens: sum(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: sum(left.cacheWriteTokens, right.cacheWriteTokens),
    cost: sum(left.cost, right.cost),
    measurementStatus:
      left.measurementStatus === "measured" &&
      right.measurementStatus === "measured"
        ? "measured"
        : left.measurementStatus === "estimated" ||
            right.measurementStatus === "estimated"
          ? "estimated"
          : "unknown",
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function cleanRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tool argument 'path' must be a non-empty string.");
  }
  if (value.includes("\0") || isAbsolute(value)) {
    throw new Error("Tool paths must be relative and cannot contain NUL.");
  }
  return value;
}

function governedWritePath(value: unknown): string {
  const raw = cleanRelativePath(value);
  if (/^[\\/]/u.test(raw)) {
    throw new Error("WORKSPACE_PATH_DENIED: write paths must be relative.");
  }
  const segments = raw.replaceAll("\\", "/").split("/");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    segments.some((segment) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      /[:\u0000-\u001f]/u.test(segment) ||
      /[. ]$/u.test(segment) ||
      reserved.test(segment)
    )
  ) {
    throw new Error(
      "WORKSPACE_PATH_DENIED: write path uses an empty/dot segment, Windows namespace, device name, ADS, control character, or trailing dot/space alias.",
    );
  }
  const folded = segments.map((segment) => segment.toLocaleLowerCase("en-US"));
  if (
    folded.some((segment) =>
      [".chartermesh", ".git", ".codex", ".claude"].includes(segment)
    ) ||
    folded.some((segment) => ["agents.md", "claude.md", "codex.md"].includes(segment))
  ) {
    throw new Error(
      "WORKSPACE_CONTROL_PATH_DENIED: project-state, VCS, or coding-host control paths require a separate configuration plan.",
    );
  }
  return segments.join("/");
}

function canonicalAllowedRoots(
  workspaceRoot: string,
  policy: ToolPolicy,
): string[] {
  const root = realpathSync.native(workspaceRoot);
  return (policy.workspaceRoots ?? ["."]).map((entry) => {
    const relativePath = cleanRelativePath(entry);
    const candidate = resolve(root, relativePath);
    if (!isWithin(root, candidate)) {
      throw new Error(`Workspace root '${entry}' escapes the target project.`);
    }
    if (!existsSync(candidate)) {
      throw new Error(`Workspace root '${entry}' does not exist.`);
    }
    const canonical = realpathSync.native(candidate);
    if (!isWithin(root, canonical)) {
      throw new Error(`Workspace root '${entry}' resolves outside the project.`);
    }
    return canonical;
  });
}

function canonicalPath(
  workspaceRoot: string,
  policy: ToolPolicy,
  value: unknown,
  mode: "read" | "write",
): { absolute: string; display: string; canonical: string } {
  const display = mode === "write"
    ? governedWritePath(value)
    : cleanRelativePath(value);
  const root = realpathSync.native(workspaceRoot);
  const absolute = resolve(root, display);
  if (!isWithin(root, absolute)) {
    throw new Error(`Path '${display}' escapes the workspace.`);
  }
  const allowedRoots = canonicalAllowedRoots(root, policy);
  let canonical: string;
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Symbolic-link target '${display}' is not allowed.`);
    }
    canonical = realpathSync.native(absolute);
  } else {
    if (mode === "read") throw new Error(`Path '${display}' does not exist.`);
    let ancestor = dirname(absolute);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    canonical = resolve(
      realpathSync.native(ancestor),
      relative(ancestor, absolute),
    );
  }
  if (!allowedRoots.some((allowed) => isWithin(allowed, canonical))) {
    throw new Error(`Path '${display}' is outside OrgSpec workspaceRoots.`);
  }
  if (mode === "write") {
    governedWritePath(relative(root, canonical).replaceAll("\\", "/"));
  }
  return { absolute, display, canonical };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function occurrenceCount(content: string, search: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - search.length) {
    const next = content.indexOf(search, cursor);
    if (next === -1) break;
    count += 1;
    cursor = next + search.length;
  }
  return count;
}

function canonicalIdentity(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

function sameFileIdentity(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openVerifiedRegularFile(
  path: string,
  expectedCanonical: string,
): number {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Path '${path}' is not a regular non-linked file.`);
  }
  const beforeCanonical = realpathSync.native(path);
  if (
    canonicalIdentity(beforeCanonical) !== canonicalIdentity(expectedCanonical)
  ) {
    throw new Error(`WORKSPACE_PATH_RACE: '${path}' changed after validation.`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    const after = lstatSync(path);
    const afterCanonical = realpathSync.native(path);
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened) ||
      canonicalIdentity(afterCanonical) !== canonicalIdentity(expectedCanonical)
    ) {
      throw new Error(`WORKSPACE_PATH_RACE: '${path}' changed while opening.`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openVerifiedDirectory(
  path: string,
  expectedCanonical: string,
): { descriptor: number; identity: ReturnType<typeof lstatSync> } {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Path '${path}' is not a regular non-linked directory.`);
  }
  if (
    canonicalIdentity(realpathSync.native(path)) !==
      canonicalIdentity(expectedCanonical)
  ) {
    throw new Error(`WORKSPACE_PATH_RACE: '${path}' changed after validation.`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const directoryOnly = typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  const descriptor = openSync(
    path,
    constants.O_RDONLY | noFollow | directoryOnly,
  );
  try {
    const opened = fstatSync(descriptor);
    const after = lstatSync(path);
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened) ||
      canonicalIdentity(realpathSync.native(path)) !==
        canonicalIdentity(expectedCanonical)
    ) {
      throw new Error(`WORKSPACE_PATH_RACE: '${path}' changed while opening.`);
    }
    return { descriptor, identity: before };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertDirectoryIdentity(
  path: string,
  expectedCanonical: string,
  expected: ReturnType<typeof lstatSync>,
  descriptor: number,
): void {
  const current = lstatSync(path);
  const opened = fstatSync(descriptor);
  if (
    !opened.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(expected, opened) ||
    !sameFileIdentity(current, opened) ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    canonicalIdentity(realpathSync.native(path)) !==
      canonicalIdentity(expectedCanonical)
  ) {
    throw new Error(`WORKSPACE_PATH_RACE: directory '${path}' changed while open.`);
  }
}

function digestRegularFile(path: string, expectedCanonical: string): string {
  const descriptor = openVerifiedRegularFile(path, expectedCanonical);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function hashBoundedRegularFile(
  path: string,
  expectedCanonical: string,
  maximumBytes: number,
): { byteSize: number; sha256: string } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("maximumBytes must be a non-negative safe integer.");
  }
  const descriptor = openVerifiedRegularFile(path, expectedCanonical);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let byteSize = 0;
  try {
    const opened = fstatSync(descriptor);
    if (opened.size > maximumBytes) {
      throw new Error(
        `REGULAR_FILE_SIZE_LIMIT: '${path}' exceeds ${maximumBytes} bytes.`,
      );
    }
    for (;;) {
      const length = readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      byteSize += length;
      if (byteSize > maximumBytes) {
        throw new Error(
          `REGULAR_FILE_SIZE_LIMIT: '${path}' exceeds ${maximumBytes} bytes.`,
        );
      }
      hash.update(chunk.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return { byteSize, sha256: hash.digest("hex") };
}

function inspectBoundedTextFile(
  path: string,
  expectedCanonical: string,
  maximum: number,
): { byteSize: number; prefix: Buffer; sha256: string } {
  const descriptor = openVerifiedRegularFile(path, expectedCanonical);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const prefix = Buffer.allocUnsafe(maximum);
  let prefixLength = 0;
  let byteSize = 0;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Path '${path}' is not a regular file.`);
    }
    for (;;) {
      const length = readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      const current = chunk.subarray(0, length);
      if (current.includes(0)) {
        throw new Error(`Path '${path}' is not a UTF-8 text file.`);
      }
      hash.update(current);
      byteSize += length;
      if (prefixLength < maximum) {
        const copied = Math.min(length, maximum - prefixLength);
        current.copy(prefix, prefixLength, 0, copied);
        prefixLength += copied;
      }
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    byteSize,
    prefix: prefix.subarray(0, prefixLength),
    sha256: hash.digest("hex"),
  };
}

interface PlannedWorkspaceWrite {
  path: { absolute: string; display: string };
  content: string;
  beforeSha256: string | null;
  afterSha256: string;
  mode: "content" | "replacements";
  replacementCount: number;
}

function planWorkspaceWrite(
  workspaceRoot: string,
  policy: ToolPolicy,
  value: unknown,
): PlannedWorkspaceWrite {
  const args = objectArguments(value);
  const path = canonicalPath(workspaceRoot, policy, args.path, "write");
  let content: string;
  let beforeSha256: string | null;
  const replacements = Array.isArray(args.replacements)
    ? (args.replacements as Array<Record<string, unknown>>)
    : null;
  if (replacements) {
    const current = inspectBoundedTextFile(
      path.absolute,
      path.canonical,
      262_145,
    );
    if (current.byteSize > 262_144) {
      throw new Error(
        `Replacement target '${path.display}' exceeds the 262144-byte limit.`,
      );
    }
    beforeSha256 = current.sha256;
    if (beforeSha256 !== args.expectedSha256) {
      throw new Error(
        `Replacement target '${path.display}' changed after planning: expected ${String(
          args.expectedSha256,
        )}, found ${beforeSha256}.`,
      );
    }
    content = current.prefix.toString("utf8");
    for (const replacement of replacements) {
      const oldText = String(replacement.oldText);
      const newText = String(replacement.newText);
      const expectedOccurrences = Number(replacement.expectedOccurrences ?? 1);
      const found = occurrenceCount(content, oldText);
      if (found !== expectedOccurrences) {
        throw new Error(
          `Replacement in '${path.display}' expected ${expectedOccurrences} occurrence(s), found ${found}.`,
        );
      }
      content = content.split(oldText).join(newText);
    }
  } else if (typeof args.content === "string") {
    content = args.content;
    beforeSha256 = args.beforeSha256 === null
      ? null
      : String(args.beforeSha256);
    const metadata = existsSync(path.absolute) ? lstatSync(path.absolute) : null;
    if (beforeSha256 === null) {
      if (metadata) {
        throw new Error(
          `Target changed after planning: content target '${path.display}' exists but beforeSha256 was null.`,
        );
      }
    } else {
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `Target changed after planning: content target '${path.display}' is not an existing regular file.`,
        );
      }
      const currentSha256 = digestRegularFile(
        path.absolute,
        path.canonical,
      );
      if (currentSha256 !== beforeSha256) {
        throw new Error(
          `Target changed after planning: content target '${path.display}' expected ${beforeSha256}, found ${currentSha256}.`,
        );
      }
    }
  } else {
    throw new Error("workspace.write_file requires content or exact replacements.");
  }
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > 262_144) {
    throw new Error("Resulting UTF-8 file exceeds the 262144-byte limit.");
  }
  return {
    path,
    content,
    beforeSha256,
    afterSha256: digest(content),
    mode: replacements ? "replacements" : "content",
    replacementCount: replacements?.length ?? 0,
  };
}

export function summarizeWorkspaceWriteRequest(
  workspaceRoot: string,
  policy: ToolPolicy,
  value: unknown,
): WorkspaceWriteRequestSummary {
  const plan = planWorkspaceWrite(workspaceRoot, policy, value);
  const byteSize = Buffer.byteLength(plan.content, "utf8");
  return {
    title: `Workspace file ${plan.beforeSha256 === null ? "creation" : "replacement"}`,
    changeCount: 1,
    totalBytes: byteSize,
    changes: [{
      path: plan.path.display,
      beforeSha256: plan.beforeSha256,
      afterSha256: plan.afterSha256,
      byteSize,
    }],
  };
}

export function createWorkspaceTools(
  workspaceRoot: string,
  policy: ToolPolicy,
): RuntimeTool[] {
  return [
    {
      modelTool: {
        name: "workspace.list_files",
        description:
          "List one directory inside the approved workspace roots. This does not recurse.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1 },
            maxEntries: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
      },
      permission: "read_only",
      async execute(value) {
        const args = objectArguments(value);
        const path = canonicalPath(
          workspaceRoot,
          policy,
          args.path,
          "read",
        );
        const maximum = Math.min(
          200,
          Math.max(1, Number(args.maxEntries ?? 100)),
        );
        const verified = openVerifiedDirectory(path.absolute, path.canonical);
        let directory: ReturnType<typeof opendirSync> | undefined;
        const entries: Array<{ name: string; kind: string }> = [];
        try {
          directory = opendirSync(path.absolute);
          assertDirectoryIdentity(
            path.absolute,
            path.canonical,
            verified.identity,
            verified.descriptor,
          );
          while (entries.length < maximum) {
            const entry = directory.readSync();
            if (!entry) break;
            entries.push({
            name: entry.name,
            kind: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
            });
            assertDirectoryIdentity(
              path.absolute,
              path.canonical,
              verified.identity,
              verified.descriptor,
            );
          }
          assertDirectoryIdentity(
            path.absolute,
            path.canonical,
            verified.identity,
            verified.descriptor,
          );
        } finally {
          try {
            directory?.closeSync();
          } finally {
            closeSync(verified.descriptor);
          }
        }
        return {
          output: JSON.stringify({ path: path.display, entries }),
          paths: [path.display],
        };
      },
    },
    {
      modelTool: {
        name: "workspace.read_file",
        description:
          "Read a bounded UTF-8 text file inside the approved workspace roots. The result includes the SHA-256 of the complete file for exact replacement writes.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1 },
            maxBytes: {
              type: "integer",
              minimum: 1,
              maximum: 65_536,
            },
          },
        },
      },
      permission: "read_only",
      async execute(value) {
        const args = objectArguments(value);
        const path = canonicalPath(
          workspaceRoot,
          policy,
          args.path,
          "read",
        );
        if (!lstatSync(path.absolute).isFile()) {
          throw new Error(`Path '${path.display}' is not a regular file.`);
        }
        const maximum = Math.min(
          65_536,
          Math.max(1, Number(args.maxBytes ?? 32_768)),
        );
        const content = inspectBoundedTextFile(
          path.absolute,
          path.canonical,
          maximum,
        );
        return {
          output: JSON.stringify({
            path: path.display,
            truncated: content.byteSize > maximum,
            sha256: content.sha256,
            content: content.prefix.toString("utf8"),
          }),
          paths: [path.display],
        };
      },
    },
    {
      modelTool: {
        name: "workspace.write_file",
        description:
          "Create or replace one UTF-8 text file inside the approved workspace roots with an exact content precondition and recoverable atomic transaction. For content mode, beforeSha256 is null only for a new absent path, otherwise it is the complete current-file hash. Prefer replacements for small exact edits. Exact-call human approval is required.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1 },
            content: {
              type: "string",
              maxLength: 262_144,
              description:
                "Exact raw UTF-8 file text after JSON parsing. Source quotes and line breaks must not remain pervasively backslash-escaped.",
            },
            beforeSha256: {
              anyOf: [
                { type: "string", pattern: "^[a-f0-9]{64}$" },
                { type: "null" },
              ],
              description:
                "Complete current-file SHA-256, or null only when the target does not exist.",
            },
            expectedSha256: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
              description:
                "Required in replacement mode; must match the complete current file.",
            },
            replacements: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              description:
                "Exact bounded edits applied in order. Omit content when using this mode.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["oldText", "newText"],
                properties: {
                  oldText: { type: "string", minLength: 1 },
                  newText: { type: "string" },
                  expectedOccurrences: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    default: 1,
                  },
                },
              },
            },
          },
          oneOf: [
            {
              required: ["content", "beforeSha256"],
              not: { required: ["replacements"] },
            },
            {
              required: ["expectedSha256", "replacements"],
              not: { required: ["content"] },
            },
          ],
        },
      },
      permission: "workspace_write",
      async execute(value) {
        const plan = planWorkspaceWrite(workspaceRoot, policy, value);
        applyFileTransaction(
          workspaceRoot,
          `runtime-${digest({
            path: plan.path.display,
            beforeSha256: plan.beforeSha256,
            afterSha256: plan.afterSha256,
          }).slice(0, 48)}`,
          [{
            path: plan.path.absolute,
            content: plan.content,
            beforeHash: plan.beforeSha256,
            afterHash: plan.afterSha256,
          }],
          { denyHostControlPaths: true },
        );
        return {
          output: JSON.stringify({
            path: plan.path.display,
            mode: plan.mode,
            replacements: plan.replacementCount,
            beforeSha256: plan.beforeSha256,
            byteSize: Buffer.byteLength(plan.content, "utf8"),
            sha256: plan.afterSha256,
          }),
          paths: [plan.path.display],
        };
      },
    },
  ];
}

function snapshotToolPolicy(input: ToolPolicy): ToolPolicy {
  const policy: ToolPolicy = {
    ...input,
    allow: [...input.allow],
    ...(input.approvalRequired
      ? { approvalRequired: [...input.approvalRequired] }
      : {}),
    ...(input.workspaceRoots
      ? { workspaceRoots: [...input.workspaceRoots] }
      : {}),
  };
  Object.freeze(policy.allow);
  if (policy.approvalRequired) Object.freeze(policy.approvalRequired);
  if (policy.workspaceRoots) Object.freeze(policy.workspaceRoots);
  return Object.freeze(policy);
}

export class ToolRuntime {
  readonly #workspaceRoot: string;
  readonly #workItemId: string;
  readonly #policy: ToolPolicy;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #isApproved: (callHash: string, toolName: string) => boolean;
  readonly #prepareEvidence?: ToolRuntimeOptions["prepareEvidence"];
  readonly #onEvidence?: ToolRuntimeOptions["onEvidence"];

  constructor(options: ToolRuntimeOptions) {
    this.#workspaceRoot = realpathSync(options.workspaceRoot);
    this.#workItemId = options.workItemId;
    this.#policy = snapshotToolPolicy(options.policy);
    this.#tools = new Map(
      options.tools.map((tool) => [tool.modelTool.name, tool]),
    );
    this.#isApproved = options.isApproved ?? (() => false);
    this.#prepareEvidence = options.prepareEvidence;
    this.#onEvidence = options.onEvidence;
    const maximum = this.#policy.maxIterations ?? 4;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 12) {
      throw new Error("Tool maxIterations must be an integer from 1 through 12.");
    }
    for (const name of this.#policy.approvalRequired ?? []) {
      if (!this.#policy.allow.includes(name)) {
        throw new Error(
          `Approval-required tool '${name}' is not in the OrgSpec allowlist.`,
        );
      }
    }
    canonicalAllowedRoots(this.#workspaceRoot, this.#policy);
  }

  modelTools(): ModelTool[] {
    return this.#policy.allow.flatMap((name) => {
      const tool = this.#tools.get(name);
      return tool ? [tool.modelTool] : [];
    });
  }

  async #record(
    evidence: ToolExecutionEvidence,
    collection: ToolExecutionEvidence[],
    preparation?: ToolEvidencePreparation,
  ): Promise<void> {
    collection.push(evidence);
    const receipt = preparation
      ? createRuntimeReceipt(this.#workItemId, evidence, preparation)
      : undefined;
    await this.#onEvidence?.(evidence, receipt);
  }

  async #prepare(
    call: ModelToolCall,
  ): Promise<ToolEvidencePreparation | undefined> {
    return this.#prepareEvidence?.({
      callHash: toolCallHash(this.#workItemId, call),
      toolName: call.name,
      inputHash: digest(call.arguments),
    });
  }

  #evidence(
    call: ModelToolCall,
    status: ToolExecutionStatus,
    started: number,
    output: string | null,
    paths: string[] = [],
  ): ToolExecutionEvidence {
    return {
      id: `tool-evidence-${randomUUID()}`,
      callHash: toolCallHash(this.#workItemId, call),
      toolName: call.name,
      status,
      inputHash: digest(call.arguments),
      outputHash: output === null ? null : digest(output),
      paths,
      durationMs: Math.max(0, Date.now() - started),
      createdAt: new Date().toISOString(),
    };
  }

  async executeApprovedCall(
    call: ModelToolCall,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovedToolCallResult> {
    const evidence: ToolExecutionEvidence[] = [];
    const started = Date.now();
    const callHash = toolCallHash(this.#workItemId, call);
    const receipt = await this.#prepare(call);
    const tool = this.#tools.get(call.name);
    if (!tool || !this.#policy.allow.includes(call.name)) {
      const output = JSON.stringify({
        ok: false,
        code: "TOOL_DENIED",
        message: `Tool '${call.name}' is not allowed by OrgSpec.`,
      });
      await this.#record(
        this.#evidence(
          call,
          "denied",
          started,
          output,
          declaredPaths(call.arguments),
        ),
        evidence,
        receipt,
      );
      throw new Error(`TOOL_DENIED: '${call.name}' is not allowed by OrgSpec.`);
    }
    const malformed = malformedToolArguments(call.arguments, call.name);
    if (malformed) {
      const output = JSON.stringify({
        ok: false,
        code: "TOOL_ARGUMENTS_INVALID",
        message: malformed,
      });
      await this.#record(
        this.#evidence(
          call,
          "failed",
          started,
          output,
          declaredPaths(call.arguments),
        ),
        evidence,
        receipt,
      );
      throw new Error(`TOOL_ARGUMENTS_INVALID: ${malformed}`);
    }
    const approvalRequired =
      tool.permission !== "read_only" ||
      (this.#policy.approvalRequired ?? []).includes(call.name);
    if (approvalRequired && !this.#isApproved(callHash, call.name)) {
      let summary: WorkspaceWriteRequestSummary | null = null;
      if (call.name === "workspace.write_file") {
        try {
          summary = summarizeWorkspaceWriteRequest(
            this.#workspaceRoot,
            this.#policy,
            call.arguments,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_PRECONDITION_FAILED",
            message,
          }).slice(0, 8_000);
          await this.#record(
            this.#evidence(
              call,
              "failed",
              started,
              output,
              declaredPaths(call.arguments),
            ),
            evidence,
            receipt,
          );
          throw new Error(`TOOL_PRECONDITION_FAILED: ${message}`);
        }
      }
      await this.#record(
        this.#evidence(
          call,
          "approval_required",
          started,
          null,
          declaredPaths(call.arguments),
        ),
        evidence,
        receipt,
      );
      throw new ToolApprovalRequiredError(
        callHash,
        call.name,
        call,
        summary,
      );
    }
    let result: Awaited<ReturnType<RuntimeTool["execute"]>>;
    try {
      options.signal?.throwIfAborted();
      result = await tool.execute(call.arguments, {
        workspaceRoot: this.#workspaceRoot,
        signal: options.signal,
      });
    } catch (error) {
      const output = JSON.stringify({
        ok: false,
        code: "TOOL_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }).slice(0, 8_000);
      const record = this.#evidence(
        call,
        "failed",
        started,
        output,
        declaredPaths(call.arguments),
      );
      await this.#record(record, evidence, receipt);
      throw new Error(
        `TOOL_EXECUTION_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const output = result.output.slice(0, 65_536);
    const record = this.#evidence(
      call,
      "succeeded",
      started,
      output,
      result.paths ?? declaredPaths(call.arguments),
    );
    try {
      await this.#record(record, evidence, receipt);
    } catch (error) {
      throw new ToolEvidenceCommitError(callHash, call.name, error);
    }
    return { output, evidence: record };
  }

  async run(
    engine: ModelEngine,
    request: InferenceRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolLoopResult> {
    const evidence: ToolExecutionEvidence[] = [];
    const messages = [...request.messages];
    const maximum = this.#policy.maxIterations ?? 4;
    let usage: ModelUsage | undefined;
    for (let iteration = 0; iteration <= maximum; iteration += 1) {
      const inference = await engine.generate(
        {
          ...request,
          invocationId: `${request.invocationId}:tool-${iteration + 1}`,
          messages,
          tools: this.modelTools(),
        },
        options,
      );
      usage = usage
        ? mergeUsage(usage, inference.usage)
        : inference.usage;
      if (inference.toolCalls.length === 0) {
        return {
          inference: { ...inference, usage: usage ?? emptyUsage() },
          evidence,
          iterations: iteration + 1,
        };
      }
      if (iteration === maximum) {
        throw new ToolIterationLimitError(maximum);
      }
      messages.push({
        role: "assistant",
        content: inference.text,
        toolCalls: inference.toolCalls,
      });
      for (const call of inference.toolCalls) {
        const started = Date.now();
        const callHash = toolCallHash(this.#workItemId, call);
        const receipt = await this.#prepare(call);
        const tool = this.#tools.get(call.name);
        if (!tool || !this.#policy.allow.includes(call.name)) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_DENIED",
            message: `Tool '${call.name}' is not allowed by OrgSpec.`,
          });
          await this.#record(
            this.#evidence(call, "denied", started, output),
            evidence,
            receipt,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: output,
          });
          continue;
        }
        const malformed = malformedToolArguments(call.arguments, call.name);
        if (malformed) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_ARGUMENTS_INVALID",
            message: malformed,
          });
          await this.#record(
            this.#evidence(
              call,
              "failed",
              started,
              output,
              declaredPaths(call.arguments),
            ),
            evidence,
            receipt,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: output,
          });
          continue;
        }
        const approvalRequired =
          tool.permission !== "read_only" ||
          (this.#policy.approvalRequired ?? []).includes(call.name);
        if (
          approvalRequired &&
          !this.#isApproved(callHash, call.name)
        ) {
          let summary: WorkspaceWriteRequestSummary | null = null;
          if (call.name === "workspace.write_file") {
            try {
              summary = summarizeWorkspaceWriteRequest(
                this.#workspaceRoot,
                this.#policy,
                call.arguments,
              );
            } catch (error) {
              const output = JSON.stringify({
                ok: false,
                code: "TOOL_PRECONDITION_FAILED",
                message: error instanceof Error ? error.message : String(error),
              }).slice(0, 8_000);
              await this.#record(
                this.#evidence(
                  call,
                  "failed",
                  started,
                  output,
                  declaredPaths(call.arguments),
                ),
                evidence,
                receipt,
              );
              messages.push({
                role: "tool",
                toolCallId: call.id,
                content: output,
              });
              continue;
            }
          }
          await this.#record(
            this.#evidence(
              call,
              "approval_required",
              started,
              null,
              declaredPaths(call.arguments),
            ),
            evidence,
            receipt,
          );
          throw new ToolApprovalRequiredError(
            callHash,
            call.name,
            call,
            summary,
          );
        }
        let result: Awaited<ReturnType<RuntimeTool["execute"]>>;
        try {
          options.signal?.throwIfAborted();
          result = await tool.execute(call.arguments, {
            workspaceRoot: this.#workspaceRoot,
            signal: options.signal,
          });
        } catch (error) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_EXECUTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }).slice(0, 8_000);
          await this.#record(
            this.#evidence(call, "failed", started, output),
            evidence,
            receipt,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: output,
          });
          continue;
        }
        const output = result.output.slice(0, 65_536);
        const record = this.#evidence(
          call,
          "succeeded",
          started,
          output,
          result.paths ?? [],
        );
        try {
          await this.#record(record, evidence, receipt);
        } catch (error) {
          throw new ToolEvidenceCommitError(callHash, call.name, error);
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: output,
        });
      }
    }
    throw new ToolIterationLimitError(maximum);
  }
}

export function createWorkspaceToolRuntime(
  options: Omit<ToolRuntimeOptions, "tools"> & {
    additionalTools?: RuntimeTool[];
  },
): ToolRuntime {
  const { additionalTools = [], ...runtimeOptions } = options;
  const policy = snapshotToolPolicy(options.policy);
  return new ToolRuntime({
    ...runtimeOptions,
    policy,
    tools: [
      ...createWorkspaceTools(options.workspaceRoot, policy),
      ...additionalTools,
    ],
  });
}
