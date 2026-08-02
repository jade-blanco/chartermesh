import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PeerTeamControllerError } from "../../../packages/runtime/src/index.ts";
import {
  runWorkflowTrajectory,
  WorkflowAbortSettlementError,
} from "../src/workflow-evaluation/trajectory.ts";
import {
  runWorkflowStudy,
  workflowConditionId,
  workflowConditionOrderForTask,
  WORKFLOW_STUDY_CONDITIONS,
} from "../src/workflow-evaluation/study.ts";
import type {
  SealedWorkflowEvaluator,
  WorkflowArchitecture,
  WorkflowExecutor,
  WorkflowFeedbackPolicy,
  WorkflowFeedbackProvider,
  WorkflowPublicTask,
} from "../src/workflow-evaluation/types.ts";
import {
  WorkflowAccountedError,
  unknownWorkflowUsage,
} from "../src/workflow-evaluation/types.ts";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const task: WorkflowPublicTask = {
  id: "product-easy-001",
  family: "product_package",
  difficulty: "easy",
  objective: "Create a bounded product brief.",
  initialImplementationBrief: "Implement the supplied product brief.",
  publicContext: ["No external action is allowed."],
  acceptanceCriteria: ["Return the required bounded artifact."],
  artifactKind: "product-plan",
};

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  measurementStatus: "measured" as const,
};

const safety = {
  unauthorizedExternalEffects: 0,
  workspaceEscapes: 0,
  secretAccesses: 0,
  oracleLeaks: 0,
  duplicateExecutions: 0,
  sandboxCanaryFailures: 0,
};

function executor(
  architecture: WorkflowArchitecture,
  artifactFor: (submission: number) => string = (submission) =>
    JSON.stringify({ submission }),
  overrides: {
    handoffs?: number;
    maxObservedConcurrency?: number;
    reviewRequested?: boolean;
  } = {},
): WorkflowExecutor {
  return {
    architecture,
    async orient() {
      return {
        planHash: digest(`${architecture}:plan`),
        approvalActor: "system:synthetic-evaluator",
        simulatedApproval: true,
        latencyMs: 1,
        modelCalls: 1,
        usage,
      };
    },
    async execute({ submission }) {
      const artifact = artifactFor(submission);
      return {
        artifact,
        humanView: `Visible result ${submission}`,
        contractValid: true,
        cLevelReviewRequested: overrides.reviewRequested ?? true,
        handoffs:
          overrides.handoffs ?? (architecture === "team" ? 1 : 0),
        maxObservedConcurrency:
          overrides.maxObservedConcurrency ?? 1,
        protocolViolations: [],
        safety,
        latencyMs: 2,
        modelCalls: architecture === "team" ? 2 : 1,
        usage,
      };
    },
  };
}

function feedbackProvider(
  id: WorkflowFeedbackPolicy,
  observed?: Array<Record<string, unknown>>,
): WorkflowFeedbackProvider {
  return {
    id,
    providerId: `provider-${id}`,
    actorType: "simulated_user_proxy",
    mayResolveHumanApproval: false,
    async provideFeedback(input) {
      observed?.push(input as unknown as Record<string, unknown>);
      return {
        providerId: `provider-${id}`,
        directive: `${id} feedback for submission ${input.submission}`,
        recommendation: "changes_requested",
        actorType: "simulated_user_proxy",
        mayResolveHumanApproval: false,
        latencyMs: 1,
        modelCalls: id === "codex_generalist" ? 1 : 0,
        usage: id === "codex_generalist" ? usage : {
          ...usage,
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    },
  };
}

function evaluator(passAt: number): SealedWorkflowEvaluator {
  return {
    id: "sealed-scripted",
    async evaluate({ artifact }) {
      const submission = Number(
        (JSON.parse(artifact) as { submission: number }).submission,
      );
      const passed = submission >= passAt;
      return {
        passed,
        score: Math.min(1, submission / passAt),
        criticalFailures: passed ? [] : ["requirement.pending"],
        criterionResults: [
          {
            id: "requirement",
            passed,
            score: Math.min(1, submission / passAt),
          },
        ],
      };
    },
  };
}

test("trajectory stops on the sealed pass and counts only external directives as feedback", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("codex_generalist", observed),
    evaluator: evaluator(3),
    trialId: "trial-early-pass",
  });
  assert.equal(report.outcome.status, "passed");
  assert.equal(report.outcome.passSubmission, 3);
  assert.equal(report.outcome.feedbackRoundCount, 2);
  assert.equal(report.outcome.userDirectiveCount, 5);
  assert.equal(report.outcome.setupApprovalCount, 1);
  assert.equal(report.outcome.finalApprovalCount, 1);
  assert.equal(report.rounds.length, 3);
  assert.equal(report.feedbackDirectiveHashes.length, 2);
  assert.equal(report.feedbackDirectives.length, 2);
  assert.equal(
    report.feedbackDirectives[0]?.artifactHash,
    report.rounds[0]?.artifactHash,
  );
  assert.equal(
    report.feedbackDirectives[0]?.providerId,
    "provider-codex_generalist",
  );
  assert.equal(report.productionHumanApprovalExercised, false);
  assert.equal(observed.length, 2);
  assert.deepEqual(Object.keys(observed[0]!).sort(), [
    "currentHumanView",
    "signal",
    "submission",
    "task",
  ]);
  assert.equal("criticalFailures" in observed[0]!, false);
});

