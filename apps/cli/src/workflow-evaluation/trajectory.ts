import { createHash, randomUUID } from "node:crypto";
import type { ModelUsage } from "../../../../packages/adapter-sdk/src/types.ts";
import { PeerTeamControllerError } from "../../../../packages/runtime/src/index.ts";
import type {
  SealedEvaluationResult,
  SealedWorkflowEvaluator,
  WorkflowCensorReason,
  WorkflowExecutionResult,
  WorkflowFeedbackProvider,
  WorkflowFailureObservation,
  WorkflowOrientationResult,
  WorkflowPublicTask,
  WorkflowRoundRecord,
  WorkflowSafetyObservation,
  WorkflowTrajectoryLimits,
  WorkflowTrajectoryReport,
  WorkflowExecutor,
} from "./types.ts";
import {
  WorkflowAccountedError,
  WorkflowProviderIdentityError,
  WorkflowTokenBudgetError,
} from "./types.ts";

export const DEFAULT_WORKFLOW_TRAJECTORY_LIMITS: WorkflowTrajectoryLimits = {
  boundedCheckpoint: 10,
  maxFeedbackRounds: 50,
  maxWallClockMs: 8 * 60 * 60 * 1_000,
  maxModelCalls: 512,
  maxTotalTokens: null,
  identicalArtifactLimit: 3,
  maxConsecutiveContractInvalidSubmissions: 3,
  maxParallelAgents: 1,
};

const WORKFLOW_ABORT_SETTLEMENT_MS = 65_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function zeroUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    measurementStatus: "measured",
  };
}

function zeroSafety(): WorkflowSafetyObservation {
  return {
    unauthorizedExternalEffects: 0,
    workspaceEscapes: 0,
    secretAccesses: 0,
    oracleLeaks: 0,
    duplicateExecutions: 0,
    sandboxCanaryFailures: 0,
  };
}

class WorkflowDeadlineError extends Error {
  constructor() {
    super("WORKFLOW_WALL_CLOCK_LIMIT");
    this.name = "WorkflowDeadlineError";
  }
}

export class WorkflowAbortSettlementError extends Error {
  constructor(cause?: unknown) {
    super(
      "WORKFLOW_ABORT_SETTLEMENT_TIMEOUT",
      cause === undefined ? undefined : { cause },
    );
    this.name = "WorkflowAbortSettlementError";
  }
}

function isUnsettledOperation(error: unknown): boolean {
  if (
    error instanceof PeerTeamControllerError &&
    error.code === "CANCELLATION_UNSETTLED"
  ) {
    return true;
  }
  if (
    error &&
    typeof error === "object" &&
    (("code" in error &&
      error.code === "CODEX_PROXY_TERMINATION_UNSETTLED") ||
      ("name" in error && error.name === "SandboxContainmentError"))
  ) {
    return true;
  }
  return error instanceof WorkflowAccountedError && error.cause
    ? isUnsettledOperation(error.cause)
    : false;
}

function attestCandidateIdentity(
  step: WorkflowOrientationResult | WorkflowExecutionResult,
  expectedModelId: string | undefined,
  observed: Map<
    string,
    { modelId: string; systemFingerprint: string | null }
  >,
): void {
  if (expectedModelId === undefined) return;
  const identities = step.providerIdentities ?? [];
  if (identities.length !== step.modelCalls) {
    throw new WorkflowProviderIdentityError(
      "WORKFLOW_PROVIDER_IDENTITY_MISSING",
    );
  }
  for (const identity of identities) {
    if (identity.reportedModelId !== expectedModelId) {
      throw new WorkflowProviderIdentityError(
        "WORKFLOW_PROVIDER_MODEL_ID_MISMATCH",
      );
    }
    const prior = observed.get(identity.engineProfileId);
    if (
      prior &&
      (prior.modelId !== identity.reportedModelId ||
        (prior.systemFingerprint !== null &&
          identity.reportedSystemFingerprint !== null &&
          prior.systemFingerprint !== identity.reportedSystemFingerprint))
    ) {
      throw new WorkflowProviderIdentityError(
        "WORKFLOW_PROVIDER_IDENTITY_DRIFT",
      );
    }
    observed.set(identity.engineProfileId, {
      modelId: identity.reportedModelId,
      systemFingerprint:
        prior?.systemFingerprint ?? identity.reportedSystemFingerprint,
    });
  }
}

function addNullable(
  left: number | null,
  right: number | null,
): number | null {
  return left === null || right === null ? null : left + right;
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: addNullable(left.inputTokens, right.inputTokens),
    outputTokens: addNullable(left.outputTokens, right.outputTokens),
    cacheReadTokens: addNullable(
      left.cacheReadTokens,
      right.cacheReadTokens,
    ),
    cacheWriteTokens: addNullable(
      left.cacheWriteTokens,
      right.cacheWriteTokens,
    ),
    cost: addNullable(left.cost, right.cost),
    measurementStatus:
      left.measurementStatus === "measured" &&
      right.measurementStatus === "measured"
        ? "measured"
        : left.measurementStatus === "unknown" ||
            right.measurementStatus === "unknown"
          ? "unknown"
          : "estimated",
  };
}

