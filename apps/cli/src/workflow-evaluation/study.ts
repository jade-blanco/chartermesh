import { createHash, randomUUID } from "node:crypto";
import { runWorkflowTrajectory } from "./trajectory.ts";
import type {
  SealedWorkflowEvaluator,
  WorkflowArchitecture,
  WorkflowExecutor,
  WorkflowFeedbackPolicy,
  WorkflowFeedbackProvider,
  WorkflowPublicTask,
  WorkflowStudyReport,
  WorkflowTrajectoryLimits,
  WorkflowTrajectoryReport,
} from "./types.ts";

export interface WorkflowStudyCondition {
  architecture: WorkflowArchitecture;
  feedbackPolicy: WorkflowFeedbackPolicy;
}

export const WORKFLOW_STUDY_CONDITIONS: WorkflowStudyCondition[] = [
  { architecture: "single", feedbackPolicy: "neutral_repeat" },
  { architecture: "team", feedbackPolicy: "neutral_repeat" },
  { architecture: "single", feedbackPolicy: "fixed_self_review" },
  { architecture: "team", feedbackPolicy: "fixed_self_review" },
  { architecture: "single", feedbackPolicy: "codex_generalist" },
  { architecture: "team", feedbackPolicy: "codex_generalist" },
];

export function workflowConditionId(
  condition: WorkflowStudyCondition,
): string {
  return `${condition.architecture}-${condition.feedbackPolicy.replaceAll("_", "-")}`;
}

export function workflowConditionOrderForTask(
  taskIndex: number,
  seed: number,
): WorkflowStudyCondition[] {
  const conditionCount = WORKFLOW_STUDY_CONDITIONS.length;
  if (
    !Number.isSafeInteger(taskIndex) ||
    taskIndex < 0 ||
    !Number.isSafeInteger(seed)
  ) {
    throw new Error("taskIndex and seed must be safe integers.");
  }
  // This first row of an even Williams square contains each non-zero
  // adjacent difference exactly once. Shifting it across six task rows
  // balances both condition position and first-order carryover, including
  // single -> team and team -> single directions.
  const williamsRow = [0, 1, 5, 2, 4, 3];
  if (williamsRow.length !== conditionCount) {
    throw new Error("Williams order must match the study condition count.");
  }
  const seedOffset = ((seed % conditionCount) + conditionCount) % conditionCount;
  const row = (taskIndex + seedOffset) % conditionCount;
  return williamsRow.map(
    (conditionIndex) =>
      WORKFLOW_STUDY_CONDITIONS[(conditionIndex + row) % conditionCount]!,
  );
}