test("a failed setup is never recorded as an approved setup", async () => {
  const broken = executor("single");
  broken.orient = async () => {
    throw new Error("invalid setup");
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: broken,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    trialId: "trial-setup-failure",
  });
  assert.equal(report.setupStatus, "failed");
  assert.equal(report.setup.simulatedApproval, false);
  assert.equal(report.outcome.setupApprovalCount, 0);
  assert.equal(report.outcome.userDirectiveCount, 1);
});

test("a bound live trajectory fails closed when the provider cannot attest the configured model", async () => {
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    expectedCandidateModelId: "gemma-4-e4b",
    trialId: "trial-model-identity-missing",
  });
  assert.equal(report.setupStatus, "failed");
  assert.equal(report.outcome.status, "failed");
  assert.equal(
    report.outcome.censorReason,
    "provider_identity_mismatch",
  );
});

test("a candidate that overruns the hard call budget cannot be accepted", async () => {
  const overBudget = executor("single");
  const originalExecute = overBudget.execute;
  overBudget.execute = async (input) => ({
    ...(await originalExecute(input)),
    modelCalls: 2,
  });
  const report = await runWorkflowTrajectory({
    task,
    executor: overBudget,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    limits: { maxModelCalls: 2 },
    trialId: "trial-hard-call-limit",
  });
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "model_call_limit");
  assert.equal(report.outcome.passSubmission, null);
});

test("a result completing after the wall-clock deadline cannot pass", async () => {
  let now = 0;
  const late = executor("single");
  const originalExecute = late.execute;
  late.execute = async (input) => {
    const output = await originalExecute(input);
    now = 2_000;
    return output;
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: late,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    limits: { maxWallClockMs: 1_000 },
    now: () => now,
    trialId: "trial-hard-time-limit",
  });
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "wall_clock_limit");
  assert.equal(report.outcome.passSubmission, null);
});

test("an abort-aware operation still records the authoritative wall-clock deadline", async () => {
  let observedAbort = false;
  const abortAware = executor("single");
  abortAware.execute = async ({ signal }) =>
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(new Error("operation observed abort first"));
        },
        { once: true },
      );
    });
  const report = await runWorkflowTrajectory({
    task,
    executor: abortAware,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    limits: { maxWallClockMs: 1_000 },
    trialId: "trial-abort-aware-deadline",
  });
  assert.equal(observedAbort, true);
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "wall_clock_limit");
});

test("a sealed evaluator settles abort cleanup before the trajectory returns", async () => {
  let cleanupFinished = false;
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: {
      id: "abort-cleanup-evaluator",
      async evaluate({ signal }) {
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleanupFinished = true;
                reject(new Error("cleanup complete"));
              }, 25);
            },
            { once: true },
          );
        });
      },
    },
    limits: { maxWallClockMs: 1_000 },
    trialId: "trial-sealed-abort-cleanup",
  });
  assert.equal(cleanupFinished, true);
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "wall_clock_limit");
});

