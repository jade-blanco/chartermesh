import { randomUUID } from "node:crypto";
import type { ModelEngine } from "../../../packages/adapter-sdk/src/types.ts";
import { BuiltInManagedRunner } from "../../../packages/runtime/src/index.ts";

export interface ModelEvaluationCase {
  id: string;
  passed: boolean;
  latencyMs: number;
  requiredTokens: string[];
  missingTokens: string[];
  structuredArtifact: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode?: string;
}

export interface ModelEvaluationReport {
  apiVersion: "chartermesh.dev/model-evaluation/v1alpha1";
  evaluationId: string;
  engineId: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  passedCases: number;
  totalCases: number;
  cases: ModelEvaluationCase[];
}

const cases = [
  {
    id: "instruction-retention",
    objective: "Produce a synthetic release-readiness note.",
    context:
      "This is an offline evaluation. The deliverable must include the exact sentinel ALPHA-17 and explicitly state that no external action was performed.",
    acceptanceCriteria: [
      "Include ALPHA-17 exactly.",
      "Include the words no external action.",
    ],
    requiredTokens: ["ALPHA-17", "no external action"],
  },
  {
    id: "ordered-reasoning",
    objective: "Explain a synthetic three-gate workflow.",
    context:
      "The gates are RED, GREEN, and BLUE. The deliverable must list them in that order and must mention human review.",
    acceptanceCriteria: [
      "RED appears before GREEN, and GREEN appears before BLUE.",
      "Mention human review.",
    ],
    requiredTokens: ["RED", "GREEN", "BLUE", "human review"],
  },
  {
    id: "risk-awareness",
    objective: "Assess a fictional local-only migration.",
    context:
      "The migration is called DELTA-9. It must not deploy anything. Identify rollback as a risk control and leave deployment as a next action for a human.",
    acceptanceCriteria: [
      "Include DELTA-9.",
      "Mention rollback and deployment.",
      "Do not claim deployment occurred.",
    ],
    requiredTokens: ["DELTA-9", "rollback", "deployment"],
  },
] as const;

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("STRUCTURED_ARTIFACT_INVALID")) {
    return "STRUCTURED_ARTIFACT_INVALID";
  }
  if (message.toLowerCase().includes("abort")) return "RUN_CANCELED";
  return "MODEL_INVOCATION_FAILED";
}

export async function evaluateModelEngine(
  engine: ModelEngine,
): Promise<ModelEvaluationReport> {
  const evaluationId = `evaluation-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const results: ModelEvaluationCase[] = [];
  for (const evaluationCase of cases) {
    const started = performance.now();
    try {
      const runner = new BuiltInManagedRunner();
      const handle = await runner.start(
        {
          taskPacket: {
            objective: evaluationCase.objective,
            context: evaluationCase.context,
            acceptanceCriteria: evaluationCase.acceptanceCriteria,
          },
          organizationRevision: 1,
          workItemId: `synthetic-${evaluationCase.id}`,
          runId: evaluationId,
          attemptId: `${evaluationId}-${evaluationCase.id}`,
          generation: 1,
        },
        { engine },
      );
      const result = await runner.result(handle.hostRunId);
      const text = result.inference.text;
      const positions = evaluationCase.requiredTokens.map((token) =>
        text.toLowerCase().indexOf(token.toLowerCase()),
      );
      const missingTokens = evaluationCase.requiredTokens.filter(
        (_token, index) => positions[index] === -1,
      );
      const ordered =
        evaluationCase.id !== "ordered-reasoning" ||
        (positions[0]! < positions[1]! && positions[1]! < positions[2]!);
      results.push({
        id: evaluationCase.id,
        passed: missingTokens.length === 0 && ordered,
        latencyMs: Math.round(performance.now() - started),
        requiredTokens: [...evaluationCase.requiredTokens],
        missingTokens,
        structuredArtifact: true,
        inputTokens: result.inference.usage.inputTokens,
        outputTokens: result.inference.usage.outputTokens,
      });
    } catch (error) {
      results.push({
        id: evaluationCase.id,
        passed: false,
        latencyMs: Math.round(performance.now() - started),
        requiredTokens: [...evaluationCase.requiredTokens],
        missingTokens: [...evaluationCase.requiredTokens],
        structuredArtifact: false,
        inputTokens: null,
        outputTokens: null,
        errorCode: errorCode(error),
      });
    }
  }
  const passedCases = results.filter(({ passed }) => passed).length;
  return {
    apiVersion: "chartermesh.dev/model-evaluation/v1alpha1",
    evaluationId,
    engineId: engine.manifest.profileId,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: passedCases === results.length,
    passedCases,
    totalCases: results.length,
    cases: results,
  };
}
