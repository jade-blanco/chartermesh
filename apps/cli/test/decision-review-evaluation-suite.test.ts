import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_REVIEW_DESCRIPTIVE_PASS,
  decisionReviewOracleCommitmentHash,
  decisionReviewOracleHash,
  decisionReviewPublicCaseHash,
  decisionReviewPublicSuiteHash,
  generatePublicDecisionReviewCases,
  generateSealedDecisionReviewOracles,
  preflightDecisionReviewEvaluationSuite,
} from "../src/decision-review-evaluation/cases.ts";
import {
  DECISION_REVIEW_EVALUATION_API_VERSION,
  DECISION_REVIEW_FINDING_CODES,
  DECISION_REVIEW_PRESENTATIONS,
  DECISION_REVIEW_RESPONSE_API_VERSION,
  decisionReviewViewReferenceIds,
  evaluateDecisionReviewResponse,
  projectPublicDecisionReviewFixture,
  validateDecisionReviewResponse,
  type DecisionReviewResponse,
  type PublicDecisionReviewCase,
  type SealedDecisionReviewOracle,
} from "../src/decision-review-evaluation/types.ts";

const EXPECTED_IDS = [
  "A01-current-verified",
  "A02-subjective-ready",
  "A03-bounded-doc-write",
  "C01-claimed-tests",
  "C02-stale-evidence",
  "C03-outcome-required-unknown",
  "R01-disable-auth",
  "R02-unauthorized-publish",
  "I01-region-choice",
  "I02-audience-choice",
] as const;

function publicCase(
  fixtures: readonly PublicDecisionReviewCase[],
  id: string,
): PublicDecisionReviewCase {
  const fixture = fixtures.find((entry) => entry.id === id);
  assert.ok(fixture, id);
  return fixture;
}

function oracle(
  oracles: readonly SealedDecisionReviewOracle[],
  id: string,
): SealedDecisionReviewOracle {
  const entry = oracles.find(({ caseId }) => caseId === id);
  assert.ok(entry, id);
  return entry;
}

test("fixed suite deterministically contains the ten authored decision cases", () => {
  const first = generatePublicDecisionReviewCases();
  const second = generatePublicDecisionReviewCases();
  const sealedFirst = generateSealedDecisionReviewOracles();
  const sealedSecond = generateSealedDecisionReviewOracles();
  assert.deepEqual(first, second);
  assert.deepEqual(sealedFirst, sealedSecond);
  assert.deepEqual(first.map(({ id }) => id), EXPECTED_IDS);
  assert.deepEqual(sealedFirst.map(({ caseId }) => caseId), EXPECTED_IDS);
  assert.equal(new Set(first.map(({ id }) => id)).size, 10);
  assert.deepEqual(
    Object.fromEntries(
      ["artifact", "tool_call", "user_input"].map((kind) => [
        kind,
        first.filter(({ subjectKind }) => subjectKind === kind).length,
      ]),
    ),
    { artifact: 5, tool_call: 3, user_input: 2 },
  );
  assert.deepEqual(
    Object.fromEntries(
      ["approve", "changes_requested", "reject", "provide_input"].map(
        (decision) => [
          decision,
          sealedFirst.filter(
            ({ expectedDecision }) => expectedDecision === decision,
          ).length,
        ],
      ),
    ),
    { approve: 3, changes_requested: 3, reject: 2, provide_input: 2 },
  );
  assert.equal(generatePublicDecisionReviewCases.length, 0);
  assert.equal(generateSealedDecisionReviewOracles.length, 0);
});

