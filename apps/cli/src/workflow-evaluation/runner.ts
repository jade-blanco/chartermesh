import { createHash } from "node:crypto";
import type { ModelEngine } from "../../../../packages/adapter-sdk/src/types.ts";
import type { PeerTeamLifecycle } from "../../../../packages/runtime/src/index.ts";
import {
  ArtifactTaskSealedEvaluator,
  workflowTaskFromArtifactTask,
} from "./artifact-adapters.ts";
import {
  CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
  CodexCliFeedbackProvider,
  FIXED_SELF_REVIEW_FEEDBACK_SHA256,
  NEUTRAL_REPEAT_FEEDBACK_SHA256,
} from "./codex-proxy.ts";
import {
  CodeWorkflowSealedEvaluator,
  PeerTeamCodeWorkflowExecutor,
  SingleCodeWorkflowExecutor,
  preflightCodeWorkflowSandbox,
  workflowTaskFromCodeTask,
  type CodeWorkflowTask,
} from "./code-adapters.ts";
import type { CodeSandboxBackend } from "../code-evaluation/sandbox.ts";
import {
  standardWorkflowFeedbackProviders,
  WORKFLOW_FEEDBACK_ADAPTER_VERSION,
} from "./feedback-adapters.ts";
import {
  createArtifactWorkflowExecutor,
  createIdentityAttestingWorkflowEngine,
  WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
  WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
  WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
  WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
  type WorkflowProviderIdentityObservation,
} from "./model-executors.ts";
import {
  WORKFLOW_STUDY_CONDITIONS,
  runWorkflowStudy,
  workflowConditionId,
} from "./study.ts";
import type { ArtifactEvaluationTask } from "./suite.ts";
import type {
  WorkflowStudyReport,
  WorkflowExecutionResult,
  WorkflowPublicTask,
  WorkflowTrajectoryLimits,
  WorkflowTrajectoryReport,
} from "./types.ts";

export type WorkflowStudyTaskBinding =
  | {
      kind: "artifact";
      task: ArtifactEvaluationTask;
    }
  | {
      kind: "code";
      task: CodeWorkflowTask;
    };

export const WORKFLOW_STUDY_PLAN_API_VERSION =
  "chartermesh.dev/collaboration-study-plan/v1alpha2" as const;
export const WORKFLOW_STUDY_HARNESS_VERSION =
  "chartermesh.dev/collaboration-study-harness/v1alpha2" as const;

export interface WorkflowStudyPlan {
  apiVersion: typeof WORKFLOW_STUDY_PLAN_API_VERSION;
  studyId: string;
  planHash: string;
  suiteHash: string;
  seed: number;
  tasks: Array<{
    id: string;
    family: WorkflowPublicTask["family"];
    difficulty: WorkflowPublicTask["difficulty"];
    executionBoundary: "semantic_ir" | "attested_vm";
  }>;
  conditions: string[];
  conditionOrdering: "seeded_williams_square_v1";
  harnessVersion: typeof WORKFLOW_STUDY_HARNESS_VERSION;
  responseSchemaPolicy: {
    version: typeof WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION;
    maximumGrammarRepetition: typeof WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION;
    oversizedBoundAction: typeof WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION;
    acceptedOutputValidation: "original_application_contract";
    repetitionKeywords: Array<
      (typeof WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS)[number]
    >;
  };
  feedbackAdapterVersion: typeof WORKFLOW_FEEDBACK_ADAPTER_VERSION;
  feedbackInterventionHashes: {
    neutralRepeat: string;
    fixedSelfReview: string;
    codexGeneralist: string;
  };
  plannedTrajectories: number;
  boundedCheckpointFeedbackRounds: number;
  maximumFeedbackRoundsPerTrajectory: number;
  maximumTotalModelCallsPerTrajectory: number;
  codexProxyRequired: true;
  planGenerationModelCalls: false;
  liveExecutionRequiresExactApproval: true;
  actualHumanApproval: false;
  officeBoundary: "semantic_ir_only";
  codeBoundary: "not_selected" | "attested_vm_only";
  limits: WorkflowTrajectoryLimits;
  bindings: {
    candidateEngineId: string | null;
    candidateRuntimeProfileHash: string | null;
    candidateConfiguredModelId: string | null;
    codexExecutableSha256: string | null;
    codexModelId: string | null;
    codexTimeoutMs: number | null;
    codeSandboxId: string | null;
    codeSandboxProvenanceHash: string | null;
    codeSandboxLauncherCommitment: string | null;
    codeSandboxLauncherAttestation:
      | "file_sha256"
      | "command_name_only"
      | null;
  };
  liveReady: boolean;
}