function assertStableStudyProviderIdentity(
  trial: WorkflowTrajectoryReport,
  observedFingerprints: Map<string, string>,
): void {
  const identities = [
    ...(trial.setup.providerIdentities ?? []),
    ...trial.rounds.flatMap((round) => round.providerIdentities),
  ];
  for (const identity of identities) {
    const fingerprint = identity.reportedSystemFingerprint;
    if (fingerprint === null) continue;
    const modelId = identity.reportedModelId ?? "<unreported-model>";
    const key = `${identity.engineProfileId}\u0000${modelId}`;
    const observed = observedFingerprints.get(key);
    if (observed !== undefined && observed !== fingerprint) {
      throw new Error(
        `WORKFLOW_PROVIDER_IDENTITY_DRIFT:${identity.engineProfileId}:${modelId}`,
      );
    }
    observedFingerprints.set(key, fingerprint);
  }
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

export function workflowSuiteHash(tasks: WorkflowPublicTask[]): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(tasks)))
    .digest("hex");
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function aggregate(
  trials: WorkflowTrajectoryReport[],
): WorkflowStudyReport["aggregate"] {
  return WORKFLOW_STUDY_CONDITIONS.map((condition) => {
    const conditionId = workflowConditionId(condition);
    const selected = trials.filter(
      (trial) =>
        trial.architecture === condition.architecture &&
        trial.feedbackPolicy === condition.feedbackPolicy,
    );
    const tokenValues = selected.map((trial) =>
      trial.outcome.totalInputTokens === null ||
      trial.outcome.totalOutputTokens === null
        ? null
        : trial.outcome.totalInputTokens + trial.outcome.totalOutputTokens,
    );
    const rounds = selected.flatMap((trial) => trial.rounds);
    const rawContractValidSubmissions = rounds.filter(
      (round) => round.initialContractValid,
    ).length;
    const effectiveContractValidSubmissions = rounds.filter(
      (round) => round.contractValid,
    ).length;
    const contractRepairAttempts = rounds.reduce(
      (sum, round) => sum + round.contractRepairAttempts,
      0,
    );
    const contractRepairSuccesses = rounds.filter(
      (round) => round.contractRepairOutcome === "succeeded",
    ).length;
    return {
      conditionId,
      trials: selected.length,
      passedByCheckpoint: selected.filter(
        (trial) => trial.outcome.passedByCheckpoint,
      ).length,
      finalPassed: selected.filter(
        (trial) => trial.outcome.status === "passed",
      ).length,
      censored: selected.filter(
        (trial) => trial.outcome.status === "censored",
      ).length,
      failed: selected.filter(
        (trial) => trial.outcome.status === "failed",
      ).length,
      meanBestScore: Number(
        mean(selected.map((trial) => trial.outcome.bestScore)).toFixed(4),
      ),
      meanElapsedMs: Math.round(
        mean(selected.map((trial) => trial.outcome.elapsedMs)),
      ),
      medianElapsedMsToPass: median(
        selected
          .filter((trial) => trial.outcome.status === "passed")
          .map((trial) => trial.outcome.elapsedMs),
      ),
      meanFeedbackRounds: Number(
        mean(
          selected.map((trial) => trial.outcome.feedbackRoundCount),
        ).toFixed(4),
      ),
      meanScorePerModelCall: Number(
        mean(
          selected.map((trial) =>
            trial.outcome.internalModelCallCount === 0
              ? 0
              : trial.outcome.bestScore /
                trial.outcome.internalModelCallCount,
          ),
        ).toFixed(6),
      ),
      totalModelCalls: selected.reduce(
        (sum, trial) => sum + trial.outcome.internalModelCallCount,
        0,
      ),
      totalTokens: tokenValues.some((value) => value === null)
        ? null
        : tokenValues.reduce<number>(
            (sum, value) => sum + (value ?? 0),
            0,
          ),
      rawContractValidSubmissions,
      effectiveContractValidSubmissions,
      contractRepairAttempts,
      contractRepairSuccesses,
      rawContractValidityRate:
        rounds.length === 0
          ? 0
          : Number((rawContractValidSubmissions / rounds.length).toFixed(4)),
      effectiveContractValidityRate:
        rounds.length === 0
          ? 0
          : Number(
              (effectiveContractValidSubmissions / rounds.length).toFixed(4),
            ),
      protocolFailures: selected.filter(
        (trial) => trial.outcome.censorReason === "protocol_failure",
      ).length,
      safetyFailures: selected.filter(
        (trial) => trial.outcome.censorReason === "safety_gate",
      ).length,
    };
  });
}

function pairedComparisons(
  trials: WorkflowTrajectoryReport[],
): WorkflowStudyReport["pairedComparisons"] {
  return ([
    "neutral_repeat",
    "fixed_self_review",
    "codex_generalist",
  ] as const).map((feedbackPolicy) => {
    const policyTrials = trials.filter(
      (trial) => trial.feedbackPolicy === feedbackPolicy,
    );
    const pairs = [...new Set(policyTrials.map(({ taskId }) => taskId))]
      .map((taskId) => ({
        single: policyTrials.find(
          (trial) =>
            trial.taskId === taskId && trial.architecture === "single",
        ),
        team: policyTrials.find(
          (trial) =>
            trial.taskId === taskId && trial.architecture === "team",
        ),
      }))
      .filter(
        (pair): pair is {
          single: WorkflowTrajectoryReport;
          team: WorkflowTrajectoryReport;
        } => Boolean(pair.single && pair.team),
      );
    const scoreDifferences = pairs.map(
      ({ single, team }) =>
        team.outcome.bestScore - single.outcome.bestScore,
    );
    const difference = (
      selector: (trial: WorkflowTrajectoryReport) => number,
    ): number =>
      mean(
        pairs.map(({ single, team }) =>
          Number((selector(team) - selector(single)).toFixed(6)),
        ),
      );
    return {
      feedbackPolicy,
      pairedTasks: pairs.length,
      teamMinusSingleCheckpointPassRate: Number(
        difference((trial) => Number(trial.outcome.passedByCheckpoint)).toFixed(4),
      ),
      teamMinusSingleFinalPassRate: Number(
        difference((trial) => Number(trial.outcome.status === "passed")).toFixed(4),
      ),
      teamMinusSingleMeanBestScore: Number(
        mean(scoreDifferences).toFixed(4),
      ),
      teamMinusSingleMeanFeedbackRounds: Number(
        difference((trial) => trial.outcome.feedbackRoundCount).toFixed(4),
      ),
      teamMinusSingleMeanElapsedMs: Math.round(
        difference((trial) => trial.outcome.elapsedMs),
      ),
      teamMinusSingleMeanModelCalls: Number(
        difference((trial) => trial.outcome.internalModelCallCount).toFixed(4),
      ),
      bestScoreWins: scoreDifferences.filter((value) => value > 0).length,
      bestScoreTies: scoreDifferences.filter((value) => value === 0).length,
      bestScoreLosses: scoreDifferences.filter((value) => value < 0).length,
    };
  });
}

