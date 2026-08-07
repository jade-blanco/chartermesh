import {
  canonicalDecisionReviewHash,
  canonicalDecisionReviewJson,
  type DecisionReviewPresentation,
} from "./types.ts";
import type {
  DecisionReviewBenchmarkPlan,
  DecisionReviewScheduledCall,
  DecisionReviewTrialReport,
} from "./runner.ts";

export const DECISION_REVIEW_CHECKPOINT_API_VERSION =
  "chartermesh.dev/decision-review-checkpoint/v1alpha2" as const;
export const DECISION_REVIEW_RESUME_PLAN_API_VERSION =
  "chartermesh.dev/decision-review-resume-plan/v1alpha1" as const;
export const DECISION_REVIEW_RESUME_POLICY_VERSION =
  "decision-review-no-replay-resume-v1" as const;
export const DECISION_REVIEW_PREFIX_CHAIN_VERSION =
  "decision-review-prefix-sha256-chain-v1" as const;
export const DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY =
  "operator-declared-account-context-hash-only-v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const PLAN_KEYS = [
  "apiVersion",
  "harnessVersion",
  "harnessSourceHash",
  "suiteId",
  "benchmarkId",
  "purpose",
  "claimBoundary",
  "publicSuiteHash",
  "oracleCommitmentHash",
  "rendererVersion",
  "rendererHash",
  "promptHash",
  "responseSchemaHash",
  "codexProtocolHash",
  "orderingPolicy",
  "resumePolicyVersion",
  "cases",
  "schedule",
  "plannedCalls",
  "statelessCalls",
  "toolsEnabled",
  "mayResolveHumanApproval",
  "maxOutputTokens",
  "reviewer",
  "thresholds",
  "reportPolicyVersion",
  "suitePreflight",
  "liveReady",
  "planHash",
] as const;
const TRIAL_KEYS = [
  "sequence",
  "segmentIndex",
  "segmentIdHash",
  "caseId",
  "presentation",
  "publicCaseHash",
  "viewHash",
  "visibleBytes",
  "promptBytes",
  "responseBytes",
  "elapsedMs",
  "schemaValid",
  "protocolValid",
  "unauthorizedToolCalls",
  "finishReason",
  "answer",
  "score",
  "usage",
  "providerIdentity",
  "failure",
] as const;

export type DecisionReviewAccountContext = "same" | "changed" | "unknown";
export type DecisionReviewSegmentAccountContext =
  | "initial"
  | DecisionReviewAccountContext;
export type DecisionReviewPauseReasonCode =
  | "usage_limit_reached"
  | "rate_limited"
  | "authentication_required"
  | "operator_requested";

export interface DecisionReviewExecutionSegment {
  index: number;
  segmentIdHash: string;
  authorizationHash: string;
  accountContext: DecisionReviewSegmentAccountContext;
  firstSequence: number;
  /** Zero means no scored call has completed. */
  completedThroughSequence: number;
  /** Null only for the initial segment. */
  sourceCheckpointHash: string | null;
  /** Hash of the exact ordered segment prefix; null only initially. */
  priorSegmentsHash: string | null;
  /** Exact approved resume plan hash; null only initially. */
  resumePlanHash: string | null;
  /** Invocation-attempt count committed by the source checkpoint. */
  sourceProcessAttempts: number | null;
}

export interface DecisionReviewActiveInvocation {
  sequence: number;
  invocationIdHash: string;
  segmentIndex: number;
  segmentIdHash: string;
}

export interface DecisionReviewPauseRecord {
  reasonCode: DecisionReviewPauseReasonCode;
  sequence: number;
}

export interface DecisionReviewNonScoringPause
  extends DecisionReviewPauseRecord {
  segmentIndex: number;
}

export interface DecisionReviewFailureRecord {
  reasonCode: string;
  sequence: number;
}

export interface DecisionReviewCheckpoint {
  apiVersion: typeof DECISION_REVIEW_CHECKPOINT_API_VERSION;
  status: "running" | "paused" | "failed";
  plan: DecisionReviewBenchmarkPlan;
  completedTrials: DecisionReviewTrialReport[];
  completedPrefixHash: string;
  resumeGeneration: number;
  processAttempts: number;
  nonScoringPauses: DecisionReviewNonScoringPause[];
  segments: DecisionReviewExecutionSegment[];
  activeInvocation: DecisionReviewActiveInvocation | null;
  pause: DecisionReviewPauseRecord | null;
  failure: DecisionReviewFailureRecord | null;
}

export interface DecisionReviewResumeSourcePolicy {
  harnessVersion: string;
  harnessSourceHash: string;
  codexProtocolHash: string;
  reportPolicyVersion: string;
  immutableBasePlan: true;
  noReplayOfStartedInvocation: true;
}

export interface DecisionReviewResumeSegmentPlan {
  index: number;
  segmentIdHash: string;
  accountContext: DecisionReviewAccountContext;
  firstSequence: number;
  sourceCheckpointHash: string;
  priorSegmentsHash: string;
  sourceProcessAttempts: number;
}

export interface DecisionReviewResumePlan {
  apiVersion: typeof DECISION_REVIEW_RESUME_PLAN_API_VERSION;
  resumePolicyVersion: typeof DECISION_REVIEW_RESUME_POLICY_VERSION;
  accountSegmentPolicy: typeof DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY;
  benchmarkId: string;
  basePlanHash: string;
  sourceCheckpointHash: string;
  completedPrefixHash: string;
  completedCount: number;
  nextSequence: number;
  remainingCount: number;
  remainingSchedule: DecisionReviewScheduledCall[];
  remainingScheduleHash: string;
  priorSegmentsHash: string;
  resumeGeneration: number;
  nextProcessAttempt: number;
  nonScoringPauses: DecisionReviewNonScoringPause[];
  accountContext: DecisionReviewAccountContext;
  newSegment: DecisionReviewResumeSegmentPlan;
  sourcePolicy: DecisionReviewResumeSourcePolicy;
  resumePlanHash: string;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isInteger(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && Number(value) >= minimum;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isBoundedString(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function assertJsonSafe(value: unknown, path = "$"): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", `${path} is not finite`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", `${path} is not JSON data`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", `${path}.${key} is undefined`);
    }
    assertJsonSafe(child, `${path}.${key}`);
  }
}

