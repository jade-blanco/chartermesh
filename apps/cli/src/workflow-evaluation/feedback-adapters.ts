import type { ModelUsage } from "../../../../packages/adapter-sdk/src/types.ts";
import {
  CodexCliFeedbackProvider,
  FixedSelfReviewFeedbackProvider,
  NeutralRepeatFeedbackProvider,
  SIMULATED_USER_FEEDBACK_REQUEST_API_VERSION,
  type SimulatedUserFeedbackProvider,
} from "./codex-proxy.ts";
import type {
  WorkflowFeedbackPolicy,
  WorkflowFeedbackProvider,
} from "./types.ts";
import {
  WorkflowAccountedError,
  unknownWorkflowUsage,
} from "./types.ts";

export const WORKFLOW_FEEDBACK_ADAPTER_VERSION =
  "chartermesh.dev/workflow-feedback-adapter/v1alpha2" as const;

function usage(modelCall: boolean): ModelUsage {
  return {
    inputTokens: modelCall ? null : 0,
    outputTokens: modelCall ? null : 0,
    cacheReadTokens: modelCall ? null : 0,
    cacheWriteTokens: modelCall ? null : 0,
    cost: modelCall ? null : 0,
    measurementStatus: modelCall ? "unknown" : "measured",
  };
}

export function adaptSimulatedUserFeedbackProvider(input: {
  evaluationId: string;
  policy: WorkflowFeedbackPolicy;
  provider: SimulatedUserFeedbackProvider;
  countsAsModelCall: boolean;
}): WorkflowFeedbackProvider {
  return {
    id: input.policy,
    providerId: input.provider.providerId,
    actorType: "simulated_user_proxy",
    mayResolveHumanApproval: false,
    async provideFeedback(request) {
      const startedAt = performance.now();
      let result;
      try {
        result = await input.provider.provideFeedback(
          {
            apiVersion: SIMULATED_USER_FEEDBACK_REQUEST_API_VERSION,
            evaluationId: input.evaluationId,
            taskId: request.task.id,
            iteration: request.submission,
            publicObjective: request.task.objective,
            publicImplementationRequest:
              request.task.initialImplementationBrief,
            publicArtifacts: [
              {
                name: `${request.task.id}-visible-result.txt`,
                mediaType: "text/plain",
                content: request.currentHumanView,
              },
            ],
            publicChecks: request.task.acceptanceCriteria.map(
              (criterion, index) => ({
                name: `public-criterion-${index + 1}`,
                status: "unknown" as const,
                summary: criterion,
              }),
            ),
          },
          request.signal ? { signal: request.signal } : {},
        );
      } catch (error) {
        if (!input.countsAsModelCall) throw error;
        throw new WorkflowAccountedError(
          "WORKFLOW_FEEDBACK_INVOCATION_FAILED",
          {
            latencyMs: Math.round(performance.now() - startedAt),
            modelCalls: 1,
            usage: unknownWorkflowUsage(),
          },
          error,
        );
      }
      const fallback =
        result.recommendation === "approve"
          ? "특별한 수정 의견 없음"
          : "공개 결과물을 다시 확인하고 개선해 주세요.";
      return {
        providerId: result.providerId,
        directive:
          result.feedback.length > 0
            ? input.policy !== "codex_generalist"
              ? result.feedback[0]!
              : result.feedback.map((item) => `- ${item}`).join("\n")
            : fallback,
        recommendation:
          result.recommendation === "approve"
            ? "looks_good"
            : "changes_requested",
        actorType: "simulated_user_proxy",
        mayResolveHumanApproval: false,
        latencyMs: Math.round(performance.now() - startedAt),
        modelCalls: input.countsAsModelCall ? 1 : 0,
        usage: usage(input.countsAsModelCall),
      };
    },
  };
}

export function standardWorkflowFeedbackProviders(input: {
  evaluationId: string;
  codex: CodexCliFeedbackProvider;
}): Record<WorkflowFeedbackPolicy, WorkflowFeedbackProvider> {
  return {
    neutral_repeat: adaptSimulatedUserFeedbackProvider({
      evaluationId: input.evaluationId,
      policy: "neutral_repeat",
      provider: new NeutralRepeatFeedbackProvider(),
      countsAsModelCall: false,
    }),
    fixed_self_review: adaptSimulatedUserFeedbackProvider({
      evaluationId: input.evaluationId,
      policy: "fixed_self_review",
      provider: new FixedSelfReviewFeedbackProvider(),
      countsAsModelCall: false,
    }),
    codex_generalist: adaptSimulatedUserFeedbackProvider({
      evaluationId: input.evaluationId,
      policy: "codex_generalist",
      provider: input.codex,
      countsAsModelCall: true,
    }),
  };
}
