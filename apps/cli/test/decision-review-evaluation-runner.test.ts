import assert from "node:assert/strict";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  generateSealedDecisionReviewOracles,
} from "../src/decision-review-evaluation/cases.ts";
import {
  assertDecisionReviewReportPublishable,
  createDecisionReviewEvaluationPlan,
  runDecisionReviewEvaluation,
} from "../src/decision-review-evaluation/runner.ts";
import {
  createDecisionReviewResumeExecutionSegment,
  createDecisionReviewResumePlan,
  createInitialDecisionReviewCheckpoint,
  decisionReviewCompletedPrefixHash,
  decisionReviewPriorSegmentsHash,
  parseDecisionReviewCheckpoint,
} from "../src/decision-review-evaluation/resume.ts";
import { DECISION_REVIEW_CONSEQUENCES } from "../src/decision-review-evaluation/types.ts";
import {
  CODEX_EXEC_MODEL_PROTOCOL_SHA256,
  CodexProxyError,
  codexCommandAttestationFingerprint,
} from "../src/workflow-evaluation/codex-proxy.ts";

const reviewer = {
  executableSha256: "a".repeat(64),
  modelId: "codex-test-model",
  timeoutMs: 120_000,
  maxOutputBytes: 1_048_576,
  engineProfileId: "codex-cli-decision-review" as const,
};

function engine(
  generate: (request: InferenceRequest) => Promise<InferenceResult>,
): ModelEngine {
  return {
    manifest: {
      kind: "model_engine",
      profileId: "codex-cli-decision-review",
      adapter: "codex-cli-exec",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "experimental",
          constraints: {
            executableSha256: reviewer.executableSha256,
            model: reviewer.modelId,
            processPolicySha256: CODEX_EXEC_MODEL_PROTOCOL_SHA256,
            transportAttestation: "default_spawn",
          },
        },
      ],
    },
    generate,
  };
}

function result(request: InferenceRequest, text: string): InferenceResult {
  return {
    invocationId: request.invocationId,
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cost: null,
      measurementStatus: "unknown",
    },
    providerIdentity: {
      reportedModelId: reviewer.modelId,
      reportedSystemFingerprint: codexCommandAttestationFingerprint(
        reviewer.executableSha256,
        reviewer.modelId,
        "default_spawn",
      ),
    },
  };
}

test("decision-review plans bind twenty fixed calls and reviewer identity", () => {
  const first = createDecisionReviewEvaluationPlan({ reviewer });
  const second = createDecisionReviewEvaluationPlan({ reviewer: { ...reviewer } });
  assert.deepEqual(first, second);
  assert.equal(first.schedule.length, 20);
  assert.equal(first.plannedCalls, 20);
  assert.equal(first.liveReady, true);
  assert.equal(first.mayResolveHumanApproval, false);
  assert.equal(first.toolsEnabled, false);
  assert.match(first.planHash, /^[a-f0-9]{64}$/u);
  assert.equal(first.schedule[0]?.presentation, "raw");
  assert.equal(first.schedule[2]?.presentation, "decision_review");

  const changed = createDecisionReviewEvaluationPlan({
    reviewer: { ...reviewer, modelId: "other-model" },
  });
  assert.notEqual(changed.planHash, first.planHash);
});

test("known-good scripted responses account for every paired trial", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  let calls = 0;
  const scripted = engine(async (request) => {
    const scheduled = plan.schedule[calls]!;
    calls += 1;
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    return result(request, JSON.stringify(oracle.knownGood[scheduled.presentation]));
  });
  const report = await runDecisionReviewEvaluation({
    plan,
    engine: scripted,
  });
  assert.equal(calls, 20);
  assert.equal(report.trials.length, 20);
  assert.deepEqual(
    report.aggregate.map(
      ({ cases, schemaValid, protocolValid, exactDecisions, passedCases }) => ({
        cases,
        schemaValid,
        protocolValid,
        exactDecisions,
        passedCases,
      }),
    ),
    [
      {
        cases: 10,
        schemaValid: 10,
        protocolValid: 10,
        exactDecisions: 10,
        passedCases: 10,
      },
      {
        cases: 10,
        schemaValid: 10,
        protocolValid: 10,
        exactDecisions: 10,
        passedCases: 10,
      },
    ],
  );
  assert.equal(report.gates.packetStrictPass, true);
  assert.equal(report.gates.packetNoRegression, true);
  assert.equal(report.gates.qualityGain, false);
  assert.equal(report.gates.demonstratedPilotBenefit, false);
  assert.equal(report.trials.some(({ answer }) => answer?.feedbackHash.length !== 64), false);
});

