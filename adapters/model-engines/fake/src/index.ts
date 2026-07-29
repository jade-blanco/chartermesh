import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelEngineManifest,
} from "../../../../packages/adapter-sdk/src/types.ts";

export class FakeModelEngine implements ModelEngine {
  readonly manifest: ModelEngineManifest = {
    kind: "model_engine",
    profileId: "fake-model-engine",
    adapter: "fake-model-engine",
    contractVersion: "v1alpha1",
    capabilities: [
      {
        name: "model.text.generate",
        support: "native",
        stability: "stable",
      },
      {
        name: "model.structured_output",
        support: "native",
        stability: "stable",
      },
    ],
  };

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    const userMessage = [...request.messages]
      .reverse()
      .find(({ role }) => role === "user")?.content;
    return {
      invocationId: request.invocationId,
      text: JSON.stringify({
        apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
        summary: "Simulated CharterMesh result",
        deliverable:
          userMessage?.slice(0, 500) ?? "No task input was provided.",
        checks: ["The offline execution path completed."],
        risks: ["This is synthetic output and performs no external side effect."],
        nextActions: ["Review the immutable artifact hash."],
        confidence: "high",
      }),
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        measurementStatus: "measured",
      },
    };
  }
}
