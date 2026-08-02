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
  CodexExecModelEngine,
  CODEX_EXEC_MODEL_PROTOCOL_SHA256,
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
  fixedWorkflowTeam,
  WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS,
  WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
  WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
  WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION,
  WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256,
  WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
  WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
  WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
  WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
  WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION,
  WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
  WORKFLOW_TEAM_MAX_HANDOFFS,
  WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
  WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
  WORKFLOW_TEAM_MAX_PARALLEL,
  WORKFLOW_TEAM_MAX_STAGE_CALLS,
  WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
  WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
  WORKFLOW_TEAM_PROTOCOL_VERSION,
  type WorkflowProviderIdentityObservation,
} from "./model-executors.ts";
import {
  WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS,
  WORKFLOW_STUDY_CONDITIONS,
  runWorkflowStudy,
  workflowConditionId,
} from "./study.ts";
import type { ArtifactEvaluationTask } from "./suite.ts";
import type {
  WorkflowStudyReport,
  WorkflowEngineRoute,
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
  "chartermesh.dev/collaboration-study-plan/v1alpha6" as const;
export const WORKFLOW_STUDY_HARNESS_VERSION =
  "chartermesh.dev/collaboration-study-harness/v1alpha6" as const;
export const WORKFLOW_STUDY_ENGINE_ROUTING_POLICY_VERSION =
  "chartermesh.dev/workflow-engine-routing/v1alpha1" as const;
export const WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID =
  "codex-cli-ordinary-user" as const;
export const WORKFLOW_HYBRID_HOST_ORIENTATION_PLAN = [
  "Treat the public objective, context, acceptance criteria, and caller-owned response contract as the complete specification.",
  "Cover every public acceptance criterion, verify contract completeness before requesting review, and return only contract-valid output.",
  "Do not assume hidden requirements or perform external side effects.",
].join("\n");

export type WorkflowStudyConditionSet =
  | "standard_v1"
  | "hybrid_c_level_canary_v1";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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
  conditionSet: WorkflowStudyConditionSet;
  conditions: string[];
  conditionOrdering:
    | "seeded_williams_square_v1"
    | "seeded_cyclic_latin_v1";
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
  teamProtocolPolicy: {
    version: typeof WORKFLOW_TEAM_PROTOCOL_VERSION;
    setup: "fixed_host_owned_two_role";
    finalSubmission: "caller_owned_typed_object";
    dispatchRoleConstraint: "declared_worker_enum";
    reviewRequiresHandoff: true;
    fixedTeamSha256: {
      artifact: string;
      code: string;
    };
    controller: {
      maxInternalCycles: typeof WORKFLOW_TEAM_MAX_INTERNAL_CYCLES;
      maxHandoffs: typeof WORKFLOW_TEAM_MAX_HANDOFFS;
      maxStageCalls: typeof WORKFLOW_TEAM_MAX_STAGE_CALLS;
      maxParallel: typeof WORKFLOW_TEAM_MAX_PARALLEL;
      maxOutputTokensPerCall: typeof WORKFLOW_TEAM_MAX_OUTPUT_TOKENS;
      maxDirectiveChars: typeof WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS;
      maxWorkerResponseChars: typeof WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS;
      maxTranscriptChars: typeof WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS;
    };
  };
  artifactRetentionPolicy: {
    version: typeof WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION;
    nextRevisionBaseline: "last_contract_valid";
    sealedScoreInfluencesRetention: false;
  };
  contractRepairPolicy: {
    version: typeof WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION;
    maximumAttempts: typeof WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS;
    appliesTo: "single_and_team_artifact_and_code";
    trigger: "public_contract_or_transport_invalid_and_budget_available";
    diagnosticDisclosure: "public_codes_only";
    maximumInvalidCandidateChars: typeof WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS;
    maximumOutputTokensPerCall: typeof WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS;
    finishReasonPolicy: "stop_required";
    budgetBehavior: "skip_without_call";
    promptSha256: string;
  };
  orientationSamplingPolicy: {
    designSeedPurpose: "task_and_condition_order_only";
    inferenceSampling:
      | "provider_default_uncontrolled"
      | "host_owned_deterministic";
    sharedAcrossConditions: boolean;
    hostOwnedCanonicalPlanSha256: string | null;
  };
  engineRoutingPolicy: {
    version: typeof WORKFLOW_STUDY_ENGINE_ROUTING_POLICY_VERSION;
    defaultEngineBinding: "candidate";
    codexCLevelBoundary: {
      workspace: "ephemeral_read_only";
      hostCapabilities: "disabled";
      responseSchema: "required";
      outputTokenLimit: "prompt_only_unverified";
      hardOutputLimit: "plan_bound_bytes";
      usage: "unknown";
    } | null;
    routes: Array<{
      conditionId: string;
      engineRoute: WorkflowEngineRoute;
      orientationEngine: "candidate" | "host";
      coordinatorEngine: "candidate" | "codex";
      specialistEngine: "candidate";
      repairEngine: "candidate";
    }>;
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
  maximumConsecutiveContractInvalidSubmissionsPerTrajectory: number;
  codexProxyRequired: true;
  codexExecutionPurpose:
    | "simulated_user_feedback"
    | "c_level_model_engine";
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
    codexMaxOutputBytes: number | null;
    codexFeedbackEngineProfileId: string | null;
    codexEngineProfileId: string | null;
    codexModelEngineProtocolSha256: string | null;
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

function workflowConditionsForSet(conditionSet: WorkflowStudyConditionSet) {
  return conditionSet === "hybrid_c_level_canary_v1"
    ? WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS
    : WORKFLOW_STUDY_CONDITIONS;
}

function workflowEngineRoutingPolicy(
  conditionSet: WorkflowStudyConditionSet,
): WorkflowStudyPlan["engineRoutingPolicy"] {
  return {
    version: WORKFLOW_STUDY_ENGINE_ROUTING_POLICY_VERSION,
    defaultEngineBinding: "candidate",
    codexCLevelBoundary:
      conditionSet === "hybrid_c_level_canary_v1"
        ? {
            workspace: "ephemeral_read_only",
            hostCapabilities: "disabled",
            responseSchema: "required",
            outputTokenLimit: "prompt_only_unverified",
            hardOutputLimit: "plan_bound_bytes",
            usage: "unknown",
          }
        : null,
    routes: workflowConditionsForSet(conditionSet).map((condition) => ({
      conditionId: workflowConditionId(condition),
      engineRoute: condition.engineRoute,
      orientationEngine:
        conditionSet === "hybrid_c_level_canary_v1"
          ? "host" as const
          : "candidate" as const,
      coordinatorEngine:
        condition.engineRoute === "codex-c-level-local-worker-team"
          ? "codex" as const
          : "candidate" as const,
      specialistEngine: "candidate" as const,
      repairEngine: "candidate" as const,
    })),
  };
}

function workflowOrientationSamplingPolicy(
  conditionSet: WorkflowStudyConditionSet,
): WorkflowStudyPlan["orientationSamplingPolicy"] {
  const hybrid = conditionSet === "hybrid_c_level_canary_v1";
  return {
    designSeedPurpose: "task_and_condition_order_only",
    inferenceSampling: hybrid
      ? "host_owned_deterministic"
      : "provider_default_uncontrolled",
    sharedAcrossConditions: hybrid,
    hostOwnedCanonicalPlanSha256: hybrid
      ? sha256Text(WORKFLOW_HYBRID_HOST_ORIENTATION_PLAN)
      : null,
  };
}

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
    plan.bindings.codexMaxOutputBytes,
    ...(plan.conditionSet === "standard_v1"
      ? [plan.bindings.codexFeedbackEngineProfileId]
      : []),
    ...(plan.conditionSet === "hybrid_c_level_canary_v1"
      ? [
          plan.bindings.codexEngineProfileId,
          plan.bindings.codexModelEngineProtocolSha256,
        ]
      : []),
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
  const expectedConditions = workflowConditionsForSet(
    plan.conditionSet,
  ).map(workflowConditionId);
  const expectedFeedbackHashes = {
    neutralRepeat: NEUTRAL_REPEAT_FEEDBACK_SHA256,
    fixedSelfReview: FIXED_SELF_REVIEW_FEEDBACK_SHA256,
    codexGeneralist: CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
  };
  const expectedFixedTeamSha256 = {
    artifact: hash(fixedWorkflowTeam("artifact")),
    code: hash(fixedWorkflowTeam("code")),
  };
  if (
    recomputed !== planHash ||
    !["standard_v1", "hybrid_c_level_canary_v1"].includes(
      plan.conditionSet,
    ) ||
    studyId !== `collaboration-study-${recomputed.slice(0, 16)}` ||
    plan.liveReady !== expectedLiveReady ||
    hash(plan.conditions) !== hash(expectedConditions) ||
    plan.conditionOrdering !==
      (plan.conditionSet === "hybrid_c_level_canary_v1"
        ? "seeded_cyclic_latin_v1"
        : "seeded_williams_square_v1") ||
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
    hash(plan.teamProtocolPolicy) !==
      hash({
        version: WORKFLOW_TEAM_PROTOCOL_VERSION,
        setup: "fixed_host_owned_two_role",
        finalSubmission: "caller_owned_typed_object",
        dispatchRoleConstraint: "declared_worker_enum",
        reviewRequiresHandoff: true,
        fixedTeamSha256: expectedFixedTeamSha256,
        controller: {
          maxInternalCycles: WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
          maxHandoffs: WORKFLOW_TEAM_MAX_HANDOFFS,
          maxStageCalls: WORKFLOW_TEAM_MAX_STAGE_CALLS,
          maxParallel: WORKFLOW_TEAM_MAX_PARALLEL,
          maxOutputTokensPerCall: WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
          maxDirectiveChars: WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
          maxWorkerResponseChars:
            WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
          maxTranscriptChars: WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
        },
      }) ||
    hash(plan.artifactRetentionPolicy) !==
      hash({
        version: WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION,
        nextRevisionBaseline: "last_contract_valid",
        sealedScoreInfluencesRetention: false,
      }) ||
    hash(plan.contractRepairPolicy) !==
      hash({
        version: WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION,
        maximumAttempts: WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS,
        appliesTo: "single_and_team_artifact_and_code",
        trigger:
          "public_contract_or_transport_invalid_and_budget_available",
        diagnosticDisclosure: "public_codes_only",
        maximumInvalidCandidateChars:
          WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
        maximumOutputTokensPerCall:
          WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
        finishReasonPolicy: "stop_required",
        budgetBehavior: "skip_without_call",
        promptSha256: WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256,
      }) ||
    hash(plan.orientationSamplingPolicy) !==
      hash(workflowOrientationSamplingPolicy(plan.conditionSet)) ||
    hash(plan.engineRoutingPolicy) !==
      hash(workflowEngineRoutingPolicy(plan.conditionSet)) ||
    plan.codexExecutionPurpose !==
      (plan.conditionSet === "hybrid_c_level_canary_v1"
        ? "c_level_model_engine"
        : "simulated_user_feedback") ||
    (plan.conditionSet === "hybrid_c_level_canary_v1" &&
      (requiresCode ||
        plan.bindings.codexFeedbackEngineProfileId !== null ||
        plan.bindings.candidateEngineId ===
          plan.bindings.codexEngineProfileId ||
        plan.bindings.codexModelEngineProtocolSha256 !==
          CODEX_EXEC_MODEL_PROTOCOL_SHA256 ||
        plan.limits.maxTotalTokens !== null)) ||
    (plan.conditionSet === "standard_v1" &&
      (plan.bindings.codexFeedbackEngineProfileId !==
          WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID ||
        plan.bindings.candidateEngineId ===
          plan.bindings.codexFeedbackEngineProfileId ||
        plan.bindings.codexEngineProfileId !== null ||
        plan.bindings.codexModelEngineProtocolSha256 !== null)) ||
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
  wrapEngine(input: {
    engine: ModelEngine;
    configuredModelId: string;
  }): ModelEngine;
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
    conditionId: string;
    engineRoute:
      | "local-single"
      | "all-local-team"
      | "codex-c-level-local-worker-team";
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
  conditionSet?: WorkflowStudyConditionSet;
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
  const conditionSet = input.conditionSet ?? "standard_v1";
  if (
    !["standard_v1", "hybrid_c_level_canary_v1"].includes(conditionSet)
  ) {
    throw new Error("Unknown workflow study condition set.");
  }
  if (
    conditionSet === "hybrid_c_level_canary_v1" &&
    requiresCodeSandbox
  ) {
    throw new Error(
      "The hybrid C-level canary currently supports artifact tasks only.",
    );
  }
  if (
    conditionSet === "hybrid_c_level_canary_v1" &&
    input.limits.maxTotalTokens !== null
  ) {
    throw new Error(
      "Hybrid C-level Codex usage is unmeasured; maxTotalTokens must be null.",
    );
  }
  const hasCodexBinding = Boolean(
    input.bindings?.codexExecutableSha256 &&
      input.bindings?.codexModelId &&
      input.bindings?.codexTimeoutMs,
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
    codexMaxOutputBytes:
      input.bindings?.codexMaxOutputBytes ??
      (hasCodexBinding ? 1_048_576 : null),
    codexFeedbackEngineProfileId:
      conditionSet === "standard_v1"
        ? input.bindings?.codexFeedbackEngineProfileId ??
          WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID
        : null,
    codexEngineProfileId:
      conditionSet === "hybrid_c_level_canary_v1"
        ? input.bindings?.codexEngineProfileId ?? "codex-cli-c-level"
        : null,
    codexModelEngineProtocolSha256:
      conditionSet === "hybrid_c_level_canary_v1"
        ? CODEX_EXEC_MODEL_PROTOCOL_SHA256
        : null,
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
    [
      "codexModelEngineProtocolSha256",
      bindings.codexModelEngineProtocolSha256,
    ],
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
    ["codexFeedbackEngineProfileId", bindings.codexFeedbackEngineProfileId],
    ["codexEngineProfileId", bindings.codexEngineProfileId],
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
    bindings.codexMaxOutputBytes !== null &&
    (!Number.isInteger(bindings.codexMaxOutputBytes) ||
      bindings.codexMaxOutputBytes < 1 ||
      bindings.codexMaxOutputBytes > 16_777_216)
  ) {
    throw new Error(
      "codexMaxOutputBytes must be between 1 and 16777216.",
    );
  }
  if (
    conditionSet === "standard_v1" &&
    (bindings.codexFeedbackEngineProfileId !==
      WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID ||
      bindings.candidateEngineId ===
        bindings.codexFeedbackEngineProfileId)
  ) {
    throw new Error(
      "Standard candidate and Codex feedback engine profile ids must be distinct.",
    );
  }
  if (
    conditionSet === "hybrid_c_level_canary_v1" &&
    bindings.candidateEngineId !== null &&
    bindings.candidateEngineId === bindings.codexEngineProfileId
  ) {
    throw new Error(
      "Hybrid candidate and C-level engine profile ids must be distinct.",
    );
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
    conditionSet,
    conditions: workflowConditionsForSet(conditionSet).map(
      workflowConditionId,
    ),
    conditionOrdering:
      conditionSet === "hybrid_c_level_canary_v1"
        ? "seeded_cyclic_latin_v1" as const
        : "seeded_williams_square_v1" as const,
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
    teamProtocolPolicy: {
      version: WORKFLOW_TEAM_PROTOCOL_VERSION,
      setup: "fixed_host_owned_two_role" as const,
      finalSubmission: "caller_owned_typed_object" as const,
      dispatchRoleConstraint: "declared_worker_enum" as const,
      reviewRequiresHandoff: true as const,
      fixedTeamSha256: {
        artifact: hash(fixedWorkflowTeam("artifact")),
        code: hash(fixedWorkflowTeam("code")),
      },
      controller: {
        maxInternalCycles: WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
        maxHandoffs: WORKFLOW_TEAM_MAX_HANDOFFS,
        maxStageCalls: WORKFLOW_TEAM_MAX_STAGE_CALLS,
        maxParallel: WORKFLOW_TEAM_MAX_PARALLEL,
        maxOutputTokensPerCall: WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
        maxDirectiveChars: WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
        maxWorkerResponseChars:
          WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
        maxTranscriptChars: WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
      },
    },
    artifactRetentionPolicy: {
      version: WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION,
      nextRevisionBaseline: "last_contract_valid" as const,
      sealedScoreInfluencesRetention: false as const,
    },
    contractRepairPolicy: {
      version: WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION,
      maximumAttempts: WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS,
      appliesTo: "single_and_team_artifact_and_code" as const,
      trigger:
        "public_contract_or_transport_invalid_and_budget_available" as const,
      diagnosticDisclosure: "public_codes_only" as const,
      maximumInvalidCandidateChars:
        WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
      maximumOutputTokensPerCall:
        WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
      finishReasonPolicy: "stop_required" as const,
      budgetBehavior: "skip_without_call" as const,
      promptSha256: WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256,
    },
    orientationSamplingPolicy:
      workflowOrientationSamplingPolicy(conditionSet),
    engineRoutingPolicy: workflowEngineRoutingPolicy(conditionSet),
    feedbackAdapterVersion: WORKFLOW_FEEDBACK_ADAPTER_VERSION,
    feedbackInterventionHashes: {
      neutralRepeat: NEUTRAL_REPEAT_FEEDBACK_SHA256,
      fixedSelfReview: FIXED_SELF_REVIEW_FEEDBACK_SHA256,
      codexGeneralist: CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
    },
    plannedTrajectories:
      input.taskBindings.length * workflowConditionsForSet(conditionSet).length,
    boundedCheckpointFeedbackRounds: input.limits.boundedCheckpoint,
    maximumFeedbackRoundsPerTrajectory: input.limits.maxFeedbackRounds,
    maximumTotalModelCallsPerTrajectory: input.limits.maxModelCalls,
    maximumConsecutiveContractInvalidSubmissionsPerTrajectory:
      input.limits.maxConsecutiveContractInvalidSubmissions,
    codexProxyRequired: true as const,
    codexExecutionPurpose:
      conditionSet === "hybrid_c_level_canary_v1"
        ? "c_level_model_engine" as const
        : "simulated_user_feedback" as const,
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
    bindings.codexMaxOutputBytes,
    ...(conditionSet === "standard_v1"
      ? [bindings.codexFeedbackEngineProfileId]
      : []),
    ...(conditionSet === "hybrid_c_level_canary_v1"
      ? [
          bindings.codexEngineProfileId,
          bindings.codexModelEngineProtocolSha256,
        ]
      : []),
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
  conditionSet?: WorkflowStudyConditionSet;
  bindings?: Partial<ArtifactWorkflowStudyPlan["bindings"]>;
}): ArtifactWorkflowStudyPlan {
  return createWorkflowStudyPlan({
    taskBindings: input.tasks.map((task) => ({ kind: "artifact", task })),
    limits: input.limits,
    seed: input.seed,
    ...(input.conditionSet ? { conditionSet: input.conditionSet } : {}),
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
}

export async function runBoundWorkflowStudy(input: {
  plan: WorkflowStudyPlan;
  taskBindings: WorkflowStudyTaskBinding[];
  limits: WorkflowTrajectoryLimits;
  engine: ModelEngine;
  codex: CodexCliFeedbackProvider;
  cLevelEngine?: CodexExecModelEngine;
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
  const hybridCLevel =
    input.plan.conditionSet === "hybrid_c_level_canary_v1";
  const standardCodexFeedback = !hybridCLevel;
  const hasCode = input.taskBindings.some(({ kind }) => kind === "code");
  if (
    input.plan.bindings.candidateEngineId !==
      input.engine.manifest.profileId ||
    input.plan.bindings.codexExecutableSha256 !==
      input.codex.executableSha256 ||
    input.plan.bindings.codexModelId !== input.codex.model ||
    input.plan.bindings.codexTimeoutMs !== input.codex.timeoutMs ||
    input.plan.bindings.codexMaxOutputBytes !== input.codex.maxOutputBytes ||
    (standardCodexFeedback &&
      (!CodexCliFeedbackProvider.isLiveAttestedInstance(input.codex) ||
        input.plan.bindings.codexFeedbackEngineProfileId !==
          input.codex.providerId)) ||
    !input.plan.liveReady
  ) {
    throw new Error("WORKFLOW_STUDY_PLAN_BINDING_MISMATCH");
  }
  if (standardCodexFeedback) {
    await input.codex.preflightExecutableAttestation();
  }
  if (
    hybridCLevel !== Boolean(input.cLevelEngine) ||
    (input.cLevelEngine &&
      (!CodexExecModelEngine.isLiveAttestedInstance(input.cLevelEngine) ||
        input.plan.bindings.codexEngineProfileId !==
        input.cLevelEngine.manifest.profileId ||
        input.plan.bindings.codexExecutableSha256 !==
          input.cLevelEngine.executableSha256 ||
        input.plan.bindings.codexModelId !== input.cLevelEngine.model ||
        input.plan.bindings.codexTimeoutMs !== input.cLevelEngine.timeoutMs ||
        input.plan.bindings.codexMaxOutputBytes !==
          input.cLevelEngine.maxOutputBytes ||
        input.plan.bindings.codexModelEngineProtocolSha256 !==
          CODEX_EXEC_MODEL_PROTOCOL_SHA256))
  ) {
    throw new Error("WORKFLOW_STUDY_C_LEVEL_ENGINE_BINDING_MISMATCH");
  }
  if (input.cLevelEngine) {
    await input.cLevelEngine.preflightExecutableAttestation();
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
  const attestedEngine = (
    engine: ModelEngine,
    configuredModelId: string,
  ): ModelEngine => {
    const existing = attestedEngines.get(engine);
    if (existing) return existing;
    const wrapped = createIdentityAttestingWorkflowEngine({
      engine,
      expectedModelId: configuredModelId,
      observed: observedProviderIdentities,
    });
    attestedEngines.set(engine, wrapped);
    return wrapped;
  };
  const primaryEngine = attestedEngine(input.engine, expectedModelId);
  const cLevelEngine = input.cLevelEngine
    ? attestedEngine(
        input.cLevelEngine,
        input.plan.bindings.codexModelId!,
      )
    : null;
  const expectedModelIds: Record<string, string> = {
    [primaryEngine.manifest.profileId]: expectedModelId,
    ...(cLevelEngine
      ? {
          [cLevelEngine.manifest.profileId]:
            input.plan.bindings.codexModelId!,
        }
      : {}),
  };
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
            conditionId: condition.id,
            engineRoute: condition.engineRoute,
            engine: primaryEngine,
          })
        : null;
      if (persisted) finalizers.set(trialId, persisted.finalize);
      const selectedEngine = persisted?.engine ?? primaryEngine;
      const selectedCLevelEngine = cLevelEngine
        ? persisted?.wrapEngine({
            engine: cLevelEngine,
            configuredModelId: input.plan.bindings.codexModelId!,
          }) ?? cLevelEngine
        : null;
      const hybridRoute =
        condition.engineRoute === "codex-c-level-local-worker-team";
      if (hybridRoute && !selectedCLevelEngine) {
        throw new Error("WORKFLOW_STUDY_C_LEVEL_ENGINE_REQUIRED");
      }
      const roleEngine = hybridRoute
        ? (role: string): ModelEngine => {
            if (role === "coordinator") return selectedCLevelEngine!;
            if (role === "specialist") return selectedEngine;
            throw new Error(`WORKFLOW_STUDY_UNBOUND_ROLE:${role}`);
          }
        : undefined;
      const hostOwnedOrientation = hybridCLevel
        ? {
            canonicalPlan: WORKFLOW_HYBRID_HOST_ORIENTATION_PLAN,
            planHash:
              input.plan.orientationSamplingPolicy
                .hostOwnedCanonicalPlanSha256!,
          }
        : undefined;
      const executor =
        binding.kind === "artifact"
          ? createArtifactWorkflowExecutor({
              architecture: condition.architecture,
              engine: selectedEngine,
              task: binding.task,
              maxParallelAgents: input.limits.maxParallelAgents,
              ...(hostOwnedOrientation ? { hostOwnedOrientation } : {}),
              ...(roleEngine ? { engineForRole: roleEngine } : {}),
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
    expectedCandidateModelId: expectedModelIds,
    conditions: workflowConditionsForSet(input.plan.conditionSet),
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
      codexProxy: hybridCLevel
        ? null
        : {
            providerId: input.codex.providerId,
            executableSha256: input.codex.executableSha256,
            requestedModelId: input.codex.model,
          },
      cLevelEngine: input.cLevelEngine
        ? {
            profileId: input.cLevelEngine.manifest.profileId,
            adapter: input.cLevelEngine.manifest.adapter,
            manifestHash: hash(input.cLevelEngine.manifest),
            configuredModelId: input.cLevelEngine.model,
            executableSha256: input.cLevelEngine.executableSha256,
            transportPolicySha256: CODEX_EXEC_MODEL_PROTOCOL_SHA256,
            identityAttestation: "command_attested" as const,
            tokenUsageVisibility: "unknown" as const,
          }
        : null,
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
  cLevelEngine?: CodexExecModelEngine;
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
    ...(input.cLevelEngine ? { cLevelEngine: input.cLevelEngine } : {}),
    ...(input.engineForRole
      ? { engineForRole: input.engineForRole }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onTrial ? { onTrial: input.onTrial } : {}),
    ...(input.persistence ? { persistence: input.persistence } : {}),
  });
}