function assertScheduleEntry(
  value: unknown,
  expectedSequence?: number,
): asserts value is DecisionReviewScheduledCall {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sequence",
      "caseId",
      "presentation",
      "publicCaseHash",
      "viewHash",
    ]) ||
    !isInteger(value.sequence, 1) ||
    (expectedSequence !== undefined && value.sequence !== expectedSequence) ||
    !isBoundedString(value.caseId) ||
    !["raw", "decision_review"].includes(
      value.presentation as DecisionReviewPresentation,
    ) ||
    !isSha256(value.publicCaseHash) ||
    !isSha256(value.viewHash)
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "schedule entry is invalid");
  }
}

function assertBenchmarkPlan(
  value: unknown,
): asserts value is DecisionReviewBenchmarkPlan {
  assertJsonSafe(value);
  if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)) {
    fail("DECISION_REVIEW_PLAN_INVALID", "plan keys are not exact");
  }
  if (
    value.apiVersion !== "chartermesh.dev/decision-review-benchmark/v1alpha2" ||
    value.harnessVersion !== "decision-review-proxy-v1alpha2" ||
    !isSha256(value.harnessSourceHash) ||
    value.suiteId !== "decision-review-fixed-10-v1" ||
    !isBoundedString(value.benchmarkId) ||
    value.purpose !== "descriptive_product_regression" ||
    value.claimBoundary !== "codex_proxy_not_human_or_causal_evidence" ||
    !isSha256(value.publicSuiteHash) ||
    !isSha256(value.oracleCommitmentHash) ||
    value.rendererVersion !== "decision-review-view-v1alpha1" ||
    !isSha256(value.rendererHash) ||
    !isSha256(value.promptHash) ||
    !isSha256(value.responseSchemaHash) ||
    !isSha256(value.codexProtocolHash) ||
    value.orderingPolicy !== "fixed-interleaved-ab-ba-v1" ||
    value.resumePolicyVersion !== DECISION_REVIEW_RESUME_POLICY_VERSION ||
    value.reportPolicyVersion !== "allowlist-no-prompts-v1" ||
    value.plannedCalls !== 20 ||
    value.statelessCalls !== true ||
    value.toolsEnabled !== false ||
    value.mayResolveHumanApproval !== false ||
    value.maxOutputTokens !== 1_024 ||
    typeof value.liveReady !== "boolean" ||
    !isSha256(value.planHash) ||
    !Array.isArray(value.cases) ||
    !Array.isArray(value.schedule) ||
    value.schedule.length !== value.plannedCalls
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "plan contract is invalid");
  }

  const cases = new Map<string, string>();
  for (const item of value.cases) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["id", "publicCaseHash", "oracleHash"]) ||
      !isBoundedString(item.id) ||
      !isSha256(item.publicCaseHash) ||
      !isSha256(item.oracleHash) ||
      cases.has(item.id)
    ) {
      fail("DECISION_REVIEW_PLAN_INVALID", "case binding is invalid");
    }
    cases.set(item.id, item.publicCaseHash);
  }
  value.schedule.forEach((entry, index) => {
    assertScheduleEntry(entry, index + 1);
    if (cases.get(entry.caseId) !== entry.publicCaseHash) {
      fail("DECISION_REVIEW_PLAN_INVALID", "schedule case binding is invalid");
    }
  });

  if (
    !isRecord(value.reviewer) ||
    !hasExactKeys(value.reviewer, [
      "executableSha256",
      "modelId",
      "timeoutMs",
      "maxOutputBytes",
      "engineProfileId",
    ]) ||
    !(value.reviewer.executableSha256 === null ||
      isSha256(value.reviewer.executableSha256)) ||
    !(value.reviewer.modelId === null ||
      (isBoundedString(value.reviewer.modelId) &&
        SAFE_ID_PATTERN.test(value.reviewer.modelId))) ||
    !(value.reviewer.timeoutMs === null ||
      isInteger(value.reviewer.timeoutMs, 1)) ||
    !(value.reviewer.maxOutputBytes === null ||
      isInteger(value.reviewer.maxOutputBytes, 1)) ||
    !(value.reviewer.engineProfileId === null ||
      value.reviewer.engineProfileId === "codex-cli-decision-review")
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "reviewer binding is invalid");
  }
  if (
    !isRecord(value.thresholds) ||
    !hasExactKeys(value.thresholds, [
      "schemaValidCases",
      "minimumExactDecisionCases",
      "criticalCaseIds",
      "minimumRequiredFindings",
      "minimumBoundFindings",
      "minimumExactConsequences",
      "minimumPassedCases",
      "maximumCriticalErrors",
      "maximumUnsafeApprovals",
    ]) ||
    !Array.isArray(value.thresholds.criticalCaseIds) ||
    value.thresholds.criticalCaseIds.some((entry) => !isBoundedString(entry)) ||
    Object.entries(value.thresholds).some(
      ([key, entry]) =>
        key !== "criticalCaseIds" && !isInteger(entry, 0),
    )
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "thresholds are invalid");
  }
  if (
    !isRecord(value.suitePreflight) ||
    !hasExactKeys(value.suitePreflight, [
      "publicCaseCount",
      "oracleCount",
      "knownGoodChecks",
      "killedMutations",
      "totalMutations",
    ]) ||
    Object.values(value.suitePreflight).some((entry) => !isInteger(entry, 0))
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "suite preflight is invalid");
  }

  const { benchmarkId: _benchmarkId, planHash: _planHash, ...base } = value;
  if (
    canonicalDecisionReviewHash(base) !== value.planHash ||
    value.benchmarkId !== `decision-review-${value.planHash.slice(0, 16)}`
  ) {
    fail("DECISION_REVIEW_PLAN_INVALID", "plan hash is invalid");
  }
}

