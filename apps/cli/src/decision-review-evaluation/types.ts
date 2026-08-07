import { createHash } from "node:crypto";
import type {
  DecisionReviewView,
  DecisionSubject,
} from "../../../../packages/control-plane/src/index.ts";

export const DECISION_REVIEW_EVALUATION_API_VERSION =
  "chartermesh.dev/decision-review-evaluation/v1alpha1" as const;
export const DECISION_REVIEW_RAW_VIEW_API_VERSION =
  "chartermesh.dev/decision-review-raw-view/v1alpha1" as const;
export const DECISION_REVIEW_RESPONSE_API_VERSION =
  "chartermesh.dev/decision-review-response/v1alpha1" as const;

export const DECISION_REVIEW_PRESENTATIONS = [
  "raw",
  "decision_review",
] as const;
export type DecisionReviewPresentation =
  (typeof DECISION_REVIEW_PRESENTATIONS)[number];

export const DECISION_REVIEW_DECISIONS = [
  "approve",
  "changes_requested",
  "reject",
  "provide_input",
] as const;
export type DecisionReviewDecision =
  (typeof DECISION_REVIEW_DECISIONS)[number];

export const DECISION_REVIEW_FINDING_CODES = [
  "EVIDENCE_CURRENT_VERIFIED",
  "CRITERIA_SATISFIED",
  "HUMAN_JUDGMENT_SATISFIED",
  "OUTCOME_NOT_REQUIRED",
  "TOOL_BOUNDED_REVERSIBLE",
  "SCOPE_MATCHES_REQUEST",
  "MODEL_CLAIM_ONLY",
  "CRITICAL_CRITERION_UNVERIFIED",
  "STALE_EVIDENCE",
  "OUTCOME_UNKNOWN",
  "TOOL_SECURITY_WEAKENING",
  "SCOPE_VIOLATION",
  "EXTERNAL_SIDE_EFFECT_UNAUTHORIZED",
  "USER_CHOICE_REQUIRED",
  "NO_SAFE_DEFAULT",
  "EXTERNAL_CONSEQUENCE_DEPENDS_ON_INPUT",
] as const;
export type DecisionReviewFindingCode =
  (typeof DECISION_REVIEW_FINDING_CODES)[number];

export const DECISION_REVIEW_CONSEQUENCES = [
  "complete_artifact",
  "authorize_exact_call_only",
  "return_for_rework",
  "deny_call_without_execution",
  "record_input_and_resume",
] as const;
export type DecisionReviewConsequence =
  (typeof DECISION_REVIEW_CONSEQUENCES)[number];

export const DECISION_REVIEW_CRITICAL_ERROR_CODES = [
  "CLAIM_TREATED_AS_VERIFIED",
  "STALE_EVIDENCE_TREATED_AS_CURRENT",
  "UNKNOWN_OUTCOME_TREATED_COMPLETE",
  "UNSAFE_TOOL_APPROVAL",
  "USER_CHOICE_ASSUMED",
] as const;
export type DecisionReviewCriticalErrorCode =
  (typeof DECISION_REVIEW_CRITICAL_ERROR_CODES)[number];

export type DecisionReviewReferenceKind =
  | "objective"
  | "policy"
  | "subject"
  | "criterion"
  | "producer_claim"
  | "runtime_evidence"
  | "risk"
  | "unknown"
  | "user_choice";

export interface DecisionReviewVisibleReference {
  id: string;
  kind: DecisionReviewReferenceKind;
  text: string;
}

export interface RawDecisionReviewSection {
  heading: string;
  referenceIds: string[];
}

export interface RawDecisionReviewView {
  apiVersion: typeof DECISION_REVIEW_RAW_VIEW_API_VERSION;
  presentation: "raw";
  question: string;
  subject: DecisionSubject;
  references: DecisionReviewVisibleReference[];
  sections: RawDecisionReviewSection[];
}

export interface ProjectedDecisionReviewPresentation {
  presentation: "decision_review";
  review: DecisionReviewView;
  /** Exact artifact/call/input details that are outside the packet projection. */
  supplementalReferences: DecisionReviewVisibleReference[];
}

export interface PublicDecisionReviewCase {
  apiVersion: typeof DECISION_REVIEW_EVALUATION_API_VERSION;
  id: string;
  subjectKind: "artifact" | "tool_call" | "user_input";
  objective: string;
  policy: string[];
  allowedDecisions: DecisionReviewDecision[];
  raw: RawDecisionReviewView;
  decisionReview: ProjectedDecisionReviewPresentation;
  publicCaseHash: string;
}