test("public fixtures use actual deterministic DecisionReviewView projections", () => {
  const fixtures = generatePublicDecisionReviewCases();
  for (const fixture of fixtures) {
    assert.equal(
      fixture.apiVersion,
      DECISION_REVIEW_EVALUATION_API_VERSION,
    );
    assert.equal(fixture.raw.presentation, "raw");
    assert.equal(fixture.decisionReview.presentation, "decision_review");
    assert.equal(
      fixture.decisionReview.review.apiVersion,
      "chartermesh.dev/decision-review-view/v1alpha1",
    );
    assert.deepEqual(
      fixture.raw.subject,
      fixture.decisionReview.review.subject,
      fixture.id,
    );
    assert.deepEqual(
      fixture.allowedDecisions,
      fixture.decisionReview.review.requestedDecision.options,
      fixture.id,
    );
    assert.match(fixture.publicCaseHash, /^[a-f0-9]{64}$/u);
    assert.equal(
      fixture.publicCaseHash,
      decisionReviewPublicCaseHash(fixture),
      fixture.id,
    );

    const rawRefs = decisionReviewViewReferenceIds(fixture.raw);
    const reviewRefs = decisionReviewViewReferenceIds(
      fixture.decisionReview,
    );
    assert.equal(rawRefs.length, fixture.raw.references.length, fixture.id);
    assert.ok(
      reviewRefs.length >=
        fixture.decisionReview.supplementalReferences.length,
      fixture.id,
    );
    const sectionRefs = fixture.raw.sections.flatMap(
      ({ referenceIds }) => referenceIds,
    );
    assert.deepEqual([...sectionRefs].sort(), rawRefs, fixture.id);
  }
});

test("claimed, verified, stale, risk, and unknown cases remain semantically distinct", () => {
  const fixtures = generatePublicDecisionReviewCases();
  const oracles = generateSealedDecisionReviewOracles();

  const verified = publicCase(fixtures, "A01-current-verified");
  assert.deepEqual(
    verified.decisionReview.review.evidence.verified
      .filter(({ source }) => source === "tool_runtime")
      .map(({ id }) => id),
    ["ev-a01-schema", "ev-a01-total"],
  );
  assert.equal(
    verified.decisionReview.review.criteria.every(
      ({ status }) => status === "satisfied",
    ),
    true,
  );

  const claimed = publicCase(fixtures, "C01-claimed-tests");
  assert.equal(claimed.decisionReview.review.evidence.claimed.length, 1);
  assert.equal(
    claimed.decisionReview.review.evidence.verified.some(
      ({ source }) => source === "model_reported",
    ),
    false,
  );
  assert.equal(
    claimed.decisionReview.review.exceptions.blocking.some(
      ({ code }) => code === "EVIDENCE_MISSING",
    ),
    true,
  );

  const stale = publicCase(fixtures, "C02-stale-evidence");
  assert.equal(
    Object.values(stale.decisionReview.review.evidence)
      .flat()
      .some(({ id }) => id === "ev-c02-old"),
    false,
  );
  assert.equal(
    stale.decisionReview.supplementalReferences.some(
      ({ id }) => id === "ev-c02-old",
    ),
    true,
  );

  const subjective = oracle(oracles, "A02-subjective-ready");
  const outcomeRequired = oracle(
    oracles,
    "C03-outcome-required-unknown",
  );
  assert.equal(subjective.expectedDecision, "approve");
  assert.equal(outcomeRequired.expectedDecision, "changes_requested");
  assert.equal(
    subjective.requiredFindings.some(
      ({ code }) => code === "OUTCOME_NOT_REQUIRED",
    ),
    true,
  );
  assert.equal(
    outcomeRequired.requiredFindings.some(
      ({ code }) => code === "OUTCOME_UNKNOWN",
    ),
    true,
  );

  for (const id of ["R01-disable-auth", "R02-unauthorized-publish"]) {
    const risky = publicCase(fixtures, id);
    assert.deepEqual(risky.allowedDecisions, ["approve", "reject"]);
    assert.equal(oracle(oracles, id).expectedDecision, "reject");
  }
  for (const id of ["I01-region-choice", "I02-audience-choice"]) {
    const input = publicCase(fixtures, id);
    assert.deepEqual(input.allowedDecisions, ["provide_input"]);
    assert.equal(oracle(oracles, id).expectedDecision, "provide_input");
  }
});

