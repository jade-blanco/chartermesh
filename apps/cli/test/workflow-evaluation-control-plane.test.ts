import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";
import {
  PeerTeamController,
  type PeerTeamSetup,
} from "../../../packages/runtime/src/index.ts";
import { createControlPlaneWorkflowStudyPersistence } from "../src/workflow-evaluation/control-plane-persistence.ts";
import { generateReferenceArtifactSuite } from "../src/workflow-evaluation/suite.ts";
import type { WorkflowTrajectoryReport } from "../src/workflow-evaluation/types.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  measurementStatus: "measured",
};

function result(request: InferenceRequest, text: string): InferenceResult {
  return {
    invocationId: request.invocationId,
    text,
    toolCalls: [],
    finishReason: "stop",
    usage,
    providerIdentity: {
      reportedModelId: "scripted-model",
      reportedSystemFingerprint: "fixture-v1",
    },
  };
}

test("peer-team stages, invocations, handoff hashes, and final evidence are durable in an isolated Control Plane", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-control-plane-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  let cLevelCalls = 0;
  const baseEngine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "scripted-peer-engine",
      adapter: "scripted-test",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      const system = request.messages.find(({ role }) => role === "system")?.content ?? "";
      if (system.includes("You are worker role")) {
        return result(request, "Worker checked the bounded requirements.");
      }
      cLevelCalls += 1;
      return result(
        request,
        cLevelCalls === 1
          ? JSON.stringify({
              action: "dispatch",
              reason: "Obtain a peer check.",
              recipients: [
                {
                  role: "maker",
                  instruction: "Check the bounded public contract.",
                  artifactAccess: "read_only",
                },
              ],
            })
          : JSON.stringify({
              action: "request_review",
              reason: "The peer check was incorporated.",
              artifact: {
                apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
                summary: "Ready for synthetic evaluation.",
                deliverable: "candidate-output",
                checks: ["Peer handoff completed."],
                risks: ["Synthetic fixture."],
                nextActions: ["Inspect sealed result."],
                confidence: "medium",
              },
            }),
      );
    },
  };
  const task = generateReferenceArtifactSuite()[0]!;
  const persistence = createControlPlaneWorkflowStudyPersistence({
    controlPlane,
    configuredModelId: "scripted-model",
    maxChildrenPerTrial: 32,
  });
  const runtime = await persistence.prepare({
    studyId: "study-durable-peer",
    trialId: "study-durable-peer:trial-1",
    task,
    architecture: "team",
    feedbackPolicy: "neutral_repeat",
    conditionId: "team-neutral-repeat",
    engineRoute: "all-local-team",
    engine: baseEngine,
  });
  const team: PeerTeamSetup = {
    cLevelRole: "chief",
    roles: [
      {
        id: "chief",
        name: "Chief",
        class: "c_level",
        description: "Coordinates the team.",
      },
      {
        id: "maker",
        name: "Maker",
        class: "worker",
        description: "Checks the candidate.",
      },
    ],
  };
  const observedStages: Array<Record<string, unknown>> = [];
  const baseLifecycle = runtime.runContext.lifecycle!;
  const lifecycle = {
    ...baseLifecycle,
    startStage: async (stage: Parameters<NonNullable<typeof baseLifecycle.startStage>>[0]) => {
      observedStages.push(stage as unknown as Record<string, unknown>);
      return await baseLifecycle.startStage?.(stage);
    },
  };
  const peerResult = await new PeerTeamController({
    maxStageCalls: 8,
  }).run(
    {
      taskPacket: {
        objective: task.objective,
        context: "Synthetic offline fixture.",
        acceptanceCriteria: task.publicInstructions,
      },
      organizationRevision: 1,
      workItemId: runtime.runContext.workItemId,
      runId: runtime.runContext.runId,
      attemptId: runtime.runContext.attemptId,
      generation: runtime.runContext.generation,
    },
    {
      team,
      engine: runtime.engine,
      lifecycle,
    },
  );

  const attempts = controlPlane.listAttempts(runtime.runContext.runId);
  assert.equal(attempts.length, 4);
  assert.equal(
    attempts.filter(({ kind, status }) =>
      kind === "delegated" && status === "succeeded"
    ).length,
    3,
  );
  assert.equal(controlPlane.listInvocations().length, 3);
  assert.match(
    String(observedStages.find(({ role }) => role === "maker")?.envelopeHash),
    /^[a-f0-9]{64}$/u,
  );
  const audit = controlPlane.auditRecordsPage({ afterId: 0, limit: 1_000 });
  const handoffEvent = audit.find(
    ({ type, payload }) =>
      type === "attempt.delegated.started" &&
      typeof payload.handoffHash === "string",
  );
  assert.ok(handoffEvent, JSON.stringify(audit, null, 2));
  assert.match(String(handoffEvent?.payload.handoffHash), /^[a-f0-9]{64}$/u);
  assert.equal(handoffEvent?.payload.stageIndex, 1);
  assert.equal(handoffEvent?.payload.cycle, 1);
  assert.equal(handoffEvent?.payload.stageKind, "worker");

  await runtime.recordExecution?.({
    submission: 1,
    directiveHash: "d".repeat(64),
    result: {
      artifact: peerResult.artifact.deliverable,
      humanView: "Candidate output for a person.",
      contractValid: false,
      cLevelReviewRequested: true,
      handoffs: peerResult.metrics.handoffCount,
      maxObservedConcurrency: peerResult.metrics.maxObservedParallel,
      protocolViolations: [],
      safety: {
        unauthorizedExternalEffects: 0,
        workspaceEscapes: 0,
        secretAccesses: 0,
        oracleLeaks: 0,
        duplicateExecutions: 0,
        sandboxCanaryFailures: 0,
      },
      latencyMs: 1,
      modelCalls: peerResult.metrics.stageCalls,
      usage: peerResult.metrics.usage,
    },
  });
  await runtime.finalize({
    trialId: "study-durable-peer:trial-1",
    feedbackPolicy: "neutral_repeat",
    outcome: {
      feedbackRoundCount: 0,
      internalModelCallCount: 3,
      totalInputTokens: 6,
      totalOutputTokens: 9,
    },
  } as WorkflowTrajectoryReport);
  assert.equal(
    controlPlane.get(runtime.runContext.workItemId).status,
    "review_pending",
  );
  const evidence = controlPlane.latestArtifact(runtime.runContext.workItemId);
  assert.ok(evidence);
  assert.match(evidence.content, /candidate-output/u);
  assert.match(evidence.content, /latestExecution/u);
  const evidenceValue = JSON.parse(evidence.content) as {
    trial: WorkflowTrajectoryReport;
  };
  assert.equal(evidenceValue.trial.outcome.internalModelCallCount, 3);
  assert.equal(evidenceValue.trial.outcome.totalInputTokens, 6);
  assert.equal(evidenceValue.trial.outcome.totalOutputTokens, 9);
});

