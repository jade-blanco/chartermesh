import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifactWorkflowStudyPlan,
  createWorkflowStudyPlan,
  runBoundWorkflowStudy,
  WORKFLOW_STUDY_HARNESS_VERSION,
  WORKFLOW_STUDY_PLAN_API_VERSION,
  workflowStudyValueHash,
} from "../src/workflow-evaluation/runner.ts";
import {
  fixedWorkflowTeam,
  WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION,
  WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS,
  WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
  WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
  WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION,
  WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256,
  WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
  WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
  WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
  WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
  WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
  WORKFLOW_TEAM_MAX_HANDOFFS,
  WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
  WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
  WORKFLOW_TEAM_MAX_PARALLEL,
  WORKFLOW_TEAM_MAX_STAGE_CALLS,
  WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
  WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
  WORKFLOW_TEAM_PROTOCOL_VERSION,
} from "../src/workflow-evaluation/model-executors.ts";
import { generateReferenceCodeWorkflowSuite } from "../src/workflow-evaluation/code-adapters.ts";
import { generateReferenceArtifactSuite } from "../src/workflow-evaluation/suite.ts";
import { DEFAULT_WORKFLOW_TRAJECTORY_LIMITS } from "../src/workflow-evaluation/trajectory.ts";

const bindings = {
  candidateEngineId: "local-model",
  candidateRuntimeProfileHash: "1".repeat(64),
  candidateConfiguredModelId: "local/model-q4",
  codexExecutableSha256: "2".repeat(64),
  codexModelId: "gpt-test",
  codexTimeoutMs: 120_000,
};

test("workflow plan hash deterministically binds sealed fixtures, limits, and engines", () => {
  const tasks = [generateReferenceArtifactSuite()[0]!];
  const first = createArtifactWorkflowStudyPlan({
    tasks,
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings,
  });
  const second = createArtifactWorkflowStudyPlan({
    tasks: structuredClone(tasks),
    limits: { ...DEFAULT_WORKFLOW_TRAJECTORY_LIMITS },
    seed: 17,
    bindings: { ...bindings },
  });
  assert.deepEqual(first, second);
  assert.equal(first.liveReady, true);
  assert.equal(first.conditionOrdering, "seeded_williams_square_v1");
  assert.equal(first.apiVersion, WORKFLOW_STUDY_PLAN_API_VERSION);
  assert.equal(first.harnessVersion, WORKFLOW_STUDY_HARNESS_VERSION);
  assert.deepEqual(first.responseSchemaPolicy, {
    version: WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
    maximumGrammarRepetition: WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
    oversizedBoundAction: WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
    acceptedOutputValidation: "original_application_contract",
    repetitionKeywords: [...WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS],
  });
  assert.deepEqual(first.teamProtocolPolicy, {
    version: WORKFLOW_TEAM_PROTOCOL_VERSION,
    setup: "fixed_host_owned_two_role",
    finalSubmission: "caller_owned_typed_object",
    dispatchRoleConstraint: "declared_worker_enum",
    reviewRequiresHandoff: true,
    fixedTeamSha256: {
      artifact: workflowStudyValueHash(fixedWorkflowTeam("artifact")),
      code: workflowStudyValueHash(fixedWorkflowTeam("code")),
    },
    controller: {
      maxInternalCycles: WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
      maxHandoffs: WORKFLOW_TEAM_MAX_HANDOFFS,
      maxStageCalls: WORKFLOW_TEAM_MAX_STAGE_CALLS,
      maxParallel: WORKFLOW_TEAM_MAX_PARALLEL,
      maxOutputTokensPerCall: WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
      maxDirectiveChars: WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
      maxWorkerResponseChars: WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
      maxTranscriptChars: WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
    },
  });
  assert.deepEqual(first.artifactRetentionPolicy, {
    version: WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION,
    nextRevisionBaseline: "last_contract_valid",
    sealedScoreInfluencesRetention: false,
  });
  assert.deepEqual(first.contractRepairPolicy, {
    version: WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION,
    maximumAttempts: WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS,
    appliesTo: "single_and_team_artifact_and_code",
    trigger: "public_contract_or_transport_invalid_and_budget_available",
    diagnosticDisclosure: "public_codes_only",
    maximumInvalidCandidateChars:
      WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
    maximumOutputTokensPerCall: WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
    finishReasonPolicy: "stop_required",
    budgetBehavior: "skip_without_call",
    promptSha256: WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256,
  });
  assert.deepEqual(first.orientationSamplingPolicy, {
    designSeedPurpose: "task_and_condition_order_only",
    inferenceSampling: "provider_default_uncontrolled",
    sharedAcrossFeedbackPolicies: false,
  });
  assert.match(first.feedbackInterventionHashes.neutralRepeat, /^[a-f0-9]{64}$/u);
  assert.match(first.feedbackInterventionHashes.fixedSelfReview, /^[a-f0-9]{64}$/u);
  assert.match(first.feedbackInterventionHashes.codexGeneralist, /^[a-f0-9]{64}$/u);
  assert.match(first.planHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    first.studyId,
    `collaboration-study-${first.planHash.slice(0, 16)}`,
  );

  const differentLimit = createArtifactWorkflowStudyPlan({
    tasks,
    limits: {
      ...DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      maxFeedbackRounds: 51,
    },
    seed: 17,
    bindings,
  });
  assert.notEqual(differentLimit.planHash, first.planHash);

  for (const changed of [
    { maxWallClockMs: first.limits.maxWallClockMs + 1_000 },
    { maxTotalTokens: 12_345 },
    { identicalArtifactLimit: first.limits.identicalArtifactLimit + 1 },
    {
      maxConsecutiveContractInvalidSubmissions:
        first.limits.maxConsecutiveContractInvalidSubmissions + 1,
    },
    { maxParallelAgents: first.limits.maxParallelAgents + 1 },
  ]) {
    const changedPlan = createArtifactWorkflowStudyPlan({
      tasks,
      limits: { ...DEFAULT_WORKFLOW_TRAJECTORY_LIMITS, ...changed },
      seed: 17,
      bindings,
    });
    assert.notEqual(changedPlan.planHash, first.planHash);
  }

  const differentSealedFixture = createArtifactWorkflowStudyPlan({
    tasks: [generateReferenceArtifactSuite(99)[0]!],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings,
  });
  assert.notEqual(differentSealedFixture.suiteHash, first.suiteHash);
  assert.notEqual(differentSealedFixture.planHash, first.planHash);
});