test("invalid model output remains in the twenty-call denominator", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  let calls = 0;
  const invalid = engine(async (request) => {
    calls += 1;
    return result(request, "{}");
  });
  const report = await runDecisionReviewEvaluation({ plan, engine: invalid });
  assert.equal(calls, 20);
  assert.equal(report.trials.length, 20);
  assert.equal(report.aggregate.every(({ schemaValid }) => schemaValid === 0), true);
  assert.equal(report.gates.packetStrictPass, false);
  assert.equal(
    report.completedPrefixHash,
    decisionReviewCompletedPrefixHash(plan, report.trials),
  );
  assert.equal(
    report.segmentChainHeadHash,
    decisionReviewPriorSegmentsHash(report.execution.segments),
  );
  assert.match(report.reportHash, /^[a-f0-9]{64}$/u);
  const tamperedReport = structuredClone(report);
  tamperedReport.execution.processAttempts += 1;
  assert.throws(
    () => assertDecisionReviewReportPublishable(tamperedReport),
    /DECISION_REVIEW_REPORT_INTEGRITY_INVALID/u,
  );
});

test("the runner rejects any full-plan mutation before a model call", async () => {
  const original = createDecisionReviewEvaluationPlan({ reviewer });
  const tamperedPlans = [
    (() => {
      const plan = structuredClone(original);
      plan.schedule[0]!.caseId = "tampered-case";
      return plan;
    })(),
    { ...structuredClone(original), codexProtocolHash: "b".repeat(64) },
    { ...structuredClone(original), benchmarkId: "tampered-benchmark" },
    {
      ...structuredClone(original),
      thresholds: { ...original.thresholds, minimumPassedCases: 0 },
    },
  ];
  let calls = 0;
  const shouldNotRun = engine(async () => {
    calls += 1;
    throw new Error("MODEL_MUST_NOT_START");
  });
  for (const plan of tamperedPlans) {
    await assert.rejects(
      runDecisionReviewEvaluation({ plan, engine: shouldNotRun }),
      /DECISION_REVIEW_PLAN_MISMATCH/u,
    );
  }
  assert.equal(calls, 0);
});

test("reports hash free text and never publish model-injected refs", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  const privateFeedback = "PRIVATE_FEEDBACK_C:\\Users\\reviewer\\notes.txt";
  const privateRef = "c:users:private-user:private:artifact";
  let calls = 0;
  const injected = engine(async (request) => {
    const scheduled = plan.schedule[calls]!;
    calls += 1;
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    const answer = structuredClone(
      oracle.knownGood[scheduled.presentation],
    );
    answer.feedback = [privateFeedback];
    answer.findings[0]!.refs = [privateRef];
    return result(request, JSON.stringify(answer));
  });
  const report = await runDecisionReviewEvaluation({
    plan,
    engine: injected,
  });
  const serialized = JSON.stringify(report);
  assert.equal(calls, 20);
  assert.equal(serialized.includes(privateFeedback), false);
  assert.equal(serialized.includes(privateRef), false);
  assert.equal(
    report.trials.every(({ score }) => score.invalidReferenceCount === 1),
    true,
  );
  assert.equal(report.gates.packetStrictPass, false);
});