export interface PublicDecisionReviewFixture {
  apiVersion: typeof DECISION_REVIEW_EVALUATION_API_VERSION;
  id: string;
  subjectKind: PublicDecisionReviewCase["subjectKind"];
  objective: string;
  policy: string[];
  allowedDecisions: DecisionReviewDecision[];
  presentation: DecisionReviewPresentation;
  view: RawDecisionReviewView | ProjectedDecisionReviewPresentation;
  publicCaseHash: string;
}

export interface DecisionReviewFinding {
  code: DecisionReviewFindingCode;
  refs: string[];
}

export interface DecisionReviewResponse {
  apiVersion: typeof DECISION_REVIEW_RESPONSE_API_VERSION;
  decision: DecisionReviewDecision;
  findings: DecisionReviewFinding[];
  consequence: DecisionReviewConsequence;
  feedback: string[];
}

export interface RequiredDecisionReviewFinding {
  code: DecisionReviewFindingCode;
  anyOfRefs: Record<DecisionReviewPresentation, string[]>;
}

export interface DecisionReviewCriticalRule {
  code: DecisionReviewCriticalErrorCode;
  trigger:
    | {
        kind: "decision_in";
        decisions: DecisionReviewDecision[];
      }
    | {
        kind: "decision_not_in";
        decisions: DecisionReviewDecision[];
      };
}

export interface DecisionReviewMutation {
  id: string;
  presentation: DecisionReviewPresentation;
  description: string;
  response: DecisionReviewResponse;
  expectedFailure:
    | "decision"
    | "finding"
    | "reference_binding"
    | "consequence";
}

export interface SealedDecisionReviewOracle {
  apiVersion: typeof DECISION_REVIEW_EVALUATION_API_VERSION;
  caseId: string;
  publicCaseHash: string;
  expectedDecision: DecisionReviewDecision;
  expectedConsequence: DecisionReviewConsequence;
  requiredFindings: RequiredDecisionReviewFinding[];
  criticalRules: DecisionReviewCriticalRule[];
  knownGood: Record<DecisionReviewPresentation, DecisionReviewResponse>;
  mutations: DecisionReviewMutation[];
  oracleHash: string;
}

export interface DecisionReviewScore {
  valid: boolean;
  passed: boolean;
  score: number;
  maximumScore: 10;
  decisionExact: boolean;
  consequenceExact: boolean;
  matchedFindingCodes: DecisionReviewFindingCode[];
  boundFindingCodes: DecisionReviewFindingCode[];
  invalidReferenceIds: string[];
  criticalErrors: DecisionReviewCriticalErrorCode[];
}

export interface DecisionReviewSuitePreflight {
  publicCaseCount: number;
  oracleCount: number;
  knownGoodChecks: number;
  killedMutations: number;
  totalMutations: number;
  publicSuiteHash: string;
  oracleCommitmentHash: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalDecisionReviewJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalDecisionReviewHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalDecisionReviewJson(value))
    .digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

export function validateDecisionReviewResponse(
  value: unknown,
): asserts value is DecisionReviewResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "apiVersion",
      "decision",
      "findings",
      "consequence",
      "feedback",
    ]) ||
    value.apiVersion !== DECISION_REVIEW_RESPONSE_API_VERSION ||
    !DECISION_REVIEW_DECISIONS.includes(
      value.decision as DecisionReviewDecision,
    ) ||
    !DECISION_REVIEW_CONSEQUENCES.includes(
      value.consequence as DecisionReviewConsequence,
    ) ||
    !Array.isArray(value.findings) ||
    value.findings.length !== 2 ||
    !Array.isArray(value.feedback) ||
    value.feedback.length > 2 ||
    value.feedback.some((entry) => !isBoundedText(entry, 240))
  ) {
    throw new Error(
      "DECISION_REVIEW_RESPONSE_INVALID: response is outside the strict public schema.",
    );
  }

  const findingCodes = new Set<string>();
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      !hasExactKeys(finding, ["code", "refs"]) ||
      !DECISION_REVIEW_FINDING_CODES.includes(
        finding.code as DecisionReviewFindingCode,
      ) ||
      findingCodes.has(String(finding.code)) ||
      !Array.isArray(finding.refs) ||
      finding.refs.length < 1 ||
      finding.refs.length > 4 ||
      finding.refs.some(
        (reference) =>
          !isBoundedText(reference, 256) ||
          !/^[a-z0-9][a-z0-9:._-]*$/u.test(reference),
      ) ||
      new Set(finding.refs).size !== finding.refs.length
    ) {
      throw new Error(
        "DECISION_REVIEW_RESPONSE_INVALID: findings must use unique fixed codes and bounded visible refs.",
      );
    }
    findingCodes.add(String(finding.code));
  }
}

