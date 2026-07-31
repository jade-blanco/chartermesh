import { randomUUID } from "node:crypto";
import type {
  HostRunHandle,
  HostRunRequest,
  InferenceResult,
  ManagedRunner,
  ManagedRunnerManifest,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import type {
  ToolExecutionEvidence,
  ToolRuntime,
} from "./tool-runtime.ts";

export interface ManagedRunResult {
  hostRunId: string;
  inference: InferenceResult;
  toolEvidence: ToolExecutionEvidence[];
}

export interface StructuredArtifact {
  apiVersion: "chartermesh.dev/structured-artifact/v1alpha1";
  summary: string;
  deliverable: string;
  checks: string[];
  risks: string[];
  nextActions: string[];
  confidence: "low" | "medium" | "high";
}

const MAX_MODEL_OUTPUT_TOKENS = 4_096;

export const structuredArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "apiVersion",
    "summary",
    "deliverable",
    "checks",
    "risks",
    "nextActions",
    "confidence",
  ],
  properties: {
    apiVersion: {
      const: "chartermesh.dev/structured-artifact/v1alpha1",
    },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
    deliverable: { type: "string", minLength: 1, maxLength: 20_000 },
    checks: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    risks: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    nextActions: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    confidence: { enum: ["low", "medium", "high"] },
  },
} satisfies Record<string, unknown>;

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 1_000,
    )
  );
}