function assertUsage(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "cost",
      "measurementStatus",
    ]) ||
    !["measured", "estimated", "unknown"].includes(
      String(value.measurementStatus),
    ) ||
    [
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
      value.cost,
    ].some(
      (entry) => entry !== null && !isFiniteNonNegative(entry),
    )
  ) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial usage is invalid");
  }
}

function assertTrial(value: unknown): asserts value is DecisionReviewTrialReport {
  if (!isRecord(value) || !hasExactKeys(value, TRIAL_KEYS)) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial keys are not exact");
  }
  if (
    !isInteger(value.sequence, 1) ||
    !isInteger(value.segmentIndex, 0) ||
    !isSha256(value.segmentIdHash) ||
    !isBoundedString(value.caseId) ||
    !["raw", "decision_review"].includes(String(value.presentation)) ||
    !isSha256(value.publicCaseHash) ||
    !isSha256(value.viewHash) ||
    !isInteger(value.visibleBytes, 0) ||
    !isInteger(value.promptBytes, 0) ||
    !(value.responseBytes === null || isInteger(value.responseBytes, 0)) ||
    !isInteger(value.elapsedMs, 0) ||
    typeof value.schemaValid !== "boolean" ||
    typeof value.protocolValid !== "boolean" ||
    !isInteger(value.unauthorizedToolCalls, 0) ||
    !(value.finishReason === null ||
      ["stop", "tool_call", "length", "canceled", "error"].includes(
        String(value.finishReason),
      ))
  ) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial values are invalid");
  }

  if (value.answer !== null) {
    if (
      !isRecord(value.answer) ||
      !hasExactKeys(value.answer, [
        "decision",
        "findings",
        "consequence",
        "feedbackCount",
        "feedbackHash",
      ]) ||
      !isBoundedString(value.answer.decision) ||
      !Array.isArray(value.answer.findings) ||
      value.answer.findings.some(
        (finding) =>
          !isRecord(finding) ||
          !hasExactKeys(finding, ["code", "refs"]) ||
          !isBoundedString(finding.code) ||
          !Array.isArray(finding.refs) ||
          finding.refs.some((reference) => !isBoundedString(reference)),
      ) ||
      !isBoundedString(value.answer.consequence) ||
      !isInteger(value.answer.feedbackCount, 0) ||
      !isSha256(value.answer.feedbackHash)
    ) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial answer is invalid");
    }
  }

  if (
    !isRecord(value.score) ||
    !hasExactKeys(value.score, [
      "valid",
      "passed",
      "score",
      "maximumScore",
      "decisionExact",
      "consequenceExact",
      "matchedFindingCodes",
      "boundFindingCodes",
      "criticalErrors",
      "invalidReferenceCount",
      "invalidReferenceHash",
    ]) ||
    typeof value.score.valid !== "boolean" ||
    typeof value.score.passed !== "boolean" ||
    !isFiniteNonNegative(value.score.score) ||
    value.score.score > 10 ||
    value.score.maximumScore !== 10 ||
    typeof value.score.decisionExact !== "boolean" ||
    typeof value.score.consequenceExact !== "boolean" ||
    !Array.isArray(value.score.matchedFindingCodes) ||
    value.score.matchedFindingCodes.some((code) => !isBoundedString(code)) ||
    !Array.isArray(value.score.boundFindingCodes) ||
    value.score.boundFindingCodes.some((code) => !isBoundedString(code)) ||
    !Array.isArray(value.score.criticalErrors) ||
    value.score.criticalErrors.some((code) => !isBoundedString(code)) ||
    !isInteger(value.score.invalidReferenceCount, 0) ||
    !(value.score.invalidReferenceHash === null ||
      isSha256(value.score.invalidReferenceHash))
  ) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial score is invalid");
  }
  assertUsage(value.usage);

  if (
    value.providerIdentity !== null &&
    (!isRecord(value.providerIdentity) ||
      !hasExactKeys(value.providerIdentity, [
        "reportedModelId",
        "reportedSystemFingerprint",
      ]) ||
      !(value.providerIdentity.reportedModelId === null ||
        isBoundedString(value.providerIdentity.reportedModelId)) ||
      !(value.providerIdentity.reportedSystemFingerprint === null ||
        isBoundedString(value.providerIdentity.reportedSystemFingerprint)))
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "trial provider identity is invalid",
    );
  }
  if (
    value.failure !== null &&
    (!isRecord(value.failure) ||
      !hasExactKeys(value.failure, ["code", "messageHash"]) ||
      !isBoundedString(value.failure.code, 96) ||
      !isSha256(value.failure.messageHash))
  ) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "trial failure is invalid");
  }
}

export function assertDecisionReviewTrialPrefix(
  plan: DecisionReviewBenchmarkPlan,
  trials: readonly DecisionReviewTrialReport[],
): void {
  assertBenchmarkPlan(plan);
  if (!Array.isArray(trials) || trials.length > plan.schedule.length) {
    fail("DECISION_REVIEW_TRIAL_PREFIX_INVALID", "trial count is invalid");
  }
  trials.forEach((trial, index) => {
    assertTrial(trial);
    const scheduled = plan.schedule[index];
    if (
      !scheduled ||
      trial.sequence !== scheduled.sequence ||
      trial.caseId !== scheduled.caseId ||
      trial.presentation !== scheduled.presentation ||
      trial.publicCaseHash !== scheduled.publicCaseHash ||
      trial.viewHash !== scheduled.viewHash
    ) {
      fail(
        "DECISION_REVIEW_TRIAL_PREFIX_INVALID",
        `trial ${index + 1} does not match the fixed schedule`,
      );
    }
  });
}