test("mixed plans bind semantic tasks, attested code tasks, and VM provenance", () => {
  const artifact = generateReferenceArtifactSuite()[0]!;
  const code = generateReferenceCodeWorkflowSuite()[0]!;
  const plan = createWorkflowStudyPlan({
    taskBindings: [
      { kind: "artifact", task: artifact },
      { kind: "code", task: code },
    ],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings: {
      ...bindings,
      codeSandboxId: "windows-sandbox-protected-client",
      codeSandboxProvenanceHash: "3".repeat(64),
      codeSandboxLauncherCommitment: "5".repeat(64),
      codeSandboxLauncherAttestation: "file_sha256",
    },
  });
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.codeBoundary, "attested_vm_only");
  assert.equal(plan.liveReady, true);
  assert.deepEqual(
    plan.tasks.map(({ executionBoundary }) => executionBoundary),
    ["semantic_ir", "attested_vm"],
  );

  const differentVm = createWorkflowStudyPlan({
    taskBindings: [
      { kind: "artifact", task: artifact },
      { kind: "code", task: code },
    ],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings: {
      ...bindings,
      codeSandboxId: "windows-sandbox-protected-client",
      codeSandboxProvenanceHash: "4".repeat(64),
      codeSandboxLauncherCommitment: "5".repeat(64),
      codeSandboxLauncherAttestation: "file_sha256",
    },
  });
  assert.notEqual(differentVm.planHash, plan.planHash);

  const unresolvedLauncher = createWorkflowStudyPlan({
    taskBindings: [{ kind: "code", task: code }],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings: {
      ...bindings,
      codeSandboxId: "windows-sandbox-protected-client",
      codeSandboxProvenanceHash: "3".repeat(64),
      codeSandboxLauncherCommitment: "5".repeat(64),
      codeSandboxLauncherAttestation: "command_name_only",
    },
  });
  assert.equal(unresolvedLauncher.liveReady, false);
});

test("an unbound dry plan cannot be mistaken for a live-ready approval", () => {
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [generateReferenceArtifactSuite()[0]!],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
  });
  assert.equal(plan.liveReady, false);
  assert.equal(plan.bindings.candidateEngineId, null);
  assert.equal(plan.bindings.codexExecutableSha256, null);
});

test("live execution rejects rehashed plans with stale protocol commitments", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [task],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings,
  });
  const asRecord = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const tamperCases: Array<{
    name: string;
    mutate: (candidate: Record<string, unknown>) => void;
  }> = [
    {
      name: "response schema repetition limit",
      mutate(candidate) {
        asRecord(candidate.responseSchemaPolicy).maximumGrammarRepetition = 999;
      },
    },
    {
      name: "fixed artifact team hash",
      mutate(candidate) {
        asRecord(asRecord(candidate.teamProtocolPolicy).fixedTeamSha256)
          .artifact = "f".repeat(64);
      },
    },
    {
      name: "team controller cycle limit",
      mutate(candidate) {
        asRecord(asRecord(candidate.teamProtocolPolicy).controller)
          .maxInternalCycles = 99;
      },
    },
    {
      name: "contract repair attempt limit",
      mutate(candidate) {
        asRecord(candidate.contractRepairPolicy).maximumAttempts = 2;
      },
    },
    {
      name: "contract repair prompt hash",
      mutate(candidate) {
        asRecord(candidate.contractRepairPolicy).promptSha256 = "f".repeat(64);
      },
    },
    {
      name: "orientation sampling disclosure",
      mutate(candidate) {
        asRecord(candidate.orientationSamplingPolicy)
          .sharedAcrossFeedbackPolicies = true;
      },
    },
  ];

  for (const tamperCase of tamperCases) {
    const tampered = structuredClone(plan) as unknown as Record<string, unknown>;
    tamperCase.mutate(tampered);
    const {
      studyId: _studyId,
      planHash: _planHash,
      liveReady: _liveReady,
      ...committed
    } = tampered;
    const forgedHash = workflowStudyValueHash(committed);
    tampered.planHash = forgedHash;
    tampered.studyId = `collaboration-study-${forgedHash.slice(0, 16)}`;

    await assert.rejects(
      runBoundWorkflowStudy({
        plan: tampered as never,
        taskBindings: [{ kind: "artifact", task }],
        limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
        engine: {} as never,
        codex: {} as never,
      }),
      /WORKFLOW_STUDY_PLAN_INTEGRITY_MISMATCH/u,
      tamperCase.name,
    );
  }
});

test("live execution rejects an unbound role-engine resolver", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [task],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings,
  });

  await assert.rejects(
    runBoundWorkflowStudy({
      plan,
      taskBindings: [{ kind: "artifact", task }],
      limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      engine: {} as never,
      codex: {} as never,
      engineForRole: () => ({}) as never,
    }),
    /WORKFLOW_STUDY_UNBOUND_ROLE_ENGINE_RESOLVER/u,
  );
});