test("local and Codex engines share one durable registry and produce exact per-engine accounting", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "workflow-mixed-engine-accounting-"),
  );
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  const localEngine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "local-specialist",
      adapter: "scripted-local",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return {
        ...result(request, "local specialist result"),
        providerIdentity: {
          reportedModelId: "gemma-local",
          reportedSystemFingerprint: "local-fixture-v1",
        },
      };
    },
  };
  const unknownUsage: InferenceResult["usage"] = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus: "unknown",
  };
  const codexEngine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "codex-c-level",
      adapter: "scripted-codex-exec",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return {
        invocationId: request.invocationId,
        text: "Codex C-level result",
        toolCalls: [],
        finishReason: request.invocationId.endsWith("canceled")
          ? "canceled"
          : "stop",
        usage: unknownUsage,
        providerIdentity: {
          reportedModelId: "gpt-5.6-terra",
          reportedSystemFingerprint: "codex-fixture-v1",
        },
      };
    },
  };
  const task = generateReferenceArtifactSuite()[0]!;
  const runtime = await createControlPlaneWorkflowStudyPersistence({
    controlPlane,
    configuredModelId: "gemma-local",
    maxChildrenPerTrial: 8,
  }).prepare({
    studyId: "study-mixed-engine-accounting",
    trialId: "study-mixed-engine-accounting:trial-1",
    task,
    architecture: "team",
    feedbackPolicy: "neutral_repeat",
    conditionId: "hybrid-neutral-repeat",
    engineRoute: "codex-c-level-local-worker-team",
    engine: localEngine,
  });
  const wrappedCodex = runtime.wrapEngine({
    engine: codexEngine,
    configuredModelId: "gpt-5.6-terra",
  });
  assert.equal(
    runtime.wrapEngine({
      engine: localEngine,
      configuredModelId: "gemma-local",
    }),
    runtime.engine,
  );
  assert.equal(
    runtime.wrapEngine({
      engine: codexEngine,
      configuredModelId: "gpt-5.6-terra",
    }),
    wrappedCodex,
  );

  await runtime.engine.generate({
    invocationId: "local-success",
    messages: [{ role: "user", content: "Run the local specialist." }],
  });
  await wrappedCodex.generate({
    invocationId: "codex-success",
    messages: [{ role: "user", content: "Run the Codex C-level." }],
  });
  await wrappedCodex.generate({
    invocationId: "codex-canceled",
    messages: [{ role: "user", content: "Record a canceled C-level call." }],
  });

  const invocations = controlPlane.listInvocations();
  assert.equal(invocations.length, 3);
  assert.equal(
    invocations.every(
      ({ attemptId }) => attemptId === runtime.runContext.attemptId,
    ),
    true,
  );
  assert.equal(invocations.every(({ status }) => status !== "running"), true);
  assert.equal(invocations.every(({ finishedAt }) => finishedAt !== null), true);
  assert.deepEqual(
    invocations
      .map(({ engineId, modelId, status }) => ({ engineId, modelId, status }))
      .sort((left, right) =>
        `${left.engineId}:${left.status}`.localeCompare(
          `${right.engineId}:${right.status}`,
        )
      ),
    [
      {
        engineId: "codex-c-level",
        modelId: "gpt-5.6-terra",
        status: "canceled",
      },
      {
        engineId: "codex-c-level",
        modelId: "gpt-5.6-terra",
        status: "succeeded",
      },
      {
        engineId: "local-specialist",
        modelId: "gemma-local",
        status: "succeeded",
      },
    ],
  );

  assert.throws(
    () =>
      runtime.finalize({
        trialId: "study-mixed-engine-accounting:trial-1",
        conditionId: "hybrid-neutral-repeat",
        engineRoute: "codex-c-level-local-worker-team",
        feedbackPolicy: "neutral_repeat",
        engineAccounting: [],
        outcome: {
          feedbackRoundCount: 0,
          internalModelCallCount: 2,
          totalInputTokens: null,
          totalOutputTokens: null,
        },
      } as WorkflowTrajectoryReport),
    /WORKFLOW_STUDY_INVOCATION_ACCOUNTING_MISMATCH/u,
  );

  await runtime.finalize({
    trialId: "study-mixed-engine-accounting:trial-1",
    conditionId: "hybrid-neutral-repeat",
    engineRoute: "codex-c-level-local-worker-team",
    feedbackPolicy: "neutral_repeat",
    engineAccounting: [],
    outcome: {
      feedbackRoundCount: 0,
      internalModelCallCount: 3,
      totalInputTokens: null,
      totalOutputTokens: null,
    },
  } as WorkflowTrajectoryReport);

  const evidence = controlPlane.latestArtifact(runtime.runContext.workItemId);
  assert.ok(evidence);
  const trial = (JSON.parse(evidence.content) as {
    trial: WorkflowTrajectoryReport;
  }).trial;
  assert.equal(trial.outcome.internalModelCallCount, 3);
  assert.equal(trial.outcome.totalInputTokens, null);
  assert.equal(trial.outcome.totalOutputTokens, null);
  const codexAccounting = trial.engineAccounting.find(
    ({ engineProfileId }) => engineProfileId === "codex-c-level",
  );
  const localAccounting = trial.engineAccounting.find(
    ({ engineProfileId }) => engineProfileId === "local-specialist",
  );
  assert.deepEqual(
    codexAccounting && {
      ...codexAccounting,
      elapsedMs: Number(codexAccounting.elapsedMs >= 0),
    },
    {
      engineProfileId: "codex-c-level",
      modelId: "gpt-5.6-terra",
      calls: 2,
      succeeded: 1,
      failed: 0,
      canceled: 1,
      abandoned: 0,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      elapsedMs: 1,
      measurementStatus: "unknown",
      evidenceSource: "control_plane_invocation",
    },
  );
  assert.deepEqual(
    localAccounting && {
      ...localAccounting,
      elapsedMs: Number(localAccounting.elapsedMs >= 0),
    },
    {
      engineProfileId: "local-specialist",
      modelId: "gemma-local",
      calls: 1,
      succeeded: 1,
      failed: 0,
      canceled: 0,
      abandoned: 0,
      inputTokens: 2,
      outputTokens: 3,
      cost: 0,
      elapsedMs: 1,
      measurementStatus: "measured",
      evidenceSource: "control_plane_invocation",
    },
  );
  assert.equal(
    controlPlane.listInvocations().every(({ status }) => status !== "running"),
    true,
  );
});

