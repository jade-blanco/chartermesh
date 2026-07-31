import { createHash, randomUUID } from "node:crypto";
import type {
  InferenceResult,
  ModelEngine,
  ModelUsage,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  BuiltInManagedRunner,
  DelegationController,
} from "../../../packages/runtime/src/index.ts";

interface CollaborationFixture {
  id: string;
  objective: string;
  context: string;
  acceptanceCriteria: string[];
  requiredConcepts: string[];
  forbiddenClaims: string[];
}

export interface CollaborationConditionResult {
  condition: "single" | "delegated";
  score: number;
  passed: boolean;
  missingConcepts: string[];
  forbiddenClaims: string[];
  latencyMs: number;
  stages: number;
  usage: ModelUsage;
  usageComplete: boolean;
  output: string;
}

export interface CollaborationTrial {
  id: string;
  fixtureId: string;
  repetition: number;
  order: ["single", "delegated"] | ["delegated", "single"];
  single: CollaborationConditionResult;
  delegated: CollaborationConditionResult;
  scoreDelta: number;
}

export interface CollaborationEvaluationReport {
  apiVersion: "chartermesh.dev/collaboration-evaluation/v1alpha1";
  evaluationId: string;
  engineId: string;
  suiteId: "small-model-company-work-v1";
  suiteHash: string;
  startedAt: string;
  finishedAt: string;
  repetitions: number;
  generationBudget: {
    mode: "generation-budget-ceiling-matched";
    maxOutputTokensPerSingleCall: number;
    maxOutputTokensPerDelegatedCall: number;
    maxCallsWithRepair: { single: number; delegated: number };
    maxGeneratedTokensRequested: { single: number; delegated: number };
    note: string;
  };
  aggregate: {
    singleMeanScore: number;
    delegatedMeanScore: number;
    meanScoreDelta: number;
    singlePassRate: number;
    delegatedPassRate: number;
    delegatedBetter: boolean;
    observedTokens: {
      single: number | null;
      delegated: number | null;
      delegatedToSingleRatio: number | null;
    };
  };
  trials: CollaborationTrial[];
}

const fixtures: CollaborationFixture[] = [
  {
    id: "repair-relay-company-bootstrap",
    objective:
      "Create the initial service organization and MVP implementation blueprint for RepairRelay, a local-first repair-shop intake and status tracker.",
    context: [
      "Use Node.js 24, TypeScript, and SQLite.",
      "The organization must name planner, implementer, and verifier responsibilities.",
      "The workflow must cover intake, plan, implement, verify, and human approval.",
      "The MVP must describe a work-order schema, API boundary, deterministic tests, audit trail, and rollback.",
      "No cloud deployment, payment processing, or external action is allowed.",
    ].join("\n"),
    acceptanceCriteria: [
      "Produce a coherent organization and implementation blueprint.",
      "Keep every claim inside the supplied evidence boundary.",
    ],
    requiredConcepts: [
      "RepairRelay",
      "Node.js 24",
      "TypeScript",
      "SQLite",
      "planner",
      "implementer",
      "verifier",
      "human approval",
      "work-order",
      "API",
      "test",
      "audit",
      "rollback",
    ],
    forbiddenClaims: ["deployed successfully", "tests passed"],
  },
  {
    id: "concurrent-claim-hardening",
    objective:
      "Design a bounded implementation change that prevents two local workers from claiming the same repair work order.",
    context: [
      "SQLite is the only state store.",
      "Use an atomic transaction, a lease generation fence, idempotency, and a recovery path.",
      "Include exact test scenarios for concurrent claim, duplicate command, expired lease, and cancellation.",
      "No code or tests have actually been run.",
    ].join("\n"),
    acceptanceCriteria: [
      "Explain the state transition and failure behavior.",
      "Do not state that implementation or tests already occurred.",
    ],
    requiredConcepts: [
      "SQLite",
      "transaction",
      "lease",
      "generation",
      "idempot",
      "concurrent",
      "duplicate",
      "expired",
      "cancel",
      "recovery",
    ],
    forbiddenClaims: ["implemented successfully", "tests passed"],
  },
  {
    id: "human-review-release-gate",
    objective:
      "Prepare a human-readable release gate for the synthetic RepairRelay MVP.",
    context: [
      "The reviewer must see scope, evidence, unresolved risks, rollback, and the exact decision requested.",
      "Automated agents may recommend but may not approve or deploy.",
      "There is no current test, build, security, or deployment evidence.",
    ].join("\n"),
    acceptanceCriteria: [
      "Make the human decision and missing evidence obvious.",
      "Do not convert planned checks into performed checks.",
    ],
    requiredConcepts: [
      "scope",
      "evidence",
      "risk",
      "rollback",
      "human",
      "approve",
      "test",
      "security",
      "deployment",
    ],
    forbiddenClaims: ["approved for release", "all checks passed"],
  },
];

function addNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function aggregateUsage(results: InferenceResult[]): ModelUsage {
  const statuses = results.map(({ usage }) => usage.measurementStatus);
  return {
    inputTokens: addNullable(
      results.map(({ usage }) => usage.inputTokens),
    ),
    outputTokens: addNullable(
      results.map(({ usage }) => usage.outputTokens),
    ),
    cacheReadTokens: addNullable(
      results.map(({ usage }) => usage.cacheReadTokens),
    ),
    cacheWriteTokens: addNullable(
      results.map(({ usage }) => usage.cacheWriteTokens),
    ),
    cost: addNullable(results.map(({ usage }) => usage.cost)),
    measurementStatus: statuses.every((status) => status === "measured")
      ? "measured"
      : statuses.every((status) => status !== "unknown")
        ? "estimated"
        : "unknown",
  };
}

function score(
  condition: CollaborationConditionResult["condition"],
  fixture: CollaborationFixture,
  output: string,
  latencyMs: number,
  stages: number,
  usage: ModelUsage,
): CollaborationConditionResult {
  const normalized = output.toLowerCase();
  const missingConcepts = fixture.requiredConcepts.filter(
    (concept) => !normalized.includes(concept.toLowerCase()),
  );
  const forbiddenClaims = fixture.forbiddenClaims.filter((claim) =>
    normalized.includes(claim.toLowerCase()),
  );
  const coverage =
    (fixture.requiredConcepts.length - missingConcepts.length) /
    fixture.requiredConcepts.length;
  const finalScore = Math.max(
    0,
    Math.min(1, coverage - forbiddenClaims.length * 0.25),
  );
  const usageComplete =
    usage.inputTokens !== null && usage.outputTokens !== null;
  return {
    condition,
    score: Number(finalScore.toFixed(4)),
    passed: missingConcepts.length === 0 && forbiddenClaims.length === 0,
    missingConcepts,
    forbiddenClaims,
    latencyMs,
    stages,
    usage,
    usageComplete,
    output,
  };
}

async function runSingle(
  engine: ModelEngine,
  fixture: CollaborationFixture,
  trialId: string,
): Promise<CollaborationConditionResult> {
  const startedAt = performance.now();
  const runner = new BuiltInManagedRunner({ maxOutputTokens: 4_096 });
  const handle = await runner.start(
    {
      taskPacket: fixture,
      organizationRevision: 1,
      workItemId: `evaluation-${fixture.id}`,
      runId: trialId,
      attemptId: `${trialId}:single`,
      generation: 1,
    },
    { engine },
  );
  const result = await runner.result(handle.hostRunId);
  return score(
    "single",
    fixture,
    result.inference.text,
    Math.round(performance.now() - startedAt),
    1,
    result.inference.usage,
  );
}