export type ArtifactWorkflowStudyPlan = WorkflowStudyPlan;

function assertWorkflowStudyPlanIntegrity(plan: WorkflowStudyPlan): void {
  const {
    studyId,
    planHash,
    liveReady: _liveReady,
    ...committed
  } = plan;
  const recomputed = hash(committed);
  const requiresCode = plan.tasks.some(
    ({ executionBoundary }) => executionBoundary === "attested_vm",
  );
  const expectedLiveReady = [
    plan.bindings.candidateEngineId,
    plan.bindings.candidateRuntimeProfileHash,
    plan.bindings.candidateConfiguredModelId,
    plan.bindings.codexExecutableSha256,
    plan.bindings.codexModelId,
    plan.bindings.codexTimeoutMs,
    ...(requiresCode
      ? [
          plan.bindings.codeSandboxId,
          plan.bindings.codeSandboxProvenanceHash,
          plan.bindings.codeSandboxLauncherCommitment,
        ]
      : []),
  ].every((value) => value !== null) &&
    (!requiresCode ||
      plan.bindings.codeSandboxLauncherAttestation === "file_sha256");
  const expectedConditions =
    WORKFLOW_STUDY_CONDITIONS.map(workflowConditionId);
  const expectedFeedbackHashes = {
    neutralRepeat: NEUTRAL_REPEAT_FEEDBACK_SHA256,
    fixedSelfReview: FIXED_SELF_REVIEW_FEEDBACK_SHA256,
    codexGeneralist: CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
  };
  if (
    recomputed !== planHash ||
    studyId !== `collaboration-study-${recomputed.slice(0, 16)}` ||
    plan.liveReady !== expectedLiveReady ||
    hash(plan.conditions) !== hash(expectedConditions) ||
    plan.conditionOrdering !== "seeded_williams_square_v1" ||
    plan.apiVersion !== WORKFLOW_STUDY_PLAN_API_VERSION ||
    plan.harnessVersion !== WORKFLOW_STUDY_HARNESS_VERSION ||
    hash(plan.responseSchemaPolicy) !==
      hash({
        version: WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
        maximumGrammarRepetition:
          WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
        oversizedBoundAction:
          WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
        acceptedOutputValidation: "original_application_contract",
        repetitionKeywords: [
          ...WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
        ],
      }) ||
    plan.feedbackAdapterVersion !== WORKFLOW_FEEDBACK_ADAPTER_VERSION ||
    hash(plan.feedbackInterventionHashes) !==
      hash(expectedFeedbackHashes) ||
    plan.codeBoundary !==
      (requiresCode ? "attested_vm_only" : "not_selected")
  ) {
    throw new Error("WORKFLOW_STUDY_PLAN_INTEGRITY_MISMATCH");
  }
}

export interface WorkflowStudyTrialRuntime {
  engine: ModelEngine;
  runContext: {
    workItemId: string;
    runId: string;
    attemptId: string;
    generation: number;
    lifecycle?: Partial<PeerTeamLifecycle>;
  };
  finalize(
    trial: WorkflowTrajectoryReport,
  ): Promise<void> | void;
  recordExecution?(input: {
    submission: number;
    directiveHash: string;
    result: WorkflowExecutionResult;
  }): Promise<void> | void;
}

