import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import {
  ControlPlane,
  assertMaintenanceInactive,
  normalizeArtifactProducerReport,
  openControlPlaneDatabase,
  type ArtifactProducerReport,
} from "../../../packages/control-plane/src/index.ts";
import { parseOrgSpec } from "../../../packages/orgspec/src/index.ts";
import type { ToolPolicy } from "../../../packages/orgspec/src/index.ts";
import {
  applyFileTransaction,
  recoverFileTransaction,
} from "../../../packages/compiler/src/index.ts";
import {
  createWorkspaceToolRuntime,
  hashBoundedRegularFile,
  assertNoLinkedPathComponents,
  readBoundedRegularText,
  resolveProjectStatePaths,
  toolCallHash,
  type RuntimeTool,
  type ToolEvidenceReceipt,
  type ToolExecutionEvidence,
} from "../../../packages/runtime/src/index.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
]);
const MCP_SERVER_NAME = "chartermesh-control-plane";
const MCP_SERVER_VERSION = "0.0.10-alpha.1";
const MCP_RESULT_VERSION = "chartermesh.dev/mcp-result/v1alpha1";
const MAX_REQUEST_BYTES = 7_500_000;
const MAX_ARTIFACT_INPUT_BYTES = 1_000_000;
const MAX_ARTIFACT_RESPONSE_BYTES = 256_000;
const MAX_WORKSPACE_CHANGE_SET_BYTES = 1_048_576;
const MAX_WORKSPACE_CHANGE_COUNT = 50;
const READ_ONLY_MCP_TOOLS = new Set([
  "chartermesh_status",
  "chartermesh_work_list",
  "chartermesh_work_next",
  "chartermesh_work_show",
  "chartermesh_decision_show",
  "chartermesh_artifact_show",
  "chartermesh_run_show",
]);

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ControlPlaneMcpHandler {
  readonly sessionActor: string;
  handleMessage(
    message: unknown,
  ): JsonRpcResponse | Promise<JsonRpcResponse> | null;
  handleLine(
    line: string,
  ): JsonRpcResponse | Promise<JsonRpcResponse> | null;
}

export interface OpenControlPlaneMcpBridge {
  target: string;
  controlPlane: ControlPlane;
  handler: ControlPlaneMcpHandler;
  close(): void;
}

interface HandlerOptions {
  controlPlane: ControlPlane;
  actor?: string;
  allowedRoles?: string[];
  allowedExecutionTargets?: string[];
  workspaceRoot?: string;
  rolePolicies?: Readonly<Record<string, ToolPolicy>>;
  beforeMutation?: () => void;
}

interface OpenBridgeOptions {
  target: string;
  actor?: string;
  allowedRoles?: string[];
  allowedExecutionTargets?: string[];
}

interface StdioOptions extends OpenBridgeOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WritableStream, "write">;
}

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const idSchema = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

const idempotencyKeySchema = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
} as const;

const producerReportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "deliverable",
    "reportedChecks",
    "reportedRisks",
    "nextActions",
    "confidence",
  ],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
    deliverable: { type: "string", minLength: 1, maxLength: 300_000 },
    reportedChecks: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    reportedRisks: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    nextActions: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high", "unknown"],
    },
  },
} as const;

const workspaceChangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content", "beforeSha256"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1_000 },
    content: { type: "string", maxLength: MAX_WORKSPACE_CHANGE_SET_BYTES },
    beforeSha256: {
      anyOf: [
        { type: "string", pattern: "^[a-f0-9]{64}$" },
        { type: "null" },
      ],
    },
  },
} as const;

export const CONTROL_PLANE_MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "chartermesh_status",
    description:
      "Read local Control Plane health and the bounded dashboard summary. This tool never changes state.",
    inputSchema: emptyObjectSchema,
  },
  {
    name: "chartermesh_work_list",
    description:
      "List a bounded page of WorkItems from the CharterMesh Control Plane.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2_048 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        includeCompleted: { type: "boolean" },
        includeArchived: { type: "boolean" },
      },
    },
  },
  {
    name: "chartermesh_work_next",
    description:
      "Read the next claimable WorkItem and its immutable decision contract without claiming it.",
    inputSchema: emptyObjectSchema,
  },
  {
    name: "chartermesh_work_show",
    description:
      "Read one WorkItem, its decision contract, decision packet, evidence, and latest artifact metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: idSchema },
    },
  },
  {
    name: "chartermesh_decision_show",
    description:
      "Read the current hash-bound Decision Packet for one WorkItem. This tool cannot resolve it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: idSchema },
    },
  },
  {
    name: "chartermesh_artifact_show",
    description:
      "Read the latest immutable artifact. Content is returned only when it fits the requested bounded byte limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: idSchema,
        maxContentBytes: {
          type: "integer",
          minimum: 0,
          maximum: MAX_ARTIFACT_RESPONSE_BYTES,
        },
      },
    },
  },
  {
    name: "chartermesh_run_show",
    description:
      "Read one run's cancellation signal, bounded attempt history, and bounded model invocation history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: idSchema },
    },
  },
  {
    name: "chartermesh_work_claim",
    description:
      "Atomically claim a ready WorkItem with version checking and receive a fenced run, attempt, lease, and generation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "expectedVersion", "idempotencyKey"],
      properties: {
        id: idSchema,
        expectedVersion: { type: "integer", minimum: 1 },
        idempotencyKey: idempotencyKeySchema,
        leaseMinutes: { type: "integer", minimum: 1, maximum: 60 },
      },
    },
  },
  {
    name: "chartermesh_run_heartbeat",
    description:
      "Renew only the exact active run/attempt/lease tuple owned by the server-bound actor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "generation",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        idempotencyKey: idempotencyKeySchema,
        leaseMinutes: { type: "integer", minimum: 1, maximum: 60 },
      },
    },
  },
  {
    name: "chartermesh_work_progress",
    description:
      "Record bounded progress only for the caller's exact active run/attempt/lease tuple.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "expectedVersion",
        "generation",
        "summary",
        "nextAction",
        "idempotencyKey"
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        expectedVersion: { type: "integer", minimum: 1 },
        generation: { type: "integer", minimum: 1 },
        summary: { type: "string", minLength: 1, maxLength: 10_000 },
        nextAction: { type: "string", minLength: 1, maxLength: 2_000 },
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_work_block",
    description:
      "Release the caller's exact active lease and block work for explicit user input or a manual resume. This requests human action but cannot supply it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "expectedVersion",
        "generation",
        "type",
        "reason",
        "idempotencyKey"
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        expectedVersion: { type: "integer", minimum: 1 },
        generation: { type: "integer", minimum: 1 },
        type: { type: "string", enum: ["user_input", "manual_resume"] },
        reason: { type: "string", minLength: 1, maxLength: 2_000 },
        reference: { type: "string", minLength: 1, maxLength: 160 },
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_workspace_changes_request",
    description:
      "Request one hash-bound human approval for an exact atomic UTF-8 workspace change set (1-50 files, at most 1 MiB total). This cannot approve or execute it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "generation",
        "changes",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WORKSPACE_CHANGE_COUNT,
          items: workspaceChangeSchema,
        },
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_workspace_write_request",
    description:
      "Compatibility wrapper that requests exact-call approval for one UTF-8 file with an explicit content precondition. Prefer chartermesh_workspace_changes_request for bounded atomic batches.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "generation",
        "path",
        "content",
        "beforeSha256",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        path: { type: "string", minLength: 1, maxLength: 1_000 },
        content: {
          type: "string",
          maxLength: MAX_WORKSPACE_CHANGE_SET_BYTES,
        },
        beforeSha256: workspaceChangeSchema.properties.beforeSha256,
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_workspace_write_execute",
    description:
      "Execute only a previously human-approved workspace.write_file call with an exact active run fence, then record Tool Runtime evidence. This cannot grant approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "generation",
        "callHash",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        callHash: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_artifact_submit",
    description:
      "Submit one bounded immutable artifact from the caller's exact active run for exact-hash human review. This cannot approve the result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "attemptId",
        "leaseId",
        "generation",
        "content",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        attemptId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        content: {
          type: "string",
          minLength: 1,
          maxLength: MAX_ARTIFACT_INPUT_BYTES,
        },
        mediaType: { type: "string", minLength: 1, maxLength: 256 },
        producerReport: producerReportSchema,
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
  {
    name: "chartermesh_run_fail",
    description:
      "Settle the caller's active fenced run as failed with a bounded machine code and explanation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "runId",
        "leaseId",
        "generation",
        "attemptId",
        "errorCode",
        "errorMessage",
        "idempotencyKey",
      ],
      properties: {
        id: idSchema,
        runId: idSchema,
        leaseId: idSchema,
        generation: { type: "integer", minimum: 1 },
        attemptId: idSchema,
        errorCode: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[A-Z][A-Z0-9_]*$",
        },
        errorMessage: { type: "string", minLength: 1, maxLength: 1_000 },
        idempotencyKey: idempotencyKeySchema,
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectInput(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("arguments must be an object.");
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument field: ${unknown[0]}.`);
  }
  for (const key of requiredKeys) {
    if (!(key in value)) throw new Error(`Missing required argument: ${key}.`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  options: { pattern?: RegExp; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte.`);
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (Array.from(value).length > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return boundedString(value, label, 160, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  });
}