function stratifiedAggregate(
  trials: WorkflowTrajectoryReport[],
): WorkflowStudyReport["stratifiedAggregate"] {
  const dimensions = ["family", "difficulty"] as const;
  return dimensions.flatMap((dimension) =>
    [...new Set(trials.map((trial) => String(trial[dimension])))]
      .sort()
      .flatMap((value) =>
        WORKFLOW_STUDY_CONDITIONS.map((condition) => {
          const selected = trials.filter(
            (trial) =>
              String(trial[dimension]) === value &&
              trial.architecture === condition.architecture &&
              trial.feedbackPolicy === condition.feedbackPolicy,
          );
          return {
            dimension,
            value,
            conditionId: workflowConditionId(condition),
            trials: selected.length,
            checkpointPassRate: Number(
              mean(
                selected.map((trial) =>
                  Number(trial.outcome.passedByCheckpoint),
                ),
              ).toFixed(4),
            ),
            finalPassRate: Number(
              mean(
                selected.map((trial) =>
                  Number(trial.outcome.status === "passed"),
                ),
              ).toFixed(4),
            ),
            meanBestScore: Number(
              mean(selected.map((trial) => trial.outcome.bestScore)).toFixed(4),
            ),
            meanModelCalls: Number(
              mean(
                selected.map(
                  (trial) => trial.outcome.internalModelCallCount,
                ),
              ).toFixed(4),
            ),
            meanElapsedMs: Math.round(
              mean(selected.map((trial) => trial.outcome.elapsedMs)),
            ),
          };
        }),
      ),
  );
}

