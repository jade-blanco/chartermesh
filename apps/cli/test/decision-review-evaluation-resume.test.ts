import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecisionReviewEvaluationPlan,
  type DecisionReviewBenchmarkPlan,
  type DecisionReviewTrialReport,
} from "../src/decision-review-evaluation/runner.ts";
import {
  DECISION_REVIEW_CHECKPOINT_API_VERSION,
  DECISION_REVIEW_RESUME_PLAN_API_VERSION,
  assertDecisionReviewResumePlan,
  assertDecisionReviewTrialPrefix,
  createDecisionReviewActiveInvocation,
  createDecisionReviewResumeExecutionSegment,
  createDecisionReviewResumePlan,
  createInitialDecisionReviewCheckpoint,
  decisionReviewCheckpointHash,
  decisionReviewCompletedPrefixHash,
  parseDecisionReviewCheckpoint,
  type DecisionReviewCheckpoint,
  type DecisionReviewPauseReasonCode,
  type DecisionReviewResumePlan,
} from "../src/decision-review-evaluation/resume.ts";

const reviewer = {
  executableSha256: "a".repeat(64),
  modelId: "codex-test-model",
  timeoutMs: 120_000,
  maxOutputBytes: 1_048_576,
  engineProfileId: "codex-cli-decision-review" as const,
};

function plan(): DecisionReviewBenchmarkPlan {
  return createDecisionReviewEvaluationPlan({ reviewer });
}

function trialFor(
  benchmarkPlan: DecisionReviewBenchmarkPlan,
  index: number,
  segmentIndex = 0,
  segmentIdHash = "0".repeat(64),
): DecisionReviewTrialReport {
  const scheduled = benchmarkPlan.schedule[index]!;
  return {
    sequence: scheduled.sequence,
    segmentIndex,
    segmentIdHash,
    caseId: scheduled.caseId,
    presentation: scheduled.presentation,
    publicCaseHash: scheduled.publicCaseHash,
    viewHash: scheduled.viewHash,
    visibleBytes: 100 + index,
    promptBytes: 200 + index,
    responseBytes: null,
    elapsedMs: 10 + index,
    schemaValid: false,
    protocolValid: false,
    unauthorizedToolCalls: 0,
    finishReason: "error",
    answer: null,
    score: {
      valid: false,
      passed: false,
      score: 0,
      maximumScore: 10,
      decisionExact: false,
      consequenceExact: false,
      matchedFindingCodes: [],
      boundFindingCodes: [],
      criticalErrors: [],
      invalidReferenceCount: 0,
      invalidReferenceHash: null,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cost: null,
      measurementStatus: "unknown",
    },
    providerIdentity: null,
    failure: {
      code: "SCRIPTED_FAILURE",
      messageHash: "b".repeat(64),
    },
  };
}

function withCompletedPrefix(
  checkpoint: DecisionReviewCheckpoint,
  count: number,
): DecisionReviewCheckpoint {
  const next = structuredClone(checkpoint);
  next.completedTrials = Array.from({ length: count }, (_, index) =>
    trialFor(
      next.plan,
      index,
      next.segments.at(-1)!.index,
      next.segments.at(-1)!.segmentIdHash,
    ),
  );
  next.completedPrefixHash = decisionReviewCompletedPrefixHash(
    next.plan,
    next.completedTrials,
  );
  next.segments.at(-1)!.completedThroughSequence = count;
  next.processAttempts = count;
  return parseDecisionReviewCheckpoint(next);
}

function pausedCheckpoint(
  count = 4,
  reasonCode: DecisionReviewPauseReasonCode = "usage_limit_reached",
): DecisionReviewCheckpoint {
  const benchmarkPlan = plan();
  const next = withCompletedPrefix(
    createInitialDecisionReviewCheckpoint(
      benchmarkPlan,
      benchmarkPlan.planHash,
    ),
    count,
  );
  next.status = "paused";
  next.pause = { reasonCode, sequence: count + 1 };
  next.nonScoringPauses = [
    { reasonCode, sequence: count + 1, segmentIndex: 0 },
  ];
  next.processAttempts += reasonCode === "operator_requested" ? 0 : 1;
  return parseDecisionReviewCheckpoint(next);
}

