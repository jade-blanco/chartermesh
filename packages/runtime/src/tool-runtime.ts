import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  onEvidence?: (
    evidence: ToolExecutionEvidence,
  ) => void | Promise<void>;
}

export interface ToolLoopResult {
  inference: InferenceResult;
  evidence: ToolExecutionEvidence[];
  iterations: number;
}

export class ToolApprovalRequiredError extends Error {
  readonly code = "TOOL_APPROVAL_REQUIRED";
  readonly callHash: string;
  readonly toolName: string;

  constructor(callHash: string, toolName: string) {
    super(
      `TOOL_APPROVAL_REQUIRED: approve exact call hash ${callHash} for '${toolName}'.`,
    );
    this.name = "ToolApprovalRequiredError";
    this.callHash = callHash;
    this.toolName = toolName;
  }
}

export class ToolIterationLimitError extends Error {
  readonly code = "TOOL_ITERATION_LIMIT";

  constructor(limit: number) {
    super(`TOOL_ITERATION_LIMIT: model exceeded ${limit} tool iterations.`);
    this.name = "ToolIterationLimitError";
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

function canonicalAllowedRoots(
  workspaceRoot: string,
  policy: ToolPolicy,
): string[] {
  const root = realpathSync(workspaceRoot);
  return (policy.workspaceRoots ?? ["."]).map((entry) => {
    const relativePath = cleanRelativePath(entry);
    const candidate = resolve(root, relativePath);
    if (!isWithin(root, candidate)) {
      throw new Error(`Workspace root '${entry}' escapes the target project.`);
    }
    if (!existsSync(candidate)) {
      throw new Error(`Workspace root '${entry}' does not exist.`);
    }
    const canonical = realpathSync(candidate);
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
): { absolute: string; display: string } {
  const display = cleanRelativePath(value);
  const root = realpathSync(workspaceRoot);
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
    canonical = realpathSync(absolute);
  } else {
    if (mode === "read") throw new Error(`Path '${display}' does not exist.`);
    let ancestor = dirname(absolute);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    canonical = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  }
  if (!allowedRoots.some((allowed) => isWithin(allowed, canonical))) {
    throw new Error(`Path '${display}' is outside OrgSpec workspaceRoots.`);
  }
  return { absolute, display };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
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
        const entries = readdirSync(path.absolute, { withFileTypes: true })
          .slice(0, maximum)
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
          }));
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
          "Read a bounded UTF-8 text file inside the approved workspace roots.",
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
        const content = readFileSync(path.absolute);
        if (content.includes(0)) {
          throw new Error(`Path '${path.display}' is not a UTF-8 text file.`);
        }
        return {
          output: JSON.stringify({
            path: path.display,
            truncated: content.byteLength > maximum,
            content: content.subarray(0, maximum).toString("utf8"),
          }),
          paths: [path.display],
        };
      },
    },
    {
      modelTool: {
        name: "workspace.write_file",
        description:
          "Create or replace one UTF-8 text file inside the approved workspace roots. Exact-call human approval is required.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string", minLength: 1 },
            content: {
              type: "string",
              maxLength: 262_144,
            },
          },
        },
      },
      permission: "workspace_write",
      async execute(value) {
        const args = objectArguments(value);
        if (
          typeof args.content !== "string" ||
          Buffer.byteLength(args.content, "utf8") > 262_144
        ) {
          throw new Error(
            "Tool argument 'content' must be a UTF-8 string of at most 262144 bytes.",
          );
        }
        const path = canonicalPath(
          workspaceRoot,
          policy,
          args.path,
          "write",
        );
        mkdirSync(dirname(path.absolute), { recursive: true });
        if (
          existsSync(path.absolute) &&
          lstatSync(path.absolute).isSymbolicLink()
        ) {
          throw new Error(`Symbolic-link target '${path.display}' is not allowed.`);
        }
        const noFollow = "O_NOFOLLOW" in constants
          ? Number(constants.O_NOFOLLOW)
          : 0;
        const descriptor = openSync(
          path.absolute,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_TRUNC |
            noFollow,
          0o600,
        );
        try {
          writeFileSync(descriptor, args.content, { encoding: "utf8" });
        } finally {
          closeSync(descriptor);
        }
        return {
          output: JSON.stringify({
            path: path.display,
            byteSize: Buffer.byteLength(args.content, "utf8"),
            sha256: digest(args.content),
          }),
          paths: [path.display],
        };
      },
    },
  ];
}