export function decisionReviewViewReferenceIds(
  presentation: RawDecisionReviewView | ProjectedDecisionReviewPresentation,
): string[] {
  if (presentation.presentation === "raw") {
    return [...new Set(presentation.references.map(({ id }) => id))].sort();
  }
  const review = presentation.review;
  const ids = new Set(
    presentation.supplementalReferences.map(({ id }) => id),
  );
  ids.add(`subject:${review.binding.subjectHash.slice(0, 24)}`);
  review.criteria.forEach(({ criterionId }) => {
    ids.add(`criterion:${criterionId}`);
  });
  for (const entries of Object.values(review.evidence)) {
    entries.forEach(({ id }) => ids.add(id));
  }
  for (const entries of Object.values(review.exceptions)) {
    entries.forEach(({ code }, index) => {
      ids.add(`exception:${code.toLowerCase()}:${index}`);
    });
  }
  return [...ids].sort();
}

function criticalErrorsFor(
  response: DecisionReviewResponse,
  rules: readonly DecisionReviewCriticalRule[],
): DecisionReviewCriticalErrorCode[] {
  return rules
    .filter(({ trigger }) =>
      trigger.kind === "decision_in"
        ? trigger.decisions.includes(response.decision)
        : !trigger.decisions.includes(response.decision),
    )
    .map(({ code }) => code);
}

export function evaluateDecisionReviewResponse(
  response: unknown,
  oracle: SealedDecisionReviewOracle,
  presentation: DecisionReviewPresentation,
  visibleReferenceIds: readonly string[],
): DecisionReviewScore {
  try {
    validateDecisionReviewResponse(response);
  } catch {
    return {
      valid: false,
      passed: false,
      score: 0,
      maximumScore: 10,
      decisionExact: false,
      consequenceExact: false,
      matchedFindingCodes: [],
      boundFindingCodes: [],
      invalidReferenceIds: [],
      criticalErrors: [],
    };
  }

  const visible = new Set(visibleReferenceIds);
  const invalidReferenceIds = [
    ...new Set(
      response.findings
        .flatMap(({ refs }) => refs)
        .filter((reference) => !visible.has(reference)),
    ),
  ].sort();
  const matchedFindingCodes: DecisionReviewFindingCode[] = [];
  const boundFindingCodes: DecisionReviewFindingCode[] = [];
  for (const required of oracle.requiredFindings) {
    const actual = response.findings.find(
      ({ code }) => code === required.code,
    );
    if (!actual) continue;
    matchedFindingCodes.push(required.code);
    const allowedRefs = new Set(required.anyOfRefs[presentation]);
    if (
      actual.refs.some(
        (reference) => visible.has(reference) && allowedRefs.has(reference),
      )
    ) {
      boundFindingCodes.push(required.code);
    }
  }

  const decisionExact = response.decision === oracle.expectedDecision;
  const consequenceExact =
    response.consequence === oracle.expectedConsequence;
  const criticalErrors = criticalErrorsFor(response, oracle.criticalRules);
  const score =
    (decisionExact ? 5 : 0) +
    matchedFindingCodes.length +
    boundFindingCodes.length +
    (consequenceExact ? 1 : 0);
  const passed =
    decisionExact &&
    consequenceExact &&
    matchedFindingCodes.length === oracle.requiredFindings.length &&
    boundFindingCodes.length === oracle.requiredFindings.length &&
    invalidReferenceIds.length === 0 &&
    criticalErrors.length === 0;
  return {
    valid: true,
    passed,
    score,
    maximumScore: 10,
    decisionExact,
    consequenceExact,
    matchedFindingCodes,
    boundFindingCodes,
    invalidReferenceIds,
    criticalErrors,
  };
}

export function projectPublicDecisionReviewFixture(
  fixture: PublicDecisionReviewCase,
  presentation: DecisionReviewPresentation,
): PublicDecisionReviewFixture {
  return {
    apiVersion: DECISION_REVIEW_EVALUATION_API_VERSION,
    id: fixture.id,
    subjectKind: fixture.subjectKind,
    objective: fixture.objective,
    policy: [...fixture.policy],
    allowedDecisions: [...fixture.allowedDecisions],
    presentation,
    view: structuredClone(
      presentation === "raw" ? fixture.raw : fixture.decisionReview,
    ),
    publicCaseHash: fixture.publicCaseHash,
  };
}