test("initial checkpoints bind the approved plan and an empty prefix", () => {
  const benchmarkPlan = plan();
  const first = createInitialDecisionReviewCheckpoint(
    benchmarkPlan,
    benchmarkPlan.planHash,
  );
  const second = createInitialDecisionReviewCheckpoint(
    structuredClone(benchmarkPlan),
    benchmarkPlan.planHash,
  );

  assert.deepEqual(first, second);
  assert.equal(first.apiVersion, DECISION_REVIEW_CHECKPOINT_API_VERSION);
  assert.equal(first.processAttempts, 0);
  assert.equal(first.resumeGeneration, 0);
  assert.deepEqual(first.nonScoringPauses, []);
  assert.equal(first.segments[0]?.accountContext, "initial");
  assert.equal(first.segments[0]?.completedThroughSequence, 0);
  assert.equal(first.segments[0]?.sourceCheckpointHash, null);
  assert.equal(first.segments[0]?.resumePlanHash, null);
  assert.equal(
    first.completedPrefixHash,
    decisionReviewCompletedPrefixHash(benchmarkPlan, []),
  );
  assert.match(decisionReviewCheckpointHash(first), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => createInitialDecisionReviewCheckpoint(benchmarkPlan, "c".repeat(64)),
    /initial authorization must equal/u,
  );
});

test("trial prefixes reject tampering, reordering, and duplication", () => {
  const benchmarkPlan = plan();
  const trials = [
    trialFor(benchmarkPlan, 0, 0, "0".repeat(64)),
    trialFor(benchmarkPlan, 1, 0, "0".repeat(64)),
    trialFor(benchmarkPlan, 2, 0, "0".repeat(64)),
  ];
  assert.doesNotThrow(() =>
    assertDecisionReviewTrialPrefix(benchmarkPlan, trials),
  );

  const tampered = structuredClone(trials);
  tampered[1]!.caseId = "tampered-case";
  assert.throws(
    () => assertDecisionReviewTrialPrefix(benchmarkPlan, tampered),
    /DECISION_REVIEW_TRIAL_PREFIX_INVALID/u,
  );
  assert.throws(
    () =>
      assertDecisionReviewTrialPrefix(benchmarkPlan, [
        trials[1]!,
        trials[0]!,
        trials[2]!,
      ]),
    /DECISION_REVIEW_TRIAL_PREFIX_INVALID/u,
  );
  assert.throws(
    () =>
      assertDecisionReviewTrialPrefix(benchmarkPlan, [
        trials[0]!,
        trials[0]!,
        trials[1]!,
      ]),
    /DECISION_REVIEW_TRIAL_PREFIX_INVALID/u,
  );

  const checkpoint = withCompletedPrefix(
    createInitialDecisionReviewCheckpoint(
      benchmarkPlan,
      benchmarkPlan.planHash,
    ),
    3,
  );
  const corrupted = structuredClone(checkpoint);
  corrupted.completedTrials[0]!.elapsedMs += 1;
  assert.throws(
    () => parseDecisionReviewCheckpoint(corrupted),
    /completed prefix hash is invalid/u,
  );
});

test("an active invocation is exact, durable, and never resumable", () => {
  const benchmarkPlan = plan();
  const running = withCompletedPrefix(
    createInitialDecisionReviewCheckpoint(
      benchmarkPlan,
      benchmarkPlan.planHash,
    ),
    2,
  );
  const active = createDecisionReviewActiveInvocation(running);
  running.activeInvocation = active;
  running.processAttempts += 1;
  assert.equal(active.sequence, 3);
  assert.doesNotThrow(() => parseDecisionReviewCheckpoint(running));
  assert.throws(
    () => createDecisionReviewResumePlan(running, "changed"),
    /DECISION_REVIEW_CHECKPOINT_NOT_RESUMABLE/u,
  );

  const wrongSequence = structuredClone(running);
  wrongSequence.activeInvocation!.sequence = 4;
  assert.throws(
    () => parseDecisionReviewCheckpoint(wrongSequence),
    /active invocation is not the exact next call/u,
  );

  const falselyPaused = structuredClone(running);
  falselyPaused.status = "paused";
  falselyPaused.pause = {
    reasonCode: "operator_requested",
    sequence: 3,
  };
  falselyPaused.nonScoringPauses = [
    { reasonCode: "operator_requested", sequence: 3, segmentIndex: 0 },
  ];
  assert.throws(
    () => parseDecisionReviewCheckpoint(falselyPaused),
    /checkpoint status fields are inconsistent/u,
  );

  const impossibleOvercount = structuredClone(
    withCompletedPrefix(
      createInitialDecisionReviewCheckpoint(
        benchmarkPlan,
        benchmarkPlan.planHash,
      ),
      2,
    ),
  );
  impossibleOvercount.processAttempts += 1;
  assert.throws(
    () => parseDecisionReviewCheckpoint(impossibleOvercount),
    /process attempt accounting is not exact/u,
  );
});