test("unattested provider identity aborts the study without echoing identity", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  const privateFingerprint = "C:\\Users\\reviewer\\provider-state.json";
  let calls = 0;
  const unattested = engine(async (request) => {
    const scheduled = plan.schedule[calls]!;
    calls += 1;
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    const generated = result(
      request,
      JSON.stringify(oracle.knownGood[scheduled.presentation]),
    );
    generated.providerIdentity = {
      reportedModelId: reviewer.modelId,
      reportedSystemFingerprint: privateFingerprint,
    };
    return generated;
  });
  await assert.rejects(
    runDecisionReviewEvaluation({ plan, engine: unattested }),
    (error: unknown) => {
      assert.equal(String(error).includes(privateFingerprint), false);
      return /DECISION_REVIEW_PROVIDER_IDENTITY_MISMATCH/u.test(String(error));
    },
  );
  assert.equal(calls, 1);
});

test("an unsettled Codex child aborts before another trial can start", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  let calls = 0;
  const unsettled = engine(async () => {
    calls += 1;
    throw new CodexProxyError(
      "CODEX_PROXY_TERMINATION_UNSETTLED",
      "the bounded child did not settle",
    );
  });
  await assert.rejects(
    runDecisionReviewEvaluation({ plan, engine: unsettled }),
    /CODEX_PROXY_TERMINATION_UNSETTLED/u,
  );
  assert.equal(calls, 1);
});

test("an incompatible Codex CLI is fatal instead of consuming twenty calls", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  let calls = 0;
  const incompatible = engine(async () => {
    calls += 1;
    throw new CodexProxyError(
      "CODEX_PROXY_UNSUPPORTED_FLAGS",
      "required isolation flags are unavailable",
    );
  });
  await assert.rejects(
    runDecisionReviewEvaluation({ plan, engine: incompatible }),
    /CODEX_PROXY_UNSUPPORTED_FLAGS/u,
  );
  assert.equal(calls, 1);
});

test("an abort after invocation start remains unknown and is never made resumable", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const started: number[] = [];
  const pauses: number[] = [];
  let calls = 0;
  const aborted = engine(async () => {
    calls += 1;
    throw new CodexProxyError(
      "CODEX_PROXY_ABORTED",
      "the local child settled but remote execution is unknown",
    );
  });
  await assert.rejects(
    runDecisionReviewEvaluation({
      plan,
      engine: aborted,
      onInvocationStart(record) {
        started.push(record.sequence);
      },
      onInvocationPause(pause) {
        pauses.push(pause.sequence);
      },
    }),
    /CODEX_PROXY_ABORTED/u,
  );
  assert.deepEqual(started, [1]);
  assert.deepEqual(pauses, []);
  assert.equal(calls, 1);
});

test("a typed account pause preserves the scored prefix and starts no later call", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  const completed: Array<Awaited<ReturnType<typeof runDecisionReviewEvaluation>>["trials"][number]> = [];
  const started: number[] = [];
  const pauses: Array<{ sequence: number; reasonCode: string }> = [];
  let calls = 0;
  const capacityBound = engine(async (request) => {
    const scheduled = plan.schedule[calls]!;
    calls += 1;
    if (scheduled.sequence === 4) {
      throw new CodexProxyError(
        "CODEX_PROXY_USAGE_LIMIT_REACHED",
        "safe fixed diagnostic",
      );
    }
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    return result(request, JSON.stringify(oracle.knownGood[scheduled.presentation]));
  });

  await assert.rejects(
    runDecisionReviewEvaluation({
      plan,
      engine: capacityBound,
      onInvocationStart(record) {
        started.push(record.sequence);
      },
      onInvocationPause(pause) {
        pauses.push(pause);
      },
      onTrial(trial) {
        completed.push(trial);
      },
    }),
    /DECISION_REVIEW_PAUSED: usage_limit_reached/u,
  );
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(
    completed.map(({ sequence }) => sequence),
    [1, 2, 3],
  );
  assert.deepEqual(pauses, [
    { sequence: 4, reasonCode: "usage_limit_reached", segmentIndex: 0 },
  ]);
  assert.equal(calls, 4);
});