export class ToolRuntime {
  private readonly workspaceRoot: string;
  private readonly workItemId: string;
  private readonly policy: ToolPolicy;
  private readonly tools: Map<string, RuntimeTool>;
  private readonly isApproved: (callHash: string, toolName: string) => boolean;
  private readonly onEvidence?: ToolRuntimeOptions["onEvidence"];

  constructor(options: ToolRuntimeOptions) {
    this.workspaceRoot = realpathSync(options.workspaceRoot);
    this.workItemId = options.workItemId;
    this.policy = options.policy;
    this.tools = new Map(
      options.tools.map((tool) => [tool.modelTool.name, tool]),
    );
    this.isApproved = options.isApproved ?? (() => false);
    this.onEvidence = options.onEvidence;
    const maximum = this.policy.maxIterations ?? 4;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 12) {
      throw new Error("Tool maxIterations must be an integer from 1 through 12.");
    }
    for (const name of this.policy.approvalRequired ?? []) {
      if (!this.policy.allow.includes(name)) {
        throw new Error(
          `Approval-required tool '${name}' is not in the OrgSpec allowlist.`,
        );
      }
    }
    canonicalAllowedRoots(this.workspaceRoot, this.policy);
  }

  modelTools(): ModelTool[] {
    return this.policy.allow.flatMap((name) => {
      const tool = this.tools.get(name);
      return tool ? [tool.modelTool] : [];
    });
  }

  private async record(
    evidence: ToolExecutionEvidence,
    collection: ToolExecutionEvidence[],
  ): Promise<void> {
    collection.push(evidence);
    await this.onEvidence?.(evidence);
  }

  private evidence(
    call: ModelToolCall,
    status: ToolExecutionStatus,
    started: number,
    output: string | null,
    paths: string[] = [],
  ): ToolExecutionEvidence {
    return {
      id: `tool-evidence-${randomUUID()}`,
      callHash: toolCallHash(this.workItemId, call),
      toolName: call.name,
      status,
      inputHash: digest(call.arguments),
      outputHash: output === null ? null : digest(output),
      paths,
      durationMs: Math.max(0, Date.now() - started),
      createdAt: new Date().toISOString(),
    };
  }

  async run(
    engine: ModelEngine,
    request: InferenceRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolLoopResult> {
    const evidence: ToolExecutionEvidence[] = [];
    const messages = [...request.messages];
    const maximum = this.policy.maxIterations ?? 4;
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
        const callHash = toolCallHash(this.workItemId, call);
        const tool = this.tools.get(call.name);
        if (!tool || !this.policy.allow.includes(call.name)) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_DENIED",
            message: `Tool '${call.name}' is not allowed by OrgSpec.`,
          });
          await this.record(
            this.evidence(call, "denied", started, output),
            evidence,
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
          (this.policy.approvalRequired ?? []).includes(call.name);
        if (
          approvalRequired &&
          !this.isApproved(callHash, call.name)
        ) {
          await this.record(
            this.evidence(call, "approval_required", started, null),
            evidence,
          );
          throw new ToolApprovalRequiredError(callHash, call.name);
        }
        try {
          options.signal?.throwIfAborted();
          const result = await tool.execute(call.arguments, {
            workspaceRoot: this.workspaceRoot,
            signal: options.signal,
          });
          const output = result.output.slice(0, 65_536);
          await this.record(
            this.evidence(
              call,
              "succeeded",
              started,
              output,
              result.paths ?? [],
            ),
            evidence,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: output,
          });
        } catch (error) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_EXECUTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }).slice(0, 8_000);
          await this.record(
            this.evidence(call, "failed", started, output),
            evidence,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: output,
          });
        }
      }
    }
    throw new ToolIterationLimitError(maximum);
  }
}

export function createWorkspaceToolRuntime(
  options: Omit<ToolRuntimeOptions, "tools">,
): ToolRuntime {
  return new ToolRuntime({
    ...options,
    tools: createWorkspaceTools(options.workspaceRoot, options.policy),
  });
}