test("resume plans deterministically bind the exact pause and declaration", () => {
  const checkpoint = pausedCheckpoint();
  const sameFirst = createDecisionReviewResumePlan(checkpoint, "same");
  const sameSecond = createDecisionReviewResumePlan(
    structuredClone(checkpoint),
    "same",
  );
  const changed = createDecisionReviewResumePlan(checkpoint, "changed");
  const unknown = createDecisionReviewResumePlan(checkpoint, "unknown");

  assert.deepEqual(sameFirst, sameSecond);
  assert.equal(sameFirst.apiVersion, DECISION_REVIEW_RESUME_PLAN_API_VERSION);
  assert.equal(sameFirst.completedCount, 4);
  assert.equal(sameFirst.nextSequence, 5);
  assert.equal(sameFirst.remainingCount, 16);
  assert.equal(sameFirst.remainingSchedule[0]?.sequence, 5);
  assert.equal(sameFirst.resumeGeneration, 1);
  assert.equal(sameFirst.nextProcessAttempt, 6);
  assert.equal(sameFirst.nonScoringPauses.length, 1);
  assert.equal(sameFirst.sourceCheckpointHash, decisionReviewCheckpointHash(checkpoint));
  assert.notEqual(sameFirst.resumePlanHash, changed.resumePlanHash);
  assert.notEqual(
    sameFirst.newSegment.segmentIdHash,
    changed.newSegment.segmentIdHash,
  );
  assert.notEqual(changed.resumePlanHash, unknown.resumePlanHash);
  assert.doesNotThrow(() =>
    assertDecisionReviewResumePlan(sameFirst, checkpoint),
  );

  const tampered = structuredClone(sameFirst);
  tampered.remainingSchedule[0]!.caseId = "tampered-case";
  assert.throws(
    () => assertDecisionReviewResumePlan(tampered, checkpoint),
    /DECISION_REVIEW_RESUME_PLAN_INVALID/u,
  );

  const changedPause = structuredClone(checkpoint);
  changedPause.pause!.reasonCode = "rate_limited";
  changedPause.nonScoringPauses[0]!.reasonCode = "rate_limited";
  const reparsed = parseDecisionReviewCheckpoint(changedPause);
  assert.notEqual(
    createDecisionReviewResumePlan(reparsed, "same").resumePlanHash,
    sameFirst.resumePlanHash,
  );
});

test("resume generations preserve segment boundaries without account PII", () => {
  const paused = pausedCheckpoint(5);
  const resume = createDecisionReviewResumePlan(paused, "changed");
  const running = structuredClone(paused);
  running.status = "running";
  running.pause = null;
  running.resumeGeneration = resume.resumeGeneration;
  running.processAttempts = paused.processAttempts;
  running.segments.push(createDecisionReviewResumeExecutionSegment(resume));
  const parsed = parseDecisionReviewCheckpoint(running);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0]?.completedThroughSequence, 5);
  assert.equal(parsed.segments[1]?.firstSequence, 6);
  assert.equal(parsed.segments[1]?.completedThroughSequence, 5);
  assert.deepEqual(
    Object.keys(parsed.segments[1]!).sort(),
    [
      "accountContext",
      "authorizationHash",
      "completedThroughSequence",
      "firstSequence",
      "index",
      "priorSegmentsHash",
      "resumePlanHash",
      "segmentIdHash",
      "sourceCheckpointHash",
      "sourceProcessAttempts",
    ].sort(),
  );

  const secondPause = structuredClone(parsed);
  secondPause.status = "paused";
  secondPause.pause = { reasonCode: "rate_limited", sequence: 6 };
  secondPause.nonScoringPauses.push({
    reasonCode: "rate_limited",
    sequence: 6,
    segmentIndex: 1,
  });
  secondPause.processAttempts += 1;
  const secondResume = createDecisionReviewResumePlan(
    parseDecisionReviewCheckpoint(secondPause),
    "same",
  );
  assert.equal(secondResume.resumeGeneration, 2);
  assert.equal(secondResume.newSegment.firstSequence, 6);
});

