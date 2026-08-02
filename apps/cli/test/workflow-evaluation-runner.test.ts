import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  createArtifactWorkflowStudyPlan,
  createWorkflowStudyPlan,
  runBoundWorkflowStudy,
  WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID,
  WORKFLOW_HYBRID_HOST_ORIENTATION_PLAN,
  WORKFLOW_STUDY_ENGINE_ROUTING_POLICY_VERSION,
  WORKFLOW_STUDY_HARNESS_VERSION,
  WORKFLOW_STUDY_PLAN_API_VERSION,
  workflowStudyValueHash,
} from "../src/workflow-evaluation/runner.ts";
import {
  CodexCliFeedbackProvider,
  CodexExecModelEngine,
  CODEX_EXEC_MODEL_PROTOCOL_SHA256,
  type CodexSpawnFunction,
  type SpawnedCodexProcess,
} from "../src/workflow-evaluation/codex-proxy.ts";
import { WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS } from "../src/workflow-evaluation/study.ts";
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
  assert.equal(
    first.bindings.codexFeedbackEngineProfileId,
    WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID,
  );
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
    sharedAcrossConditions: false,
    hostOwnedCanonicalPlanSha256: null,
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
  assert.throws(
    () =>
      createArtifactWorkflowStudyPlan({
        tasks,
        limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
        seed: 17,
        bindings: {
          ...bindings,
          candidateEngineId: WORKFLOW_CODEX_FEEDBACK_ENGINE_PROFILE_ID,
        },
      }),
    /must be distinct/u,
  );
});

