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
        name: "runner.single_turn",
        support: "native",
        stability: "stable",
      },
      {
        name: "host.approval.pause_resume",
        support: "native",
        stability: "stable",
      },
    ],
  };

  private readonly pending = new Map<string, Promise<InferenceResult>>();

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
      "Return a concise result suitable for human review.",
    ]
      .filter(Boolean)
      .join("\n\n");

    this.pending.set(
      hostRunId,
      options.engine.generate(
        {
          invocationId: `${request.attemptId}:1`,
          messages: [
            {
              role: "system",
              content:
                "You are a bounded CharterMesh worker. Follow the task packet and do not claim external actions were performed.",
            },
            { role: "user", content: prompt },
          ],
        },
        { signal: options.signal },
      ),
    );
    return { hostRunId, status: "running" };
  }

  async result(hostRunId: string): Promise<ManagedRunResult> {
    const pending = this.pending.get(hostRunId);
    if (!pending) throw new Error(`Unknown managed run '${hostRunId}'.`);
    try {
      return { hostRunId, inference: await pending };
    } finally {
      this.pending.delete(hostRunId);
    }
  }

  async cancel(hostRunId: string): Promise<void> {
    if (!this.pending.has(hostRunId)) {
      throw new Error(`Unknown managed run '${hostRunId}'.`);
    }
    this.pending.delete(hostRunId);
  }
}