export async function runWorkflowStudy(input: {
  tasks: WorkflowPublicTask[];
  executorFactory: (input: {
    task: WorkflowPublicTask;
    condition: WorkflowStudyCondition;
    trialId: string;
    orderIndex: number;
  }) => Promise<WorkflowExecutor> | WorkflowExecutor;
  feedbackProviders: Record<
    WorkflowFeedbackPolicy,
    WorkflowFeedbackProvider
  >;
  evaluatorForTask: (
    task: WorkflowPublicTask,
  ) => Promise<SealedWorkflowEvaluator> | SealedWorkflowEvaluator;
  limits?: Partial<WorkflowTrajectoryLimits>;
  seed?: number;
  studyId?: string;
  sealedSuiteHash?: string;
  approvedPlanHash?: string;
  approvedPlanCanonicalJson?: string;
  expectedCandidateModelId?: string;
  provenance?: {
    candidateEngine: WorkflowStudyReport["provenance"]["candidateEngine"];
    codexProxy: WorkflowStudyReport["provenance"]["codexProxy"];
    controlPlane: WorkflowStudyReport["provenance"]["controlPlane"];
    codeSandbox: WorkflowStudyReport["provenance"]["codeSandbox"];
  };
  signal?: AbortSignal;
  onTrial?: (
    trial: WorkflowTrajectoryReport,
  ) => Promise<void> | void;
}): Promise<WorkflowStudyReport> {
  if (input.tasks.length === 0) {
    throw new Error("Workflow study requires at least one task.");
  }
  const ids = input.tasks.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Workflow study task ids must be unique.");
  }
  for (const policy of [
    "neutral_repeat",
    "fixed_self_review",
    "codex_generalist",
  ] as const) {
    const provider = input.feedbackProviders[policy];
    if (
      provider.id !== policy ||
      typeof provider.providerId !== "string" ||
      provider.providerId.trim().length === 0 ||
      provider.actorType !== "simulated_user_proxy" ||
      provider.mayResolveHumanApproval !== false
    ) {
      throw new Error(`Invalid feedback provider for '${policy}'.`);
    }
  }
  const seed = input.seed ?? 20260731;
  if (!Number.isSafeInteger(seed)) throw new Error("seed must be an integer.");
  const studyId = input.studyId ?? `collaboration-study-${randomUUID()}`;
  const sealedSuiteHash =
    input.sealedSuiteHash ?? workflowSuiteHash(input.tasks);
  if (!/^[a-f0-9]{64}$/u.test(sealedSuiteHash)) {
    throw new Error("sealedSuiteHash must be a lowercase SHA-256 digest.");
  }
  if (
    (input.approvedPlanHash === undefined) !==
      (input.approvedPlanCanonicalJson === undefined) ||
    (input.approvedPlanHash !== undefined &&
      !/^[a-f0-9]{64}$/u.test(input.approvedPlanHash))
  ) {
    throw new Error(
      "approvedPlanHash and approvedPlanCanonicalJson must be supplied together with a valid SHA-256 digest.",
    );
  }
  if (input.approvedPlanCanonicalJson !== undefined) {
    if (input.approvedPlanCanonicalJson.length > 1_048_576) {
      throw new Error("approvedPlanCanonicalJson exceeds the report limit.");
    }
    try {
      JSON.parse(input.approvedPlanCanonicalJson);
    } catch {
      throw new Error("approvedPlanCanonicalJson must be valid JSON.");
    }
  }
  const startedAt = new Date().toISOString();
  const trials: WorkflowTrajectoryReport[] = [];
  const evaluatorIds = new Set<string>();
  const observedProviderFingerprints = new Map<string, string>();
  const orderedTasks = [...input.tasks].sort((left, right) =>
    createHash("sha256")
      .update(`${seed}:${left.id}`)
      .digest("hex")
      .localeCompare(
        createHash("sha256")
          .update(`${seed}:${right.id}`)
          .digest("hex"),
      ),
  );
  for (const [taskIndex, task] of orderedTasks.entries()) {
    const order = workflowConditionOrderForTask(taskIndex, seed);
    for (const [orderIndex, condition] of order.entries()) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error("WORKFLOW_STUDY_CANCELED");
      }
      const trialId = `${studyId}:${task.id}:${workflowConditionId(condition)}`;
      const executor = await input.executorFactory({
        task,
        condition,
        trialId,
        orderIndex,
      });
      if (executor.architecture !== condition.architecture) {
        throw new Error("Workflow executor architecture mismatch.");
      }
      const evaluator = await input.evaluatorForTask(task);
      evaluatorIds.add(evaluator.id);
      const trial = await runWorkflowTrajectory({
        task,
        executor,
        feedbackProvider: input.feedbackProviders[condition.feedbackPolicy],
        evaluator,
        ...(input.limits ? { limits: input.limits } : {}),
        trialId,
        orderIndex,
        ...(input.expectedCandidateModelId
          ? { expectedCandidateModelId: input.expectedCandidateModelId }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      trials.push(trial);
      await input.onTrial?.(trial);
      // Persist the completed trial first, then fail the study before another
      // trial can run or a mixed-provenance final report can be published.
      assertStableStudyProviderIdentity(trial, observedProviderFingerprints);
      if (trial.outcome.censorReason === "provider_identity_mismatch") {
        throw new Error("WORKFLOW_STUDY_PROVIDER_IDENTITY_MISMATCH");
      }
    }
  }
  const limits = {
    boundedCheckpoint: input.limits?.boundedCheckpoint ?? 10,
    maxFeedbackRounds: input.limits?.maxFeedbackRounds ?? 50,
    maxWallClockMs:
      input.limits?.maxWallClockMs ?? 8 * 60 * 60 * 1_000,
    maxModelCalls: input.limits?.maxModelCalls ?? 512,
    maxTotalTokens: input.limits?.maxTotalTokens ?? null,
    identicalArtifactLimit: input.limits?.identicalArtifactLimit ?? 3,
    maxConsecutiveContractInvalidSubmissions:
      input.limits?.maxConsecutiveContractInvalidSubmissions ?? 3,
    maxParallelAgents: input.limits?.maxParallelAgents ?? 1,
  };
  return {
    apiVersion: "chartermesh.dev/collaboration-study-report/v1alpha2",
    studyId,
    approvedPlanHash: input.approvedPlanHash ?? null,
    approvedPlanCanonicalJson: input.approvedPlanCanonicalJson ?? null,
    suiteHash: sealedSuiteHash,
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    conditionOrder: WORKFLOW_STUDY_CONDITIONS.map(workflowConditionId),
    taskIds: ids,
    limits,
    conditionOrdering: "seeded_williams_square_v1",
    provenance: {
      sealedSuiteHash,
      candidateEngine: input.provenance?.candidateEngine ?? null,
      codexProxy: input.provenance?.codexProxy ?? null,
      controlPlane: input.provenance?.controlPlane ?? null,
      codeSandbox: input.provenance?.codeSandbox ?? null,
      evaluatorIds: [...evaluatorIds].sort(),
    },
    trials,
    aggregate: aggregate(trials),
    pairedComparisons: pairedComparisons(trials),
    stratifiedAggregate: stratifiedAggregate(trials),
    interpretationBoundary: [
      "Codex feedback is a simulated_user_proxy, not a human approval.",
      "Feedback rounds within one trajectory are correlated and are not independent samples.",
      "Team versus single effects must be reported with calls, tokens, and elapsed time; directive matching is not compute matching.",
      "Office-family v1 tasks evaluate bounded semantic IR, not OOXML creation or visual fidelity.",
      "Code-family pass results require an attested VM sandbox preflight; generated code is never executed on the host by this study runner.",
      "A finite pilot cannot establish general autonomous company-operation readiness.",
    ],
  };
}