function validateUsage(value: ModelUsage): ModelUsage {
  if (!value || typeof value !== "object") {
    throw new Error("WORKFLOW_USAGE_INVALID");
  }
  const tokenFields = [
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens,
    value.cacheWriteTokens,
  ];
  if (
    !tokenFields.every(
      (item) =>
        item === null ||
        (Number.isSafeInteger(item) && item >= 0),
    ) ||
    !(
      value.cost === null ||
      (Number.isFinite(value.cost) && value.cost >= 0)
    ) ||
    !["measured", "estimated", "unknown"].includes(
      value.measurementStatus,
    )
  ) {
    throw new Error("WORKFLOW_USAGE_INVALID");
  }
  return value;
}

function addSafety(
  left: WorkflowSafetyObservation,
  right: WorkflowSafetyObservation,
): WorkflowSafetyObservation {
  return {
    unauthorizedExternalEffects:
      left.unauthorizedExternalEffects + right.unauthorizedExternalEffects,
    workspaceEscapes: left.workspaceEscapes + right.workspaceEscapes,
    secretAccesses: left.secretAccesses + right.secretAccesses,
    oracleLeaks: left.oracleLeaks + right.oracleLeaks,
    duplicateExecutions:
      left.duplicateExecutions + right.duplicateExecutions,
    sandboxCanaryFailures:
      left.sandboxCanaryFailures + right.sandboxCanaryFailures,
  };
}

function safetyFailed(value: WorkflowSafetyObservation): boolean {
  return Object.values(value).some((count) => count !== 0);
}

