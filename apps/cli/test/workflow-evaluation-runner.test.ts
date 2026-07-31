import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifactWorkflowStudyPlan,
  createWorkflowStudyPlan,
  runBoundWorkflowStudy,
  workflowStudyValueHash,
} from "../src/workflow-evaluation/runner.ts";
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

test("live execution rejects a rehashed plan using stale protocol constants", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const plan = createArtifactWorkflowStudyPlan({
    tasks: [task],
    limits: DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
    seed: 17,
    bindings,
  });
  const tampered = structuredClone(plan) as unknown as Record<string, unknown>;
  tampered.feedbackAdapterVersion = "stale-feedback-adapter";
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
  );
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
