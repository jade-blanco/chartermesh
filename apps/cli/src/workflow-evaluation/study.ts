import { createHash, randomUUID } from "node:crypto";
import { runWorkflowTrajectory } from "./trajectory.ts";
import type {
  SealedWorkflowEvaluator,
  WorkflowArchitecture,
  WorkflowEngineRoute,
  WorkflowExecutor,
  WorkflowFeedbackPolicy,
  WorkflowFeedbackProvider,
  WorkflowPublicTask,
  WorkflowStudyReport,
  WorkflowTrajectoryLimits,
  WorkflowTrajectoryReport,
} from "./types.ts";

export interface WorkflowStudyCondition {
  id: string;
  architecture: WorkflowArchitecture;
  feedbackPolicy: WorkflowFeedbackPolicy;
  engineRoute: WorkflowEngineRoute;
}

export const WORKFLOW_STUDY_CONDITIONS: WorkflowStudyCondition[] = [
  {
    id: "single-neutral-repeat",
    architecture: "single",
    feedbackPolicy: "neutral_repeat",
    engineRoute: "local-single",
  },
  {
    id: "team-neutral-repeat",
    architecture: "team",
    feedbackPolicy: "neutral_repeat",
    engineRoute: "all-local-team",
  },
  {
    id: "single-fixed-self-review",
    architecture: "single",
    feedbackPolicy: "fixed_self_review",
    engineRoute: "local-single",
  },
  {
    id: "team-fixed-self-review",
    architecture: "team",
    feedbackPolicy: "fixed_self_review",
    engineRoute: "all-local-team",
  },
  {
    id: "single-codex-generalist",
    architecture: "single",
    feedbackPolicy: "codex_generalist",
    engineRoute: "local-single",
  },
  {
    id: "team-codex-generalist",
    architecture: "team",
    feedbackPolicy: "codex_generalist",
    engineRoute: "all-local-team",
  },
];

export const WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS:
  WorkflowStudyCondition[] = [
    {
      id: "single-local-neutral-repeat",
      architecture: "single",
      feedbackPolicy: "neutral_repeat",
      engineRoute: "local-single",
    },
    {
      id: "team-local-neutral-repeat",
      architecture: "team",
      feedbackPolicy: "neutral_repeat",
      engineRoute: "all-local-team",
    },
    {
      id: "team-codex-c-level-neutral-repeat",
      architecture: "team",
      feedbackPolicy: "neutral_repeat",
      engineRoute: "codex-c-level-local-worker-team",
    },
  ];

export function workflowConditionId(
  condition: WorkflowStudyCondition,
): string {
  return condition.id;
}

function validateConditionSet(
  conditions: readonly WorkflowStudyCondition[],
): void {
  if (![3, 6].includes(conditions.length)) {
    throw new Error("Workflow study condition sets must contain 3 or 6 conditions.");
  }
  const ids = new Set<string>();
  for (const condition of conditions) {
    if (
      !/^[a-z][a-z0-9-]{0,127}$/u.test(condition.id) ||
      ids.has(condition.id) ||
      !["single", "team"].includes(condition.architecture) ||
      ![
        "neutral_repeat",
        "fixed_self_review",
        "codex_generalist",
      ].includes(condition.feedbackPolicy) ||
      ![
        "local-single",
        "all-local-team",
        "codex-c-level-local-worker-team",
      ].includes(condition.engineRoute) ||
      (condition.architecture === "single") !==
        (condition.engineRoute === "local-single")
    ) {
      throw new Error("Workflow study condition set is invalid or ambiguous.");
    }
    ids.add(condition.id);
  }
}