function parseStructuredArtifact(text: string): StructuredArtifact | null {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/u, "")
        .replace(/\s*```$/u, "")
        .trim()
    : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.apiVersion !== "chartermesh.dev/structured-artifact/v1alpha1" ||
    typeof record.summary !== "string" ||
    record.summary.trim().length === 0 ||
    record.summary.length > 2_000 ||
    typeof record.deliverable !== "string" ||
    record.deliverable.trim().length === 0 ||
    record.deliverable.length > 20_000 ||
    !strings(record.checks) ||
    !strings(record.risks) ||
    !strings(record.nextActions) ||
    !["low", "medium", "high"].includes(String(record.confidence))
  ) {
    return null;
  }
  return record as unknown as StructuredArtifact;
}

function addUsage(
  first: InferenceResult["usage"],
  second: InferenceResult["usage"],
): InferenceResult["usage"] {
  const sum = (left: number | null, right: number | null): number | null =>
    left === null && right === null ? null : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: sum(first.inputTokens, second.inputTokens),
    outputTokens: sum(first.outputTokens, second.outputTokens),
    cacheReadTokens: sum(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: sum(first.cacheWriteTokens, second.cacheWriteTokens),
    cost: sum(first.cost, second.cost),
    measurementStatus:
      first.measurementStatus === "measured" &&
      second.measurementStatus === "measured"
        ? "measured"
        : "unknown",
  };
}

export class BuiltInManagedRunner implements ManagedRunner {
  readonly manifest: ManagedRunnerManifest = {
    kind: "managed_runner",
    profileId: "builtin-managed-runner",
    adapter: "builtin-managed-runner",
    contractVersion: "v1alpha1",
    permissionCeiling: "workspace_write",
    engineBinding: "injectable",
    capabilities: [
      {
        name: "runner.bounded_turns",
        support: "native",
        stability: "stable",
        constraints: { maxTurns: 2, repairTurns: 1 },
      },
      {
        name: "host.approval.pause_resume",
        support: "native",
        stability: "stable",
      },
      {
        name: "runner.structured_artifact",
        support: "native",
        stability: "stable",
      },
      {
        name: "runner.tool_loop",
        support: "native",
        stability: "stable",
        constraints: {
          maxIterations: 12,
          builtIns: [
            "workspace.list_files",
            "workspace.read_file",
            "workspace.write_file",
          ],
          optionalBuiltIns: ["web.search"],
        },
      },
      {
        name: "runner.repair_turn",
        support: "native",
        stability: "stable",
      },
    ],
  };

  private readonly pending = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<{
        inference: InferenceResult;
        toolEvidence: ToolExecutionEvidence[];
      }>;
      cleanup: () => void;
    }
  >();

  async start(
    request: HostRunRequest,
    options: {
      engine: ModelEngine;
      signal?: AbortSignal;
      toolRuntime?: ToolRuntime;
    },
  ): Promise<HostRunHandle> {
    const hostRunId = `managed-${randomUUID()}`;
    const packet = request.taskPacket as {
      objective?: string;
      context?: string;
      acceptanceCriteria?: string[];
    };
    const prompt = [
      packet.objective ?? "Complete the assigned work.",
      packet.context ? `Context:\n${packet.context}` : "",
      packet.acceptanceCriteria?.length
        ? `Acceptance criteria:\n- ${packet.acceptanceCriteria.join("\n- ")}`
        : "",
      [
        "Return JSON only with exactly this shape:",
        JSON.stringify(
          {
            apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
            summary: "non-empty string",
            deliverable: "non-empty string",
            checks: [],
            risks: ["string"],
            nextActions: ["string"],
            confidence: "low | medium | high",
          },
          null,
          2,
        ),
        [
          "Evidence boundary:",
          "- Put a check in `checks` only when it was performed in this invocation and is directly supported by the task packet or a successful tool result.",
          "- If no check was performed, return `checks: []`.",
          "- Put proposed or unperformed verification in `nextActions`, using future tense.",
          "- Never transform requested work into a claim that files, tests, dependencies, endpoints, builds, deployments, or external systems were inspected.",
          "- Lower confidence and name missing evidence in `risks`.",
          "- Write human-facing fields (`summary`, `deliverable`, `checks`, `risks`, and `nextActions`) in the task packet's primary language. Keep exact paths, commands, identifiers, and quoted source text unchanged.",
          "Use empty arrays when there are no checks, risks, or next actions. Do not add keys or Markdown fences.",
          "",
          "Tool argument boundary:",
          "- For `workspace.write_file`, put the exact raw UTF-8 file text in `content`.",
          "- For a small change to an existing file, prefer replacement mode: use the complete-file SHA-256 returned by `workspace.read_file` as `expectedSha256`, provide bounded `replacements`, and omit `content`.",
          "- Each replacement must copy `oldText` exactly from the read result and state its `expectedOccurrences` (normally 1).",
          "- JSON-escape that string exactly once for transport. Do not JSON-encode the file text a second time.",
          "- After the tool arguments are parsed, source quotes must be ordinary quote characters and source line breaks must be actual line breaks, not pervasive literal backslash escapes.",
        ].join("\n"),
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () =>
      options.signal?.removeEventListener("abort", abort);
    const messages = [
      {
        role: "system" as const,
        content:
          "You are a bounded CharterMesh worker. Follow the task packet and return only the requested JSON object. Never claim an action, inspection, test, or external effect unless the current invocation received direct evidence that it happened. Successful JSON generation is not evidence that project checks ran. Tool arguments are parsed JSON values: prefer SHA-bound workspace.write_file replacements for small edits; full content must be raw file text after one JSON transport encoding, never a second JSON-encoded string.",
      },
      { role: "user" as const, content: prompt },
    ];
    const promise = (async () => {
      const inferenceRequest = {
        invocationId: `${request.attemptId}:1`,
        messages,
        responseSchema: structuredArtifactSchema,
        maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
      };
      const toolLoop = options.toolRuntime
        ? await options.toolRuntime.run(
            options.engine,
            inferenceRequest,
            { signal: controller.signal },
          )
        : undefined;
      const first =
        toolLoop?.inference ??
        (await options.engine.generate(inferenceRequest, {
          signal: controller.signal,
        }));
      let artifact = parseStructuredArtifact(first.text);
      if (artifact) {
        return {
          inference: {
            ...first,
            text: `${JSON.stringify(artifact, null, 2)}\n`,
          },
          toolEvidence: toolLoop?.evidence ?? [],
        };
      }
      const repair = await options.engine.generate(
        {
          invocationId: `${request.attemptId}:2`,
          messages: [
            ...messages,
            { role: "assistant", content: first.text.slice(0, 12_000) },
            {
              role: "user",
              content:
                "The previous response did not match the required JSON schema. Return one corrected JSON object only. Preserve the evidence boundary: checks are only actions actually performed with direct current-invocation evidence; otherwise use an empty checks array and move proposals to nextActions. Do not use Markdown fences.",
            },
          ],
          responseSchema: structuredArtifactSchema,
          maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
        },
        { signal: controller.signal },
      );
      artifact = parseStructuredArtifact(repair.text);
      if (!artifact) {
        throw new Error(
          "STRUCTURED_ARTIFACT_INVALID: model output failed schema validation after one repair turn.",
        );
      }
      return {
        inference: {
          ...repair,
          text: `${JSON.stringify(artifact, null, 2)}\n`,
          usage: addUsage(first.usage, repair.usage),
        },
        toolEvidence: toolLoop?.evidence ?? [],
      };
    })();
    this.pending.set(hostRunId, { controller, promise, cleanup });
    return { hostRunId, status: "running" };
  }

  async result(hostRunId: string): Promise<ManagedRunResult> {
    const pending = this.pending.get(hostRunId);
    if (!pending) throw new Error(`Unknown managed run '${hostRunId}'.`);
    try {
      const result = await pending.promise;
      return { hostRunId, ...result };
    } finally {
      pending.cleanup();
      this.pending.delete(hostRunId);
    }
  }

  async cancel(hostRunId: string): Promise<void> {
    const pending = this.pending.get(hostRunId);
    if (!pending) {
      throw new Error(`Unknown managed run '${hostRunId}'.`);
    }
    pending.controller.abort(new Error("Managed run canceled."));
    try {
      await pending.promise;
    } catch {
      // Cancellation is reflected through the aborted result path.
    }
    pending.cleanup();
    this.pending.delete(hostRunId);
  }
}