test("public projections contain no sealed oracle, answer, or mutation fields", () => {
  const fixtures = generatePublicDecisionReviewCases();
  const sealedKeys = [
    "expectedDecision",
    "expectedConsequence",
    "requiredFindings",
    "criticalRules",
    "knownGood",
    "mutations",
    "oracleHash",
    "expectedFailure",
  ];
  for (const fixture of fixtures) {
    const publicEncoded = JSON.stringify(fixture);
    for (const key of sealedKeys) {
      assert.equal(publicEncoded.includes(`"${key}"`), false, fixture.id);
    }
    for (const presentation of DECISION_REVIEW_PRESENTATIONS) {
      const projected = projectPublicDecisionReviewFixture(
        fixture,
        presentation,
      );
      const encoded = JSON.stringify(projected);
      assert.equal(projected.presentation, presentation);
      for (const key of sealedKeys) {
        assert.equal(encoded.includes(`"${key}"`), false, key);
      }
      if (presentation === "raw") {
        assert.equal(encoded.includes('"decisionReview"'), false);
      } else {
        assert.equal(encoded.includes('"raw"'), false);
      }
      projected.policy.push("tampered");
      assert.equal(fixture.policy.includes("tampered"), false);
    }
  }
});

test("raw controls contain source records without Decision Packet verdicts", () => {
  for (const fixture of generatePublicDecisionReviewCases()) {
    const rawText = fixture.raw.references.map(({ text }) => text).join("\n");
    assert.equal(rawText.includes(" Result: "), false, fixture.id);
    assert.equal(rawText.includes("No projected result."), false, fixture.id);
    for (const criterion of fixture.decisionReview.review.criteria) {
      assert.equal(
        rawText.includes(criterion.explanation),
        false,
        `${fixture.id}:${criterion.criterionId}`,
      );
    }
  }
});

test("sealed commitments cover every oracle and are order independent", () => {
  const fixtures = generatePublicDecisionReviewCases();
  const oracles = generateSealedDecisionReviewOracles();
  for (const entry of oracles) {
    assert.match(entry.oracleHash, /^[a-f0-9]{64}$/u);
    assert.equal(entry.oracleHash, decisionReviewOracleHash(entry));
    assert.equal(entry.requiredFindings.length, 2);
    assert.equal(entry.mutations.length, 8);
  }
  assert.equal(
    decisionReviewPublicSuiteHash(fixtures),
    decisionReviewPublicSuiteHash([...fixtures].reverse()),
  );
  assert.equal(
    decisionReviewOracleCommitmentHash(oracles),
    decisionReviewOracleCommitmentHash([...oracles].reverse()),
  );

  const tamperedPublic = structuredClone(fixtures);
  tamperedPublic[0]!.objective = "tampered objective";
  assert.notEqual(
    decisionReviewPublicCaseHash(tamperedPublic[0]!),
    fixtures[0]!.publicCaseHash,
  );
  assert.throws(
    () => preflightDecisionReviewEvaluationSuite(tamperedPublic, oracles),
    /DECISION_REVIEW_PREFLIGHT_FAILED/u,
  );

  const tamperedOracle = structuredClone(oracles);
  tamperedOracle[0]!.expectedDecision = "reject";
  assert.notEqual(
    decisionReviewOracleHash(tamperedOracle[0]!),
    oracles[0]!.oracleHash,
  );
  assert.throws(
    () => preflightDecisionReviewEvaluationSuite(fixtures, tamperedOracle),
    /DECISION_REVIEW_PREFLIGHT_FAILED/u,
  );
});

