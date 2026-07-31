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
      internalModelCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
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
  }).prepare({
    studyId: "study-codex-accounting",
    trialId: "study-codex-accounting:trial-1",
    task,
    architecture: "single",
    feedbackPolicy: "codex_generalist",
    engine,
  });
  await runtime.engine.generate({
    invocationId: "candidate-call",
    messages: [{ role: "user", content: "Generate one candidate." }],
  });
  await runtime.finalize({
    trialId: "study-codex-accounting:trial-1",
    feedbackPolicy: "codex_generalist",
    outcome: {
      feedbackRoundCount: 0,
      internalModelCallCount: 2,
      totalInputTokens: null,
      totalOutputTokens: null,
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
});