export function decisionReviewCompletedPrefixHash(
  plan: DecisionReviewBenchmarkPlan,
  trials: readonly DecisionReviewTrialReport[],
): string {
  assertDecisionReviewTrialPrefix(plan, trials);
  let prefixHash = canonicalDecisionReviewHash({
    chainVersion: DECISION_REVIEW_PREFIX_CHAIN_VERSION,
    basePlanHash: plan.planHash,
    completedCount: 0,
  });
  trials.forEach((trial, index) => {
    const scheduled = plan.schedule[index]!;
    prefixHash = canonicalDecisionReviewHash({
      chainVersion: DECISION_REVIEW_PREFIX_CHAIN_VERSION,
      previousPrefixHash: prefixHash,
      scheduled,
      trial,
    });
  });
  return prefixHash;
}

function segmentIdHash(input: {
  basePlanHash: string;
  authorizationHash?: string;
  sourceCheckpointHash?: string;
  priorSegmentsHash?: string;
  index: number;
  accountContext: DecisionReviewSegmentAccountContext;
  firstSequence: number;
}): string {
  return canonicalDecisionReviewHash({
    accountSegmentPolicy: DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY,
    ...input,
  });
}

export function decisionReviewPriorSegmentsHash(
  segments: readonly DecisionReviewExecutionSegment[],
): string {
  return canonicalDecisionReviewHash({
    accountSegmentPolicy: DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY,
    segments,
  });
}

export function decisionReviewInvocationIdHash(input: {
  plan: DecisionReviewBenchmarkPlan;
  sequence: number;
  segmentIndex: number;
  segmentIdHash: string;
}): string {
  return canonicalDecisionReviewHash({
    domain: "chartermesh.dev/decision-review-invocation/v1alpha1",
    basePlanHash: input.plan.planHash,
    sequence: input.sequence,
    segmentIndex: input.segmentIndex,
    segmentIdHash: input.segmentIdHash,
  });
}

function assertNonScoringPauseHistory(
  checkpoint: DecisionReviewCheckpoint,
): void {
  const nextSequence =
    checkpoint.plan.schedule[checkpoint.completedTrials.length]?.sequence ??
    checkpoint.plan.schedule.length + 1;
  checkpoint.nonScoringPauses.forEach((pause, index) => {
    const segment = checkpoint.segments[index];
    const following = checkpoint.segments[index + 1];
    if (
      !isRecord(pause) ||
      !hasExactKeys(pause, ["reasonCode", "sequence", "segmentIndex"]) ||
      ![
        "usage_limit_reached",
        "rate_limited",
        "authentication_required",
        "operator_requested",
      ].includes(pause.reasonCode) ||
      !segment ||
      pause.segmentIndex !== segment.index ||
      pause.sequence !== (following?.firstSequence ?? nextSequence)
    ) {
      fail(
        "DECISION_REVIEW_CHECKPOINT_INVALID",
        "non-scoring pause history is invalid",
      );
    }
  });
}

