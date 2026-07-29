import { randomUUID } from "node:crypto";
import type {
  HostRunHandle,
  HostRunRequest,
  InferenceResult,
  ManagedRunner,
  ManagedRunnerManifest,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";

export interface ManagedRunResult {
  hostRunId: string;
  inference: InferenceResult;
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
      promise: Promise<InferenceResult>;
      cleanup: () => void;
    }
  >();

  async start(
    request: HostRunRequest,
    options: { engine: ModelEngine; signal?: AbortSignal },
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
            checks: ["string"],
            risks: ["string"],
            nextActions: ["string"],
            confidence: "low | medium | high",
          },
          null,
          2,
        ),
        "Use empty arrays when there are no checks, risks, or next actions. Do not add keys or Markdown fences.",
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
          "You are a bounded CharterMesh worker. Follow the task packet, do not claim external actions were performed, and return only the requested JSON object.",
      },
      { role: "user" as const, content: prompt },
    ];
    const promise = (async () => {
      const first = await options.engine.generate(
        {
          invocationId: `${request.attemptId}:1`,
          messages,
          responseSchema: structuredArtifactSchema,
          maxOutputTokens: 1_500,
        },
        { signal: controller.signal },
      );
      let artifact = parseStructuredArtifact(first.text);
      if (artifact) {
        return {
          ...first,
          text: `${JSON.stringify(artifact, null, 2)}\n`,
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
                "The previous response did not match the required JSON schema. Return one corrected JSON object only. Do not use Markdown fences.",
            },
          ],
          responseSchema: structuredArtifactSchema,
          maxOutputTokens: 1_500,
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
        ...repair,
        text: `${JSON.stringify(artifact, null, 2)}\n`,
        usage: addUsage(first.usage, repair.usage),
      };
    })();
    this.pending.set(hostRunId, { controller, promise, cleanup });
    return { hostRunId, status: "running" };
  }

  async result(hostRunId: string): Promise<ManagedRunResult> {
    const pending = this.pending.get(hostRunId);
    if (!pending) throw new Error(`Unknown managed run '${hostRunId}'.`);
    try {
      return { hostRunId, inference: await pending.promise };
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
