import { createHash } from "node:crypto";
import type { ControlPlane } from "../../../../packages/control-plane/src/index.ts";
import {
  ControlPlaneRecordingModelEngine,
  WorkflowAttemptRegistry,
  createControlPlanePeerTeamLifecycle,
} from "./control-plane-lifecycle.ts";
import type {
  WorkflowStudyPersistence,
  WorkflowStudyTrialRuntime,
} from "./runner.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createControlPlaneWorkflowStudyPersistence(input: {
  controlPlane: ControlPlane;
  configuredModelId: string;
  maxChildrenPerTrial: number;
}): WorkflowStudyPersistence {
  if (
    !Number.isInteger(input.maxChildrenPerTrial) ||
    input.maxChildrenPerTrial < 1 ||
    input.maxChildrenPerTrial > 1_000
  ) {
    throw new Error("maxChildrenPerTrial must be an integer from 1 to 1000.");
  }
  return {
    prepare(context): WorkflowStudyTrialRuntime {
      const actor = "system:workflow-evaluation";
      const commitment = digest(context.trialId);
      const work = input.controlPlane.intake({
        title: `${context.task.id} | ${context.architecture} | ${context.feedbackPolicy}`,
        summary: [
          "Synthetic collaboration-study trajectory.",
          `trialId=${context.trialId}`,
          "A simulated evaluator may recommend approval but cannot resolve production human approval.",
        ].join("\n"),
        ownerRole: "evaluation-coordinator",
        executionTarget: "workflow-study",
        actor,
        idempotencyKey: `${commitment}:intake`,
      });
      const triaged = input.controlPlane.triage({
        id: work.id,
        ownerRole: "evaluation-coordinator",
        executionTarget:
          context.architecture === "team"
            ? "peer-team-controller"
            : "single-model-controller",
        actor,
        idempotencyKey: `${commitment}:triage`,
      });
      const claim = input.controlPlane.claim({
        id: triaged.id,
        actor,
        idempotencyKey: `${commitment}:claim`,
        leaseMinutes: 24 * 60,
      });
      const registry = new WorkflowAttemptRegistry(claim.attemptId);
      const engine = new ControlPlaneRecordingModelEngine({
        engine: context.engine,
        controlPlane: input.controlPlane,
        registry,
        modelId: input.configuredModelId,
      });
      const lifecycle = createControlPlanePeerTeamLifecycle({
        controlPlane: input.controlPlane,
        parentAttemptId: claim.attemptId,
        actor,
        registry,
        maxChildren: input.maxChildrenPerTrial,
      });
      let latestExecution:
        | {
            submission: number;
            directiveHash: string;
            artifact: string;
            artifactHash: string;
            humanView: string;
            contractValid: boolean;
          }
        | null = null;
      return {
        engine,
        runContext: {
          workItemId: work.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          generation: claim.generation,
          lifecycle,
        },
        recordExecution({ submission, directiveHash, result }) {
          latestExecution = {
            submission,
            directiveHash,
            artifact: result.artifact,
            artifactHash: digest(result.artifact),
            humanView: result.humanView,
            contractValid: result.contractValid,
          };
        },
        finalize(trial) {
          const invocations = registry
            .attemptIds()
            .flatMap((attemptId) =>
              input.controlPlane.listInvocations(attemptId),
            );
          const codexCalls =
            context.feedbackPolicy === "codex_generalist"
              ? Math.max(
                  trial.outcome.feedbackRoundCount,
                  trial.outcome.internalModelCallCount - invocations.length,
                )
              : 0;
          trial.outcome.internalModelCallCount = Math.max(
            trial.outcome.internalModelCallCount,
            invocations.length + codexCalls,
          );
          const invocationTokens = (
            field: "inputTokens" | "outputTokens",
          ): number | null =>
            invocations.some((invocation) => invocation[field] === null)
              ? null
              : invocations.reduce(
                  (sum, invocation) => sum + invocation[field]!,
                  0,
                );
          if (codexCalls > 0) {
            trial.outcome.totalInputTokens = null;
            trial.outcome.totalOutputTokens = null;
          } else if (invocations.length > 0) {
            trial.outcome.totalInputTokens = invocationTokens("inputTokens");
            trial.outcome.totalOutputTokens = invocationTokens("outputTokens");
          }
          const content = JSON.stringify(
            {
              apiVersion:
                "chartermesh.dev/collaboration-study-trial-evidence/v1alpha1",
              trial,
              latestExecution,
            },
            null,
            2,
          );
          input.controlPlane.submitArtifact({
            id: work.id,
            content,
            mediaType:
              "application/vnd.chartermesh.collaboration-study-trial+json",
            generation: claim.generation,
            actor,
            idempotencyKey: `${commitment}:submit`,
          });
        },
      };
    },
  };
}