test("hybrid C-level plans bind the closed role route, Codex transport, and shared host orientation", () => {
  const tasks = [
    generateReferenceArtifactSuite().find(
      ({ id }) => id === "product-package-medium-001",
    )!,
  ];
  const hybridBindings = {
    ...bindings,
    codexModelId: "gpt-5.6-terra",
    codexTimeoutMs: 180_000,
    codexMaxOutputBytes: 2_097_152,
    codexEngineProfileId: "codex-cli-c-level",
  };
  const plan = createArtifactWorkflowStudyPlan({
    tasks,
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 31,
    conditionSet: "hybrid_c_level_canary_v1",
    bindings: hybridBindings,
  });

  assert.equal(plan.liveReady, true);
  assert.equal(plan.bindings.codexFeedbackEngineProfileId, null);
  assert.equal(plan.conditionOrdering, "seeded_cyclic_latin_v1");
  assert.deepEqual(
    plan.conditions,
    WORKFLOW_HYBRID_C_LEVEL_CANARY_CONDITIONS.map(({ id }) => id),
  );
  assert.equal(plan.plannedTrajectories, 3);
  assert.equal(
    plan.orientationSamplingPolicy.hostOwnedCanonicalPlanSha256,
    createHash("sha256")
      .update(WORKFLOW_HYBRID_HOST_ORIENTATION_PLAN, "utf8")
      .digest("hex"),
  );
  assert.equal(
    plan.engineRoutingPolicy.version,
    WORKFLOW_STUDY_ENGINE_ROUTING_POLICY_VERSION,
  );
  assert.deepEqual(
    plan.engineRoutingPolicy.routes.map(
      ({ conditionId, coordinatorEngine, specialistEngine, repairEngine }) => ({
        conditionId,
        coordinatorEngine,
        specialistEngine,
        repairEngine,
      }),
    ),
    [
      {
        conditionId: "single-local-neutral-repeat",
        coordinatorEngine: "candidate",
        specialistEngine: "candidate",
        repairEngine: "candidate",
      },
      {
        conditionId: "team-local-neutral-repeat",
        coordinatorEngine: "candidate",
        specialistEngine: "candidate",
        repairEngine: "candidate",
      },
      {
        conditionId: "team-codex-c-level-neutral-repeat",
        coordinatorEngine: "codex",
        specialistEngine: "candidate",
        repairEngine: "candidate",
      },
    ],
  );
  assert.equal(
    plan.bindings.codexModelEngineProtocolSha256,
    CODEX_EXEC_MODEL_PROTOCOL_SHA256,
  );

  for (const changedBindings of [
    { codexModelId: "gpt-5.6-terra-other" },
    { codexTimeoutMs: 181_000 },
    { codexMaxOutputBytes: 2_097_153 },
    { codexEngineProfileId: "different-c-level" },
  ]) {
    const changed = createArtifactWorkflowStudyPlan({
      tasks,
      limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      seed: 31,
      conditionSet: "hybrid_c_level_canary_v1",
      bindings: { ...hybridBindings, ...changedBindings },
    });
    assert.notEqual(changed.planHash, plan.planHash);
  }

  assert.throws(
    () =>
      createArtifactWorkflowStudyPlan({
        tasks,
        limits: {
          ...DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
          maxTotalTokens: 10_000,
        },
        seed: 31,
        conditionSet: "hybrid_c_level_canary_v1",
        bindings: hybridBindings,
      }),
    /usage is unmeasured/u,
  );
  assert.throws(
    () =>
      createArtifactWorkflowStudyPlan({
        tasks,
        limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
        seed: 31,
        conditionSet: "hybrid_c_level_canary_v1",
        bindings: {
          ...hybridBindings,
          candidateEngineId: "codex-cli-c-level",
        },
      }),
    /must be distinct/u,
  );
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
          .sharedAcrossConditions = true;
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

test("standard study rejects an injected or mutable Codex feedback transport before candidate execution", async (t) => {
  const task = generateReferenceArtifactSuite()[0]!;
  const directory = mkdtempSync(join(tmpdir(), "workflow-feedback-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executablePath = join(directory, "codex-fixture.exe");
  const executableBytes = "fixture codex executable\n";
  writeFileSync(executablePath, executableBytes, "utf8");
  const executableSha256 = createHash("sha256")
    .update(executableBytes)
    .digest("hex");
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [task],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings: {
      ...bindings,
      codexExecutableSha256: executableSha256,
    },
  });
  let candidateCalls = 0;
  let spawnCalls = 0;
  const candidate: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "local-model",
      adapter: "scripted-local",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      candidateCalls += 1;
      return {
        invocationId: request.invocationId,
        text: JSON.stringify(task.oracleCandidate),
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          measurementStatus: "measured",
        },
      };
    },
  };
  const injectedFeedback = new CodexCliFeedbackProvider({
    executablePath,
    executableSha256,
    model: "gpt-test",
    environment: { HOME: directory, CODEX_HOME: directory },
    spawn: () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });

  await assert.rejects(
    runBoundWorkflowStudy({
      plan,
      taskBindings: [{ kind: "artifact", task }],
      limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      engine: candidate,
      codex: injectedFeedback,
    }),
    /WORKFLOW_STUDY_PLAN_BINDING_MISMATCH/u,
  );
  assert.equal(candidateCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("bound hybrid runner rejects spoofed and injected C-level transports before either engine starts", async (t) => {
  const task = generateReferenceArtifactSuite().find(
    ({ id }) => id === "product-package-medium-001",
  )!;
  const directory = mkdtempSync(join(tmpdir(), "workflow-runner-codex-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executablePath = join(directory, "codex-fixture.exe");
  const executableBytes = "fixture codex executable\n";
  writeFileSync(executablePath, executableBytes, "utf8");
  const executableSha256 = createHash("sha256")
    .update(executableBytes)
    .digest("hex");
  const hybridBindings = {
    ...bindings,
    codexExecutableSha256: executableSha256,
    codexModelId: "gpt-5.6-terra",
    codexMaxOutputBytes: 1_048_576,
    codexEngineProfileId: "codex-cli-c-level",
  };
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [task],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 31,
    conditionSet: "hybrid_c_level_canary_v1",
    bindings: hybridBindings,
  });
  const localRequests: InferenceRequest[] = [];
  const codexPrompts: string[] = [];
  const cLevelCallCounts = new Map<string, number>();
  const scriptedEngine = (
    profileId: string,
    modelId: string,
    requests: InferenceRequest[],
  ): ModelEngine => ({
    manifest: {
      kind: "model_engine",
      profileId,
      adapter: profileId === "local-model" ? "scripted-local" : "codex-cli-exec",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request): Promise<InferenceResult> {
      requests.push(request);
      const system = request.messages.find(({ role }) => role === "system")
        ?.content ?? "";
      const schemaProperties = request.responseSchema?.properties as
        | Record<string, unknown>
        | undefined;
      let text: string;
      if (system.includes("You are worker role")) {
        text = "The public artifact contract is complete and internally consistent.";
      } else if (schemaProperties && "action" in schemaProperties) {
        const count = (cLevelCallCounts.get(profileId) ?? 0) + 1;
        cLevelCallCounts.set(profileId, count);
        text = count % 2 === 1
          ? JSON.stringify({
              action: "dispatch",
              reason: "Ask the declared specialist to verify the public contract.",
              recipients: [
                {
                  role: "specialist",
                  instruction: "Verify every public acceptance criterion and the output contract.",
                  artifactAccess: "read_only",
                },
              ],
            })
          : JSON.stringify({
              action: "request_review",
              reason: "The specialist verification is complete.",
              artifact: task.oracleCandidate,
            });
      } else {
        text = JSON.stringify(task.oracleCandidate);
      }
      return {
        invocationId: request.invocationId,
        text,
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          measurementStatus: "measured",
        },
        providerIdentity: {
          reportedModelId: modelId,
          reportedSystemFingerprint: `${profileId}-fixture-v1`,
        },
      };
    },
  });
  const local = scriptedEngine(
    "local-model",
    "local/model-q4",
    localRequests,
  );
  let codexCall = 0;
  const codexSpawn: CodexSpawnFunction = (
    _spawnExecutable,
    args,
  ) => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const promptChunks: Buffer[] = [];
    stdin.on("data", (chunk) => promptChunks.push(Buffer.from(chunk)));
    stdin.once("finish", () => {
      codexPrompts.push(Buffer.concat(promptChunks).toString("utf8"));
      const outputIndex = args.indexOf("--output-last-message");
      assert.notEqual(outputIndex, -1);
      const outputPath = args[outputIndex + 1];
      assert.equal(typeof outputPath, "string");
      codexCall += 1;
      const output = codexCall % 2 === 1
        ? {
            action: "dispatch",
            reason: "Ask the declared specialist to verify the public contract.",
            recipients: [
              {
                role: "specialist",
                instruction: "Verify every public acceptance criterion and the output contract.",
                artifactAccess: "read_only",
              },
            ],
          }
        : {
            action: "request_review",
            reason: "The specialist verification is complete.",
            artifact: task.oracleCandidate,
          };
      writeFileSync(outputPath!, JSON.stringify(output), "utf8");
      queueMicrotask(() => events.emit("close", 0, null));
    });
    return {
      stdin,
      stdout,
      stderr,
      on: events.on.bind(events),
      once: events.once.bind(events),
      kill(signal): boolean {
        queueMicrotask(() => events.emit("close", null, signal ?? "SIGTERM"));
        return true;
      },
    } as unknown as SpawnedCodexProcess;
  };
  const codexEngine = new CodexExecModelEngine({
    profileId: "codex-cli-c-level",
    executablePath,
    executableSha256,
    model: "gpt-5.6-terra",
    timeoutMs: 120_000,
    maxOutputBytes: 1_048_576,
    spawn: codexSpawn,
    environment: { HOME: directory, CODEX_HOME: directory },
    temporaryRoot: directory,
  });
  const codexFeedback = {
    providerId: "codex-cli-ordinary-user",
    actorType: "simulated_user_proxy",
    mayResolveHumanApproval: false,
    executableSha256,
    model: "gpt-5.6-terra",
    timeoutMs: 120_000,
    maxOutputBytes: 1_048_576,
  };

  await assert.rejects(
    runBoundWorkflowStudy({
      plan,
      taskBindings: [{ kind: "artifact", task }],
      limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      engine: local,
      codex: codexFeedback as never,
      cLevelEngine: {
        ...codexEngine,
        manifest: codexEngine.manifest,
        executableSha256,
        model: codexEngine.model,
        timeoutMs: codexEngine.timeoutMs,
        maxOutputBytes: codexEngine.maxOutputBytes,
      } as never,
    }),
    /WORKFLOW_STUDY_C_LEVEL_ENGINE_BINDING_MISMATCH/u,
  );

  await assert.rejects(
    runBoundWorkflowStudy({
      plan,
      taskBindings: [{ kind: "artifact", task }],
      limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
      engine: local,
      codex: codexFeedback as never,
      cLevelEngine: codexEngine,
    }),
    /WORKFLOW_STUDY_C_LEVEL_ENGINE_BINDING_MISMATCH/u,
  );
  assert.equal(localRequests.length, 0);
  assert.equal(codexPrompts.length, 0);
});
