import type { ModelUsage } from "../../../../packages/adapter-sdk/src/types.ts";

export type WorkflowArchitecture = "single" | "team";
export type WorkflowFeedbackPolicy =
  | "neutral_repeat"
  | "fixed_self_review"
  | "codex_generalist";

export type WorkflowDifficulty = "easy" | "medium" | "hard";

export interface WorkflowPublicTask {
  id: string;
  family: "code" | "product_package" | "research" | "xlsx" | "docx" | "pptx";
  difficulty: WorkflowDifficulty;
  objective: string;
  initialImplementationBrief: string;
  publicContext: string[];
  acceptanceCriteria: string[];
  artifactKind: string;
}

export interface WorkflowSafetyObservation {
  unauthorizedExternalEffects: number;
  workspaceEscapes: number;
  secretAccesses: number;
  oracleLeaks: number;
  duplicateExecutions: number;
  sandboxCanaryFailures: number;
}

export interface WorkflowStepMetrics {
  latencyMs: number;
  modelCalls: number;
  usage: ModelUsage;
  providerIdentities?: Array<{
    engineProfileId: string;
    role: string;
    reportedModelId: string | null;
    reportedSystemFingerprint: string | null;
  }>;
}

export class WorkflowAccountedError extends Error {
  readonly metrics: WorkflowStepMetrics;

  constructor(
    code: string,
    metrics: WorkflowStepMetrics,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "WorkflowAccountedError";
    this.metrics = metrics;
  }
}

export class WorkflowTokenBudgetError extends Error {
  readonly reason: "token_limit" | "token_usage_unknown";

  constructor(reason: "token_limit" | "token_usage_unknown", code: string) {
    super(code);
    this.name = "WorkflowTokenBudgetError";
    this.reason = reason;
  }
}

export class WorkflowProviderIdentityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WorkflowProviderIdentityError";
  }
}

export function unknownWorkflowUsage(): ModelUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus: "unknown",
  };
}

export function accountWorkflowError(
  error: unknown,
  code: string,
  metrics: WorkflowStepMetrics,
): WorkflowAccountedError {
  return error instanceof WorkflowAccountedError
    ? error
    : new WorkflowAccountedError(code, metrics, error);
}

export interface WorkflowOrientationResult extends WorkflowStepMetrics {
  planHash: string;
  approvalActor: "system:synthetic-evaluator";
  simulatedApproval: boolean;
}

export interface WorkflowExecutionResult extends WorkflowStepMetrics {
  artifact: string;
  humanView: string;
  contractValid: boolean;
  cLevelReviewRequested: boolean;
  handoffs: number;
  maxObservedConcurrency: number;
  protocolViolations: string[];
  safety: WorkflowSafetyObservation;
}

export interface WorkflowExecutor {
  readonly architecture: WorkflowArchitecture;
  orient(input: {
    task: WorkflowPublicTask;
    remainingTotalTokens?: number | null;
    signal?: AbortSignal;
  }): Promise<WorkflowOrientationResult>;
  execute(input: {
    task: WorkflowPublicTask;
    submission: number;
    feedbackRound: number;
    directive: string;
    directiveHash: string;
    remainingModelCalls: number;
    remainingTotalTokens?: number | null;
    previousArtifact: {
      sha256: string;
      content: string;
    } | null;
    signal?: AbortSignal;
  }): Promise<WorkflowExecutionResult>;
}

export interface WorkflowFeedbackResult extends WorkflowStepMetrics {
  providerId: string;
  directive: string;
  recommendation: "changes_requested" | "looks_good";
  actorType: "simulated_user_proxy";
  mayResolveHumanApproval: false;
}

export interface WorkflowFeedbackProvider {
  readonly id: WorkflowFeedbackPolicy;
  readonly providerId: string;
  readonly actorType: "simulated_user_proxy";
  readonly mayResolveHumanApproval: false;
  provideFeedback(input: {
    task: WorkflowPublicTask;
    currentHumanView: string;
    submission: number;
    signal?: AbortSignal;
  }): Promise<WorkflowFeedbackResult>;
}

export interface SealedEvaluationResult {
  passed: boolean;
  score: number;
  criticalFailures: string[];
  safety?: WorkflowSafetyObservation;
  criterionResults: Array<{
    id: string;
    passed: boolean;
    score: number;
  }>;
}

export interface SealedWorkflowEvaluator {
  readonly id: string;
  evaluate(input: {
    taskId: string;
    artifact: string;
    artifactHash: string;
    signal?: AbortSignal;
  }): Promise<SealedEvaluationResult>;
}

export interface WorkflowTrajectoryLimits {
  boundedCheckpoint: number;
  maxFeedbackRounds: number;
  maxWallClockMs: number;
  maxModelCalls: number;
  maxTotalTokens: number | null;
  identicalArtifactLimit: number;
  maxConsecutiveContractInvalidSubmissions: number;
  maxParallelAgents: number;
}

export type WorkflowCensorReason =
  | "feedback_round_limit"
  | "wall_clock_limit"
  | "model_call_limit"
  | "token_limit"
  | "token_usage_unknown"
  | "no_progress"
  | "protocol_failure"
  | "provider_identity_mismatch"
  | "safety_gate"
  | "canceled"
  | "execution_error";

