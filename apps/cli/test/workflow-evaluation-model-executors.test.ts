import assert from "node:assert/strict";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import { ArtifactTaskSealedEvaluator } from "../src/workflow-evaluation/artifact-adapters.ts";
import { canonicalArtifactJson } from "../src/workflow-evaluation/artifacts.ts";
import {
  PeerTeamArtifactWorkflowExecutor,
  SingleArtifactWorkflowExecutor,
  boundedWorkflowInferenceRequest,
  createIdentityAttestingWorkflowEngine,
} from "../src/workflow-evaluation/model-executors.ts";
import {
  WorkflowAccountedError,
  WorkflowProviderIdentityError,
} from "../src/workflow-evaluation/types.ts";
import { generateReferenceArtifactSuite } from "../src/workflow-evaluation/suite.ts";
import { workflowTaskFromArtifactTask } from "../src/workflow-evaluation/artifact-adapters.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 5,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  measurementStatus: "measured",
};

function result(
  request: InferenceRequest,
  text: string,
): InferenceResult {
  return {
    invocationId: request.invocationId,
    text,
    toolCalls: [],
    finishReason: "stop",
    usage,
  };
}

function engine(
  generate: ModelEngine["generate"],
): ModelEngine {
  return {
    manifest: {
      kind: "model_engine",
      profileId: "workflow-scripted-engine",
      adapter: "scripted-test",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
        },
        {
          name: "model.structured_output",
          support: "native",
          stability: "stable",
        },
      ],
    },
    generate,
  };
}

test("candidate requests reserve a conservative input bound before assigning output tokens", () => {
  const request: InferenceRequest = {
    invocationId: "bounded-request",
    messages: [{ role: "user", content: "bounded input" }],
    maxOutputTokens: 8_192,
  };
  const inputUpperBound = Buffer.byteLength(
    JSON.stringify({
      messages: request.messages,
      tools: null,
      responseSchema: null,
    }),
    "utf8",
  );
  const bounded = boundedWorkflowInferenceRequest(
    request,
    inputUpperBound + 17,
  );
  assert.equal(bounded.maxOutputTokens, 17);
  assert.throws(
    () => boundedWorkflowInferenceRequest(request, inputUpperBound),
    /WORKFLOW_TOKEN_LIMIT_PRECALL/u,
  );
});

test("engine-boundary identity attestation precedes output parsing", async () => {
  const raw = engine(async (request) => ({
    ...result(request, "not valid structured output"),
    providerIdentity: {
      reportedModelId: "wrong-model",
      reportedSystemFingerprint: "fingerprint-a",
    },
  }));
  const wrapped = createIdentityAttestingWorkflowEngine({
    engine: raw,
    expectedModelId: "expected-model",
    observed: new Map(),
  });
  await assert.rejects(
    wrapped.generate({
      invocationId: "identity-before-parse",
      messages: [{ role: "user", content: "Return malformed output." }],
    }),
    (error: unknown) =>
      error instanceof WorkflowAccountedError &&
      error.metrics.modelCalls === 1 &&
      error.metrics.providerIdentities?.[0]?.reportedModelId ===
        "wrong-model" &&
      error.cause instanceof WorkflowProviderIdentityError,
  );
});

test("single executor uses one matched orientation call and emits canonical human-reviewable output", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    return result(
      request,
      calls === 1
        ? JSON.stringify({ plan: "Build and verify every public field." })
        : JSON.stringify(task.oracleCandidate, null, 2),
    );
  });
  const executor = new SingleArtifactWorkflowExecutor({
    engine: implementation,
    task,
  });
  const setup = await executor.orient({ task: publicTask });
  const directive = publicTask.initialImplementationBrief;
  const output = await executor.execute({
    task: publicTask,
    submission: 1,
    feedbackRound: 0,
    directive,
    directiveHash: await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(directive))
      .then((bytes) => Buffer.from(bytes).toString("hex")),
    remainingModelCalls: 32,
    previousArtifact: null,
  });

  assert.equal(calls, 2);
  assert.equal(setup.modelCalls, 1);
  assert.equal(output.modelCalls, 1);
  assert.equal(output.contractValid, true);
  assert.equal(output.artifact, canonicalArtifactJson(task.oracleCandidate));
  assert.match(output.humanView, /Starter Launch Kit/u);
  assert.equal(output.handoffs, 0);
});