test("a failed first Codex review keeps total token usage unknown", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-codex-accounting-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "scripted-single-engine",
      adapter: "scripted-test",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return result(request, "candidate");
    },
  };
  const task = generateReferenceArtifactSuite()[0]!;
  const runtime = await createControlPlaneWorkflowStudyPersistence({
    controlPlane,
    configuredModelId: "scripted-model",
    maxChildrenPerTrial: 8,
    codexFeedbackAccounting: {
      engineProfileId: "codex-cli-ordinary-user",
      modelId: "gpt-feedback",
    },
  }).prepare({
    studyId: "study-codex-accounting",
    trialId: "study-codex-accounting:trial-1",
    task,
    architecture: "single",
    feedbackPolicy: "codex_generalist",
    conditionId: "single-codex-generalist",
    engineRoute: "local-single",
    engine,
  });
  await runtime.engine.generate({
    invocationId: "candidate-call",
    messages: [{ role: "user", content: "Generate one candidate." }],
  });
  await runtime.finalize({
    trialId: "study-codex-accounting:trial-1",
    conditionId: "single-codex-generalist",
    engineRoute: "local-single",
    feedbackPolicy: "codex_generalist",
    feedbackDirectives: [],
    engineAccounting: [],
    outcome: {
      feedbackRoundCount: 0,
      internalModelCallCount: 2,
      totalInputTokens: null,
      totalOutputTokens: null,
      censorReason: "execution_error",
      failure: {
        phase: "feedback",
        code: "CODEX_PROXY_EXIT_NONZERO",
        stage: null,
        stageIndex: null,
        cycle: null,
        role: null,
      },
    },
  } as WorkflowTrajectoryReport);
  const evidence = controlPlane.latestArtifact(runtime.runContext.workItemId);
  assert.ok(evidence);
  const trial = (JSON.parse(evidence.content) as {
    trial: WorkflowTrajectoryReport;
  }).trial;
  assert.equal(trial.outcome.internalModelCallCount, 2);
  assert.equal(trial.outcome.totalInputTokens, null);
  assert.equal(trial.outcome.totalOutputTokens, null);
  assert.deepEqual(
    trial.engineAccounting.find(
      ({ evidenceSource }) => evidenceSource === "derived_feedback_proxy",
    ),
    {
      engineProfileId: "codex-cli-ordinary-user",
      modelId: "gpt-feedback",
      calls: 1,
      succeeded: 0,
      failed: 1,
      canceled: 0,
      abandoned: 0,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      elapsedMs: null,
      measurementStatus: "unknown",
      evidenceSource: "derived_feedback_proxy",
    },
  );
});