export interface WorkflowRoundRecord {
  submission: number;
  feedbackRound: number;
  directiveType: "initial_assignment" | "changes_requested";
  directiveHash: string;
  artifactHash: string;
  contractValid: boolean;
  externalPass: boolean;
  partialScore: number;
  criticalFailures: string[];
  modelCalls: number;
  handoffs: number;
  maxObservedConcurrency: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  protocolViolations: string[];
  safety: WorkflowSafetyObservation;
  providerIdentities: Array<{
    engineProfileId: string;
    role: string;
    reportedModelId: string | null;
    reportedSystemFingerprint: string | null;
  }>;
}

export interface WorkflowTrajectoryReport {
  apiVersion: "chartermesh.dev/workflow-trajectory/v1alpha1";
  trialId: string;
  orderIndex: number;
  taskId: string;
  family: WorkflowPublicTask["family"];
  difficulty: WorkflowDifficulty;
  architecture: WorkflowArchitecture;
  feedbackPolicy: WorkflowFeedbackPolicy;
  boundedCheckpoint: number;
  setup: WorkflowOrientationResult;
  setupStatus: "approved" | "failed";
  evaluatorId: string;
  rounds: WorkflowRoundRecord[];
  feedbackDirectiveHashes: string[];
  feedbackDirectives: Array<{
    afterSubmission: number;
    artifactHash: string;
    directiveHash: string;
    recommendation: "changes_requested" | "looks_good";
    providerId: string;
    actorType: "simulated_user_proxy";
    mayResolveHumanApproval: false;
  }>;
  outcome: {
    status: "passed" | "censored" | "failed";
    passSubmission: number | null;
    passedByCheckpoint: boolean;
    scoreAtCheckpoint: number | null;
    bestScore: number;
    feedbackRoundCount: number;
    userDirectiveCount: number;
    setupApprovalCount: 0 | 1;
    finalApprovalCount: 0 | 1;
    internalModelCallCount: number;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    elapsedMs: number;
    censorReason: WorkflowCensorReason | null;
  };
  collaboration: {
    handoffCount: number;
    protocolComplianceRate: number;
    maxObservedConcurrency: number;
    concurrencyLimitViolations: number;
    prematureReviewRequests: number;
  };
  safety: WorkflowSafetyObservation;
  approvalAuthority: "synthetic_evaluator";
  productionHumanApprovalExercised: false;
}

export interface WorkflowStudyReport {
  apiVersion: "chartermesh.dev/collaboration-study-report/v1alpha1";
  studyId: string;
  approvedPlanHash: string | null;
  approvedPlanCanonicalJson: string | null;
  suiteHash: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  conditionOrder: string[];
  taskIds: string[];
  limits: WorkflowTrajectoryLimits;
  conditionOrdering: "seeded_williams_square_v1";
  provenance: {
    sealedSuiteHash: string;
    candidateEngine: {
      profileId: string;
      adapter: string;
      manifestHash: string;
      configuredModelId: string | null;
      runtimeProfileHash: string | null;
    } | null;
    codexProxy: {
      providerId: string;
      executableSha256: string;
      requestedModelId: string;
    } | null;
    controlPlane: {
      mode: "isolated_evaluation_database";
      durableRuns: true;
      durableAttempts: true;
      hashBoundHandoffs: true;
      productionApprovalLedgerUsed: false;
    } | null;
    codeSandbox: {
      id: string;
      provenanceHash: string;
      launcherCommitment: string;
      launcherAttestation: "file_sha256" | "command_name_only";
      preflightPassed: true;
    } | null;
    evaluatorIds: string[];
  };
  trials: WorkflowTrajectoryReport[];
  aggregate: Array<{
    conditionId: string;
    trials: number;
    passedByCheckpoint: number;
    finalPassed: number;
    censored: number;
    failed: number;
    meanBestScore: number;
    meanElapsedMs: number;
    medianElapsedMsToPass: number | null;
    meanFeedbackRounds: number;
    meanScorePerModelCall: number;
    totalModelCalls: number;
    totalTokens: number | null;
    protocolFailures: number;
    safetyFailures: number;
  }>;
  pairedComparisons: Array<{
    feedbackPolicy: WorkflowFeedbackPolicy;
    pairedTasks: number;
    teamMinusSingleCheckpointPassRate: number;
    teamMinusSingleFinalPassRate: number;
    teamMinusSingleMeanBestScore: number;
    teamMinusSingleMeanFeedbackRounds: number;
    teamMinusSingleMeanElapsedMs: number;
    teamMinusSingleMeanModelCalls: number;
    bestScoreWins: number;
    bestScoreTies: number;
    bestScoreLosses: number;
  }>;
  stratifiedAggregate: Array<{
    dimension: "family" | "difficulty";
    value: string;
    conditionId: string;
    trials: number;
    checkpointPassRate: number;
    finalPassRate: number;
    meanBestScore: number;
    meanModelCalls: number;
    meanElapsedMs: number;
  }>;
  interpretationBoundary: string[];
}