export interface WorkflowStudyPersistence {
  prepare(input: {
    studyId: string;
    trialId: string;
    task: WorkflowPublicTask;
    architecture: "single" | "team";
    feedbackPolicy: "neutral_repeat" | "fixed_self_review" | "codex_generalist";
    engine: ModelEngine;
  }): Promise<WorkflowStudyTrialRuntime> | WorkflowStudyTrialRuntime;
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

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function workflowStudyValueHash(value: unknown): string {
  return hash(value);
}

function publicTaskForBinding(
  binding: WorkflowStudyTaskBinding,
): WorkflowPublicTask {
  return binding.kind === "artifact"
    ? workflowTaskFromArtifactTask(binding.task)
    : workflowTaskFromCodeTask(binding.task);
}

export function workflowStudyTaskBindingsHash(
  bindings: WorkflowStudyTaskBinding[],
): string {
  return hash(
    bindings
      .map((binding) => ({
        kind: binding.kind,
        id:
          binding.kind === "artifact"
            ? binding.task.id
            : binding.task.task.id,
        taskHash:
          binding.kind === "artifact"
            ? binding.task.taskHash
            : binding.task.task.taskHash,
        difficulty:
          binding.kind === "artifact"
            ? binding.task.difficulty
            : binding.task.difficulty,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function createWorkflowStudyPlan(input: {
  taskBindings: WorkflowStudyTaskBinding[];
  limits: WorkflowTrajectoryLimits;
  seed: number;
  bindings?: Partial<WorkflowStudyPlan["bindings"]>;
}): WorkflowStudyPlan {
  if (input.taskBindings.length === 0) {
    throw new Error("Collaboration study requires at least one task.");
  }
  if (!Number.isSafeInteger(input.seed)) {
    throw new Error("Collaboration study seed must be a safe integer.");
  }
  const publicTasks = input.taskBindings.map(publicTaskForBinding);
  if (new Set(publicTasks.map(({ id }) => id)).size !== publicTasks.length) {
    throw new Error("Collaboration study task ids must be unique.");
  }
  const requiresCodeSandbox = input.taskBindings.some(
    ({ kind }) => kind === "code",
  );
  const bindings: WorkflowStudyPlan["bindings"] = {
    candidateEngineId: input.bindings?.candidateEngineId ?? null,
    candidateRuntimeProfileHash:
      input.bindings?.candidateRuntimeProfileHash?.toLowerCase() ?? null,
    candidateConfiguredModelId:
      input.bindings?.candidateConfiguredModelId ?? null,
    codexExecutableSha256:
      input.bindings?.codexExecutableSha256?.toLowerCase() ?? null,
    codexModelId: input.bindings?.codexModelId ?? null,
    codexTimeoutMs: input.bindings?.codexTimeoutMs ?? null,
    codeSandboxId: input.bindings?.codeSandboxId ?? null,
    codeSandboxProvenanceHash:
      input.bindings?.codeSandboxProvenanceHash?.toLowerCase() ?? null,
    codeSandboxLauncherCommitment:
      input.bindings?.codeSandboxLauncherCommitment?.toLowerCase() ?? null,
    codeSandboxLauncherAttestation:
      input.bindings?.codeSandboxLauncherAttestation ?? null,
  };
  for (const [name, value] of [
    ["candidateRuntimeProfileHash", bindings.candidateRuntimeProfileHash],
    ["codexExecutableSha256", bindings.codexExecutableSha256],
    ["codeSandboxProvenanceHash", bindings.codeSandboxProvenanceHash],
    [
      "codeSandboxLauncherCommitment",
      bindings.codeSandboxLauncherCommitment,
    ],
  ] as const) {
    if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`${name} must be a lowercase SHA-256 digest.`);
    }
  }
  for (const [name, value] of [
    ["candidateEngineId", bindings.candidateEngineId],
    ["candidateConfiguredModelId", bindings.candidateConfiguredModelId],
    ["codexModelId", bindings.codexModelId],
    ["codeSandboxId", bindings.codeSandboxId],
  ] as const) {
    if (
      value !== null &&
      (value.trim().length === 0 ||
        value.length > 1_024 ||
        /[\0\r\n]/u.test(value))
    ) {
      throw new Error(`${name} must be a bounded single-line string.`);
    }
  }
  if (
    bindings.codeSandboxLauncherAttestation !== null &&
    !["file_sha256", "command_name_only"].includes(
      bindings.codeSandboxLauncherAttestation,
    )
  ) {
    throw new Error("codeSandboxLauncherAttestation is invalid.");
  }
  if (
    bindings.codexTimeoutMs !== null &&
    (!Number.isInteger(bindings.codexTimeoutMs) ||
      bindings.codexTimeoutMs < 1_000 ||
      bindings.codexTimeoutMs > 900_000)
  ) {
    throw new Error("codexTimeoutMs must be between 1000 and 900000.");
  }
  if (
    !requiresCodeSandbox &&
    [
      bindings.codeSandboxId,
      bindings.codeSandboxProvenanceHash,
      bindings.codeSandboxLauncherCommitment,
      bindings.codeSandboxLauncherAttestation,
    ].some((value) => value !== null)
  ) {
    throw new Error(
      "Code sandbox bindings require at least one selected code task.",
    );
  }
  const committed = {
    apiVersion: WORKFLOW_STUDY_PLAN_API_VERSION,
    suiteHash: workflowStudyTaskBindingsHash(input.taskBindings),
    seed: input.seed,
    tasks: input.taskBindings.map((binding) => {
      const task = publicTaskForBinding(binding);
      return {
        id: task.id,
        family: task.family,
        difficulty: task.difficulty,
        executionBoundary:
          binding.kind === "code" ? "attested_vm" as const : "semantic_ir" as const,
      };
    }),
    conditions: WORKFLOW_STUDY_CONDITIONS.map(workflowConditionId),
    conditionOrdering: "seeded_williams_square_v1" as const,
    harnessVersion: WORKFLOW_STUDY_HARNESS_VERSION,
    responseSchemaPolicy: {
      version: WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
      maximumGrammarRepetition:
        WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
      oversizedBoundAction:
        WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
      acceptedOutputValidation: "original_application_contract" as const,
      repetitionKeywords: [
        ...WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
      ],
    },
    feedbackAdapterVersion: WORKFLOW_FEEDBACK_ADAPTER_VERSION,
    feedbackInterventionHashes: {
      neutralRepeat: NEUTRAL_REPEAT_FEEDBACK_SHA256,
      fixedSelfReview: FIXED_SELF_REVIEW_FEEDBACK_SHA256,
      codexGeneralist: CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
    },
    plannedTrajectories:
      input.taskBindings.length * WORKFLOW_STUDY_CONDITIONS.length,
    boundedCheckpointFeedbackRounds: input.limits.boundedCheckpoint,
    maximumFeedbackRoundsPerTrajectory: input.limits.maxFeedbackRounds,
    maximumTotalModelCallsPerTrajectory: input.limits.maxModelCalls,
    codexProxyRequired: true as const,
    planGenerationModelCalls: false as const,
    liveExecutionRequiresExactApproval: true as const,
    actualHumanApproval: false as const,
    officeBoundary: "semantic_ir_only" as const,
    codeBoundary: requiresCodeSandbox
      ? "attested_vm_only" as const
      : "not_selected" as const,
    limits: structuredClone(input.limits),
    bindings,
  };
  const planHash = hash(committed);
  const coreReady = [
    bindings.candidateEngineId,
    bindings.candidateRuntimeProfileHash,
    bindings.candidateConfiguredModelId,
    bindings.codexExecutableSha256,
    bindings.codexModelId,
    bindings.codexTimeoutMs,
  ].every((value) => value !== null);
  const codeReady =
    !requiresCodeSandbox ||
    (bindings.codeSandboxLauncherAttestation === "file_sha256" &&
      [
        bindings.codeSandboxId,
        bindings.codeSandboxProvenanceHash,
        bindings.codeSandboxLauncherCommitment,
      ].every((value) => value !== null));
  return {
    ...committed,
    studyId: `collaboration-study-${planHash.slice(0, 16)}`,
    planHash,
    liveReady: coreReady && codeReady,
  };
}

export function createArtifactWorkflowStudyPlan(input: {
  tasks: ArtifactEvaluationTask[];
  limits: WorkflowTrajectoryLimits;
  seed: number;
  bindings?: Partial<ArtifactWorkflowStudyPlan["bindings"]>;
}): ArtifactWorkflowStudyPlan {
  return createWorkflowStudyPlan({
    taskBindings: input.tasks.map((task) => ({ kind: "artifact", task })),
    limits: input.limits,
    seed: input.seed,
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
}

export async function runBoundWorkflowStudy(input: {
  plan: WorkflowStudyPlan;
  taskBindings: WorkflowStudyTaskBinding[];
  limits: WorkflowTrajectoryLimits;
  engine: ModelEngine;
  codex: CodexCliFeedbackProvider;
  codeSandbox?: {
    backend: CodeSandboxBackend;
    provenanceHash: string;
    launcherCommitment: string;
    launcherAttestation: "file_sha256" | "command_name_only";
  };
  engineForRole?: (role: string) => ModelEngine;
  signal?: AbortSignal;
  onTrial?: (
    trial: WorkflowTrajectoryReport,
  ) => Promise<void> | void;
  persistence?: WorkflowStudyPersistence;
}): Promise<WorkflowStudyReport> {
  assertWorkflowStudyPlanIntegrity(input.plan);
  if (
    input.plan.suiteHash !==
      workflowStudyTaskBindingsHash(input.taskBindings) ||
    input.plan.tasks.length !== input.taskBindings.length ||
    hash(input.plan.limits) !== hash(input.limits)
  ) {
    throw new Error("WORKFLOW_STUDY_PLAN_SUITE_MISMATCH");
  }
  const currentTasks = input.taskBindings.map((binding) => {
    const task = publicTaskForBinding(binding);
    return {
      id: task.id,
      family: task.family,
      difficulty: task.difficulty,
      executionBoundary:
        binding.kind === "code" ? "attested_vm" : "semantic_ir",
    };
  });
  if (hash(input.plan.tasks) !== hash(currentTasks)) {
    throw new Error("WORKFLOW_STUDY_PLAN_TASK_BINDING_MISMATCH");
  }
  if (input.engineForRole) {
    throw new Error("WORKFLOW_STUDY_UNBOUND_ROLE_ENGINE_RESOLVER");
  }
  const hasCode = input.taskBindings.some(({ kind }) => kind === "code");
  if (
    input.plan.bindings.candidateEngineId !==
      input.engine.manifest.profileId ||
    input.plan.bindings.codexExecutableSha256 !==
      input.codex.executableSha256 ||
    input.plan.bindings.codexModelId !== input.codex.model ||
    input.plan.bindings.codexTimeoutMs !== input.codex.timeoutMs ||
    !input.plan.liveReady
  ) {
    throw new Error("WORKFLOW_STUDY_PLAN_BINDING_MISMATCH");
  }
  if (
    hasCode &&
    (!input.codeSandbox ||
      input.plan.bindings.codeSandboxId !==
        input.codeSandbox.backend.manifest.id ||
      input.plan.bindings.codeSandboxProvenanceHash !==
        input.codeSandbox.provenanceHash ||
      input.plan.bindings.codeSandboxLauncherCommitment !==
        input.codeSandbox.launcherCommitment ||
      input.plan.bindings.codeSandboxLauncherAttestation !==
        input.codeSandbox.launcherAttestation)
  ) {
    throw new Error("WORKFLOW_STUDY_CODE_SANDBOX_BINDING_MISMATCH");
  }
  if (hasCode && input.codeSandbox) {
    await preflightCodeWorkflowSandbox(
      input.codeSandbox.backend,
      input.signal,
    );
  }
  const expectedModelId =
    input.plan.bindings.candidateConfiguredModelId!;
  const observedProviderIdentities = new Map<
    string,
    WorkflowProviderIdentityObservation
  >();
  const attestedEngines = new WeakMap<ModelEngine, ModelEngine>();
  const attestedEngine = (engine: ModelEngine): ModelEngine => {
    const existing = attestedEngines.get(engine);
    if (existing) return existing;
    const wrapped = createIdentityAttestingWorkflowEngine({
      engine,
      expectedModelId,
      observed: observedProviderIdentities,
    });
    attestedEngines.set(engine, wrapped);
    return wrapped;
  };
  const primaryEngine = attestedEngine(input.engine);
  const byId = new Map(
    input.taskBindings.map((binding) => [
      publicTaskForBinding(binding).id,
      binding,
    ]),
  );
  const finalizers = new Map<
    string,
    WorkflowStudyTrialRuntime["finalize"]
  >();
  return runWorkflowStudy({
    tasks: input.taskBindings.map(publicTaskForBinding),
    executorFactory: async ({ task, condition, trialId }) => {
      const binding = byId.get(task.id);
      if (!binding) throw new Error("WORKFLOW_STUDY_TASK_NOT_FOUND");
      const persisted = input.persistence
        ? await input.persistence.prepare({
            studyId: input.plan.studyId,
            trialId,
            task,
            architecture: condition.architecture,
            feedbackPolicy: condition.feedbackPolicy,
            engine: primaryEngine,
          })
        : null;
      if (persisted) finalizers.set(trialId, persisted.finalize);
      const selectedEngine = persisted?.engine ?? primaryEngine;
      const executor =
        binding.kind === "artifact"
          ? createArtifactWorkflowExecutor({
              architecture: condition.architecture,
              engine: selectedEngine,
              task: binding.task,
              maxParallelAgents: input.limits.maxParallelAgents,
              ...(persisted ? { runContext: persisted.runContext } : {}),
            })
          : condition.architecture === "single"
            ? new SingleCodeWorkflowExecutor({
                engine: selectedEngine,
                binding: binding.task,
              })
            : new PeerTeamCodeWorkflowExecutor({
                engine: selectedEngine,
                binding: binding.task,
                maxParallelAgents: input.limits.maxParallelAgents,
                ...(persisted ? { runContext: persisted.runContext } : {}),
              });
      if (!persisted?.recordExecution) return executor;
      return {
        architecture: executor.architecture,
        orient: executor.orient.bind(executor),
        execute: async (request) => {
          const result = await executor.execute(request);
          await persisted.recordExecution?.({
            submission: request.submission,
            directiveHash: request.directiveHash,
            result,
          });
          return result;
        },
      };
    },
    feedbackProviders: standardWorkflowFeedbackProviders({
      evaluationId: input.plan.studyId,
      codex: input.codex,
    }),
    evaluatorForTask: (task) => {
      const binding = byId.get(task.id);
      if (!binding) throw new Error("WORKFLOW_STUDY_TASK_NOT_FOUND");
      if (binding.kind === "artifact") {
        return new ArtifactTaskSealedEvaluator(binding.task);
      }
      if (!input.codeSandbox) {
        throw new Error("WORKFLOW_STUDY_CODE_SANDBOX_REQUIRED");
      }
      return new CodeWorkflowSealedEvaluator(
        binding.task.task,
        input.codeSandbox.backend,
      );
    },
    limits: input.limits,
    seed: input.plan.seed,
    studyId: input.plan.studyId,
    sealedSuiteHash: input.plan.suiteHash,
    approvedPlanHash: input.plan.planHash,
    approvedPlanCanonicalJson: JSON.stringify(stableValue(input.plan)),
    expectedCandidateModelId:
      input.plan.bindings.candidateConfiguredModelId!,
    provenance: {
      candidateEngine: {
        profileId: input.engine.manifest.profileId,
        adapter: input.engine.manifest.adapter,
        manifestHash: hash(input.engine.manifest),
        configuredModelId:
          input.plan.bindings.candidateConfiguredModelId,
        runtimeProfileHash:
          input.plan.bindings.candidateRuntimeProfileHash,
      },
      codexProxy: {
        providerId: input.codex.providerId,
        executableSha256: input.codex.executableSha256,
        requestedModelId: input.codex.model,
      },
      controlPlane: input.persistence
        ? {
            mode: "isolated_evaluation_database",
            durableRuns: true,
            durableAttempts: true,
            hashBoundHandoffs: true,
            productionApprovalLedgerUsed: false,
          }
        : null,
      codeSandbox: input.codeSandbox
        ? {
            id: input.codeSandbox.backend.manifest.id,
            provenanceHash: input.codeSandbox.provenanceHash,
            launcherCommitment: input.codeSandbox.launcherCommitment,
            launcherAttestation: input.codeSandbox.launcherAttestation,
            preflightPassed: true,
          }
        : null,
    },
    ...(input.signal ? { signal: input.signal } : {}),
    onTrial: async (trial) => {
      const finalize = finalizers.get(trial.trialId);
      if (finalize) {
        await finalize(trial);
        finalizers.delete(trial.trialId);
      }
      await input.onTrial?.(trial);
    },
  });
}

export async function runArtifactWorkflowStudy(input: {
  plan: ArtifactWorkflowStudyPlan;
  tasks: ArtifactEvaluationTask[];
  limits: WorkflowTrajectoryLimits;
  engine: ModelEngine;
  codex: CodexCliFeedbackProvider;
  engineForRole?: (role: string) => ModelEngine;
  signal?: AbortSignal;
  onTrial?: (
    trial: WorkflowTrajectoryReport,
  ) => Promise<void> | void;
  persistence?: WorkflowStudyPersistence;
}): Promise<WorkflowStudyReport> {
  return runBoundWorkflowStudy({
    plan: input.plan,
    taskBindings: input.tasks.map((task) => ({ kind: "artifact", task })),
    limits: input.limits,
    engine: input.engine,
    codex: input.codex,
    ...(input.engineForRole
      ? { engineForRole: input.engineForRole }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onTrial ? { onTrial: input.onTrial } : {}),
    ...(input.persistence ? { persistence: input.persistence } : {}),
  });
}