test("a resumed run executes only the immutable suffix and discloses context confounding", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  const prefix: Array<Awaited<ReturnType<typeof runDecisionReviewEvaluation>>["trials"][number]> = [];
  let firstCalls = 0;
  const firstEngine = engine(async (request) => {
    const scheduled = plan.schedule[firstCalls]!;
    firstCalls += 1;
    if (scheduled.sequence === 4) {
      throw new CodexProxyError(
        "CODEX_PROXY_AUTHENTICATION_REQUIRED",
        "safe fixed diagnostic",
      );
    }
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    return result(request, JSON.stringify(oracle.knownGood[scheduled.presentation]));
  });
  await assert.rejects(
    runDecisionReviewEvaluation({
      plan,
      engine: firstEngine,
      onTrial(trial) {
        prefix.push(trial);
      },
    }),
    /DECISION_REVIEW_PAUSED/u,
  );

  const paused = createInitialDecisionReviewCheckpoint(plan, plan.planHash);
  paused.status = "paused";
  paused.completedTrials = structuredClone(prefix);
  paused.completedPrefixHash = decisionReviewCompletedPrefixHash(plan, prefix);
  paused.processAttempts = 4;
  paused.nonScoringPauses = [
    {
      sequence: 4,
      reasonCode: "authentication_required",
      segmentIndex: 0,
    },
  ];
  paused.segments[0]!.completedThroughSequence = 3;
  paused.pause = {
    sequence: 4,
    reasonCode: "authentication_required",
  };
  const validatedPause = parseDecisionReviewCheckpoint(paused);
  const resumePlan = createDecisionReviewResumePlan(
    validatedPause,
    "changed",
  );
  const resumedSegment = createDecisionReviewResumeExecutionSegment(resumePlan);
  const resumedSegmentId = resumedSegment.segmentIdHash;
  const resumedSequences: number[] = [];
  const resumedEngine = engine(async (request) => {
    const sequence = Number(request.invocationId.split(":").at(-1));
    resumedSequences.push(sequence);
    const scheduled = plan.schedule[sequence - 1]!;
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    return result(request, JSON.stringify(oracle.knownGood[scheduled.presentation]));
  });
  const report = await runDecisionReviewEvaluation({
    plan,
    engine: resumedEngine,
    priorTrials: prefix,
    segment: { index: 1, segmentIdHash: resumedSegmentId },
    execution: {
      processAttemptsBeforeRun: 4,
      nonScoringPauses: [
        {
          sequence: 4,
          reasonCode: "authentication_required",
          segmentIndex: 0,
        },
      ],
      segments: [
        structuredClone(validatedPause.segments[0]!),
        resumedSegment,
      ],
    },
  });

  assert.deepEqual(resumedSequences, Array.from({ length: 17 }, (_, i) => i + 4));
  assert.equal(report.trials.length, 20);
  assert.equal(report.execution.processAttempts, 21);
  assert.equal(report.execution.resumeCount, 1);
  assert.equal(report.execution.comparability, "multi_declared_unverified");
  assert.equal(report.execution.contextConfounded, true);
  assert.equal(report.gates.demonstratedPilotBenefit, false);
});

test("compression cannot hide worse consequence or case-pass quality", async () => {
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const oracles = generateSealedDecisionReviewOracles();
  let calls = 0;
  const degradedPacket = engine(async (request) => {
    const scheduled = plan.schedule[calls]!;
    calls += 1;
    const oracle = oracles.find(({ caseId }) => caseId === scheduled.caseId)!;
    const answer = structuredClone(
      oracle.knownGood[scheduled.presentation],
    );
    if (scheduled.presentation === "decision_review") {
      answer.consequence = DECISION_REVIEW_CONSEQUENCES.find(
        (consequence) => consequence !== oracle.expectedConsequence,
      )!;
    }
    return result(request, JSON.stringify(answer));
  });
  const report = await runDecisionReviewEvaluation({
    plan,
    engine: degradedPacket,
  });
  const packet = report.aggregate.find(
    ({ presentation }) => presentation === "decision_review",
  )!;
  assert.equal(packet.exactConsequences, 0);
  assert.equal(packet.passedCases, 0);
  assert.equal(report.gates.packetStrictPass, false);
  assert.equal(report.gates.packetNoRegression, false);
  assert.equal(report.gates.compressionGain, false);
  assert.equal(report.gates.demonstratedPilotBenefit, false);
});