function idempotencyKey(value: unknown): string {
  return boundedString(value, "idempotencyKey", 200, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u,
  });
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, label, minimum, maximum);
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumCharacters: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be an array of at most ${maximumItems} strings.`);
  }
  return value.map((entry, index) =>
    boundedString(entry, `${label}[${index}]`, maximumCharacters)
  );
}

function producerReport(value: unknown): ArtifactProducerReport | undefined {
  if (value === undefined) return undefined;
  const input = objectInput(
    value,
    [
      "summary",
      "deliverable",
      "reportedChecks",
      "reportedRisks",
      "nextActions",
      "confidence",
    ],
    [
      "summary",
      "deliverable",
      "reportedChecks",
      "reportedRisks",
      "nextActions",
      "confidence",
    ],
  );
  const confidence = boundedString(input.confidence, "confidence", 16);
  if (!["low", "medium", "high", "unknown"].includes(confidence)) {
    throw new Error("confidence must be low, medium, high, or unknown.");
  }
  return normalizeArtifactProducerReport({
    apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1",
    source: "model_reported",
    summary: boundedString(input.summary, "producerReport.summary", 2_000),
    deliverable: boundedString(
      input.deliverable,
      "producerReport.deliverable",
      300_000,
    ),
    reportedChecks: stringArray(
      input.reportedChecks,
      "producerReport.reportedChecks",
      100,
      2_000,
    ),
    reportedRisks: stringArray(
      input.reportedRisks,
      "producerReport.reportedRisks",
      100,
      2_000,
    ),
    nextActions: stringArray(
      input.nextActions,
      "producerReport.nextActions",
      100,
      2_000,
    ),
    confidence,
  });
}

function fixedActor(value = "agent:mcp-bridge"): string {
  const actor = boundedString(value, "actor", 128, {
    pattern: /^(?:agent|host|role):[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u,
  });
  if (actor.startsWith("human:")) {
    throw new Error("The MCP bridge cannot hold human authority.");
  }
  return actor;
}

function sessionActor(callerBase: string): string {
  const slug = callerBase
    .replaceAll(":", "-")
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/-+/gu, "-")
    .slice(0, 60);
  return `runner:${slug}-${randomBytes(12).toString("hex")}`;
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function safeError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : "Unknown tool failure.";
  const message = raw.replaceAll("\0", "").slice(0, 500);
  const explicit = message.match(/^([A-Z][A-Z0-9_]{2,100})(?::|$)/u)?.[1];
  return { code: explicit ?? "TOOL_CALL_REJECTED", message };
}

function toolResult(
  data: unknown,
  actor: string,
): Record<string, unknown> {
  const envelope = {
    apiVersion: MCP_RESULT_VERSION,
    sessionActor: actor,
    ok: true,
    data,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: false,
  };
}

function toolError(error: unknown, actor: string): Record<string, unknown> {
  const failure = safeError(error);
  const envelope = {
    apiVersion: MCP_RESULT_VERSION,
    sessionActor: actor,
    ok: false,
    error: failure,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  };
}

function artifactMetadata(
  artifact: ReturnType<ControlPlane["latestArtifact"]>,
): Record<string, unknown> | null {
  if (!artifact) return null;
  const { content: _content, ...metadata } = artifact;
  return metadata;
}

interface McpRoute {
  ownerRoles: Set<string>;
  executionTargets: Set<string>;
  workspaceRoot: string | null;
  rolePolicies: Map<string, ToolPolicy>;
}

interface WorkspaceWriteCall {
  id: string;
  name: "workspace.write_file";
  arguments: {
    changeSet: {
      apiVersion: "chartermesh.dev/workspace-change-set/v1alpha1";
      changes: WorkspaceChange[];
    };
  };
}

interface WorkspaceChange {
  path: string;
  content: string;
  beforeSha256: string | null;
}

interface WorkspaceChangeSummary {
  title: string;
  changeCount: number;
  totalBytes: number;
  changes: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string;
    byteSize: number;
  }>;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalWorkspacePath(value: unknown, label: string): string {
  const raw = boundedString(value, label, 1_000);
  if (isAbsolute(raw) || /^[\\/]/u.test(raw)) {
    throw new Error("WORKSPACE_PATH_DENIED: path must be relative.");
  }
  const segments = raw.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("WORKSPACE_PATH_DENIED: path contains an empty, dot, or parent segment.");
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  for (const segment of segments) {
    if (
      /[:\u0000-\u001f]/u.test(segment) ||
      /[. ]$/u.test(segment) ||
      reserved.test(segment)
    ) {
      throw new Error(
        "WORKSPACE_PATH_DENIED: path uses a Windows namespace, device name, ADS, control character, or trailing dot/space alias.",
      );
    }
  }
  const folded = segments.map((segment) => segment.toLocaleLowerCase("en-US"));
  if (
    folded.some((segment) =>
      [".chartermesh", ".git", ".codex", ".claude"].includes(segment)
    )
  ) {
    throw new Error("WORKSPACE_CONTROL_PATH_DENIED: project state and host-control directories require a separate configuration plan.");
  }
  if (folded.some((segment) => ["agents.md", "claude.md", "codex.md"].includes(segment))) {
    throw new Error("WORKSPACE_CONTROL_PATH_DENIED: host instruction files require a separate configuration plan.");
  }
  return segments.join("/");
}

function assertGovernedFilesystemIdentity(
  workspaceRoot: string,
  candidate: string,
): void {
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync.native(ancestor);
  const canonicalCandidate = resolve(
    canonicalAncestor,
    relative(ancestor, candidate),
  );
  if (!isWithin(workspaceRoot, canonicalCandidate)) {
    throw new Error(
      "WORKSPACE_PATH_DENIED: native filesystem identity escapes the project workspace.",
    );
  }
  const nativeRelative = relative(workspaceRoot, canonicalCandidate)
    .replaceAll("\\", "/");
  canonicalWorkspacePath(nativeRelative, "native workspace path");
}

function workspaceChangeSetCall(
  workItemId: string,
  changesValue: unknown,
): WorkspaceWriteCall {
  if (
    !Array.isArray(changesValue) ||
    changesValue.length < 1 ||
    changesValue.length > MAX_WORKSPACE_CHANGE_COUNT
  ) {
    throw new Error(
      `WORKSPACE_CHANGE_SET_INVALID: changes must contain 1 through ${MAX_WORKSPACE_CHANGE_COUNT} files.`,
    );
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  const changes = changesValue.map((entry, index): WorkspaceChange => {
    const input = objectInput(
      entry,
      ["path", "content", "beforeSha256"],
      ["path", "content", "beforeSha256"],
    );
    const path = canonicalWorkspacePath(input.path, `changes[${index}].path`);
    const key = path.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new Error("WORKSPACE_CHANGE_SET_DUPLICATE_PATH: case-folded file paths must be unique.");
    }
    seen.add(key);
    const content = boundedString(
      input.content,
      `changes[${index}].content`,
      MAX_WORKSPACE_CHANGE_SET_BYTES,
      { allowEmpty: true },
    );
    totalBytes += Buffer.byteLength(content, "utf8");
    const beforeSha256 = input.beforeSha256 === null
      ? null
      : boundedString(
          input.beforeSha256,
          `changes[${index}].beforeSha256`,
          64,
          { pattern: /^[a-f0-9]{64}$/u },
        );
    return { path, content, beforeSha256 };
  });
  if (totalBytes > MAX_WORKSPACE_CHANGE_SET_BYTES) {
    throw new Error(
      `WORKSPACE_CHANGE_SET_SIZE_LIMIT: decoded content exceeds ${MAX_WORKSPACE_CHANGE_SET_BYTES} UTF-8 bytes.`,
    );
  }
  changes.sort((left, right) =>
    left.path.toLocaleLowerCase("en-US").localeCompare(
      right.path.toLocaleLowerCase("en-US"),
      "en-US",
    )
  );
  return {
    id: `mcp-change-set:${workItemId}`,
    name: "workspace.write_file",
    arguments: {
      changeSet: {
        apiVersion: "chartermesh.dev/workspace-change-set/v1alpha1",
        changes,
      },
    },
  };
}

function storedWorkspaceChangeSetCall(
  workItemId: string,
  value: unknown,
): WorkspaceWriteCall {
  const input = objectInput(value, ["changeSet"], ["changeSet"]);
  const changeSet = objectInput(
    input.changeSet,
    ["apiVersion", "changes"],
    ["apiVersion", "changes"],
  );
  if (changeSet.apiVersion !== "chartermesh.dev/workspace-change-set/v1alpha1") {
    throw new Error("WORKSPACE_CHANGE_SET_VERSION_UNSUPPORTED");
  }
  return workspaceChangeSetCall(workItemId, changeSet.changes);
}

function workspaceChangeSummary(call: WorkspaceWriteCall): WorkspaceChangeSummary {
  const changes = call.arguments.changeSet.changes.map((change) => ({
    path: change.path,
    beforeSha256: change.beforeSha256,
    afterSha256: sha256(change.content),
    byteSize: Buffer.byteLength(change.content, "utf8"),
  }));
  return {
    title: `Atomic workspace change set (${changes.length} file${changes.length === 1 ? "" : "s"})`,
    changeCount: changes.length,
    totalBytes: changes.reduce((total, change) => total + change.byteSize, 0),
    changes,
  };
}

function currentWorkspaceHash(workspaceRoot: string, path: string): string | null {
  const candidate = resolve(workspaceRoot, path);
  if (!isWithin(workspaceRoot, candidate)) {
    throw new Error("WORKSPACE_PATH_DENIED: path escapes the project workspace.");
  }
  assertGovernedFilesystemIdentity(workspaceRoot, candidate);
  assertNoLinkedPathComponents(candidate);
  if (!existsSync(candidate)) return null;
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("WORKSPACE_PATH_DENIED: existing target must be a regular non-linked file.");
  }
  if (metadata.size > MAX_WORKSPACE_CHANGE_SET_BYTES) {
    throw new Error(
      `WORKSPACE_PRESTATE_SIZE_LIMIT: existing target exceeds ${MAX_WORKSPACE_CHANGE_SET_BYTES} bytes.`,
    );
  }
  const expectedCanonical = realpathSync.native(candidate);
  try {
    return hashBoundedRegularFile(
      candidate,
      expectedCanonical,
      MAX_WORKSPACE_CHANGE_SET_BYTES,
    ).sha256;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("REGULAR_FILE_SIZE_LIMIT:")
    ) {
      throw new Error(
        `WORKSPACE_PRESTATE_SIZE_LIMIT: existing target exceeds ${MAX_WORKSPACE_CHANGE_SET_BYTES} bytes.`,
      );
    }
    throw error;
  }
}

function workspaceChangeState(
  workspaceRoot: string,
  summary: WorkspaceChangeSummary,
): { allBefore: boolean; allAfter: boolean } {
  const current = summary.changes.map((change) => ({
    ...change,
    currentSha256: currentWorkspaceHash(workspaceRoot, change.path),
  }));
  return {
    allBefore: current.every(({ currentSha256, beforeSha256 }) =>
      currentSha256 === beforeSha256
    ),
    allAfter: current.every(({ currentSha256, afterSha256 }) =>
      currentSha256 === afterSha256
    ),
  };
}

function workspaceEffectHash(summary: WorkspaceChangeSummary): string {
  return sha256(JSON.stringify({
    apiVersion: "chartermesh.dev/workspace-effect/v1alpha1",
    changes: summary.changes.map(({ path, beforeSha256, afterSha256 }) => ({
      path,
      beforeSha256,
      afterSha256,
    })),
  }));
}

function routeAllowsWorkItem(route: McpRoute, item: {
  ownerRole: string;
  executionTarget: string;
}): boolean {
  return route.ownerRoles.has(item.ownerRole) &&
    route.executionTargets.has(item.executionTarget);
}

function routedWorkItem(
  controlPlane: ControlPlane,
  route: McpRoute,
  id: string,
) {
  const item = controlPlane.get(id);
  if (!routeAllowsWorkItem(route, item)) {
    throw new Error(
      "MCP_ROUTE_DENIED: WorkItem role or execution target is outside this host bridge binding.",
    );
  }
  return item;
}

function workspaceTransactionId(callHash: string): string {
  return `mcp-${callHash.slice(0, 48)}`;
}

function workspaceTransactionFiles(
  workspaceRoot: string,
  call: WorkspaceWriteCall,
) {
  return call.arguments.changeSet.changes.map((change) => ({
    path: resolve(workspaceRoot, change.path),
    content: change.content,
    beforeHash: change.beforeSha256,
    afterHash: sha256(change.content),
  }));
}

function workspaceWriteRoute(
  controlPlane: ControlPlane,
  route: McpRoute,
  id: string,
  path: string,
): { workspaceRoot: string; policy: ToolPolicy } {
  const item = routedWorkItem(controlPlane, route, id);
  const workspaceRoot = route.workspaceRoot;
  const policy = route.rolePolicies.get(item.ownerRole);
  if (!workspaceRoot || !policy) {
    throw new Error(
      "MCP_WORKSPACE_WRITE_UNAVAILABLE: this bridge has no bound workspace policy for the assigned role.",
    );
  }
  if (
    !policy.allow.includes("workspace.write_file") ||
    !(policy.approvalRequired ?? []).includes("workspace.write_file")
  ) {
    throw new Error(
      "MCP_WORKSPACE_WRITE_DENIED: OrgSpec does not allow exact-call-approved workspace.write_file for this role.",
    );
  }
  const candidate = resolve(workspaceRoot, path);
  if (!isWithin(workspaceRoot, candidate)) {
    throw new Error("WORKSPACE_PATH_DENIED: path escapes the project workspace.");
  }
  const allowed = (policy.workspaceRoots ?? ["."]).some((root) => {
    if (!root || root.includes("\0") || isAbsolute(root)) return false;
    const allowedRoot = resolve(workspaceRoot, root);
    return isWithin(workspaceRoot, allowedRoot) && isWithin(allowedRoot, candidate);
  });
  if (!allowed) {
    throw new Error("WORKSPACE_PATH_DENIED: path is outside OrgSpec workspaceRoots.");
  }
  return { workspaceRoot, policy };
}

function workspaceChangeSetRoute(
  controlPlane: ControlPlane,
  route: McpRoute,
  id: string,
  call: WorkspaceWriteCall,
): { workspaceRoot: string; policy: ToolPolicy } {
  let binding: { workspaceRoot: string; policy: ToolPolicy } | undefined;
  for (const change of call.arguments.changeSet.changes) {
    const current = workspaceWriteRoute(controlPlane, route, id, change.path);
    if (
      binding &&
      (binding.workspaceRoot !== current.workspaceRoot || binding.policy !== current.policy)
    ) {
      throw new Error("MCP_WORKSPACE_ROUTE_CHANGED");
    }
    binding = current;
  }
  if (!binding) throw new Error("WORKSPACE_CHANGE_SET_INVALID");
  return binding;
}

function assertWorkspaceChangePrestate(
  workspaceRoot: string,
  summary: WorkspaceChangeSummary,
): void {
  for (const change of summary.changes) {
    const current = currentWorkspaceHash(workspaceRoot, change.path);
    if (current !== change.beforeSha256) {
      throw new Error(
        `TOOL_PRECONDITION_FAILED: '${change.path}' no longer matches beforeSha256.`,
      );
    }
  }
}

function changeSetRuntimeTool(
  workspaceRoot: string,
  workItemId: string,
  approvedCallHash: string,
): RuntimeTool {
  return {
    modelTool: {
      name: "workspace.write_file",
      description:
        "Apply the exact internally stored and approved CharterMesh workspace change set.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["changeSet"],
        properties: { changeSet: { type: "object" } },
      },
    },
    permission: "write",
    async execute(value) {
      const call = storedWorkspaceChangeSetCall(workItemId, value);
      if (toolCallHash(workItemId, call) !== approvedCallHash) {
        throw new Error("TOOL_CALL_HASH_MISMATCH: stored change set was altered.");
      }
      const summary = workspaceChangeSummary(call);
      applyFileTransaction(
        workspaceRoot,
        workspaceTransactionId(approvedCallHash),
        workspaceTransactionFiles(workspaceRoot, call),
        { denyHostControlPaths: true },
      );
      return {
        output: JSON.stringify({
          apiVersion: "chartermesh.dev/workspace-change-result/v1alpha1",
          callHash: approvedCallHash,
          effectHash: workspaceEffectHash(summary),
          changeCount: summary.changeCount,
          totalBytes: summary.totalBytes,
          changes: summary.changes,
        }),
        paths: summary.changes.map(({ path }) => path),
      };
    },
  };
}

function snapshotToolPolicy(policy: ToolPolicy): ToolPolicy {
  const snapshot: ToolPolicy = {
    allow: [...policy.allow],
    ...(policy.approvalRequired
      ? {
          approvalRequired: [...policy.approvalRequired],
        }
      : {}),
    ...(policy.workspaceRoots
      ? {
          workspaceRoots: [...policy.workspaceRoots],
        }
      : {}),
    ...(policy.maxIterations === undefined
      ? {}
      : { maxIterations: policy.maxIterations }),
  };
  Object.freeze(snapshot.allow);
  if (snapshot.approvalRequired) Object.freeze(snapshot.approvalRequired);
  if (snapshot.workspaceRoots) Object.freeze(snapshot.workspaceRoots);
  return Object.freeze(snapshot);
}

function internalIdempotencyKey(
  purpose: string,
  value: unknown,
): string {
  return `mcp:${purpose}:${sha256(JSON.stringify(value)).slice(0, 48)}`;
}

function requestWorkspaceChanges(
  controlPlane: ControlPlane,
  actor: string,
  route: McpRoute,
  value: unknown,
  singleFile: boolean,
): unknown {
  const allowed = [
    "id",
    "runId",
    "attemptId",
    "leaseId",
    "generation",
    ...(singleFile
      ? ["path", "content", "beforeSha256"]
      : ["changes"]),
    "idempotencyKey",
  ];
  const input = objectInput(value, allowed, allowed);
  const requestKey = idempotencyKey(input.idempotencyKey);
  const id = identifier(input.id, "id");
  const runId = identifier(input.runId, "runId");
  const attemptId = identifier(input.attemptId, "attemptId");
  const leaseId = identifier(input.leaseId, "leaseId");
  const generation = boundedInteger(input.generation, "generation", 1);
  const call = workspaceChangeSetCall(
    id,
    singleFile
      ? [{
          path: input.path,
          content: input.content,
          beforeSha256: input.beforeSha256,
        }]
      : input.changes,
  );
  const { workspaceRoot, policy } = workspaceChangeSetRoute(
    controlPlane,
    route,
    id,
    call,
  );
  createWorkspaceToolRuntime({
    workspaceRoot,
    workItemId: id,
    policy,
    additionalTools: [changeSetRuntimeTool(workspaceRoot, id, toolCallHash(id, call))],
  });
  const summary = workspaceChangeSummary(call);
  assertWorkspaceChangePrestate(workspaceRoot, summary);
  const callHash = toolCallHash(id, call);
  const pending = controlPlane.recordPendingToolCall({
    id,
    runId,
    attemptId,
    leaseId,
    generation,
    callHash,
    toolName: call.name,
    arguments: call.arguments,
    summary,
    createdAt: new Date().toISOString(),
    actor,
    idempotencyKey: requestKey,
  });
  const packet = controlPlane.decisionPacket(id);
  return {
    pending: {
      id: pending.id,
      workItemId: pending.workItemId,
      callHash: pending.callHash,
      toolName: pending.toolName,
      status: pending.status,
      createdAt: pending.createdAt,
      summary,
    },
    decisionPacketHash: packet?.binding.packetHash ?? null,
    nextAction: "A human must approve this exact atomic change set before execution.",
  };
}

async function executeWorkspaceChanges(
  controlPlane: ControlPlane,
  actor: string,
  route: McpRoute,
  value: unknown,
): Promise<unknown> {
  const input = objectInput(
    value,
    [
      "id",
      "runId",
      "attemptId",
      "leaseId",
      "generation",
      "callHash",
      "idempotencyKey",
    ],
    [
      "id",
      "runId",
      "attemptId",
      "leaseId",
      "generation",
      "callHash",
      "idempotencyKey",
    ],
  );
  const id = identifier(input.id, "id");
  const runId = identifier(input.runId, "runId");
  const attemptId = identifier(input.attemptId, "attemptId");
  const leaseId = identifier(input.leaseId, "leaseId");
  const generation = boundedInteger(input.generation, "generation", 1);
  const callHash = boundedString(input.callHash, "callHash", 64, {
    pattern: /^[a-f0-9]{64}$/u,
  });
  const requestKey = idempotencyKey(input.idempotencyKey);
  const fence = { id, runId, attemptId, leaseId, generation, actor };
  let claim = controlPlane.reservePendingToolExecution({
    ...fence,
    callHash,
    idempotencyKey: requestKey,
  });
  if (claim.disposition === "executed") {
    return {
      callHash,
      pendingStatus: "executed",
      effectHash: claim.pending.effectHash,
      evidenceId: claim.pending.evidenceId,
      replayed: true,
      summary: claim.pending.summary,
    };
  }
  let call = storedWorkspaceChangeSetCall(id, claim.pending.arguments);
  if (toolCallHash(id, call) !== callHash) {
    throw new Error("TOOL_CALL_HASH_MISMATCH: stored pending arguments do not match callHash.");
  }
  const { workspaceRoot, policy } = workspaceChangeSetRoute(
    controlPlane,
    route,
    id,
    call,
  );
  recoverFileTransaction(
    workspaceRoot,
    workspaceTransactionId(callHash),
    workspaceTransactionFiles(workspaceRoot, call),
    { denyHostControlPaths: true },
  );
  let summary = workspaceChangeSummary(call);
  const effectHash = workspaceEffectHash(summary);

  if (claim.disposition === "recovery_required") {
    const previous = claim.pending.reservation;
    if (!previous) throw new Error("PENDING_TOOL_EXECUTION_STATE_INVALID");
    const state = workspaceChangeState(workspaceRoot, summary);
    const evidence = controlPlane.listToolEvidence(id).find((entry) =>
      entry.runId === previous.runId &&
      entry.attemptId === previous.attemptId &&
      entry.callHash === callHash &&
      entry.toolName === call.name &&
      entry.status === "succeeded"
    );
    if (state.allAfter && evidence) {
      const recovered = controlPlane.recoverCommittedPendingToolExecution({
        ...fence,
        callHash,
        previousReservationId: previous.id,
        evidenceId: evidence.id,
        effectHash,
        idempotencyKey: internalIdempotencyKey("recover-committed", {
          id,
          callHash,
          previousReservationId: previous.id,
          runId,
        }),
      });
      return {
        callHash,
        pendingStatus: recovered.status,
        effectHash,
        evidenceId: evidence.id,
        recovered: true,
        summary,
      };
    }
    if (state.allBefore && !evidence) {
      claim = controlPlane.replacePendingToolExecutionReservation({
        ...fence,
        callHash,
        previousReservationId: previous.id,
        idempotencyKey: internalIdempotencyKey("recover-before", {
          id,
          callHash,
          previousReservationId: previous.id,
          runId,
        }),
      });
      call = storedWorkspaceChangeSetCall(id, claim.pending.arguments);
      summary = workspaceChangeSummary(call);
    } else {
      controlPlane.markPendingToolOutcomeUnknown({
        ...fence,
        callHash,
        previousReservationId: previous.id,
        message:
          "Recovered filesystem state does not prove both the exact committed effect and durable execution evidence.",
        idempotencyKey: internalIdempotencyKey("recover-unknown", {
          id,
          callHash,
          previousReservationId: previous.id,
          runId,
        }),
      });
      throw new Error(
        "TOOL_OUTCOME_UNKNOWN: recovered execution is fail-closed; inspect before human-acknowledged retry.",
      );
    }
  }

  const reservation = claim.pending.reservation;
  if (!reservation || claim.disposition !== "reserved") {
    throw new Error("TOOL_EXECUTION_RESERVATION_MISMATCH");
  }
  try {
    assertWorkspaceChangePrestate(workspaceRoot, summary);
  } catch (error) {
    controlPlane.failPendingToolExecutionPrecondition({
      ...fence,
      callHash,
      reservationId: reservation.id,
      message: error instanceof Error ? error.message : String(error),
      idempotencyKey: internalIdempotencyKey("precondition", {
        id,
        callHash,
        reservationId: reservation.id,
      }),
    });
    throw error;
  }

  let recordedEvidenceId: string | null = null;
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot,
    workItemId: id,
    policy,
    additionalTools: [changeSetRuntimeTool(workspaceRoot, id, callHash)],
    isApproved: (approvedHash, toolName) =>
      approvedHash === callHash &&
      toolName === call.name &&
      controlPlane.isPendingToolExecutionReserved({
        ...fence,
        callHash: approvedHash,
        toolName,
      }),
    prepareEvidence: (intent) =>
      controlPlane.prepareToolEvidence({
        ...fence,
        callHash: intent.callHash,
        toolName: intent.toolName,
        inputHash: intent.inputHash,
      }),
    onEvidence: (
      evidence: ToolExecutionEvidence,
      receipt?: ToolEvidenceReceipt,
    ) => {
      if (!receipt) throw new Error("TOOL_EVIDENCE_RECEIPT_MISSING");
      const record = controlPlane.recordToolEvidence({
        ...fence,
        receipt,
        evidenceId: evidence.id,
        callHash: evidence.callHash,
        toolName: evidence.toolName,
        status: evidence.status,
        inputHash: evidence.inputHash,
        outputHash: evidence.outputHash,
        paths: evidence.paths,
        durationMs: evidence.durationMs,
        createdAt: evidence.createdAt,
      });
      if (record.status === "succeeded") recordedEvidenceId = record.id;
    },
  });
  let execution: Awaited<ReturnType<typeof runtime.executeApprovedCall>>;
  try {
    execution = await runtime.executeApprovedCall(call);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Target changed after planning|TOOL_PRECONDITION_FAILED/u.test(message)) {
      controlPlane.failPendingToolExecutionPrecondition({
        ...fence,
        callHash,
        reservationId: reservation.id,
        message,
        idempotencyKey: internalIdempotencyKey("apply-precondition", {
          id,
          callHash,
          reservationId: reservation.id,
        }),
      });
    } else {
      controlPlane.markPendingToolOutcomeUnknown({
        ...fence,
        callHash,
        previousReservationId: reservation.id,
        message,
        idempotencyKey: internalIdempotencyKey("execute-unknown", {
          id,
          callHash,
          reservationId: reservation.id,
        }),
      });
    }
    throw error;
  }
  if (!recordedEvidenceId || !workspaceChangeState(workspaceRoot, summary).allAfter) {
    controlPlane.markPendingToolOutcomeUnknown({
      ...fence,
      callHash,
      previousReservationId: reservation.id,
      message: "Execution returned without both durable succeeded evidence and the exact approved after-state.",
      idempotencyKey: internalIdempotencyKey("settlement-unknown", {
        id,
        callHash,
        reservationId: reservation.id,
      }),
    });
    throw new Error("TOOL_OUTCOME_UNKNOWN: execution could not be proven for settlement.");
  }
  const settled = controlPlane.settlePendingToolExecution({
    ...fence,
    callHash,
    reservationId: reservation.id,
    evidenceId: recordedEvidenceId,
    effectHash,
    idempotencyKey: internalIdempotencyKey("settle", {
      id,
      callHash,
      reservationId: reservation.id,
      evidenceId: recordedEvidenceId,
    }),
  });
  return {
    callHash,
    output: execution.output,
    evidence: execution.evidence,
    pendingStatus: settled.status,
    effectHash,
    summary,
  };
}

function executeTool(
  controlPlane: ControlPlane,
  actor: string,
  route: McpRoute,
  name: string,
  value: unknown,
): unknown | Promise<unknown> {
  switch (name) {
    case "chartermesh_status": {
      objectInput(value, []);
      const dashboard = controlPlane.dashboard({ limit: 1 });
      return {
        operationalState: controlPlane.operationalState(),
        summary: dashboard.summary,
        attention: dashboard.attention,
      };
    }
    case "chartermesh_work_list": {
      const input = objectInput(value, [
        "cursor",
        "limit",
        "includeCompleted",
        "includeArchived",
      ]);
      const cursor = input.cursor === undefined
        ? undefined
        : boundedString(input.cursor, "cursor", 2_048);
      const limit = optionalInteger(input.limit, "limit", 1, 100);
      const includeCompleted = optionalBoolean(
        input.includeCompleted,
        "includeCompleted",
      );
      const includeArchived = optionalBoolean(
        input.includeArchived,
        "includeArchived",
      );
      const page = controlPlane.listPage({
        ...(cursor ? { cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(includeCompleted === undefined ? {} : { includeCompleted }),
        ...(includeArchived === undefined ? {} : { includeArchived }),
      });
      return {
        ...page,
        items: page.items.filter((item) => routeAllowsWorkItem(route, item)),
      };
    }
    case "chartermesh_work_next": {
      objectInput(value, []);
      const workItem = controlPlane.nextClaimableWorkFor({
        ownerRoles: [...route.ownerRoles],
        executionTargets: [...route.executionTargets],
      });
      return workItem
        ? {
            workItem,
            requiredTools: controlPlane.requiredTools(workItem.id),
            decisionContract: controlPlane.decisionContract(workItem.id),
          }
        : null;
    }
    case "chartermesh_work_show": {
      const input = objectInput(value, ["id"], ["id"]);
      const id = identifier(input.id, "id");
      routedWorkItem(controlPlane, route, id);
      const pendingToolCalls = controlPlane.listPendingToolCalls(id);
      const toolEvidence = controlPlane.listToolEvidence(id);
      return {
        workItem: controlPlane.get(id),
        requiredTools: controlPlane.requiredTools(id),
        decisionContract: controlPlane.decisionContract(id),
        decisionPacket: controlPlane.decisionPacket(id),
        latestArtifact: artifactMetadata(controlPlane.latestArtifact(id)),
        pendingToolCalls: pendingToolCalls
          .slice(-100)
          .map(({ arguments: _arguments, ...call }) => call),
        pendingToolCallsTruncated: pendingToolCalls.length > 100,
        toolEvidence: toolEvidence.slice(-100),
        toolEvidenceTruncated: toolEvidence.length > 100,
      };
    }
    case "chartermesh_decision_show": {
      const input = objectInput(value, ["id"], ["id"]);
      const id = identifier(input.id, "id");
      routedWorkItem(controlPlane, route, id);
      return controlPlane.decisionPacket(id);
    }
    case "chartermesh_artifact_show": {
      const input = objectInput(
        value,
        ["id", "maxContentBytes"],
        ["id"],
      );
      const id = identifier(input.id, "id");
      routedWorkItem(controlPlane, route, id);
      const maximum = optionalInteger(
        input.maxContentBytes,
        "maxContentBytes",
        0,
        MAX_ARTIFACT_RESPONSE_BYTES,
      ) ?? 64_000;
      const artifact = controlPlane.latestArtifact(id);
      if (!artifact) return null;
      const { content, ...metadata } = artifact;
      const contentBytes = Buffer.byteLength(content, "utf8");
      return {
        ...metadata,
        content: contentBytes <= maximum ? content : null,
        contentOmitted: contentBytes > maximum,
        requestedMaxContentBytes: maximum,
      };
    }
    case "chartermesh_run_show": {
      const input = objectInput(value, ["runId"], ["runId"]);
      const runId = identifier(input.runId, "runId");
      const runItem = controlPlane.getWorkItemForRun(runId);
      if (!routeAllowsWorkItem(route, runItem)) {
        throw new Error(
          "MCP_ROUTE_DENIED: run lineage is outside this host bridge binding.",
        );
      }
      const attempts = controlPlane.listAttempts(runId);
      const visibleAttempts = attempts.slice(-100);
      const allInvocations = visibleAttempts.flatMap((attempt) =>
        controlPlane.listInvocations(attempt.id)
      );
      const invocations = allInvocations.slice(-500);
      return {
        runId,
        cancellationRequested: controlPlane.isRunCancellationRequested(runId),
        attempts: visibleAttempts,
        attemptsTruncated: attempts.length > visibleAttempts.length,
        invocations,
        invocationsTruncated:
          attempts.length > visibleAttempts.length ||
          allInvocations.length > invocations.length,
      };
    }
    case "chartermesh_work_claim": {
      const input = objectInput(
        value,
        ["id", "expectedVersion", "idempotencyKey", "leaseMinutes"],
        ["id", "expectedVersion", "idempotencyKey"],
      );
      const leaseMinutes = optionalInteger(
        input.leaseMinutes,
        "leaseMinutes",
        1,
        60,
      );
      const id = identifier(input.id, "id");
      const workItem = routedWorkItem(controlPlane, route, id);
      return controlPlane.claim({
        id,
        expectedVersion: boundedInteger(
          input.expectedVersion,
          "expectedVersion",
          1,
        ),
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
        ...(leaseMinutes === undefined ? {} : { leaseMinutes }),
      });
    }
    case "chartermesh_run_heartbeat": {
      const input = objectInput(
        value,
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "generation",
          "idempotencyKey",
          "leaseMinutes",
        ],
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "generation",
          "idempotencyKey",
        ],
      );
      const leaseMinutes = optionalInteger(
        input.leaseMinutes,
        "leaseMinutes",
        1,
        60,
      );
      return controlPlane.heartbeat({
        id: identifier(input.id, "id"),
        runId: identifier(input.runId, "runId"),
        attemptId: identifier(input.attemptId, "attemptId"),
        leaseId: identifier(input.leaseId, "leaseId"),
        generation: boundedInteger(input.generation, "generation", 1),
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
        ...(leaseMinutes === undefined ? {} : { leaseMinutes }),
      });
    }
    case "chartermesh_work_progress": {
      const input = objectInput(
        value,
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "expectedVersion",
          "generation",
          "summary",
          "nextAction",
          "idempotencyKey",
        ],
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "expectedVersion",
          "generation",
          "summary",
          "nextAction",
          "idempotencyKey",
        ],
      );
      return controlPlane.progress({
        id: identifier(input.id, "id"),
        runId: identifier(input.runId, "runId"),
        attemptId: identifier(input.attemptId, "attemptId"),
        leaseId: identifier(input.leaseId, "leaseId"),
        expectedVersion: boundedInteger(
          input.expectedVersion,
          "expectedVersion",
          1,
        ),
        generation: boundedInteger(input.generation, "generation", 1),
        summary: boundedString(input.summary, "summary", 10_000),
        nextAction: boundedString(input.nextAction, "nextAction", 2_000),
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
      });
    }
    case "chartermesh_work_block": {
      const input = objectInput(
        value,
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "expectedVersion",
          "generation",
          "type",
          "reason",
          "reference",
          "idempotencyKey",
        ],
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "expectedVersion",
          "generation",
          "type",
          "reason",
          "idempotencyKey",
        ],
      );
      const type = boundedString(input.type, "type", 32);
      if (type !== "user_input" && type !== "manual_resume") {
        throw new Error("type must be user_input or manual_resume.");
      }
      const reference = input.reference === undefined
        ? undefined
        : boundedString(input.reference, "reference", 160);
      if (type === "user_input" && !reference) {
        throw new Error("user_input waits require reference.");
      }
      return controlPlane.waitOwnedRun({
        id: identifier(input.id, "id"),
        runId: identifier(input.runId, "runId"),
        attemptId: identifier(input.attemptId, "attemptId"),
        leaseId: identifier(input.leaseId, "leaseId"),
        expectedVersion: boundedInteger(
          input.expectedVersion,
          "expectedVersion",
          1,
        ),
        generation: boundedInteger(input.generation, "generation", 1),
        condition: {
          type,
          reason: boundedString(input.reason, "reason", 2_000),
          ...(reference ? { reference } : {}),
        },
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
      });
    }
    case "chartermesh_workspace_changes_request":
      return requestWorkspaceChanges(controlPlane, actor, route, value, false);
    case "chartermesh_workspace_write_request":
      return requestWorkspaceChanges(controlPlane, actor, route, value, true);
    case "chartermesh_workspace_write_execute":
      return executeWorkspaceChanges(controlPlane, actor, route, value);
    case "chartermesh_artifact_submit": {
      const input = objectInput(
        value,
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "generation",
          "content",
          "mediaType",
          "producerReport",
          "idempotencyKey",
        ],
        [
          "id",
          "runId",
          "attemptId",
          "leaseId",
          "generation",
          "content",
          "idempotencyKey",
        ],
      );
      const content = boundedString(
        input.content,
        "content",
        MAX_ARTIFACT_INPUT_BYTES,
      );
      if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_INPUT_BYTES) {
        throw new Error(
          `content exceeds ${MAX_ARTIFACT_INPUT_BYTES} UTF-8 bytes.`,
        );
      }
      const mediaType = input.mediaType === undefined
        ? undefined
        : boundedString(input.mediaType, "mediaType", 256, {
            pattern: /^[^\r\n]+$/u,
          });
      const report = producerReport(input.producerReport);
      return controlPlane.submitArtifact({
        id: identifier(input.id, "id"),
        runId: identifier(input.runId, "runId"),
        attemptId: identifier(input.attemptId, "attemptId"),
        leaseId: identifier(input.leaseId, "leaseId"),
        generation: boundedInteger(input.generation, "generation", 1),
        content,
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
        ...(mediaType ? { mediaType } : {}),
        ...(report ? { producerReport: report } : {}),
      });
    }
    case "chartermesh_run_fail": {
      const input = objectInput(
        value,
        [
          "id",
          "runId",
          "leaseId",
          "generation",
          "attemptId",
          "errorCode",
          "errorMessage",
          "idempotencyKey",
        ],
        [
          "id",
          "runId",
          "leaseId",
          "generation",
          "attemptId",
          "errorCode",
          "errorMessage",
          "idempotencyKey",
        ],
      );
      return controlPlane.failRun({
        id: identifier(input.id, "id"),
        runId: identifier(input.runId, "runId"),
        leaseId: identifier(input.leaseId, "leaseId"),
        generation: boundedInteger(input.generation, "generation", 1),
        attemptId: identifier(input.attemptId, "attemptId"),
        errorCode: boundedString(input.errorCode, "errorCode", 100, {
          pattern: /^[A-Z][A-Z0-9_]*$/u,
        }),
        errorMessage: boundedString(
          input.errorMessage,
          "errorMessage",
          1_000,
        ),
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        actor,
      });
    }
    default:
      throw new Error(`Unknown or unauthorized tool '${name}'.`);
  }
}

function requestId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length <= 128) return value;
  throw new Error("JSON-RPC id must be a short string, integer, or null.");
}

export function createControlPlaneMcpHandler(
  options: HandlerOptions,
): ControlPlaneMcpHandler {
  const callerBase = fixedActor(options.actor);
  const actor = sessionActor(callerBase);
  const route = {
    ownerRoles: new Set(
      (options.allowedRoles ?? []).map((value) =>
        boundedString(value, "allowed role", 128, {
          pattern: /^[A-Za-z0-9._-]+$/u,
        })
      ),
    ),
    executionTargets: new Set(
      (options.allowedExecutionTargets ?? []).map((value) =>
        boundedString(value, "allowed execution target", 128, {
          pattern: /^[A-Za-z0-9._-]+$/u,
        })
      ),
    ),
    workspaceRoot: options.workspaceRoot
      ? realpathSync.native(resolve(options.workspaceRoot))
      : null,
    rolePolicies: new Map(
      Object.entries(options.rolePolicies ?? {}).map(([roleId, policy]) => [
        boundedString(roleId, "role policy id", 128, {
          pattern: /^[A-Za-z0-9._-]+$/u,
        }),
        snapshotToolPolicy(policy),
      ]),
    ),
  } satisfies McpRoute;

  const handleMessage = (message: unknown): JsonRpcResponse | null => {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    let id: JsonRpcId | undefined;
    try {
      id = requestId(message.id);
    } catch (error) {
      return jsonRpcError(null, -32600, safeError(error).message);
    }
    if (typeof message.method !== "string" || message.method.length > 200) {
      return jsonRpcError(id ?? null, -32600, "Invalid JSON-RPC method.");
    }
    const notification = id === undefined;
    if (notification) return null;

    try {
      switch (message.method) {
        case "initialize": {
          const params = objectInput(
            message.params ?? {},
            ["protocolVersion", "capabilities", "clientInfo", "_meta"],
          );
          let protocolVersion = MCP_PROTOCOL_VERSION;
          if (params.protocolVersion !== undefined) {
            const requested = boundedString(
              params.protocolVersion,
              "protocolVersion",
              32,
            );
            if (SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)) {
              protocolVersion = requested;
            }
          }
          return jsonRpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: MCP_SERVER_NAME,
              title: "CharterMesh Control Plane",
              version: MCP_SERVER_VERSION,
            },
            sessionActor: actor,
            instructions:
              "Operate only assigned WorkItems. Human approvals, organization apply, and external side effects are intentionally unavailable.",
          });
        }
        case "ping":
          return jsonRpcResult(id, {});
        case "tools/list": {
          const params = objectInput(message.params ?? {}, ["cursor"]);
          if (params.cursor !== undefined) {
            boundedString(params.cursor, "cursor", 2_048);
          }
          return jsonRpcResult(id, { tools: CONTROL_PLANE_MCP_TOOLS });
        }
        case "tools/call": {
          const params = objectInput(
            message.params,
            ["name", "arguments", "_meta"],
            ["name"],
          );
          const name = boundedString(params.name, "tool name", 128, {
            pattern: /^[A-Za-z0-9_-]+$/u,
          });
          try {
            if (!READ_ONLY_MCP_TOOLS.has(name)) options.beforeMutation?.();
            const execution = executeTool(
              options.controlPlane,
              actor,
              route,
              name,
              params.arguments ?? {},
            );
            if (execution instanceof Promise) {
              return execution.then(
                (data) => jsonRpcResult(id, toolResult(data, actor)),
                (error: unknown) =>
                  jsonRpcResult(id, toolError(error, actor)),
              );
            }
            return jsonRpcResult(id, toolResult(execution, actor));
          } catch (error) {
            return jsonRpcResult(id, toolError(error, actor));
          }
        }
        default:
          return jsonRpcError(id, -32601, "Method not found.");
      }
    } catch (error) {
      return jsonRpcError(id, -32602, safeError(error).message);
    }
  };

  return {
    sessionActor: actor,
    handleMessage,
    handleLine(
      line: string,
    ): JsonRpcResponse | Promise<JsonRpcResponse> | null {
      if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
        return jsonRpcError(null, -32600, "JSON-RPC request exceeds the byte limit.");
      }
      try {
        return handleMessage(JSON.parse(line) as unknown);
      } catch {
        return jsonRpcError(null, -32700, "Parse error.");
      }
    },
  };
}

export function openControlPlaneMcpBridge(
  options: OpenBridgeOptions,
): OpenControlPlaneMcpBridge {
  const state = resolveProjectStatePaths(
    boundedString(options.target, "target", 32_767),
    { requireInitialized: true },
  );
  const target = state.projectRoot;
  const stateDirectory = state.root;
  let budgets: ReturnType<typeof parseOrgSpec>["spec"]["budgets"] | undefined;
  let organization: ReturnType<typeof parseOrgSpec> | undefined;
  const organizationText = readBoundedRegularText(state.organization, {
    maxBytes: 2 * 1024 * 1024,
  });
  organization = parseOrgSpec(organizationText);
  const organizationHash = sha256(organizationText);
  const beforeMutation = (): void => {
    assertMaintenanceInactive(stateDirectory);
    try {
      assertNoLinkedPathComponents(state.organization);
      const current = hashBoundedRegularFile(
        state.organization,
        realpathSync.native(state.organization),
        2 * 1024 * 1024,
      );
      if (current.sha256 === organizationHash) return;
    } catch (cause) {
      throw new Error("PROJECT_CONFIGURATION_CHANGED_RESTART_REQUIRED", { cause });
    }
    throw new Error("PROJECT_CONFIGURATION_CHANGED_RESTART_REQUIRED");
  };
  budgets = organization.spec.budgets;
  if (
    (options.allowedRoles?.length || options.allowedExecutionTargets?.length) &&
    !organization
  ) {
    throw new Error("MCP route binding requires a valid OrgSpec organization.");
  }
  const roleIds = new Set(organization?.spec.roles.map(({ id }) => id) ?? []);
  for (const roleId of options.allowedRoles ?? []) {
    if (!roleIds.has(roleId)) {
      throw new Error(`MCP route references unknown OrgSpec role '${roleId}'.`);
    }
  }
  const enabledTargetIds = new Set(
    organization?.spec.executionTargets
      .filter(({ enabled }) => enabled)
      .map(({ id }) => id) ?? [],
  );
  for (const targetId of options.allowedExecutionTargets ?? []) {
    if (!enabledTargetIds.has(targetId)) {
      throw new Error(
        `MCP route references disabled or unknown execution target '${targetId}'.`,
      );
    }
  }
  const database: DatabaseSync = openControlPlaneDatabase(
    state.database,
  );
  try {
    const controlPlane = new ControlPlane(
      database,
      state.artifacts,
      {
        budgets,
        maintenanceDirectory: stateDirectory,
        // Recheck after the Control Plane holds its database write lock. A
        // configure-project operation cannot race cached budgets/role policy.
        beforeMutation,
      },
    );
    const handler = createControlPlaneMcpHandler({
      controlPlane,
      actor: options.actor,
      allowedRoles: options.allowedRoles,
      allowedExecutionTargets: options.allowedExecutionTargets,
      workspaceRoot: target,
      rolePolicies: Object.fromEntries(
        organization?.spec.roles.map(({ id, tools }) => [id, tools]) ?? [],
      ),
      // Reject before inspecting workspace changes as well as at each durable
      // mutation. Read-only tools remain usable to inspect the old session.
      beforeMutation,
    });
    return {
      target,
      controlPlane,
      handler,
      close(): void {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function runControlPlaneMcpStdio(
  options: StdioOptions,
): Promise<void> {
  const bridge = openControlPlaneMcpBridge(options);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      const response = await bridge.handler.handleLine(line);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    bridge.close();
  }
}
