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
  WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
  WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION,
  WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
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

test("engine boundary omits oversized grammar bounds without mutating the application contract", async () => {
  const responseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["payload", "items"],
    properties: {
      payload: {
        type: "string",
        minLength: 1,
        maxLength: 20_000,
      },
      items: {
        type: "array",
        maxItems: 1_001,
        items: { type: "string", maxLength: 1_000 },
      },
      literal: {
        const: { maxLength: 20_000 },
        enum: [{ maxItems: 2_000 }],
      },
      default: { type: "string", maxLength: 10_000 },
    },
  } satisfies Record<string, unknown>;
  const original = structuredClone(responseSchema);
  let forwarded: Record<string, unknown> | undefined;
  const raw = engine(async (request) => {
    forwarded = request.responseSchema;
    return {
      ...result(request, '{"payload":"ok","items":[]}'),
      providerIdentity: {
        reportedModelId: "expected-model",
        reportedSystemFingerprint: "fingerprint-a",
      },
    };
  });
  const wrapped = createIdentityAttestingWorkflowEngine({
    engine: raw,
    expectedModelId: "expected-model",
    observed: new Map(),
  });

  await wrapped.generate({
    invocationId: "portable-schema",
    messages: [{ role: "user", content: "Return the object." }],
    responseSchema,
  });

  assert.deepEqual(responseSchema, original);
  assert.notEqual(forwarded, responseSchema);
  const properties = forwarded?.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(properties.payload.maxLength, undefined);
  assert.equal(properties.items.maxItems, undefined);
  assert.equal(
    (properties.items.items as Record<string, unknown>).maxLength,
    WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION,
  );
  assert.deepEqual(properties.literal.const, { maxLength: 20_000 });
  assert.deepEqual(properties.literal.enum, [{ maxItems: 2_000 }]);
  assert.equal(properties.default.maxLength, undefined);
  assert.equal(
    WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION,
    "chartermesh.dev/workflow-response-schema-portability/v1alpha1",
  );
  assert.equal(WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION, "omit");
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

test("peer-team executor uses the fixed typed team and only returns after a command handoff", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let cLevelCalls = 0;
  const implementation = engine(async (request) => {
    const system = request.messages.find(({ role }) => role === "system")?.content ?? "";
    if (system.includes("fixed, host-owned artifact peer team")) {
      return result(
        request,
        JSON.stringify({
          plan: "Delegate a schema check, then synthesize the candidate.",
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
                role: "specialist",
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
          artifact: task.oracleCandidate,
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

test("peer-team executor repairs one malformed final C-level response with symmetric accounting", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let cLevelCalls = 0;
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    const system = request.messages.find(({ role }) => role === "system")?.content ?? "";
    if (system.includes("fixed, host-owned artifact peer team")) {
      return result(
        request,
        JSON.stringify({ plan: "Delegate once, then synthesize and repair only representation." }),
      );
    }
    if (system.includes("You are worker role")) {
      return result(request, "The public contract was checked without omissions.");
    }
    if (system.includes("You are the C-level coordinator")) {
      cLevelCalls += 1;
      if (cLevelCalls === 1) {
        return result(
          request,
          JSON.stringify({
            action: "dispatch",
            reason: "Obtain the required independent contract check.",
            recipients: [
              {
                role: "specialist",
                instruction: "Check every public field and report omissions.",
                artifactAccess: "read_only",
              },
            ],
          }),
        );
      }
      return {
        ...result(
          request,
          JSON.stringify({
            action: "request_review",
            reason: "The checked artifact is ready.",
            artifact: task.oracleCandidate,
          }),
        ),
        finishReason: "length",
      };
    }
    assert.match(system, /Repair only the representation/u);
    return result(request, JSON.stringify(task.oracleCandidate));
  });
  const executor = new PeerTeamArtifactWorkflowExecutor({
    engine: implementation,
    task,
    maxParallelAgents: 1,
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
    remainingModelCalls: 4,
    previousArtifact: null,
  });

  assert.equal(calls, 5);
  assert.equal(cLevelCalls, 2);
  assert.equal(output.initialContractValid, false);
  assert.equal(output.contractValid, true);
  assert.equal(output.contractRepairAttempts, 1);
  assert.equal(output.contractRepairOutcome, "succeeded");
  assert.equal(output.modelCalls, 4);
  assert.equal(output.usage.inputTokens, 20);
  assert.equal(output.usage.outputTokens, 28);
  assert.deepEqual(output.protocolViolations, []);
  assert.equal(output.artifact, canonicalArtifactJson(task.oracleCandidate));
});

test("single artifact executor repairs one invalid candidate and accounts the repair call", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    if (calls === 1) {
      return result(request, JSON.stringify({ plan: "Repair public structure." }));
    }
    if (calls === 2) return result(request, "not-json");
    const system = request.messages.find(({ role }) => role === "system")?.content;
    assert.match(system ?? "", /Repair only the representation/u);
    return result(request, JSON.stringify(task.oracleCandidate));
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
    remainingModelCalls: 2,
    previousArtifact: null,
  });

  assert.equal(calls, 3);
  assert.equal(output.contractValid, true);
  assert.equal(output.contractRepairAttempts, 1);
  assert.equal(output.modelCalls, 2);
  assert.equal(output.usage.inputTokens, 10);
  assert.equal(output.usage.outputTokens, 14);
  assert.equal(output.artifact, canonicalArtifactJson(task.oracleCandidate));
  assert.equal(output.providerIdentities?.length, 2);
});

test("cancellation during contract repair preserves implementation and repair accounting", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  const abortController = new AbortController();
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    if (calls === 1) {
      return result(request, JSON.stringify({ plan: "Attempt one bounded repair." }));
    }
    if (calls === 2) return result(request, "not-json");
    const reason = new Error("synthetic repair cancellation");
    abortController.abort(reason);
    throw reason;
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

  await assert.rejects(
    () =>
      executor.execute({
        task: publicTask,
        submission: 1,
        feedbackRound: 0,
        directive,
        directiveHash,
        remainingModelCalls: 2,
        previousArtifact: null,
        signal: abortController.signal,
      }),
    (error: unknown) =>
      error instanceof WorkflowAccountedError &&
      error.message === "WORKFLOW_CONTRACT_REPAIR_ABORTED" &&
      error.metrics.modelCalls === 2 &&
      error.metrics.usage.inputTokens === null &&
      error.metrics.usage.outputTokens === null &&
      error.metrics.usage.measurementStatus === "unknown" &&
      error.metrics.providerIdentities?.length === 1,
  );
  assert.equal(calls, 3);
});

test("single artifact executor skips repair when the first call consumes the token budget", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    if (calls === 1) {
      return result(request, JSON.stringify({ plan: "Respect the token cap." }));
    }
    if (calls > 2) throw new Error("Repair must not start without token budget.");
    return {
      ...result(request, "not-json"),
      usage: {
        inputTokens: 90_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        measurementStatus: "measured",
      },
    };
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
    remainingModelCalls: 2,
    remainingTotalTokens: 100_000,
    previousArtifact: null,
  });

  assert.equal(calls, 2);
  assert.equal(output.contractValid, false);
  assert.equal(output.contractRepairAttempts, 0);
  assert.equal(output.modelCalls, 1);
  assert.equal(output.usage.inputTokens, 90_000);
  assert.equal(output.usage.outputTokens, 10_000);
  assert.equal(output.artifact, "not-json");
});

test("single artifact executor does not adopt a non-stop repair response", async () => {
  const task = generateReferenceArtifactSuite()[0]!;
  const publicTask = workflowTaskFromArtifactTask(task);
  let calls = 0;
  const implementation = engine(async (request) => {
    calls += 1;
    if (calls === 1) {
      return result(request, JSON.stringify({ plan: "Repair only if complete." }));
    }
    if (calls === 2) return result(request, "not-json");
    return {
      ...result(request, JSON.stringify(task.oracleCandidate)),
      finishReason: "length",
    };
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
    remainingModelCalls: 2,
    previousArtifact: null,
  });

  assert.equal(calls, 3);
  assert.equal(output.contractValid, false);
  assert.equal(output.contractRepairAttempts, 1);
  assert.equal(output.modelCalls, 2);
  assert.equal(output.usage.inputTokens, 10);
  assert.equal(output.usage.outputTokens, 14);
  assert.equal(output.artifact, "not-json");
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