test("peer-team executor forms a task-specific team and only returns after a command handoff", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let cLevelCalls = 0;
  const implementation = engine(async (request) => {
    const system = request.messages.find(({ role }) => role === "system")?.content ?? "";
    if (system.includes("Design a small task-specific peer team")) {
      return result(
        request,
        JSON.stringify({
          plan: "Delegate a schema check, then synthesize the candidate.",
          cLevelRole: "chief",
          roles: [
            {
              id: "chief",
              name: "Chief",
              class: "c_level",
              description: "Coordinates the bounded implementation.",
            },
            {
              id: "maker",
              name: "Maker Team",
              class: "worker",
              description: "Checks public requirements and artifact structure.",
            },
          ],
        }),
      );
    }
    if (system.includes("You are worker role")) {
      return result(request, "All public requirements appear covered.");
    }
    if (system.includes("You are the C-level coordinator")) {
      cLevelCalls += 1;
      if (cLevelCalls === 1) {
        return result(
          request,
          JSON.stringify({
            action: "dispatch",
            reason: "A worker must check the public contract.",
            recipients: [
              {
                role: "maker",
                instruction: "Check all public requirements and report omissions.",
                artifactAccess: "read_only",
              },
            ],
          }),
        );
      }
      return result(
        request,
        JSON.stringify({
          action: "request_review",
          reason: "The worker check was incorporated.",
          artifact: {
            apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
            summary: "Candidate ready for sealed evaluation.",
            deliverable: canonicalArtifactJson(task.oracleCandidate),
            checks: ["Worker result returned through the handoff channel."],
            risks: ["Semantic evaluation only."],
            nextActions: ["Await sealed evaluator result."],
            confidence: "high",
          },
        }),
      );
    }
    throw new Error(`Unexpected scripted prompt: ${system}`);
  });
  const executor = new PeerTeamArtifactWorkflowExecutor({
    engine: implementation,
    task,
    maxParallelAgents: 2,
  });
  const setup = await executor.orient({ task: publicTask });
  const directive = publicTask.initialImplementationBrief;
  const directiveHash = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(directive))
    .then((bytes) => Buffer.from(bytes).toString("hex"));
  const output = await executor.execute({
    task: publicTask,
    submission: 1,
    feedbackRound: 0,
    directive,
    directiveHash,
    remainingModelCalls: 32,
    previousArtifact: null,
  });

  assert.equal(setup.modelCalls, 1);
  assert.equal(cLevelCalls, 2);
  assert.equal(output.modelCalls, 3);
  assert.equal(output.handoffs, 1);
  assert.equal(output.contractValid, true);
  assert.equal(output.artifact, canonicalArtifactJson(task.oracleCandidate));
});

test("invalid model artifact remains reviewable without entering the sealed oracle", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    return result(
      request,
      calls === 1 ? JSON.stringify({ plan: "Try once." }) : "not-json",
    );
  });
  const executor = new SingleArtifactWorkflowExecutor({
    engine: implementation,
    task,
  });
  await executor.orient({ task: publicTask });
  const directive = publicTask.initialImplementationBrief;
  const directiveHash = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(directive))
    .then((bytes) => Buffer.from(bytes).toString("hex"));
  const output = await executor.execute({
    task: publicTask,
    submission: 1,
    feedbackRound: 0,
    directive,
    directiveHash,
    remainingModelCalls: 32,
    previousArtifact: null,
  });
  assert.equal(output.contractValid, false);
  assert.match(output.humanView, /형식 오류/u);
});

test("sealed evaluator rejects an artifact whose supplied hash is not bound", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const artifact = canonicalArtifactJson(task.oracleCandidate);
  await assert.rejects(
    () =>
      new ArtifactTaskSealedEvaluator(task).evaluate({
        taskId: task.id,
        artifact,
        artifactHash: "0".repeat(64),
      }),
    /ARTIFACT_HASH_MISMATCH/u,
  );
});