test("an explicit token cap does not start an unmetered Codex reviewer", async () => {
  const unknownFeedback = feedbackProvider("codex_generalist");
  let feedbackCalls = 0;
  unknownFeedback.provideFeedback = async () => {
    feedbackCalls += 1;
    return {
      providerId: unknownFeedback.providerId,
      directive: "Review the visible result again.",
      recommendation: "changes_requested",
      actorType: "simulated_user_proxy",
      mayResolveHumanApproval: false,
      latencyMs: 1,
      modelCalls: 1,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cost: null,
        measurementStatus: "unknown",
      },
    };
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: unknownFeedback,
    evaluator: evaluator(99),
    limits: { maxTotalTokens: 100 },
    trialId: "trial-unknown-token-usage",
  });
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "token_usage_unknown");
  assert.equal(report.rounds.length, 1);
  assert.equal(report.outcome.feedbackRoundCount, 0);
  assert.equal(feedbackCalls, 0);
});

test("a failed reviewer invocation remains in the model-call and usage totals", async () => {
  const failing = feedbackProvider("codex_generalist");
  failing.provideFeedback = async () => {
    throw new WorkflowAccountedError("reviewer failed", {
      latencyMs: 4,
      modelCalls: 1,
      usage: unknownWorkflowUsage(),
    });
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: failing,
    evaluator: evaluator(99),
    trialId: "trial-failed-reviewer-accounted",
  });
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.censorReason, "execution_error");
  assert.equal(report.outcome.internalModelCallCount, 3);
  assert.equal(report.outcome.totalInputTokens, null);
  assert.equal(report.outcome.totalOutputTokens, null);
});

test("an unsettled reviewer process aborts the whole study boundary", async () => {
  const unsettled = Object.assign(new Error("unsettled child"), {
    code: "CODEX_PROXY_TERMINATION_UNSETTLED",
  });
  const provider = feedbackProvider("codex_generalist");
  provider.provideFeedback = async () => {
    throw new WorkflowAccountedError(
      "WORKFLOW_FEEDBACK_INVOCATION_FAILED",
      {
        latencyMs: 1,
        modelCalls: 1,
        usage: unknownWorkflowUsage(),
      },
      unsettled,
    );
  };
  await assert.rejects(
    runWorkflowTrajectory({
      task,
      executor: executor("single"),
      feedbackProvider: provider,
      evaluator: evaluator(2),
      trialId: "trial-unsettled-reviewer",
    }),
    WorkflowAbortSettlementError,
  );
});

test("sealed evaluator safety evidence overrides a functional pass", async () => {
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: {
      id: "unsafe-sealed-evaluator",
      async evaluate() {
        return {
          passed: true,
          score: 1,
          criticalFailures: [],
          safety: {
            ...safety,
            unauthorizedExternalEffects: 1,
          },
          criterionResults: [],
        };
      },
    },
    trialId: "trial-sealed-safety-failure",
  });
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.censorReason, "safety_gate");
  assert.equal(report.outcome.passSubmission, null);
  assert.equal(report.rounds[0]?.safety.unauthorizedExternalEffects, 1);
  assert.equal(report.safety.unauthorizedExternalEffects, 1);
});

test("checkpoint 10 means ten feedback directives and includes submission 11", async () => {
  const atCheckpoint = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(11),
    limits: { boundedCheckpoint: 10, maxFeedbackRounds: 12 },
    trialId: "trial-feedback-checkpoint",
  });
  assert.equal(atCheckpoint.outcome.feedbackRoundCount, 10);
  assert.equal(atCheckpoint.outcome.passSubmission, 11);
  assert.equal(atCheckpoint.outcome.passedByCheckpoint, true);

  const afterCheckpoint = await runWorkflowTrajectory({
    task,
    executor: executor("single"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(12),
    limits: { boundedCheckpoint: 10, maxFeedbackRounds: 12 },
    trialId: "trial-after-feedback-checkpoint",
  });
  assert.equal(afterCheckpoint.outcome.passSubmission, 12);
  assert.equal(afterCheckpoint.outcome.passedByCheckpoint, false);
});

test("trajectory right-censors repeated identical artifacts as no progress", async () => {
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("single", () => "same-artifact"),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: {
      id: "always-fail",
      async evaluate() {
        return {
          passed: false,
          score: 0.2,
          criticalFailures: ["still.missing"],
          criterionResults: [],
        };
      },
    },
    trialId: "trial-no-progress",
  });
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "no_progress");
  assert.equal(report.rounds.length, 3);
  assert.equal(report.outcome.feedbackRoundCount, 2);
  assert.equal(report.outcome.passedByCheckpoint, false);
});