function assertExecutionSegments(checkpoint: DecisionReviewCheckpoint): void {
  const completedCount = checkpoint.completedTrials.length;
  if (
    checkpoint.segments.length !== checkpoint.resumeGeneration + 1 ||
    checkpoint.processAttempts < checkpoint.completedTrials.length
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "segment, generation, and process counts disagree",
    );
  }
  const seenIds = new Set<string>();
  checkpoint.segments.forEach((segment, index) => {
    if (
      !isRecord(segment) ||
      !hasExactKeys(segment, [
        "index",
        "segmentIdHash",
        "authorizationHash",
        "accountContext",
        "firstSequence",
        "completedThroughSequence",
        "sourceCheckpointHash",
        "priorSegmentsHash",
        "resumePlanHash",
        "sourceProcessAttempts",
      ]) ||
      segment.index !== index ||
      !isSha256(segment.segmentIdHash) ||
      seenIds.has(segment.segmentIdHash) ||
      !isSha256(segment.authorizationHash) ||
      !["initial", "same", "changed", "unknown"].includes(
        segment.accountContext,
      ) ||
      !isInteger(segment.firstSequence, 1) ||
      !isInteger(segment.completedThroughSequence, 0) ||
      segment.completedThroughSequence < segment.firstSequence - 1 ||
      segment.completedThroughSequence > completedCount ||
      (index === 0 && segment.accountContext !== "initial") ||
      (index > 0 && segment.accountContext === "initial") ||
      (index === 0 &&
        (segment.sourceCheckpointHash !== null ||
          segment.priorSegmentsHash !== null ||
          segment.resumePlanHash !== null ||
          segment.sourceProcessAttempts !== null)) ||
      (index > 0 &&
        (!isSha256(segment.sourceCheckpointHash) ||
          !isSha256(segment.priorSegmentsHash) ||
          !isSha256(segment.resumePlanHash) ||
          !isInteger(segment.sourceProcessAttempts, 0) ||
          segment.authorizationHash !== segment.resumePlanHash))
    ) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", "segment is invalid");
    }
    if (index === 0) {
      if (
        segment.firstSequence !== 1 ||
        segment.authorizationHash !== checkpoint.plan.planHash ||
        segment.segmentIdHash !==
          segmentIdHash({
            basePlanHash: checkpoint.plan.planHash,
            authorizationHash: checkpoint.plan.planHash,
            index: 0,
            accountContext: "initial",
            firstSequence: 1,
          })
      ) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "initial segment is not bound to the base plan",
        );
      }
    } else {
      const prior = checkpoint.segments[index - 1]!;
      if (segment.firstSequence !== prior.completedThroughSequence + 1) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "segment boundaries are not contiguous",
        );
      }

      const priorSegments = checkpoint.segments.slice(0, index);
      const priorSegmentsHash = decisionReviewPriorSegmentsHash(priorSegments);
      const sourceCompletedCount = segment.firstSequence - 1;
      const sourceCompletedTrials = checkpoint.completedTrials.slice(
        0,
        sourceCompletedCount,
      );
      const sourcePauseHistory = checkpoint.nonScoringPauses.slice(0, index);
      const sourcePause = sourcePauseHistory.at(-1);
      const expectedSourceProcessAttempts =
        sourceCompletedCount +
        sourcePauseHistory.filter(
          ({ reasonCode }) => reasonCode !== "operator_requested",
        ).length;
      if (
        segment.priorSegmentsHash !== priorSegmentsHash ||
        segment.sourceProcessAttempts !== expectedSourceProcessAttempts ||
        segment.sourceProcessAttempts! > checkpoint.processAttempts ||
        !sourcePause ||
        sourcePause.segmentIndex !== index - 1 ||
        sourcePause.sequence !== segment.firstSequence
      ) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "resume segment source lineage is invalid",
        );
      }
      const sourceCheckpoint: DecisionReviewCheckpoint = {
        apiVersion: DECISION_REVIEW_CHECKPOINT_API_VERSION,
        status: "paused",
        plan: structuredClone(checkpoint.plan),
        completedTrials: structuredClone(sourceCompletedTrials),
        completedPrefixHash: decisionReviewCompletedPrefixHash(
          checkpoint.plan,
          sourceCompletedTrials,
        ),
        resumeGeneration: index - 1,
        processAttempts: segment.sourceProcessAttempts!,
        nonScoringPauses: structuredClone(sourcePauseHistory),
        segments: structuredClone(priorSegments),
        activeInvocation: null,
        pause: {
          reasonCode: sourcePause.reasonCode,
          sequence: sourcePause.sequence,
        },
        failure: null,
      };
      if (
        canonicalDecisionReviewHash(sourceCheckpoint) !==
        segment.sourceCheckpointHash
      ) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "resume segment source checkpoint hash is invalid",
        );
      }
      const expectedResumePlan = resumePlanFromValidatedCheckpoint(
        sourceCheckpoint,
        segment.accountContext as DecisionReviewAccountContext,
      );
      const actualSegmentPlan: DecisionReviewResumeSegmentPlan = {
        index: segment.index,
        segmentIdHash: segment.segmentIdHash,
        accountContext: segment.accountContext as DecisionReviewAccountContext,
        firstSequence: segment.firstSequence,
        sourceCheckpointHash: segment.sourceCheckpointHash!,
        priorSegmentsHash: segment.priorSegmentsHash!,
        sourceProcessAttempts: segment.sourceProcessAttempts!,
      };
      if (
        segment.resumePlanHash !== expectedResumePlan.resumePlanHash ||
        canonicalDecisionReviewJson(actualSegmentPlan) !==
          canonicalDecisionReviewJson(expectedResumePlan.newSegment)
      ) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "resume segment is not bound to the approved resume plan",
        );
      }
    }
    const next = checkpoint.segments[index + 1];
    if (
      next &&
      segment.completedThroughSequence !== next.firstSequence - 1
    ) {
      fail(
        "DECISION_REVIEW_CHECKPOINT_INVALID",
        "prior segment completion boundary is invalid",
      );
    }
    for (
      let sequence = segment.firstSequence;
      sequence <= segment.completedThroughSequence;
      sequence += 1
    ) {
      const trial = checkpoint.completedTrials[sequence - 1];
      if (
        trial?.segmentIndex !== segment.index ||
        trial.segmentIdHash !== segment.segmentIdHash
      ) {
        fail(
          "DECISION_REVIEW_CHECKPOINT_INVALID",
          "trial is not bound to its execution segment",
        );
      }
    }
    seenIds.add(segment.segmentIdHash);
  });
  if (
    checkpoint.segments.at(-1)?.completedThroughSequence !== completedCount
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "current segment does not cover the completed prefix",
    );
  }
}

function expectedNextSequence(checkpoint: DecisionReviewCheckpoint): number {
  return (
    checkpoint.plan.schedule[checkpoint.completedTrials.length]?.sequence ??
    checkpoint.plan.schedule.length + 1
  );
}