test("successful Codex feedback is represented by explicit unknown-usage accounting", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-codex-success-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "scripted-local-engine",
      adapter: "scripted-test",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return result(request, "candidate");
    },
  };
  const task = generateReferenceArtifactSuite()[0]!;
  const runtime = await createControlPlaneWorkflowStudyPersistence({
    controlPlane,
    configuredModelId: "scripted-model",
    maxChildrenPerTrial: 8,
    codexFeedbackAccounting: {
      engineProfileId: "codex-cli-ordinary-user",
      modelId: "gpt-feedback",
    },
  }).prepare({
    studyId: "study-codex-success",
    trialId: "study-codex-success:trial-1",
    task,
    architecture: "single",
    feedbackPolicy: "codex_generalist",
    conditionId: "single-codex-generalist",
    engineRoute: "local-single",
    engine,
  });
  await runtime.engine.generate({
    invocationId: "candidate-call",
    messages: [{ role: "user", content: "Generate one candidate." }],
  });
  await runtime.finalize({
    trialId: "study-codex-success:trial-1",
    conditionId: "single-codex-generalist",
    engineRoute: "local-single",
    feedbackPolicy: "codex_generalist",
    feedbackDirectives: [
      { providerId: "codex-feedback" },
      { providerId: "codex-feedback" },
    ],
    engineAccounting: [],
    outcome: {
      feedbackRoundCount: 2,
      internalModelCallCount: 3,
      totalInputTokens: 2,
      totalOutputTokens: 3,
      censorReason: null,
      failure: null,
    },
  } as unknown as WorkflowTrajectoryReport);

  const evidence = controlPlane.latestArtifact(runtime.runContext.workItemId);
  assert.ok(evidence);
  const trial = (JSON.parse(evidence.content) as {
    trial: WorkflowTrajectoryReport;
  }).trial;
  assert.equal(trial.outcome.totalInputTokens, null);
  assert.equal(trial.outcome.totalOutputTokens, null);
  assert.deepEqual(
    trial.engineAccounting.find(
      ({ evidenceSource }) => evidenceSource === "derived_feedback_proxy",
    ),
    {
      engineProfileId: "codex-cli-ordinary-user",
      modelId: "gpt-feedback",
      calls: 2,
      succeeded: 2,
      failed: 0,
      canceled: 0,
      abandoned: 0,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      elapsedMs: null,
      measurementStatus: "unknown",
      evidenceSource: "derived_feedback_proxy",
    },
  );
});