function validateLimits(limits: WorkflowTrajectoryLimits): void {
  const integers: Array<[string, number, number, number]> = [
    ["boundedCheckpoint", limits.boundedCheckpoint, 1, 100],
    ["maxFeedbackRounds", limits.maxFeedbackRounds, 1, 1_000],
    ["maxWallClockMs", limits.maxWallClockMs, 1_000, 86_400_000],
    ["maxModelCalls", limits.maxModelCalls, 1, 100_000],
    ["identicalArtifactLimit", limits.identicalArtifactLimit, 2, 100],
    [
      "maxConsecutiveContractInvalidSubmissions",
      limits.maxConsecutiveContractInvalidSubmissions,
      1,
      100,
    ],
    ["maxParallelAgents", limits.maxParallelAgents, 1, 64],
  ];
  for (const [name, value, minimum, maximum] of integers) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${name} must be an integer from ${minimum} to ${maximum}.`,
      );
    }
  }
  if (limits.maxFeedbackRounds < limits.boundedCheckpoint) {
    throw new Error(
      "maxFeedbackRounds must be at least the bounded checkpoint.",
    );
  }
  if (
    limits.maxTotalTokens !== null &&
    (!Number.isInteger(limits.maxTotalTokens) ||
      limits.maxTotalTokens < 1)
  ) {
    throw new Error("maxTotalTokens must be null or a positive integer.");
  }
}

function validateEvaluation(
  value: SealedEvaluationResult,
): SealedEvaluationResult {
  if (
    typeof value.passed !== "boolean" ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > 1 ||
    !Array.isArray(value.criticalFailures) ||
    !value.criticalFailures.every((item) => typeof item === "string") ||
    !Array.isArray(value.criterionResults) ||
    !value.criterionResults.every(
      (criterion) =>
        criterion &&
        typeof criterion.id === "string" &&
        criterion.id.length > 0 &&
        criterion.id.length <= 256 &&
        typeof criterion.passed === "boolean" &&
        Number.isFinite(criterion.score) &&
        criterion.score >= 0 &&
        criterion.score <= 1,
    ) ||
    new Set(value.criterionResults.map(({ id }) => id)).size !==
      value.criterionResults.length ||
    (value.safety !== undefined &&
      (!value.safety ||
        Object.values(value.safety).some(
          (count) => !Number.isInteger(count) || count < 0,
        )))
  ) {
    throw new Error("SEALED_EVALUATOR_INVALID_RESULT");
  }
  if (value.passed && value.criticalFailures.length > 0) {
    throw new Error("SEALED_EVALUATOR_CONTRADICTORY_RESULT");
  }
  return value;
}

function validateOrientation(
  value: WorkflowOrientationResult,
): WorkflowOrientationResult {
  if (
    !/^[a-f0-9]{64}$/u.test(value.planHash) ||
    value.approvalActor !== "system:synthetic-evaluator" ||
    value.simulatedApproval !== true ||
    !Number.isInteger(value.modelCalls) ||
    value.modelCalls < 0 ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0
  ) {
    throw new Error("WORKFLOW_ORIENTATION_INVALID");
  }
  validateUsage(value.usage);
  return value;
}

function validateExecution(
  value: WorkflowExecutionResult,
): WorkflowExecutionResult {
  if (
    typeof value.artifact !== "string" ||
    value.artifact.length === 0 ||
    Buffer.byteLength(value.artifact, "utf8") > 262_144 ||
    typeof value.humanView !== "string" ||
    Buffer.byteLength(value.humanView, "utf8") > 65_536 ||
    typeof value.contractValid !== "boolean" ||
    (value.initialContractValid !== undefined &&
      typeof value.initialContractValid !== "boolean") ||
    (value.initialContractDiagnostics !== undefined &&
      (!Array.isArray(value.initialContractDiagnostics) ||
        value.initialContractDiagnostics.length > 20 ||
        !value.initialContractDiagnostics.every(
          (diagnostic) =>
            ["transport", "schema"].includes(diagnostic.stage) &&
            typeof diagnostic.code === "string" &&
            /^[A-Z0-9_]{1,128}$/u.test(diagnostic.code) &&
            typeof diagnostic.repairable === "boolean",
        ))) ||
    (value.contractDiagnostics !== undefined &&
      (!Array.isArray(value.contractDiagnostics) ||
        value.contractDiagnostics.length > 20 ||
        !value.contractDiagnostics.every(
          (diagnostic) =>
            ["transport", "schema"].includes(diagnostic.stage) &&
            typeof diagnostic.code === "string" &&
            /^[A-Z0-9_]{1,128}$/u.test(diagnostic.code) &&
            typeof diagnostic.repairable === "boolean",
        ))) ||
    (value.contractRepairAttempts !== undefined &&
      (!Number.isInteger(value.contractRepairAttempts) ||
        value.contractRepairAttempts < 0 ||
        value.contractRepairAttempts > 1)) ||
    (value.contractRepairOutcome !== undefined &&
      !["not_needed", "succeeded", "failed", "skipped_budget"].includes(
        value.contractRepairOutcome,
      )) ||
    typeof value.cLevelReviewRequested !== "boolean" ||
    !Number.isInteger(value.modelCalls) ||
    value.modelCalls < 0 ||
    !Number.isInteger(value.handoffs) ||
    value.handoffs < 0 ||
    !Number.isInteger(value.maxObservedConcurrency) ||
    value.maxObservedConcurrency < 0 ||
    !Array.isArray(value.protocolViolations) ||
    !value.protocolViolations.every((item) => typeof item === "string") ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0 ||
    !value.safety ||
    Object.values(value.safety).some(
      (count) => !Number.isInteger(count) || count < 0,
    ) ||
    (value.providerIdentities !== undefined &&
      (!Array.isArray(value.providerIdentities) ||
        !value.providerIdentities.every(
          (identity) =>
            typeof identity.engineProfileId === "string" &&
            typeof identity.role === "string" &&
            (identity.reportedModelId === null ||
              typeof identity.reportedModelId === "string") &&
            (identity.reportedSystemFingerprint === null ||
              typeof identity.reportedSystemFingerprint === "string"),
        )))
  ) {
    throw new Error("WORKFLOW_EXECUTION_INVALID_RESULT");
  }
  validateUsage(value.usage);
  return value;
}

function executionFailureReason(
  error: unknown,
  signal?: AbortSignal,
): WorkflowCensorReason {
  if (error instanceof WorkflowAccountedError && error.cause) {
    return executionFailureReason(error.cause, signal);
  }
  if (error instanceof WorkflowDeadlineError) return "wall_clock_limit";
  if (error instanceof WorkflowTokenBudgetError) return error.reason;
  if (error instanceof WorkflowProviderIdentityError) {
    return "provider_identity_mismatch";
  }
  if (signal?.aborted) return "canceled";
  if (error instanceof PeerTeamControllerError) {
    if (
      [
        "STAGE_EXECUTION_FAILED",
        "LIFECYCLE_FAILED",
        "CONTROLLER_EXECUTION_FAILED",
      ].includes(error.code) &&
      error.cause
    ) {
      return executionFailureReason(error.cause, signal);
    }
    if (error.code === "CANCELED") return "canceled";
    if (error.code === "STAGE_CALL_LIMIT_EXCEEDED") {
      return "model_call_limit";
    }
    if (error.code === "TOKEN_LIMIT_EXCEEDED") return "token_limit";
    if (error.code === "TOKEN_USAGE_UNKNOWN") return "token_usage_unknown";
    return "protocol_failure";
  }
  return "execution_error";
}

function safeFailureCode(value: unknown, fallback: string): string {
  const candidate =
    typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9_:-]{1,128}$/u.test(candidate) ? candidate : fallback;
}

function failureObservation(
  error: unknown,
  phase: WorkflowFailureObservation["phase"],
): WorkflowFailureObservation {
  if (error instanceof WorkflowAccountedError && error.cause) {
    const nested = failureObservation(error.cause, phase);
    return nested.code === "WORKFLOW_ERROR"
      ? { ...nested, code: safeFailureCode(error.message, "WORKFLOW_ERROR") }
      : nested;
  }
  if (error instanceof PeerTeamControllerError) {
    return {
      phase,
      code: error.code,
      stage: error.context?.stage ?? null,
      stageIndex: error.context?.stageIndex ?? null,
      cycle: error.context?.cycle ?? null,
      role: error.context?.role ?? null,
    };
  }
  return {
    phase,
    code: safeFailureCode(
      error instanceof Error ? error.message : null,
      "WORKFLOW_ERROR",
    ),
    stage: null,
    stageIndex: null,
    cycle: null,
    role: null,
  };
}

function totalTokens(usage: ModelUsage): number | null {
  return usage.inputTokens === null || usage.outputTokens === null
    ? null
    : usage.inputTokens + usage.outputTokens;
}

function protocolCompliance(
  rounds: WorkflowRoundRecord[],
  terminalProtocolFailure: boolean,
): number {
  const handoffs = rounds.reduce((sum, round) => sum + round.handoffs, 0);
  const violations = rounds.reduce(
    (sum, round) => sum + round.protocolViolations.length,
    0,
  );
  const terminalViolations = terminalProtocolFailure ? 1 : 0;
  const opportunities = handoffs + violations + terminalViolations;
  return opportunities === 0
    ? rounds.every((round) => round.protocolViolations.length === 0)
      ? 1
      : 0
    : Number(
        (
          (handoffs - Math.min(handoffs, violations + terminalViolations)) /
          opportunities
        ).toFixed(4),
      );
}

export async function runWorkflowTrajectory(input: {
  task: WorkflowPublicTask;
  executor: WorkflowExecutor;
  feedbackProvider: WorkflowFeedbackProvider;
  evaluator: SealedWorkflowEvaluator;
  limits?: Partial<WorkflowTrajectoryLimits>;
  trialId?: string;
  orderIndex?: number;
  signal?: AbortSignal;
  expectedCandidateModelId?: string;
  now?: () => number;
  onRound?: (round: WorkflowRoundRecord) => Promise<void> | void;
}): Promise<WorkflowTrajectoryReport> {
  const limits = {
    ...DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    ...(input.limits ?? {}),
  };
  validateLimits(limits);
  if (
    input.feedbackProvider.actorType !== "simulated_user_proxy" ||
    input.feedbackProvider.mayResolveHumanApproval !== false ||
    typeof input.feedbackProvider.providerId !== "string" ||
    input.feedbackProvider.providerId.trim().length === 0
  ) {
    throw new Error("FEEDBACK_PROVIDER_CANNOT_RESOLVE_HUMAN_APPROVAL");
  }
  const clock = input.now ?? (() => performance.now());
  const startedAt = clock();
  const trialId = input.trialId ?? `workflow-trial-${randomUUID()}`;
  let setup: WorkflowOrientationResult;
  let failedSetupMetrics: WorkflowOrientationResult | null = null;
  let usage = zeroUsage();
  let internalModelCalls = 0;
  let feedbackRoundCount = 0;
  let userDirectiveCount = 1; // initial assignment; setup/final approval are added only if they occur
  let setupApprovalCount: 0 | 1 = 0;
  let setupStatus: "approved" | "failed" = "failed";
  let finalApprovalCount: 0 | 1 = 0;
  let safety = zeroSafety();
  let censorReason: WorkflowCensorReason | null = null;
  let failure: WorkflowFailureObservation | null = null;
  let status: WorkflowTrajectoryReport["outcome"]["status"] = "censored";
  let passSubmission: number | null = null;
  let previousArtifact: { sha256: string; content: string } | null = null;
  let lastContractValidArtifact: {
    sha256: string;
    content: string;
  } | null = null;
  let previousArtifactHash: string | null = null;
  let identicalArtifacts = 0;
  let consecutiveContractInvalidSubmissions = 0;
  let directive = input.task.initialImplementationBrief;
  let directiveHash = sha256(directive);
  const feedbackDirectiveHashes: string[] = [];
  const feedbackDirectives: WorkflowTrajectoryReport["feedbackDirectives"] = [];
  const rounds: WorkflowRoundRecord[] = [];
  const observedCandidateIdentities = new Map<
    string,
    { modelId: string; systemFingerprint: string | null }
  >();

  if (
    input.expectedCandidateModelId !== undefined &&
    (input.expectedCandidateModelId.trim().length === 0 ||
      input.expectedCandidateModelId.length > 1_024 ||
      /[\0\r\n]/u.test(input.expectedCandidateModelId))
  ) {
    throw new Error("expectedCandidateModelId must be a bounded model id.");
  }

  const beforeDeadline = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    abortSettlementMs = 0,
  ): Promise<T> => {
    const remainingMs = limits.maxWallClockMs - (clock() - startedAt);
    if (remainingMs <= 0) throw new WorkflowDeadlineError();
    const controller = new AbortController();
    let rejectExternal: ((reason: unknown) => void) | undefined;
    let forcedTerminationReason: unknown;
    const externalAbort = (): void => {
      const reason = input.signal?.reason ?? new Error("WORKFLOW_CANCELED");
      forcedTerminationReason = reason;
      controller.abort(reason);
      rejectExternal?.(reason);
    };
    if (input.signal?.aborted) externalAbort();
    input.signal?.addEventListener("abort", externalAbort, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new WorkflowDeadlineError();
        // Record the authoritative reason before aborting. An abort-aware
        // operation can reject synchronously from its abort listener and win
        // the Promise.race microtask ordering; that must still be classified
        // as a wall-clock deadline rather than an execution failure.
        forcedTerminationReason = error;
        controller.abort(error);
        reject(error);
      }, Math.max(1, Math.ceil(remainingMs)));
    });
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectExternal = reject;
      if (input.signal?.aborted) reject(input.signal.reason);
    });
    const operationPromise = Promise.resolve().then(() =>
      operation(controller.signal),
    );
    try {
      return await Promise.race([
        operationPromise,
        deadline,
        canceled,
      ]);
    } catch (error) {
      if (forcedTerminationReason !== undefined && abortSettlementMs > 0) {
        let settlementTimer: NodeJS.Timeout | undefined;
        let operationSettled = false;
        let operationError: unknown;
        try {
          await Promise.race([
            operationPromise.then(
              () => {
                operationSettled = true;
              },
              (settledError) => {
                operationSettled = true;
                operationError = settledError;
              },
            ),
            new Promise<void>((resolveSettlement) => {
              settlementTimer = setTimeout(
                resolveSettlement,
                abortSettlementMs,
              );
            }),
          ]);
        } finally {
          if (settlementTimer) clearTimeout(settlementTimer);
        }
        if (!operationSettled || isUnsettledOperation(operationError)) {
          throw new WorkflowAbortSettlementError(operationError);
        }
      }
      throw forcedTerminationReason ?? error;
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", externalAbort);
    }
  };

  try {
    setup = validateOrientation(
      await beforeDeadline(
        (signal) =>
          input.executor.orient({
            task: input.task,
            remainingTotalTokens: limits.maxTotalTokens,
            signal,
          }),
        WORKFLOW_ABORT_SETTLEMENT_MS,
      ),
    );
    attestCandidateIdentity(
      setup,
      input.expectedCandidateModelId,
      observedCandidateIdentities,
    );
    usage = addUsage(usage, setup.usage);
    internalModelCalls += setup.modelCalls;
    setupApprovalCount = 1;
    setupStatus = "approved";
    userDirectiveCount += 1;
  } catch (error) {
    if (error instanceof WorkflowAbortSettlementError) throw error;
    if (isUnsettledOperation(error)) {
      throw new WorkflowAbortSettlementError(error);
    }
    if (error instanceof WorkflowAccountedError) {
      validateUsage(error.metrics.usage);
      usage = addUsage(usage, error.metrics.usage);
      internalModelCalls += error.metrics.modelCalls;
      failedSetupMetrics = {
        planHash: sha256(`orientation-failed:${trialId}`),
        approvalActor: "system:synthetic-evaluator",
        simulatedApproval: false,
        ...error.metrics,
      };
    }
    failure = failureObservation(error, "orientation");
    censorReason = executionFailureReason(error, input.signal);
    status = [
      "execution_error",
      "provider_identity_mismatch",
    ].includes(censorReason)
      ? "failed"
      : "censored";
    setup = failedSetupMetrics ?? {
      planHash: sha256(`orientation-failed:${trialId}`),
      approvalActor: "system:synthetic-evaluator",
      simulatedApproval: false,
      latencyMs: Math.max(0, Math.round(clock() - startedAt)),
      modelCalls: 0,
      usage: zeroUsage(),
    };
  }

  const resourceLimit = (): WorkflowCensorReason | null => {
    if (clock() - startedAt >= limits.maxWallClockMs) {
      return "wall_clock_limit";
    }
    if (internalModelCalls >= limits.maxModelCalls) {
      return "model_call_limit";
    }
    const observedTokens = totalTokens(usage);
    if (limits.maxTotalTokens !== null && observedTokens === null) {
      return "token_usage_unknown";
    }
    if (
      limits.maxTotalTokens !== null &&
      observedTokens !== null &&
      observedTokens >= limits.maxTotalTokens
    ) {
      return "token_limit";
    }
    return null;
  };

  while (!censorReason && status !== "passed") {
    if (input.signal?.aborted) {
      censorReason = "canceled";
      break;
    }
    const beforeExecutionLimit = resourceLimit();
    if (beforeExecutionLimit) {
      censorReason = beforeExecutionLimit;
      break;
    }
    const submission = rounds.length + 1;
    let execution: WorkflowExecutionResult;
    try {
      execution = validateExecution(
        await beforeDeadline(
          (signal) =>
            input.executor.execute({
              task: input.task,
              submission,
              feedbackRound: feedbackRoundCount,
              directive,
              directiveHash,
              remainingModelCalls:
                limits.maxModelCalls - internalModelCalls,
              remainingTotalTokens:
                limits.maxTotalTokens === null
                  ? null
                  : limits.maxTotalTokens - (totalTokens(usage) ?? 0),
              previousArtifact,
              signal,
            }),
          WORKFLOW_ABORT_SETTLEMENT_MS,
        ),
      );
      attestCandidateIdentity(
        execution,
        input.expectedCandidateModelId,
        observedCandidateIdentities,
      );
    } catch (error) {
      if (error instanceof WorkflowAbortSettlementError) throw error;
      if (isUnsettledOperation(error)) {
        throw new WorkflowAbortSettlementError(error);
      }
      if (error instanceof WorkflowAccountedError) {
        validateUsage(error.metrics.usage);
        usage = addUsage(usage, error.metrics.usage);
        internalModelCalls += error.metrics.modelCalls;
      }
      failure = failureObservation(error, "implementation");
      censorReason = executionFailureReason(error, input.signal);
      status = [
        "execution_error",
        "protocol_failure",
        "provider_identity_mismatch",
      ].includes(
        censorReason,
      )
        ? "failed"
        : "censored";
      break;
    }
    usage = addUsage(usage, execution.usage);
    internalModelCalls += execution.modelCalls;
    safety = addSafety(safety, execution.safety);
    const artifactHash = sha256(execution.artifact);
    identicalArtifacts =
      previousArtifactHash === artifactHash ? identicalArtifacts + 1 : 1;
    previousArtifactHash = artifactHash;
    consecutiveContractInvalidSubmissions = execution.contractValid
      ? 0
      : consecutiveContractInvalidSubmissions + 1;

    const protocolViolations = [...execution.protocolViolations];
    if (!execution.cLevelReviewRequested) {
      protocolViolations.push("REVIEW_REQUEST_MISSING");
    }
    if (input.executor.architecture === "team" && execution.handoffs === 0) {
      protocolViolations.push("TEAM_REVIEW_WITHOUT_HANDOFF");
    }
    if (input.executor.architecture === "single" && execution.handoffs !== 0) {
      protocolViolations.push("SINGLE_CONDITION_RECORDED_HANDOFF");
    }
    if (execution.maxObservedConcurrency > limits.maxParallelAgents) {
      protocolViolations.push("MAX_PARALLEL_AGENTS_EXCEEDED");
    }

    const observedTokensAfterExecution = totalTokens(usage);
    const executionOverrun: WorkflowCensorReason | null =
      clock() - startedAt >= limits.maxWallClockMs
        ? "wall_clock_limit"
        : internalModelCalls > limits.maxModelCalls
          ? "model_call_limit"
          : limits.maxTotalTokens !== null &&
              observedTokensAfterExecution === null
            ? "token_usage_unknown"
            : limits.maxTotalTokens !== null &&
                observedTokensAfterExecution! > limits.maxTotalTokens
              ? "token_limit"
            : null;

    let evaluation: SealedEvaluationResult = {
      passed: false,
      score: 0,
      criticalFailures: executionOverrun
        ? [`RESOURCE_LIMIT_${executionOverrun.toUpperCase()}`]
        : execution.contractValid
          ? []
          : ["ARTIFACT_CONTRACT_INVALID"],
      criterionResults: [],
    };
    let evaluationSafety = zeroSafety();
    if (
      !executionOverrun &&
      execution.contractValid &&
      execution.cLevelReviewRequested &&
      protocolViolations.length === 0 &&
      !safetyFailed(execution.safety)
    ) {
      try {
        evaluation = validateEvaluation(
          await beforeDeadline(
            (signal) =>
              input.evaluator.evaluate({
                taskId: input.task.id,
                artifact: execution.artifact,
                artifactHash,
                signal,
              }),
            WORKFLOW_ABORT_SETTLEMENT_MS,
          ),
        );
        evaluationSafety = evaluation.safety ?? zeroSafety();
        safety = addSafety(safety, evaluationSafety);
      } catch (error) {
        if (error instanceof WorkflowAbortSettlementError) throw error;
        if (isUnsettledOperation(error)) {
          throw new WorkflowAbortSettlementError(error);
        }
        failure = failureObservation(error, "evaluation");
        censorReason =
          error instanceof WorkflowDeadlineError
            ? "wall_clock_limit"
            : input.signal?.aborted
              ? "canceled"
              : "execution_error";
        status =
          censorReason === "execution_error" ? "failed" : "censored";
        evaluation = {
          passed: false,
          score: 0,
          criticalFailures: ["SEALED_EVALUATOR_ERROR"],
          criterionResults: [],
        };
      }
    }
    const roundSafety = addSafety(execution.safety, evaluationSafety);
    const submittedArtifact = {
      sha256: artifactHash,
      content: execution.artifact,
    };
    const retainable =
      execution.contractValid &&
      !executionOverrun &&
      protocolViolations.length === 0 &&
      !safetyFailed(roundSafety);
    let retentionAction: WorkflowRoundRecord["retentionAction"];
    if (retainable) {
      retentionAction = lastContractValidArtifact
        ? "accepted_valid"
        : "accepted_initial";
      lastContractValidArtifact = submittedArtifact;
      previousArtifact = submittedArtifact;
    } else if (lastContractValidArtifact) {
      retentionAction = execution.contractValid
        ? "rejected_untrusted"
        : "rejected_invalid";
      previousArtifact = lastContractValidArtifact;
    } else {
      retentionAction = "no_valid_baseline";
      previousArtifact = null;
    }
    const round: WorkflowRoundRecord = {
      submission,
      feedbackRound: feedbackRoundCount,
      directiveType:
        feedbackRoundCount === 0 ? "initial_assignment" : "changes_requested",
      directiveHash,
      artifactHash,
      initialContractValid:
        execution.initialContractValid ?? execution.contractValid,
      initialContractDiagnostics:
        execution.initialContractDiagnostics ??
        execution.contractDiagnostics ??
        [],
      contractValid: execution.contractValid,
      contractDiagnostics: execution.contractDiagnostics ?? [],
      contractRepairAttempts: execution.contractRepairAttempts ?? 0,
      contractRepairOutcome:
        execution.contractRepairOutcome ?? "not_needed",
      retainedArtifactHash: previousArtifact?.sha256 ?? null,
      retentionAction,
      externalPass: evaluation.passed,
      partialScore: Number(evaluation.score.toFixed(4)),
      criticalFailures: [...evaluation.criticalFailures],
      modelCalls: execution.modelCalls,
      handoffs: execution.handoffs,
      maxObservedConcurrency: execution.maxObservedConcurrency,
      inputTokens: execution.usage.inputTokens,
      outputTokens: execution.usage.outputTokens,
      latencyMs: execution.latencyMs,
      protocolViolations,
      safety: roundSafety,
      providerIdentities: execution.providerIdentities ?? [],
    };
    rounds.push(round);
    await input.onRound?.(round);

    if (executionOverrun) {
      censorReason = executionOverrun;
      status = "censored";
      break;
    }
    if (censorReason) break;

    if (safetyFailed(round.safety)) {
      censorReason = "safety_gate";
      status = "failed";
      break;
    }
    if (protocolViolations.length > 0) {
      failure = {
        phase: "implementation",
        code: safeFailureCode(
          protocolViolations[0],
          "PROTOCOL_VIOLATION",
        ),
        stage: "review",
        stageIndex: null,
        cycle: null,
        role: null,
      };
      censorReason = "protocol_failure";
      status = "failed";
      break;
    }
    if (evaluation.passed) {
      status = "passed";
      passSubmission = submission;
      finalApprovalCount = 1;
      userDirectiveCount += 1;
      break;
    }
    if (
      consecutiveContractInvalidSubmissions >=
      limits.maxConsecutiveContractInvalidSubmissions
    ) {
      censorReason = "no_progress";
      break;
    }
    if (identicalArtifacts >= limits.identicalArtifactLimit) {
      censorReason = "no_progress";
      break;
    }
    if (feedbackRoundCount >= limits.maxFeedbackRounds) {
      censorReason = "feedback_round_limit";
      break;
    }
    const afterExecutionLimit = resourceLimit();
    if (afterExecutionLimit) {
      censorReason = afterExecutionLimit;
      break;
    }

    if (
      limits.maxTotalTokens !== null &&
      input.feedbackProvider.id === "codex_generalist"
    ) {
      censorReason = "token_usage_unknown";
      status = "censored";
      break;
    }

    try {
      const feedback = await beforeDeadline(
        (signal) =>
          input.feedbackProvider.provideFeedback({
            task: input.task,
            currentHumanView: execution.humanView,
            submission,
            signal,
          }),
        WORKFLOW_ABORT_SETTLEMENT_MS,
      );
      if (
        feedback.actorType !== "simulated_user_proxy" ||
        feedback.mayResolveHumanApproval !== false ||
        feedback.providerId !== input.feedbackProvider.providerId ||
        !["changes_requested", "looks_good"].includes(
          feedback.recommendation,
        ) ||
        typeof feedback.directive !== "string" ||
        feedback.directive.trim().length === 0 ||
        Buffer.byteLength(feedback.directive, "utf8") > 16_384
      ) {
        throw new Error("FEEDBACK_PROVIDER_INVALID_RESULT");
      }
      validateUsage(feedback.usage);
      usage = addUsage(usage, feedback.usage);
      internalModelCalls += feedback.modelCalls;
      feedbackRoundCount += 1;
      userDirectiveCount += 1;
      const publicContractDiagnostic = (execution.contractDiagnostics ?? [])
        .map(({ stage, code }) => `${stage}:${code}`)
        .join(", ");
      directive = publicContractDiagnostic
        ? [
            feedback.directive,
            "Public contract diagnostics from the host validator:",
            publicContractDiagnostic,
            "Repair representation and disclosed schema only; do not infer hidden requirements.",
          ].join("\n")
        : feedback.directive;
      directiveHash = sha256(directive);
      feedbackDirectiveHashes.push(directiveHash);
      feedbackDirectives.push({
        afterSubmission: submission,
        artifactHash,
        directiveHash,
        recommendation: feedback.recommendation,
        providerId: feedback.providerId,
        actorType: "simulated_user_proxy",
        mayResolveHumanApproval: false,
      });
    } catch (error) {
      if (error instanceof WorkflowAbortSettlementError) throw error;
      if (isUnsettledOperation(error)) {
        throw new WorkflowAbortSettlementError(error);
      }
      if (error instanceof WorkflowAccountedError) {
        validateUsage(error.metrics.usage);
        usage = addUsage(usage, error.metrics.usage);
        internalModelCalls += error.metrics.modelCalls;
      }
      failure = failureObservation(error, "feedback");
      censorReason =
        error instanceof WorkflowDeadlineError
          ? "wall_clock_limit"
          : input.signal?.aborted
            ? "canceled"
            : "execution_error";
      status =
        censorReason === "execution_error" ? "failed" : "censored";
      break;
    }
  }

  if (!censorReason && status !== "passed") {
    censorReason = "execution_error";
    status = "failed";
  }
  // The owner defined a loop as one external feedback directive followed by
  // another implementation attempt. The initial assignment and orientation
  // therefore do not consume the bounded feedback checkpoint. Checkpoint 10
  // observes submission 11 when the trajectory has not already passed.
  const checkpointRound = rounds.find(
    (round) => round.feedbackRound === limits.boundedCheckpoint,
  );
  const scoreAtCheckpoint =
    checkpointRound?.partialScore ??
    (status === "passed" &&
    passSubmission !== null &&
    passSubmission - 1 <= limits.boundedCheckpoint
      ? rounds.at(-1)?.partialScore ?? null
      : null);
  const handoffCount = rounds.reduce((sum, round) => sum + round.handoffs, 0);
  const concurrencyLimitViolations = rounds.filter((round) =>
    round.protocolViolations.includes("MAX_PARALLEL_AGENTS_EXCEEDED"),
  ).length;
  const prematureReviewRequests = rounds.filter((round) =>
    round.protocolViolations.includes("TEAM_REVIEW_WITHOUT_HANDOFF"),
  ).length;
  return {
    apiVersion: "chartermesh.dev/workflow-trajectory/v1alpha2",
    trialId,
    orderIndex: input.orderIndex ?? 0,
    taskId: input.task.id,
    family: input.task.family,
    difficulty: input.task.difficulty,
    architecture: input.executor.architecture,
    feedbackPolicy: input.feedbackProvider.id,
    boundedCheckpoint: limits.boundedCheckpoint,
    setup,
    setupStatus,
    evaluatorId: input.evaluator.id,
    rounds,
    feedbackDirectiveHashes,
    feedbackDirectives,
    outcome: {
      status,
      passSubmission,
      passedByCheckpoint:
        passSubmission !== null &&
        passSubmission - 1 <= limits.boundedCheckpoint,
      scoreAtCheckpoint,
      bestScore: Number(
        Math.max(0, ...rounds.map((round) => round.partialScore)).toFixed(4),
      ),
      feedbackRoundCount,
      userDirectiveCount,
      setupApprovalCount,
      finalApprovalCount,
      internalModelCallCount: internalModelCalls,
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: usage.outputTokens,
      elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
      censorReason: status === "passed" ? null : censorReason,
      failure: status === "passed" ? null : failure,
    },
    collaboration: {
      handoffCount,
      protocolComplianceRate: protocolCompliance(
        rounds,
        censorReason === "protocol_failure",
      ),
      maxObservedConcurrency: Math.max(
        0,
        ...rounds.map((round) => round.maxObservedConcurrency),
      ),
      concurrencyLimitViolations,
      prematureReviewRequests,
    },
    safety,
    approvalAuthority: "synthetic_evaluator",
    productionHumanApprovalExercised: false,
  };
}