export function workflowConditionOrderForTask(
  taskIndex: number,
  seed: number,
  conditions: readonly WorkflowStudyCondition[] = WORKFLOW_STUDY_CONDITIONS,
): WorkflowStudyCondition[] {
  validateConditionSet(conditions);
  const conditionCount = conditions.length;
  if (
    !Number.isSafeInteger(taskIndex) ||
    taskIndex < 0 ||
    !Number.isSafeInteger(seed)
  ) {
    throw new Error("taskIndex and seed must be safe integers.");
  }
  const seedOffset = ((seed % conditionCount) + conditionCount) % conditionCount;
  const row = (taskIndex + seedOffset) % conditionCount;
  if (conditionCount === 3) {
    return Array.from(
      { length: conditionCount },
      (_unused, position) => conditions[(position + row) % conditionCount]!,
    );
  }
  // This first row of an even Williams square contains each non-zero
  // adjacent difference exactly once. Shifting it across six task rows
  // balances both condition position and first-order carryover, including
  // single -> team and team -> single directions.
  const williamsRow = [0, 1, 5, 2, 4, 3];
  return williamsRow.map(
    (conditionIndex) => conditions[(conditionIndex + row) % conditionCount]!,
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
  conditions: readonly WorkflowStudyCondition[],
): WorkflowStudyReport["aggregate"] {
  return conditions.map((condition) => {
    const conditionId = workflowConditionId(condition);
    const selected = trials.filter(
      (trial) => trial.conditionId === conditionId,
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
  conditions: readonly WorkflowStudyCondition[],
): WorkflowStudyReport["pairedComparisons"] {
  const standardIds = new Set(
    WORKFLOW_STUDY_CONDITIONS.map(workflowConditionId),
  );
  if (
    conditions.length !== standardIds.size ||
    conditions.some((condition) => !standardIds.has(condition.id))
  ) {
    return [];
  }
  return ([
    "neutral_repeat",
    "fixed_self_review",
    "codex_generalist",
  ] as const).map((feedbackPolicy) => {
    const singleConditionId = WORKFLOW_STUDY_CONDITIONS.find(
      (condition) =>
        condition.architecture === "single" &&
        condition.feedbackPolicy === feedbackPolicy,
    )!.id;
    const teamConditionId = WORKFLOW_STUDY_CONDITIONS.find(
      (condition) =>
        condition.architecture === "team" &&
        condition.feedbackPolicy === feedbackPolicy,
    )!.id;
    const conditionTrials = trials.filter(
      (trial) =>
        trial.conditionId === singleConditionId ||
        trial.conditionId === teamConditionId,
    );
    const pairs = [...new Set(conditionTrials.map(({ taskId }) => taskId))]
      .map((taskId) => ({
        single: conditionTrials.find(
          (trial) =>
            trial.taskId === taskId &&
            trial.conditionId === singleConditionId,
        ),
        team: conditionTrials.find(
          (trial) =>
            trial.taskId === taskId &&
            trial.conditionId === teamConditionId,
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

function compareConditions(
  trials: WorkflowTrajectoryReport[],
  contrastId: string,
  leftConditionId: string,
  rightConditionId: string,
): WorkflowStudyReport["conditionComparisons"][number] {
  const conditionTrials = trials.filter(
    (trial) =>
      trial.conditionId === leftConditionId ||
      trial.conditionId === rightConditionId,
  );
  const pairs = [...new Set(conditionTrials.map(({ taskId }) => taskId))]
    .map((taskId) => ({
      left: conditionTrials.find(
        (trial) =>
          trial.taskId === taskId && trial.conditionId === leftConditionId,
      ),
      right: conditionTrials.find(
        (trial) =>
          trial.taskId === taskId && trial.conditionId === rightConditionId,
      ),
    }))
    .filter(
      (pair): pair is {
        left: WorkflowTrajectoryReport;
        right: WorkflowTrajectoryReport;
      } => Boolean(pair.left && pair.right),
    );
  const difference = (
    selector: (trial: WorkflowTrajectoryReport) => number,
  ): number =>
    mean(
      pairs.map(({ left, right }) =>
        Number((selector(right) - selector(left)).toFixed(6)),
      ),
    );
  const scoreDifferences = pairs.map(({ left, right }) =>
    Number((right.outcome.bestScore - left.outcome.bestScore).toFixed(6)),
  );
  return {
    contrastId,
    leftConditionId,
    rightConditionId,
    pairedTasks: pairs.length,
    rightMinusLeftCheckpointPassRate: Number(
      difference((trial) => Number(trial.outcome.passedByCheckpoint)).toFixed(4),
    ),
    rightMinusLeftFinalPassRate: Number(
      difference((trial) => Number(trial.outcome.status === "passed")).toFixed(4),
    ),
    rightMinusLeftMeanBestScore: Number(
      mean(scoreDifferences).toFixed(4),
    ),
    rightMinusLeftMeanFeedbackRounds: Number(
      difference((trial) => trial.outcome.feedbackRoundCount).toFixed(4),
    ),
    rightMinusLeftMeanElapsedMs: Math.round(
      difference((trial) => trial.outcome.elapsedMs),
    ),
    rightMinusLeftMeanModelCalls: Number(
      difference((trial) => trial.outcome.internalModelCallCount).toFixed(4),
    ),
    bestScoreWins: scoreDifferences.filter((value) => value > 0).length,
    bestScoreTies: scoreDifferences.filter((value) => value === 0).length,
    bestScoreLosses: scoreDifferences.filter((value) => value < 0).length,
  };
}

function conditionComparisons(
  trials: WorkflowTrajectoryReport[],
  conditions: readonly WorkflowStudyCondition[],
): WorkflowStudyReport["conditionComparisons"] {
  const hybridIds = new Set(
    WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS.map(workflowConditionId),
  );
  if (
    conditions.length !== hybridIds.size ||
    conditions.some((condition) => !hybridIds.has(condition.id))
  ) {
    return [];
  }
  return [
    compareConditions(
      trials,
      "all-local-team-vs-local-single",
      "single-local-neutral-repeat",
      "team-local-neutral-repeat",
    ),
    compareConditions(
      trials,
      "codex-c-level-team-vs-local-single",
      "single-local-neutral-repeat",
      "team-codex-c-level-neutral-repeat",
    ),
    compareConditions(
      trials,
      "codex-c-level-team-vs-all-local-team",
      "team-local-neutral-repeat",
      "team-codex-c-level-neutral-repeat",
    ),
  ];
}

function nullableAdd(
  left: number | null,
  right: number | null,
): number | null {
  return left === null || right === null ? null : left + right;
}

function engineAggregate(
  trials: WorkflowTrajectoryReport[],
  conditions: readonly WorkflowStudyCondition[],
): WorkflowStudyReport["engineAggregate"] {
  type Aggregate = WorkflowStudyReport["engineAggregate"][number] & {
    trialIds: Set<string>;
  };
  const grouped = new Map<string, Aggregate>();
  for (const trial of trials) {
    for (const accounting of trial.engineAccounting) {
      const key = JSON.stringify([
        trial.conditionId,
        accounting.engineProfileId,
        accounting.modelId,
        accounting.evidenceSource,
      ]);
      const current = grouped.get(key);
      if (current === undefined) {
        grouped.set(key, {
          conditionId: trial.conditionId,
          engineProfileId: accounting.engineProfileId,
          modelId: accounting.modelId,
          trials: 1,
          calls: accounting.calls,
          succeeded: accounting.succeeded,
          failed: accounting.failed,
          canceled: accounting.canceled,
          abandoned: accounting.abandoned,
          inputTokens: accounting.inputTokens,
          outputTokens: accounting.outputTokens,
          cost: accounting.cost,
          elapsedMs: accounting.elapsedMs,
          measurementStatus: accounting.measurementStatus,
          evidenceSource: accounting.evidenceSource,
          trialIds: new Set([trial.trialId]),
        });
        continue;
      }
      current.trialIds.add(trial.trialId);
      current.trials = current.trialIds.size;
      current.calls += accounting.calls;
      current.succeeded += accounting.succeeded;
      current.failed += accounting.failed;
      current.canceled += accounting.canceled;
      current.abandoned += accounting.abandoned;
      current.inputTokens = nullableAdd(
        current.inputTokens,
        accounting.inputTokens,
      );
      current.outputTokens = nullableAdd(
        current.outputTokens,
        accounting.outputTokens,
      );
      current.cost = nullableAdd(current.cost, accounting.cost);
      current.elapsedMs = nullableAdd(
        current.elapsedMs,
        accounting.elapsedMs,
      );
      current.measurementStatus =
        current.measurementStatus === "unknown" ||
        accounting.measurementStatus === "unknown"
          ? "unknown"
          : current.measurementStatus === "estimated" ||
              accounting.measurementStatus === "estimated"
            ? "estimated"
            : "measured";
    }
  }
  const conditionRanks = new Map(
    conditions.map((condition, index) => [condition.id, index]),
  );
  return [...grouped.values()]
    .sort(
      (left, right) =>
        (conditionRanks.get(left.conditionId) ?? Number.MAX_SAFE_INTEGER) -
          (conditionRanks.get(right.conditionId) ?? Number.MAX_SAFE_INTEGER) ||
        left.engineProfileId.localeCompare(right.engineProfileId) ||
        left.modelId.localeCompare(right.modelId) ||
        left.evidenceSource.localeCompare(right.evidenceSource),
    )
    .map(({ trialIds: _trialIds, ...entry }) => entry);
}

function stratifiedAggregate(
  trials: WorkflowTrajectoryReport[],
  conditions: readonly WorkflowStudyCondition[],
): WorkflowStudyReport["stratifiedAggregate"] {
  const dimensions = ["family", "difficulty"] as const;
  return dimensions.flatMap((dimension) =>
    [...new Set(trials.map((trial) => String(trial[dimension])))]
      .sort()
      .flatMap((value) =>
        conditions.map((condition) => {
          const selected = trials.filter(
            (trial) =>
              String(trial[dimension]) === value &&
              trial.conditionId === condition.id,
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
  conditions?: readonly WorkflowStudyCondition[];
  executorFactory: (input: {
    task: WorkflowPublicTask;
    condition: WorkflowStudyCondition;
    trialId: string;
    orderIndex: number;
  }) => Promise<WorkflowExecutor> | WorkflowExecutor;
  feedbackProviders: Partial<Record<
    WorkflowFeedbackPolicy,
    WorkflowFeedbackProvider
  >>;
  evaluatorForTask: (
    task: WorkflowPublicTask,
  ) => Promise<SealedWorkflowEvaluator> | SealedWorkflowEvaluator;
  limits?: Partial<WorkflowTrajectoryLimits>;
  seed?: number;
  studyId?: string;
  sealedSuiteHash?: string;
  approvedPlanHash?: string;
  approvedPlanCanonicalJson?: string;
  expectedCandidateModelId?: string | Readonly<Record<string, string>>;
  provenance?: {
    candidateEngine: WorkflowStudyReport["provenance"]["candidateEngine"];
    codexProxy: WorkflowStudyReport["provenance"]["codexProxy"];
    cLevelEngine: WorkflowStudyReport["provenance"]["cLevelEngine"];
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
  const conditions = (input.conditions ?? WORKFLOW_STUDY_CONDITIONS).map(
    (condition) => ({ ...condition }),
  );
  validateConditionSet(conditions);
  const requiredPolicies = new Set(
    conditions.map(({ feedbackPolicy }) => feedbackPolicy),
  );
  for (const policy of requiredPolicies) {
    const provider = input.feedbackProviders[policy];
    if (
      provider === undefined ||
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
    const order = workflowConditionOrderForTask(taskIndex, seed, conditions);
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
      const feedbackProvider =
        input.feedbackProviders[condition.feedbackPolicy];
      if (feedbackProvider === undefined) {
        throw new Error(
          `Missing feedback provider for '${condition.feedbackPolicy}'.`,
        );
      }
      const trial = await runWorkflowTrajectory({
        task,
        executor,
        feedbackProvider,
        evaluator,
        ...(input.limits ? { limits: input.limits } : {}),
        trialId,
        conditionId: condition.id,
        engineRoute: condition.engineRoute,
        orderIndex,
        ...(input.expectedCandidateModelId
          ? { expectedCandidateModelId: input.expectedCandidateModelId }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        trial.conditionId !== condition.id ||
        trial.engineRoute !== condition.engineRoute
      ) {
        throw new Error("Workflow trajectory condition attestation mismatch.");
      }
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
    apiVersion: "chartermesh.dev/collaboration-study-report/v1alpha3",
    studyId,
    approvedPlanHash: input.approvedPlanHash ?? null,
    approvedPlanCanonicalJson: input.approvedPlanCanonicalJson ?? null,
    suiteHash: sealedSuiteHash,
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    conditionOrder: conditions.map(workflowConditionId),
    conditionDefinitions: conditions.map((condition) => ({
      id: condition.id,
      architecture: condition.architecture,
      feedbackPolicy: condition.feedbackPolicy,
      engineRoute: condition.engineRoute,
    })),
    taskIds: ids,
    limits,
    conditionOrdering:
      conditions.length === 3
        ? "seeded_cyclic_latin_v1"
        : "seeded_williams_square_v1",
    provenance: {
      sealedSuiteHash,
      candidateEngine: input.provenance?.candidateEngine ?? null,
      codexProxy: input.provenance?.codexProxy ?? null,
      cLevelEngine: input.provenance?.cLevelEngine ?? null,
      controlPlane: input.provenance?.controlPlane ?? null,
      codeSandbox: input.provenance?.codeSandbox ?? null,
      evaluatorIds: [...evaluatorIds].sort(),
    },
    trials,
    aggregate: aggregate(trials, conditions),
    pairedComparisons: pairedComparisons(trials, conditions),
    conditionComparisons: conditionComparisons(trials, conditions),
    engineAggregate: engineAggregate(trials, conditions),
    stratifiedAggregate: stratifiedAggregate(trials, conditions),
    interpretationBoundary: [
      ...(conditions.some(
        ({ feedbackPolicy }) => feedbackPolicy === "codex_generalist",
      )
        ? [
            "Codex feedback is a simulated_user_proxy, not a human approval.",
          ]
        : []),
      "Feedback rounds within one trajectory are correlated and are not independent samples.",
      "Team versus single effects must be reported with calls, tokens, and elapsed time; directive matching is not compute matching.",
      "Office-family v1 tasks evaluate bounded semantic IR, not OOXML creation or visual fidelity.",
      "Code-family pass results require an attested VM sandbox preflight; generated code is never executed on the host by this study runner.",
      ...(conditions.some(
        ({ engineRoute }) =>
          engineRoute === "codex-c-level-local-worker-team",
      )
        ? [
            "A Codex C-level route is an external hosted model role, not a local model or human approval; it is not compute matched.",
            "Codex exec usage is unknown and its requested output-token limit is advisory; the harness enforces timeout, call-count, schema, and output-byte bounds instead.",
          ]
        : []),
      "A finite pilot cannot establish general autonomous company-operation readiness.",
    ],
  };
}