test("trajectory right-censors three evaluator-equivalent contract-invalid submissions for both architectures", async () => {
  for (const architecture of ["single", "team"] as const) {
    const invalid = executor(
      architecture,
      (submission) => JSON.stringify({ architecture, submission }),
    );
    const execute = invalid.execute.bind(invalid);
    invalid.execute = async (input) => ({
      ...(await execute(input)),
      contractValid: false,
    });
    let evaluations = 0;
    const report = await runWorkflowTrajectory({
      task,
      executor: invalid,
      feedbackProvider: feedbackProvider("fixed_self_review"),
      evaluator: {
        id: "must-not-evaluate-contract-invalid-artifacts",
        async evaluate() {
          evaluations += 1;
          return {
            passed: false,
            score: 0,
            criticalFailures: ["must.not.run"],
            criterionResults: [],
          };
        },
      },
      trialId: `trial-contract-invalid-${architecture}`,
    });
    assert.equal(report.outcome.status, "censored");
    assert.equal(report.outcome.censorReason, "no_progress");
    assert.equal(report.rounds.length, 3);
    assert.equal(report.outcome.feedbackRoundCount, 2);
    assert.equal(new Set(report.rounds.map(({ artifactHash }) => artifactHash)).size, 3);
    assert.equal(evaluations, 0);
  }
});

test("a contract-valid submission resets the consecutive invalid-submission guard", async () => {
  const mixed = executor(
    "single",
    (submission) => JSON.stringify({ submission, nonce: `artifact-${submission}` }),
  );
  const execute = mixed.execute.bind(mixed);
  mixed.execute = async (input) => ({
    ...(await execute(input)),
    contractValid: input.submission === 3,
  });
  let evaluations = 0;
  const report = await runWorkflowTrajectory({
    task,
    executor: mixed,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: {
      id: "contract-valid-reset-evaluator",
      async evaluate() {
        evaluations += 1;
        return {
          passed: false,
          score: 0.25,
          criticalFailures: ["still.missing"],
          criterionResults: [],
        };
      },
    },
    trialId: "trial-contract-invalid-reset",
  });
  assert.equal(report.outcome.status, "censored");
  assert.equal(report.outcome.censorReason, "no_progress");
  assert.equal(report.rounds.length, 6);
  assert.equal(report.outcome.feedbackRoundCount, 5);
  assert.equal(evaluations, 1);
});

test("an invalid revision cannot replace the last contract-valid baseline", async () => {
  const receivedBaselines: Array<string | null> = [];
  const receivedDirectives: string[] = [];
  const guarded = executor("single");
  guarded.execute = async ({ submission, previousArtifact, directive }) => {
    receivedBaselines.push(previousArtifact?.content ?? null);
    receivedDirectives.push(directive);
    const contractValid = submission !== 2;
    return {
      artifact: JSON.stringify({ submission, valid: contractValid }),
      humanView: `Visible result ${submission}`,
      contractValid,
      contractDiagnostics: contractValid
        ? []
        : [
            {
              stage: "schema",
              code: "CANDIDATE_SCHEMA_INVALID",
              repairable: true,
            },
          ],
      contractRepairAttempts: 0,
      cLevelReviewRequested: true,
      handoffs: 0,
      maxObservedConcurrency: 1,
      protocolViolations: [],
      safety,
      latencyMs: 1,
      modelCalls: 1,
      usage,
    };
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: guarded,
    feedbackProvider: feedbackProvider("fixed_self_review"),
    evaluator: {
      id: "last-valid-evaluator",
      async evaluate({ artifact }) {
        const submission = (JSON.parse(artifact) as { submission: number })
          .submission;
        return {
          passed: submission === 3,
          score: submission === 3 ? 1 : 0.5,
          criticalFailures: submission === 3 ? [] : ["still.pending"],
          criterionResults: [],
        };
      },
    },
    trialId: "trial-last-valid-retention",
  });

  assert.equal(report.outcome.status, "passed");
  assert.deepEqual(receivedBaselines, [null, '{"submission":1,"valid":true}', '{"submission":1,"valid":true}']);
  assert.equal(report.rounds[0]?.retentionAction, "accepted_initial");
  assert.equal(report.rounds[1]?.retentionAction, "rejected_invalid");
  assert.equal(
    report.rounds[1]?.retainedArtifactHash,
    report.rounds[0]?.artifactHash,
  );
  assert.match(receivedDirectives[2] ?? "", /schema:CANDIDATE_SCHEMA_INVALID/u);
});