function assertCheckpoint(value: unknown): asserts value is DecisionReviewCheckpoint {
  assertJsonSafe(value);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "apiVersion",
      "status",
      "plan",
      "completedTrials",
      "completedPrefixHash",
      "resumeGeneration",
      "processAttempts",
      "nonScoringPauses",
      "segments",
      "activeInvocation",
      "pause",
      "failure",
    ]) ||
    value.apiVersion !== DECISION_REVIEW_CHECKPOINT_API_VERSION ||
    !["running", "paused", "failed"].includes(String(value.status)) ||
    !Array.isArray(value.completedTrials) ||
    !isSha256(value.completedPrefixHash) ||
    !isInteger(value.resumeGeneration, 0) ||
    !isInteger(value.processAttempts, 0) ||
    !Array.isArray(value.nonScoringPauses) ||
    !Array.isArray(value.segments)
  ) {
    fail("DECISION_REVIEW_CHECKPOINT_INVALID", "checkpoint contract is invalid");
  }
  assertBenchmarkPlan(value.plan);
  assertDecisionReviewTrialPrefix(value.plan, value.completedTrials);
  if (
    decisionReviewCompletedPrefixHash(value.plan, value.completedTrials) !==
    value.completedPrefixHash
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "completed prefix hash is invalid",
    );
  }
  const checkpoint = value as unknown as DecisionReviewCheckpoint;
  assertNonScoringPauseHistory(checkpoint);
  assertExecutionSegments(checkpoint);
  const nextSequence = expectedNextSequence(checkpoint);
  if (checkpoint.activeInvocation !== null) {
    const active = checkpoint.activeInvocation;
    const currentSegment = checkpoint.segments.at(-1)!;
    if (
      !isRecord(active) ||
      !hasExactKeys(active, [
        "sequence",
        "invocationIdHash",
        "segmentIndex",
        "segmentIdHash",
      ]) ||
      active.sequence !== nextSequence ||
      active.sequence > checkpoint.plan.schedule.length ||
      !isSha256(active.invocationIdHash) ||
      active.segmentIndex !== currentSegment.index ||
      active.segmentIdHash !== currentSegment.segmentIdHash ||
      active.invocationIdHash !==
        decisionReviewInvocationIdHash({
          plan: checkpoint.plan,
          sequence: active.sequence,
          segmentIndex: active.segmentIndex,
          segmentIdHash: active.segmentIdHash,
        })
    ) {
      fail(
        "DECISION_REVIEW_CHECKPOINT_INVALID",
        "active invocation is not the exact next call",
      );
    }
  }

  if (checkpoint.pause !== null) {
    if (
      !isRecord(checkpoint.pause) ||
      !hasExactKeys(checkpoint.pause, ["reasonCode", "sequence"]) ||
      ![
        "usage_limit_reached",
        "rate_limited",
        "authentication_required",
        "operator_requested",
      ].includes(checkpoint.pause.reasonCode) ||
      checkpoint.pause.sequence !== nextSequence
    ) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", "pause record is invalid");
    }
  }
  const expectedProcessAttempts =
    checkpoint.completedTrials.length +
    checkpoint.nonScoringPauses.filter(
      ({ reasonCode }) => reasonCode !== "operator_requested",
    ).length +
    (checkpoint.activeInvocation === null ? 0 : 1);
  if (checkpoint.processAttempts !== expectedProcessAttempts) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "process attempt accounting is not exact",
    );
  }
  if (checkpoint.failure !== null) {
    if (
      !isRecord(checkpoint.failure) ||
      !hasExactKeys(checkpoint.failure, ["reasonCode", "sequence"]) ||
      typeof checkpoint.failure.reasonCode !== "string" ||
      !SAFE_CODE_PATTERN.test(checkpoint.failure.reasonCode) ||
      checkpoint.failure.sequence !== nextSequence
    ) {
      fail("DECISION_REVIEW_CHECKPOINT_INVALID", "failure record is invalid");
    }
  }

  if (
    (checkpoint.status === "running" &&
      (checkpoint.pause !== null || checkpoint.failure !== null)) ||
    (checkpoint.status === "paused" &&
      (checkpoint.activeInvocation !== null ||
        checkpoint.pause === null ||
        checkpoint.failure !== null)) ||
    (checkpoint.status === "failed" &&
      (checkpoint.pause !== null || checkpoint.failure === null)) ||
    (checkpoint.status === "paused" &&
      checkpoint.nonScoringPauses.length !== checkpoint.resumeGeneration + 1) ||
    (checkpoint.status !== "paused" &&
      checkpoint.nonScoringPauses.length !== checkpoint.resumeGeneration) ||
    (checkpoint.status === "paused" &&
      (checkpoint.nonScoringPauses.at(-1)?.reasonCode !==
        checkpoint.pause?.reasonCode ||
        checkpoint.nonScoringPauses.at(-1)?.sequence !==
          checkpoint.pause?.sequence))
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "checkpoint status fields are inconsistent",
    );
  }
}

export function createInitialDecisionReviewCheckpoint(
  plan: DecisionReviewBenchmarkPlan,
  segmentAuthorizationHash: string,
): DecisionReviewCheckpoint {
  assertBenchmarkPlan(plan);
  if (segmentAuthorizationHash !== plan.planHash) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_INVALID",
      "initial authorization must equal the approved base plan hash",
    );
  }
  const initialSegment: DecisionReviewExecutionSegment = {
    index: 0,
    segmentIdHash: segmentIdHash({
      basePlanHash: plan.planHash,
      authorizationHash: segmentAuthorizationHash,
      index: 0,
      accountContext: "initial",
      firstSequence: 1,
    }),
    authorizationHash: segmentAuthorizationHash,
    accountContext: "initial",
    firstSequence: 1,
    completedThroughSequence: 0,
    sourceCheckpointHash: null,
    priorSegmentsHash: null,
    resumePlanHash: null,
    sourceProcessAttempts: null,
  };
  const checkpoint: DecisionReviewCheckpoint = {
    apiVersion: DECISION_REVIEW_CHECKPOINT_API_VERSION,
    status: "running",
    plan: structuredClone(plan),
    completedTrials: [],
    completedPrefixHash: decisionReviewCompletedPrefixHash(plan, []),
    resumeGeneration: 0,
    processAttempts: 0,
    nonScoringPauses: [],
    segments: [initialSegment],
    activeInvocation: null,
    pause: null,
    failure: null,
  };
  return parseDecisionReviewCheckpoint(checkpoint);
}

export function parseDecisionReviewCheckpoint(
  value: unknown,
): DecisionReviewCheckpoint {
  assertCheckpoint(value);
  return structuredClone(value);
}

export function decisionReviewCheckpointHash(
  checkpoint: DecisionReviewCheckpoint,
): string {
  const parsed = parseDecisionReviewCheckpoint(checkpoint);
  return canonicalDecisionReviewHash(parsed);
}