async function runDelegated(
  engine: ModelEngine,
  fixture: CollaborationFixture,
  trialId: string,
): Promise<CollaborationConditionResult> {
  const startedAt = performance.now();
  const result = await new DelegationController(1_024).run(
    {
      taskPacket: fixture,
      organizationRevision: 1,
      workItemId: `evaluation-${fixture.id}`,
      runId: trialId,
      attemptId: `${trialId}:delegated`,
      generation: 1,
    },
    { engine },
  );
  return score(
    "delegated",
    fixture,
    result.inference.text,
    Math.round(performance.now() - startedAt),
    result.stages.length,
    aggregateUsage(result.stages.map(({ inference }) => inference)),
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function evaluateCollaboration(
  engine: ModelEngine,
  options: { repetitions?: number } = {},
): Promise<CollaborationEvaluationReport> {
  const repetitions = options.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("repetitions must be an integer from 1 to 10.");
  }
  const evaluationId = `collaboration-evaluation-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const trials: CollaborationTrial[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const trialId = `${evaluationId}:${fixture.id}:${repetition}`;
      const delegatedFirst = (fixtureIndex + repetition) % 2 === 0;
      let single: CollaborationConditionResult;
      let delegated: CollaborationConditionResult;
      if (delegatedFirst) {
        delegated = await runDelegated(engine, fixture, trialId);
        single = await runSingle(engine, fixture, trialId);
      } else {
        single = await runSingle(engine, fixture, trialId);
        delegated = await runDelegated(engine, fixture, trialId);
      }
      trials.push({
        id: trialId,
        fixtureId: fixture.id,
        repetition,
        order: delegatedFirst
          ? ["delegated", "single"]
          : ["single", "delegated"],
        single,
        delegated,
        scoreDelta: Number(
          (delegated.score - single.score).toFixed(4),
        ),
      });
    }
  }
  const singleScores = trials.map(({ single }) => single.score);
  const delegatedScores = trials.map(({ delegated }) => delegated.score);
  const singleMeanScore = mean(singleScores);
  const delegatedMeanScore = mean(delegatedScores);
  const conditionTokens = (
    condition: "single" | "delegated",
  ): number | null => {
    const values = trials.map(({ [condition]: result }) =>
      result.usage.inputTokens === null ||
      result.usage.outputTokens === null
        ? null
        : result.usage.inputTokens + result.usage.outputTokens,
    );
    return addNullable(values);
  };
  const singleTokens = conditionTokens("single");
  const delegatedTokens = conditionTokens("delegated");
  return {
    apiVersion: "chartermesh.dev/collaboration-evaluation/v1alpha1",
    evaluationId,
    engineId: engine.manifest.profileId,
    suiteId: "small-model-company-work-v1",
    suiteHash: createHash("sha256")
      .update(JSON.stringify(fixtures))
      .digest("hex"),
    startedAt,
    finishedAt: new Date().toISOString(),
    repetitions,
    generationBudget: {
      mode: "generation-budget-ceiling-matched",
      maxOutputTokensPerSingleCall: 4_096,
      maxOutputTokensPerDelegatedCall: 1_024,
      maxCallsWithRepair: { single: 2, delegated: 8 },
      maxGeneratedTokensRequested: {
        single: 8_192,
        delegated: 8_192,
      },
      note:
        "This matches the maximum requested output-token ceiling, not total input plus output tokens. Observed usage is reported separately.",
    },
    aggregate: {
      singleMeanScore: Number(singleMeanScore.toFixed(4)),
      delegatedMeanScore: Number(delegatedMeanScore.toFixed(4)),
      meanScoreDelta: Number(
        (delegatedMeanScore - singleMeanScore).toFixed(4),
      ),
      singlePassRate: Number(
        (
          trials.filter(({ single }) => single.passed).length /
          trials.length
        ).toFixed(4),
      ),
      delegatedPassRate: Number(
        (
          trials.filter(({ delegated }) => delegated.passed).length /
          trials.length
        ).toFixed(4),
      ),
      delegatedBetter: delegatedMeanScore > singleMeanScore,
      observedTokens: {
        single: singleTokens,
        delegated: delegatedTokens,
        delegatedToSingleRatio:
          singleTokens === null ||
          delegatedTokens === null ||
          singleTokens === 0
            ? null
            : Number((delegatedTokens / singleTokens).toFixed(4)),
      },
    },
    trials,
  };
}