test("Codex feedback accounting fails closed for missing, colliding, or inconsistent evidence", async (t) => {
  const cases = [
    {
      name: "missing metadata",
      internalModelCallCount: 1,
      codexFeedbackAccounting: undefined,
    },
    {
      name: "primary profile collision",
      internalModelCallCount: 1,
      codexFeedbackAccounting: {
        engineProfileId: "scripted-local-engine",
        modelId: "gpt-feedback",
      },
    },
    {
      name: "excess unpersisted calls",
      internalModelCallCount: 2,
      codexFeedbackAccounting: {
        engineProfileId: "codex-cli-ordinary-user",
        modelId: "gpt-feedback",
      },
    },
    {
      name: "missing unpersisted call",
      internalModelCallCount: 0,
      codexFeedbackAccounting: {
        engineProfileId: "codex-cli-ordinary-user",
        modelId: "gpt-feedback",
      },
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const directory = mkdtempSync(join(tmpdir(), "workflow-codex-mismatch-"));
      const database = openControlPlaneDatabase(join(directory, "state.db"));
      try {
        const controlPlane = new ControlPlane(
          database,
          join(directory, "artifacts"),
        );
        const engine: ModelEngine = {
          manifest: {
            kind: "model_engine",
            profileId: "scripted-local-engine",
            adapter: "scripted-test",
            contractVersion: "v1alpha1",
            capabilities: [],
          },
          async generate(request) {
            return result(request, "candidate");
          },
        };
        const task = generateReferenceArtifactSuite()[0]!;
        const persistence = createControlPlaneWorkflowStudyPersistence({
          controlPlane,
          configuredModelId: "scripted-model",
          maxChildrenPerTrial: 8,
          ...(fixture.codexFeedbackAccounting
            ? { codexFeedbackAccounting: fixture.codexFeedbackAccounting }
            : {}),
        });
        const runtime = await persistence.prepare({
          studyId: "study-codex-mismatch",
          trialId: `study-codex-mismatch:${fixture.name}`,
          task,
          architecture: "single",
          feedbackPolicy: "codex_generalist",
          conditionId: "single-codex-generalist",
          engineRoute: "local-single",
          engine,
        });
        assert.throws(
          () =>
            runtime.finalize({
              trialId: `study-codex-mismatch:${fixture.name}`,
              conditionId: "single-codex-generalist",
              engineRoute: "local-single",
              feedbackPolicy: "codex_generalist",
              feedbackDirectives: [{ providerId: "codex-feedback" }],
              engineAccounting: [],
              outcome: {
                feedbackRoundCount: 1,
                internalModelCallCount: fixture.internalModelCallCount,
                totalInputTokens: null,
                totalOutputTokens: null,
                censorReason: null,
                failure: null,
              },
            } as unknown as WorkflowTrajectoryReport),
          /WORKFLOW_STUDY_INVOCATION_ACCOUNTING_MISMATCH/u,
        );
      } finally {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