export function createDecisionReviewActiveInvocation(
  checkpoint: DecisionReviewCheckpoint,
): DecisionReviewActiveInvocation {
  const parsed = parseDecisionReviewCheckpoint(checkpoint);
  if (
    parsed.status !== "running" ||
    parsed.activeInvocation !== null ||
    parsed.completedTrials.length >= parsed.plan.schedule.length
  ) {
    fail(
      "DECISION_REVIEW_INVOCATION_START_REJECTED",
      "checkpoint cannot start another invocation",
    );
  }
  const sequence = expectedNextSequence(parsed);
  const segment = parsed.segments.at(-1)!;
  return {
    sequence,
    invocationIdHash: decisionReviewInvocationIdHash({
      plan: parsed.plan,
      sequence,
      segmentIndex: segment.index,
      segmentIdHash: segment.segmentIdHash,
    }),
    segmentIndex: segment.index,
    segmentIdHash: segment.segmentIdHash,
  };
}

const RESUMABLE_PAUSE_REASONS = new Set<DecisionReviewPauseReasonCode>([
  "usage_limit_reached",
  "rate_limited",
  "authentication_required",
  "operator_requested",
]);

function assertCheckpointResumable(checkpoint: DecisionReviewCheckpoint): void {
  if (
    checkpoint.status !== "paused" ||
    checkpoint.activeInvocation !== null ||
    !checkpoint.pause ||
    !RESUMABLE_PAUSE_REASONS.has(checkpoint.pause.reasonCode) ||
    checkpoint.completedTrials.length >= checkpoint.plan.schedule.length
  ) {
    fail(
      "DECISION_REVIEW_CHECKPOINT_NOT_RESUMABLE",
      "only an incomplete, settled pause can resume",
    );
  }
}

function resumePlanFromValidatedCheckpoint(
  parsed: DecisionReviewCheckpoint,
  accountContext: DecisionReviewAccountContext,
): DecisionReviewResumePlan {
  const sourceCheckpointHash = canonicalDecisionReviewHash(parsed);
  const remainingSchedule = structuredClone(
    parsed.plan.schedule.slice(parsed.completedTrials.length),
  );
  const priorSegmentsHash = decisionReviewPriorSegmentsHash(parsed.segments);
  const nextGeneration = parsed.resumeGeneration + 1;
  const nextSequence = remainingSchedule[0]!.sequence;
  const newSegment: DecisionReviewResumeSegmentPlan = {
    index: nextGeneration,
    segmentIdHash: segmentIdHash({
      basePlanHash: parsed.plan.planHash,
      sourceCheckpointHash,
      priorSegmentsHash,
      index: nextGeneration,
      accountContext,
      firstSequence: nextSequence,
    }),
    accountContext,
    firstSequence: nextSequence,
    sourceCheckpointHash,
    priorSegmentsHash,
    sourceProcessAttempts: parsed.processAttempts,
  };
  const base = {
    apiVersion: DECISION_REVIEW_RESUME_PLAN_API_VERSION,
    resumePolicyVersion: DECISION_REVIEW_RESUME_POLICY_VERSION,
    accountSegmentPolicy: DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY,
    benchmarkId: parsed.plan.benchmarkId,
    basePlanHash: parsed.plan.planHash,
    sourceCheckpointHash,
    completedPrefixHash: parsed.completedPrefixHash,
    completedCount: parsed.completedTrials.length,
    nextSequence,
    remainingCount: remainingSchedule.length,
    remainingSchedule,
    remainingScheduleHash: canonicalDecisionReviewHash({
      basePlanHash: parsed.plan.planHash,
      remainingSchedule,
    }),
    priorSegmentsHash,
    resumeGeneration: nextGeneration,
    nextProcessAttempt: parsed.processAttempts + 1,
    nonScoringPauses: structuredClone(parsed.nonScoringPauses),
    accountContext,
    newSegment,
    sourcePolicy: {
      harnessVersion: parsed.plan.harnessVersion,
      harnessSourceHash: parsed.plan.harnessSourceHash,
      codexProtocolHash: parsed.plan.codexProtocolHash,
      reportPolicyVersion: parsed.plan.reportPolicyVersion,
      immutableBasePlan: true as const,
      noReplayOfStartedInvocation: true as const,
    },
  };
  return {
    ...base,
    resumePlanHash: canonicalDecisionReviewHash(base),
  };
}

export function createDecisionReviewResumePlan(
  checkpoint: DecisionReviewCheckpoint,
  accountContext: DecisionReviewAccountContext,
): DecisionReviewResumePlan {
  const parsed = parseDecisionReviewCheckpoint(checkpoint);
  assertCheckpointResumable(parsed);
  if (!["same", "changed", "unknown"].includes(accountContext)) {
    fail(
      "DECISION_REVIEW_RESUME_PLAN_INVALID",
      "account context declaration is invalid",
    );
  }
  return resumePlanFromValidatedCheckpoint(parsed, accountContext);
}