test("resumed segment lineage binds the exact checkpoint, chain, and approval", () => {
  const paused = pausedCheckpoint(5);
  const resume = createDecisionReviewResumePlan(paused, "changed");
  const running = structuredClone(paused);
  running.status = "running";
  running.pause = null;
  running.resumeGeneration = resume.resumeGeneration;
  running.segments.push(createDecisionReviewResumeExecutionSegment(resume));
  const valid = parseDecisionReviewCheckpoint(running);
  const segment = valid.segments[1]!;
  assert.equal(segment.sourceCheckpointHash, resume.sourceCheckpointHash);
  assert.equal(segment.priorSegmentsHash, resume.priorSegmentsHash);
  assert.equal(segment.resumePlanHash, resume.resumePlanHash);
  assert.equal(segment.authorizationHash, resume.resumePlanHash);

  for (const field of [
    "sourceCheckpointHash",
    "priorSegmentsHash",
    "resumePlanHash",
    "authorizationHash",
  ] as const) {
    const tampered = structuredClone(valid);
    tampered.segments[1]![field] = "e".repeat(64);
    assert.throws(
      () => parseDecisionReviewCheckpoint(tampered),
      /DECISION_REVIEW_CHECKPOINT_INVALID/u,
    );
  }
  const attemptsTampered = structuredClone(valid);
  attemptsTampered.segments[1]!.sourceProcessAttempts! += 1;
  assert.throws(
    () => parseDecisionReviewCheckpoint(attemptsTampered),
    /DECISION_REVIEW_CHECKPOINT_INVALID/u,
  );

  const predecessorTampered = structuredClone(valid);
  predecessorTampered.completedTrials[0]!.elapsedMs += 1;
  predecessorTampered.completedPrefixHash = decisionReviewCompletedPrefixHash(
    predecessorTampered.plan,
    predecessorTampered.completedTrials,
  );
  assert.throws(
    () => parseDecisionReviewCheckpoint(predecessorTampered),
    /source checkpoint hash is invalid/u,
  );
});

test("resumed lineage counts provider pauses as attempts but excludes pre-call operator pauses", () => {
  const quotaPaused = pausedCheckpoint(5, "usage_limit_reached");
  assert.equal(quotaPaused.processAttempts, 6);

  const undercountedSource = structuredClone(quotaPaused);
  undercountedSource.processAttempts = 5;
  assert.throws(
    () => parseDecisionReviewCheckpoint(undercountedSource),
    /process attempt accounting is not exact/u,
  );

  const operatorPaused = pausedCheckpoint(5, "operator_requested");
  assert.equal(operatorPaused.processAttempts, 5);
  const operatorPlan = createDecisionReviewResumePlan(operatorPaused, "same");
  const operatorRun = structuredClone(operatorPaused);
  operatorRun.status = "running";
  operatorRun.pause = null;
  operatorRun.resumeGeneration = operatorPlan.resumeGeneration;
  operatorRun.segments.push(
    createDecisionReviewResumeExecutionSegment(operatorPlan),
  );
  assert.doesNotThrow(() => parseDecisionReviewCheckpoint(operatorRun));
});

test("complete and unknown-outcome checkpoints fail closed while settled operator pauses resume", () => {
  const benchmarkPlan = plan();
  const complete = withCompletedPrefix(
    createInitialDecisionReviewCheckpoint(
      benchmarkPlan,
      benchmarkPlan.planHash,
    ),
    20,
  );
  assert.throws(
    () => createDecisionReviewResumePlan(complete, "same"),
    /DECISION_REVIEW_CHECKPOINT_NOT_RESUMABLE/u,
  );
  assert.doesNotThrow(() =>
    createDecisionReviewResumePlan(
      pausedCheckpoint(4, "operator_requested"),
      "same",
    ),
  );

  const failed = structuredClone(withCompletedPrefix(
    createInitialDecisionReviewCheckpoint(
      benchmarkPlan,
      benchmarkPlan.planHash,
    ),
    1,
  ));
  failed.status = "failed";
  failed.failure = { reasonCode: "UNKNOWN_OUTCOME", sequence: 2 };
  assert.doesNotThrow(() => parseDecisionReviewCheckpoint(failed));
  assert.throws(
    () => createDecisionReviewResumePlan(failed, "changed"),
    /DECISION_REVIEW_CHECKPOINT_NOT_RESUMABLE/u,
  );
});

test("checkpoint and resume parsers reject extra keys and stale approvals", () => {
  const checkpoint = pausedCheckpoint();
  const extraCheckpoint = {
    ...checkpoint,
    accountEmail: "must-not-be-recorded@example.invalid",
  };
  assert.throws(
    () => parseDecisionReviewCheckpoint(extraCheckpoint),
    /checkpoint contract is invalid/u,
  );

  const resume = createDecisionReviewResumePlan(checkpoint, "same");
  const stale = structuredClone(resume) as DecisionReviewResumePlan;
  stale.resumePlanHash = "f".repeat(64);
  assert.throws(
    () => assertDecisionReviewResumePlan(stale, checkpoint),
    /DECISION_REVIEW_RESUME_PLAN_INVALID/u,
  );
});