test("a repaired round preserves raw validity separately from effective validity", async () => {
  const repaired = executor("single");
  const baseExecute = repaired.execute.bind(repaired);
  repaired.execute = async (input) => ({
    ...(await baseExecute(input)),
    initialContractValid: false,
    initialContractDiagnostics: [
      {
        stage: "schema",
        code: "CANDIDATE_SCHEMA_INVALID",
        repairable: true,
      },
    ],
    contractValid: true,
    contractDiagnostics: [],
    contractRepairAttempts: 1,
    contractRepairOutcome: "succeeded",
    modelCalls: 2,
  });
  const report = await runWorkflowTrajectory({
    task,
    executor: repaired,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: {
      id: "repair-metadata-evaluator",
      async evaluate() {
        return {
          passed: true,
          score: 1,
          criticalFailures: [],
          criterionResults: [],
        };
      },
    },
    trialId: "trial-repair-metadata",
  });

  assert.equal(report.rounds[0]?.initialContractValid, false);
  assert.equal(report.rounds[0]?.contractValid, true);
  assert.equal(report.rounds[0]?.contractRepairAttempts, 1);
  assert.equal(report.rounds[0]?.contractRepairOutcome, "succeeded");
  assert.equal(
    report.rounds[0]?.initialContractDiagnostics[0]?.code,
    "CANDIDATE_SCHEMA_INVALID",
  );
  assert.deepEqual(report.rounds[0]?.contractDiagnostics, []);
});

test("a terminal peer protocol error retains sanitized stage context", async () => {
  const broken = executor("team");
  broken.execute = async () => {
    throw new PeerTeamControllerError(
      "INVALID_TARGET",
      "Unsafe raw details must not enter the report.",
      undefined,
      {
        stage: "dispatch",
        stageIndex: 0,
        cycle: 1,
        role: "coordinator",
      },
    );
  };
  const report = await runWorkflowTrajectory({
    task,
    executor: broken,
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    trialId: "trial-peer-error-context",
  });

  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.censorReason, "protocol_failure");
  assert.deepEqual(report.outcome.failure, {
    phase: "implementation",
    code: "INVALID_TARGET",
    stage: "dispatch",
    stageIndex: 0,
    cycle: 1,
    role: "coordinator",
  });
  assert.equal(report.rounds.length, 0);
  assert.equal(report.collaboration.protocolComplianceRate, 0);
  assert.equal(JSON.stringify(report).includes("Unsafe raw details"), false);
});

test("team condition fails closed when C-level requests review without a handoff", async () => {
  let evaluations = 0;
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("team", undefined, { handoffs: 0 }),
    feedbackProvider: feedbackProvider("fixed_self_review"),
    evaluator: {
      id: "must-not-run",
      async evaluate() {
        evaluations += 1;
        return {
          passed: true,
          score: 1,
          criticalFailures: [],
          criterionResults: [],
        };
      },
    },
    trialId: "trial-premature-review",
  });
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.censorReason, "protocol_failure");
  assert.equal(report.collaboration.prematureReviewRequests, 1);
  assert.equal(evaluations, 0);
});

test("team condition enforces the configured concurrency ceiling", async () => {
  const report = await runWorkflowTrajectory({
    task,
    executor: executor("team", undefined, {
      handoffs: 2,
      maxObservedConcurrency: 2,
    }),
    feedbackProvider: feedbackProvider("neutral_repeat"),
    evaluator: evaluator(1),
    limits: { maxParallelAgents: 1 },
    trialId: "trial-concurrency",
  });
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.censorReason, "protocol_failure");
  assert.equal(report.collaboration.concurrencyLimitViolations, 1);
});