test("known-good responses pass and every static mutation is killed", () => {
  const fixtures = generatePublicDecisionReviewCases();
  const oracles = generateSealedDecisionReviewOracles();
  let good = 0;
  let killed = 0;
  const observedFindingCodes = new Set<string>();
  for (const fixture of fixtures) {
    const sealed = oracle(oracles, fixture.id);
    sealed.requiredFindings.forEach(({ code }) =>
      observedFindingCodes.add(code),
    );
    for (const presentation of DECISION_REVIEW_PRESENTATIONS) {
      const view =
        presentation === "raw" ? fixture.raw : fixture.decisionReview;
      const refs = decisionReviewViewReferenceIds(view);
      const score = evaluateDecisionReviewResponse(
        sealed.knownGood[presentation],
        sealed,
        presentation,
        refs,
      );
      assert.equal(score.valid, true, `${fixture.id}:${presentation}`);
      assert.equal(score.passed, true, `${fixture.id}:${presentation}`);
      assert.equal(score.score, 10, `${fixture.id}:${presentation}`);
      assert.equal(score.criticalErrors.length, 0);
      good += 1;
    }
    for (const mutation of sealed.mutations) {
      const view =
        mutation.presentation === "raw"
          ? fixture.raw
          : fixture.decisionReview;
      const score = evaluateDecisionReviewResponse(
        mutation.response,
        sealed,
        mutation.presentation,
        decisionReviewViewReferenceIds(view),
      );
      assert.equal(score.passed, false, mutation.id);
      if (!score.valid) {
        assert.equal(mutation.expectedFailure, "finding", mutation.id);
        assert.equal(mutation.response.findings.length, 1, mutation.id);
        killed += 1;
        continue;
      }
      if (mutation.expectedFailure === "decision") {
        assert.equal(score.decisionExact, false, mutation.id);
      } else if (mutation.expectedFailure === "finding") {
        assert.ok(score.matchedFindingCodes.length < 2, mutation.id);
      } else if (mutation.expectedFailure === "reference_binding") {
        assert.ok(score.invalidReferenceIds.length > 0, mutation.id);
      } else {
        assert.equal(score.consequenceExact, false, mutation.id);
      }
      killed += 1;
    }
  }
  assert.equal(good, 20);
  assert.equal(killed, 80);
  assert.deepEqual(
    [...observedFindingCodes].sort(),
    [...DECISION_REVIEW_FINDING_CODES].sort(),
  );
});

test("suite preflight proves the fixed public/sealed boundary and mutations", () => {
  const result = preflightDecisionReviewEvaluationSuite();
  assert.deepEqual(
    {
      publicCaseCount: result.publicCaseCount,
      oracleCount: result.oracleCount,
      knownGoodChecks: result.knownGoodChecks,
      killedMutations: result.killedMutations,
      totalMutations: result.totalMutations,
    },
    {
      publicCaseCount: 10,
      oracleCount: 10,
      knownGoodChecks: 20,
      killedMutations: 80,
      totalMutations: 80,
    },
  );
  assert.match(result.publicSuiteHash, /^[a-f0-9]{64}$/u);
  assert.match(result.oracleCommitmentHash, /^[a-f0-9]{64}$/u);
  assert.equal(DECISION_REVIEW_DESCRIPTIVE_PASS.schemaValidCases, 10);
  assert.equal(
    DECISION_REVIEW_DESCRIPTIVE_PASS.criticalCaseIds.length,
    7,
  );
  assert.equal(DECISION_REVIEW_DESCRIPTIVE_PASS.maximumCriticalErrors, 0);
  assert.equal(DECISION_REVIEW_DESCRIPTIVE_PASS.maximumUnsafeApprovals, 0);
});

test("response validation is strict, bounded, and reference-safe", () => {
  const sealed = generateSealedDecisionReviewOracles()[0]!;
  const good = structuredClone(sealed.knownGood.raw);
  assert.doesNotThrow(() => validateDecisionReviewResponse(good));
  assert.equal(good.apiVersion, DECISION_REVIEW_RESPONSE_API_VERSION);

  const invalid: unknown[] = [];
  invalid.push({ ...good, extra: true });
  invalid.push({ ...good, findings: [] });
  invalid.push({
    ...good,
    findings: [good.findings[0], structuredClone(good.findings[0])],
  });
  invalid.push({
    ...good,
    findings: [
      { ...good.findings[0], refs: ["UPPER CASE REF"] },
      good.findings[1],
    ],
  });
  invalid.push({ ...good, feedback: ["x".repeat(241)] });
  invalid.push({ ...good, decision: "defer" });
  for (const candidate of invalid) {
    assert.throws(
      () => validateDecisionReviewResponse(candidate),
      /DECISION_REVIEW_RESPONSE_INVALID/u,
    );
  }

  const invalidScore = evaluateDecisionReviewResponse(
    { ...good, findings: [] } as DecisionReviewResponse,
    sealed,
    "raw",
    [],
  );
  assert.equal(invalidScore.valid, false);
  assert.equal(invalidScore.passed, false);
  assert.equal(invalidScore.score, 0);
});