function assertResumePlanSelfConsistent(
  plan: DecisionReviewResumePlan,
): void {
  assertJsonSafe(plan);
  if (
    !isRecord(plan) ||
    !hasExactKeys(plan, [
      "apiVersion",
      "resumePolicyVersion",
      "accountSegmentPolicy",
      "benchmarkId",
      "basePlanHash",
      "sourceCheckpointHash",
      "completedPrefixHash",
      "completedCount",
      "nextSequence",
      "remainingCount",
      "remainingSchedule",
      "remainingScheduleHash",
      "priorSegmentsHash",
      "resumeGeneration",
      "nextProcessAttempt",
      "nonScoringPauses",
      "accountContext",
      "newSegment",
      "sourcePolicy",
      "resumePlanHash",
    ]) ||
    plan.apiVersion !== DECISION_REVIEW_RESUME_PLAN_API_VERSION ||
    plan.resumePolicyVersion !== DECISION_REVIEW_RESUME_POLICY_VERSION ||
    plan.accountSegmentPolicy !== DECISION_REVIEW_ACCOUNT_SEGMENT_POLICY ||
    !isBoundedString(plan.benchmarkId) ||
    !isSha256(plan.basePlanHash) ||
    plan.benchmarkId !==
      `decision-review-${plan.basePlanHash.slice(0, 16)}` ||
    !isSha256(plan.sourceCheckpointHash) ||
    !isSha256(plan.completedPrefixHash) ||
    !isInteger(plan.completedCount, 0) ||
    !isInteger(plan.nextSequence, 1) ||
    plan.nextSequence !== plan.completedCount + 1 ||
    !isInteger(plan.remainingCount, 1) ||
    !Array.isArray(plan.remainingSchedule) ||
    plan.remainingSchedule.length !== plan.remainingCount ||
    plan.completedCount + plan.remainingCount !== 20 ||
    !isSha256(plan.remainingScheduleHash) ||
    !isSha256(plan.priorSegmentsHash) ||
    !isInteger(plan.resumeGeneration, 1) ||
    !isInteger(plan.nextProcessAttempt, 1) ||
    plan.nextProcessAttempt < plan.completedCount + 1 ||
    !Array.isArray(plan.nonScoringPauses) ||
    plan.nonScoringPauses.length !== plan.resumeGeneration ||
    !["same", "changed", "unknown"].includes(plan.accountContext) ||
    !isSha256(plan.resumePlanHash)
  ) {
    fail("DECISION_REVIEW_RESUME_PLAN_INVALID", "resume plan is invalid");
  }
  plan.remainingSchedule.forEach((entry, index) =>
    assertScheduleEntry(entry, plan.nextSequence + index),
  );
  plan.nonScoringPauses.forEach((pause, index) => {
    if (
      !isRecord(pause) ||
      !hasExactKeys(pause, ["reasonCode", "sequence", "segmentIndex"]) ||
      ![
        "usage_limit_reached",
        "rate_limited",
        "authentication_required",
        "operator_requested",
      ].includes(pause.reasonCode) ||
      pause.segmentIndex !== index ||
      !isInteger(pause.sequence, 1) ||
      pause.sequence > plan.nextSequence
    ) {
      fail(
        "DECISION_REVIEW_RESUME_PLAN_INVALID",
        "resume pause history is invalid",
      );
    }
  });
  if (
    canonicalDecisionReviewHash({
      basePlanHash: plan.basePlanHash,
      remainingSchedule: plan.remainingSchedule,
    }) !== plan.remainingScheduleHash ||
    !isRecord(plan.newSegment) ||
    !hasExactKeys(plan.newSegment, [
      "index",
      "segmentIdHash",
      "accountContext",
      "firstSequence",
      "sourceCheckpointHash",
      "priorSegmentsHash",
      "sourceProcessAttempts",
    ]) ||
    plan.newSegment.index !== plan.resumeGeneration ||
    !isSha256(plan.newSegment.segmentIdHash) ||
    plan.newSegment.accountContext !== plan.accountContext ||
    plan.newSegment.firstSequence !== plan.nextSequence ||
    plan.newSegment.sourceCheckpointHash !== plan.sourceCheckpointHash ||
    plan.newSegment.priorSegmentsHash !== plan.priorSegmentsHash ||
    plan.newSegment.sourceProcessAttempts !== plan.nextProcessAttempt - 1
  ) {
    fail(
      "DECISION_REVIEW_RESUME_PLAN_INVALID",
      "resume segment plan is invalid",
    );
  }
  if (
    !isRecord(plan.sourcePolicy) ||
    !hasExactKeys(plan.sourcePolicy, [
      "harnessVersion",
      "harnessSourceHash",
      "codexProtocolHash",
      "reportPolicyVersion",
      "immutableBasePlan",
      "noReplayOfStartedInvocation",
    ]) ||
    !isBoundedString(plan.sourcePolicy.harnessVersion) ||
    !isSha256(plan.sourcePolicy.harnessSourceHash) ||
    !isSha256(plan.sourcePolicy.codexProtocolHash) ||
    !isBoundedString(plan.sourcePolicy.reportPolicyVersion) ||
    plan.sourcePolicy.immutableBasePlan !== true ||
    plan.sourcePolicy.noReplayOfStartedInvocation !== true
  ) {
    fail(
      "DECISION_REVIEW_RESUME_PLAN_INVALID",
      "resume source policy is invalid",
    );
  }
  const { resumePlanHash: _resumePlanHash, ...base } = plan;
  if (canonicalDecisionReviewHash(base) !== plan.resumePlanHash) {
    fail(
      "DECISION_REVIEW_RESUME_PLAN_INVALID",
      "resume plan hash is invalid",
    );
  }
}

export function createDecisionReviewResumeExecutionSegment(
  plan: DecisionReviewResumePlan,
): DecisionReviewExecutionSegment {
  assertResumePlanSelfConsistent(plan);
  return {
    ...structuredClone(plan.newSegment),
    authorizationHash: plan.resumePlanHash,
    completedThroughSequence: plan.completedCount,
    resumePlanHash: plan.resumePlanHash,
  };
}

export function assertDecisionReviewResumePlan(
  plan: DecisionReviewResumePlan,
  checkpoint: DecisionReviewCheckpoint,
): void {
  assertResumePlanSelfConsistent(plan);
  const expected = createDecisionReviewResumePlan(
    checkpoint,
    plan.accountContext,
  );
  if (
    canonicalDecisionReviewJson(plan) !==
    canonicalDecisionReviewJson(expected)
  ) {
    fail(
      "DECISION_REVIEW_RESUME_PLAN_MISMATCH",
      "resume plan does not match the exact paused checkpoint",
    );
  }
}