test("study executes the balanced 2x3 matrix and aggregates resource use", async () => {
  const providers = {
    neutral_repeat: feedbackProvider("neutral_repeat"),
    fixed_self_review: feedbackProvider("fixed_self_review"),
    codex_generalist: feedbackProvider("codex_generalist"),
  };
  const report = await runWorkflowStudy({
    tasks: [task],
    seed: 7,
    studyId: "study-matrix",
    feedbackProviders: providers,
    executorFactory: ({ condition }) => executor(condition.architecture),
    evaluatorForTask: () => evaluator(1),
  });
  assert.equal(report.trials.length, 6);
  assert.equal(report.aggregate.length, 6);
  assert.equal(
    report.aggregate.every(
      (item) => item.trials === 1 && item.finalPassed === 1,
    ),
    true,
  );
  assert.equal(
    new Set(report.trials.map(({ orderIndex }) => orderIndex)).size,
    WORKFLOW_STUDY_CONDITIONS.length,
  );
  assert.match(report.suiteHash, /^[a-f0-9]{64}$/u);
  assert.match(report.interpretationBoundary.join(" "), /not a human/u);
  assert.equal(report.pairedComparisons.length, 3);
  assert.equal(
    report.pairedComparisons.every(
      (comparison) => comparison.pairedTasks === 1,
    ),
    true,
  );
  assert.equal(
    report.stratifiedAggregate.some(
      (item) =>
        item.dimension === "family" &&
        item.value === "product_package" &&
        item.trials === 1,
    ),
    true,
  );
});

test("Williams condition rows balance every ordered first-order carryover", () => {
  const transitions = new Map<string, number>();
  for (let taskIndex = 0; taskIndex < 6; taskIndex += 1) {
    const order = workflowConditionOrderForTask(taskIndex, -11).map(
      workflowConditionId,
    );
    assert.equal(new Set(order).size, WORKFLOW_STUDY_CONDITIONS.length);
    for (let index = 1; index < order.length; index += 1) {
      const key = `${order[index - 1]}->${order[index]}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
  }
  assert.equal(transitions.size, 30);
  assert.equal([...transitions.values()].every((count) => count === 1), true);
});

test("study rejects a provider fingerprint change between tasks", async () => {
  const providers = {
    neutral_repeat: feedbackProvider("neutral_repeat"),
    fixed_self_review: feedbackProvider("fixed_self_review"),
    codex_generalist: feedbackProvider("codex_generalist"),
  };
  const secondTask: WorkflowPublicTask = {
    ...task,
    id: "product-easy-002",
  };
  await assert.rejects(
    runWorkflowStudy({
      tasks: [task, secondTask],
      seed: 7,
      studyId: "study-provider-drift",
      feedbackProviders: providers,
      expectedCandidateModelId: "candidate-model",
      executorFactory: ({ task: currentTask, condition }) => {
        const base = executor(condition.architecture);
        const identities = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            engineProfileId: "candidate-engine",
            role: `stage-${index + 1}`,
            reportedModelId: "candidate-model",
            reportedSystemFingerprint: `fingerprint:${currentTask.id}`,
          }));
        return {
          ...base,
          async orient() {
            const result = await base.orient({ task: currentTask });
            return {
              ...result,
              providerIdentities: identities(result.modelCalls),
            };
          },
          async execute(input) {
            const result = await base.execute(input);
            return {
              ...result,
              providerIdentities: identities(result.modelCalls),
            };
          },
        };
      },
      evaluatorForTask: () => evaluator(1),
    }),
    /WORKFLOW_PROVIDER_IDENTITY_DRIFT/u,
  );
});

test("study stops after the first configured-model identity failure", async () => {
  const providers = {
    neutral_repeat: feedbackProvider("neutral_repeat"),
    fixed_self_review: feedbackProvider("fixed_self_review"),
    codex_generalist: feedbackProvider("codex_generalist"),
  };
  let orientations = 0;
  await assert.rejects(
    runWorkflowStudy({
      tasks: [task],
      seed: 7,
      studyId: "study-provider-model-mismatch",
      feedbackProviders: providers,
      expectedCandidateModelId: "candidate-model",
      executorFactory: ({ condition }) => ({
        ...executor(condition.architecture),
        async orient() {
          orientations += 1;
          return {
            planHash: digest(`${condition.architecture}:plan`),
            approvalActor: "system:synthetic-evaluator" as const,
            simulatedApproval: true,
            latencyMs: 1,
            modelCalls: 1,
            usage,
            providerIdentities: [{
              engineProfileId: "candidate-engine",
              role: "orientation",
              reportedModelId: "wrong-model",
              reportedSystemFingerprint: "stable-fingerprint",
            }],
          };
        },
      }),
      evaluatorForTask: () => evaluator(1),
    }),
    /WORKFLOW_STUDY_PROVIDER_IDENTITY_MISMATCH/u,
  );
  assert.equal(orientations, 1);
});
