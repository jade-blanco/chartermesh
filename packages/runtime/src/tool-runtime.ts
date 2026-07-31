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

export interface ApprovedToolCallResult {
  output: string;
  evidence: ToolExecutionEvidence;
}

export class ToolApprovalRequiredError extends Error {
  readonly code = "TOOL_APPROVAL_REQUIRED";
  readonly callHash: string;
  readonly toolName: string;
  readonly call: ModelToolCall;

  constructor(callHash: string, toolName: string, call: ModelToolCall) {
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
    if (typeof record.path !== "string" || !record.path.trim()) {
      return "workspace.write_file requires a non-empty path.";
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

function writeUtf8File(path: { absolute: string; display: string }, content: string) {
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
    writeFileSync(descriptor, content, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
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
        const content = readFileSync(path.absolute);
        if (content.includes(0)) {
          throw new Error(`Path '${path.display}' is not a UTF-8 text file.`);
        }
        return {
          output: JSON.stringify({
            path: path.display,
            truncated: content.byteLength > maximum,
            sha256: createHash("sha256").update(content).digest("hex"),
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
          "Create or replace one UTF-8 text file inside the approved workspace roots. Prefer replacements with the complete-file expectedSha256 for small, exact edits; every oldText must occur exactly expectedOccurrences times. Otherwise pass exact raw file text in content after one JSON transport encoding. Never JSON-encode file text a second time. Exact-call human approval is required.",
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
              required: ["content"],
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
        const args = objectArguments(value);
        const path = canonicalPath(
          workspaceRoot,
          policy,
          args.path,
          "write",
        );
        let content: string;
        let beforeSha256: string | null = null;
        const replacements = Array.isArray(args.replacements)
          ? (args.replacements as Array<Record<string, unknown>>)
          : null;
        if (replacements) {
          if (!existsSync(path.absolute) || !lstatSync(path.absolute).isFile()) {
            throw new Error(
              `Replacement target '${path.display}' must be an existing regular file.`,
            );
          }
          const current = readFileSync(path.absolute);
          if (current.includes(0)) {
            throw new Error(
              `Replacement target '${path.display}' is not UTF-8 text.`,
            );
          }
          beforeSha256 = createHash("sha256").update(current).digest("hex");
          if (beforeSha256 !== args.expectedSha256) {
            throw new Error(
              `Replacement target '${path.display}' changed: expected ${String(
                args.expectedSha256,
              )}, found ${beforeSha256}.`,
            );
          }
          content = current.toString("utf8");
          for (const replacement of replacements) {
            const oldText = String(replacement.oldText);
            const newText = String(replacement.newText);
            const expectedOccurrences = Number(
              replacement.expectedOccurrences ?? 1,
            );
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
        } else {
          throw new Error(
            "workspace.write_file requires content or exact replacements.",
          );
        }
        if (Buffer.byteLength(content, "utf8") > 262_144) {
          throw new Error(
            "Resulting UTF-8 file exceeds the 262144-byte limit.",
          );
        }
        writeUtf8File(path, content);
        return {
          output: JSON.stringify({
            path: path.display,
            mode: replacements ? "replacements" : "content",
            replacements: replacements?.length ?? 0,
            beforeSha256,
            byteSize: Buffer.byteLength(content, "utf8"),
            sha256: digest(content),
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

  async executeApprovedCall(
    call: ModelToolCall,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovedToolCallResult> {
    const evidence: ToolExecutionEvidence[] = [];
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
        this.evidence(
          call,
          "denied",
          started,
          output,
          declaredPaths(call.arguments),
        ),
        evidence,
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
      await this.record(
        this.evidence(
          call,
          "failed",
          started,
          output,
          declaredPaths(call.arguments),
        ),
        evidence,
      );
      throw new Error(`TOOL_ARGUMENTS_INVALID: ${malformed}`);
    }
    const approvalRequired =
      tool.permission !== "read_only" ||
      (this.policy.approvalRequired ?? []).includes(call.name);
    if (approvalRequired && !this.isApproved(callHash, call.name)) {
      await this.record(
        this.evidence(
          call,
          "approval_required",
          started,
          null,
          declaredPaths(call.arguments),
        ),
        evidence,
      );
      throw new ToolApprovalRequiredError(callHash, call.name, call);
    }
    try {
      options.signal?.throwIfAborted();
      const result = await tool.execute(call.arguments, {
        workspaceRoot: this.workspaceRoot,
        signal: options.signal,
      });
      const output = result.output.slice(0, 65_536);
      const record = this.evidence(
        call,
        "succeeded",
        started,
        output,
        result.paths ?? declaredPaths(call.arguments),
      );
      await this.record(record, evidence);
      return { output, evidence: record };
    } catch (error) {
      const output = JSON.stringify({
        ok: false,
        code: "TOOL_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }).slice(0, 8_000);
      const record = this.evidence(
        call,
        "failed",
        started,
        output,
        declaredPaths(call.arguments),
      );
      await this.record(record, evidence);
      throw new Error(
        `TOOL_EXECUTION_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
        const malformed = malformedToolArguments(call.arguments, call.name);
        if (malformed) {
          const output = JSON.stringify({
            ok: false,
            code: "TOOL_ARGUMENTS_INVALID",
            message: malformed,
          });
          await this.record(
            this.evidence(
              call,
              "failed",
              started,
              output,
              declaredPaths(call.arguments),
            ),
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
            this.evidence(
              call,
              "approval_required",
              started,
              null,
              declaredPaths(call.arguments),
            ),
            evidence,
          );
          throw new ToolApprovalRequiredError(callHash, call.name, call);
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
  options: Omit<ToolRuntimeOptions, "tools"> & {
    additionalTools?: RuntimeTool[];
  },
): ToolRuntime {
  const { additionalTools = [], ...runtimeOptions } = options;
  return new ToolRuntime({
    ...runtimeOptions,
    tools: [
      ...createWorkspaceTools(options.workspaceRoot, options.policy),
      ...additionalTools,
    ],
  });
}
