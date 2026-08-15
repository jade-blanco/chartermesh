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
  codexFeedbackAccounting?: {
    engineProfileId: string;
    modelId: string;
  };
}): WorkflowStudyPersistence {
  if (
    !Number.isInteger(input.maxChildrenPerTrial) ||
    input.maxChildrenPerTrial < 1 ||
    input.maxChildrenPerTrial > 1_000
  ) {
    throw new Error("maxChildrenPerTrial must be an integer from 1 to 1000.");
  }
  if (
    input.codexFeedbackAccounting &&
    [
      input.codexFeedbackAccounting.engineProfileId,
      input.codexFeedbackAccounting.modelId,
    ].some(
      (value) =>
        value.trim().length === 0 ||
        value.length > 1_024 ||
        /[\0\r\n]/u.test(value),
    )
  ) {
    throw new Error("Codex feedback accounting ids must be bounded strings.");
  }
  return {
    prepare(context): WorkflowStudyTrialRuntime {
      const actor = "system:workflow-evaluation";
      const commitment = digest(context.trialId);
      const work = input.controlPlane.intake({
        title: `${context.task.id} | ${context.conditionId}`,
        summary: [
          "Synthetic collaboration-study trajectory.",
          `trialId=${context.trialId}`,
          `engineRoute=${context.engineRoute}`,
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
      const wrappedEngines = new WeakMap<
        object,
        Map<string, ControlPlaneRecordingModelEngine>
      >();
      const wrapEngine = (wrappedInput: {
        engine: WorkflowStudyTrialRuntime["engine"];
        configuredModelId: string;
      }): ControlPlaneRecordingModelEngine => {
        let byModel = wrappedEngines.get(wrappedInput.engine);
        if (!byModel) {
          byModel = new Map();
          wrappedEngines.set(wrappedInput.engine, byModel);
        }
        const existing = byModel.get(wrappedInput.configuredModelId);
        if (existing) return existing;
        const wrapped = new ControlPlaneRecordingModelEngine({
          engine: wrappedInput.engine,
          controlPlane: input.controlPlane,
          registry,
          modelId: wrappedInput.configuredModelId,
        });
        byModel.set(wrappedInput.configuredModelId, wrapped);
        return wrapped;
      };
      const engine = wrapEngine({
        engine: context.engine,
        configuredModelId: input.configuredModelId,
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
        wrapEngine,
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
          if (invocations.some(({ status }) => status === "running")) {
            throw new Error("WORKFLOW_STUDY_INVOCATION_UNSETTLED");
          }
          const unpersistedCalls =
            trial.outcome.internalModelCallCount - invocations.length;
          const feedbackFailure =
            trial.outcome.failure?.phase === "feedback" ? 1 : 0;
          const successfulCodexFeedbackCalls =
            context.feedbackPolicy === "codex_generalist"
              ? trial.feedbackDirectives.length
              : 0;
          const codexCalls =
            context.feedbackPolicy === "codex_generalist"
              ? successfulCodexFeedbackCalls + feedbackFailure
              : 0;
          if (
            unpersistedCalls !== codexCalls ||
            (codexCalls > 0 && !input.codexFeedbackAccounting) ||
            (codexCalls > 0 &&
              input.codexFeedbackAccounting?.engineProfileId ===
                context.engine.manifest.profileId)
          ) {
            throw new Error("WORKFLOW_STUDY_INVOCATION_ACCOUNTING_MISMATCH");
          }
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
          const groupedInvocations = new Map<
            string,
            typeof invocations
          >();
          for (const invocation of invocations) {
            const key = `${invocation.engineId}\u0000${invocation.modelId}`;
            const group = groupedInvocations.get(key) ?? [];
            group.push(invocation);
            groupedInvocations.set(key, group);
          }
          trial.engineAccounting = [...groupedInvocations.values()]
            .map((group) => {
              const first = group[0]!;
              const nullableSum = (
                select: (item: (typeof group)[number]) => number | null,
              ): number | null =>
                group.some((item) => select(item) === null)
                  ? null
                  : group.reduce(
                      (sum, item) => sum + select(item)!,
                      0,
                    );
              const elapsedMs = group.reduce((sum, invocation) => {
                if (invocation.finishedAt === null) return sum;
                return sum + Math.max(
                  0,
                  new Date(invocation.finishedAt).getTime() -
                    new Date(invocation.startedAt).getTime(),
                );
              }, 0);
              return {
                engineProfileId: first.engineId,
                modelId: first.modelId,
                calls: group.length,
                succeeded: group.filter(({ status }) => status === "succeeded")
                  .length,
                failed: group.filter(({ status }) => status === "failed")
                  .length,
                canceled: group.filter(({ status }) => status === "canceled")
                  .length,
                abandoned: group.filter(({ status }) => status === "abandoned")
                  .length,
                inputTokens: nullableSum(({ inputTokens }) => inputTokens),
                outputTokens: nullableSum(({ outputTokens }) => outputTokens),
                cost: nullableSum(({ cost }) => cost),
                elapsedMs,
                measurementStatus: group.some(
                  ({ measurementStatus }) => measurementStatus === "unknown",
                )
                  ? "unknown" as const
                  : group.some(
                        ({ measurementStatus }) =>
                          measurementStatus === "estimated",
                      )
                    ? "estimated" as const
                    : "measured" as const,
                evidenceSource: "control_plane_invocation" as const,
              };
            })
            .sort((left, right) =>
              `${left.engineProfileId}\u0000${left.modelId}`.localeCompare(
                `${right.engineProfileId}\u0000${right.modelId}`,
              ),
            );
          if (codexCalls > 0) {
            const canceled =
              feedbackFailure > 0 &&
              ["canceled", "wall_clock_limit"].includes(
                String(trial.outcome.censorReason),
              )
                ? 1
                : 0;
            trial.engineAccounting.push({
              engineProfileId:
                input.codexFeedbackAccounting!.engineProfileId,
              modelId: input.codexFeedbackAccounting!.modelId,
              calls: codexCalls,
              succeeded: successfulCodexFeedbackCalls,
              failed: feedbackFailure - canceled,
              canceled,
              abandoned: 0,
              inputTokens: null,
              outputTokens: null,
              cost: null,
              elapsedMs: null,
              measurementStatus: "unknown",
              evidenceSource: "derived_feedback_proxy",
            });
          }
          trial.engineAccounting.sort((left, right) =>
            `${left.engineProfileId}\u0000${left.modelId}\u0000${left.evidenceSource}`.localeCompare(
              `${right.engineProfileId}\u0000${right.modelId}\u0000${right.evidenceSource}`,
            ),
          );
          if (
            trial.engineAccounting.reduce(
              (sum, accounting) => sum + accounting.calls,
              0,
            ) !== trial.outcome.internalModelCallCount
          ) {
            throw new Error("WORKFLOW_STUDY_INVOCATION_ACCOUNTING_MISMATCH");
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
            runId: claim.runId,
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
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
