import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  canonicalCandidateText,
  type CodeCandidate,
} from "../src/code-evaluation/candidate.ts";
import type {
  CodeSandboxBackend,
  CodeSandboxProbe,
} from "../src/code-evaluation/sandbox.ts";
import {
  CodeWorkflowSealedEvaluator,
  PeerTeamCodeWorkflowExecutor,
  SingleCodeWorkflowExecutor,
  generateReferenceCodeWorkflowSuite,
  preflightCodeWorkflowSandbox,
  workflowTaskFromCodeTask,
} from "../src/workflow-evaluation/code-adapters.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 11,
  outputTokens: 13,
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

function scriptedEngine(outputs: string[]): ModelEngine {
  let cursor = 0;
  return {
    manifest: {
      kind: "model_engine",
      profileId: "code-workflow-test-engine",
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
    async generate(request) {
      const text = outputs[cursor++];
      if (text === undefined) throw new Error("Unexpected model call.");
      return result(request, text);
    },
  };
}

function candidate(content: string): CodeCandidate {
  return {
    apiVersion: "chartermesh.dev/code-candidate/v1alpha1",
    files: [{ path: "solution.mjs", content }],
    summary: "Implemented and reviewed the requested transition rules.",
  };
}

const passingProbe: CodeSandboxProbe = {
  ok: true,
  backendId: "test-attested-vm",
  evidence: {
    networkDenied: true,
    hostReadDenied: true,
    hostWriteDenied: true,
    childEscapeDenied: true,
    timeoutEnforced: true,
    outputAllowlistEnforced: true,
  },
  issues: [],
};

function vmBackend(options: {
  policyViolations?: string[];
  survivorProcesses?: number;
} = {}): CodeSandboxBackend {
  return {
    manifest: {
      id: "test-attested-vm",
      isolation: "vm",
      network: "disabled",
      hostFilesystem: "mapped-allowlist",
      generatedCodeExecution: true,
    },
    async probe() {
      return structuredClone(passingProbe);
    },
    async run(task, _candidate, cases, jobId = "test-job") {
      return {
        jobId,
        taskId: task.id,
        passed: (options.policyViolations?.length ?? 0) === 0,
        cases: cases.map(({ id }) => ({
          id,
          passed: true,
          exitCode: 0,
          latencyMs: 1,
        })),
        changedPaths: ["solution.mjs"],
        policyViolations: options.policyViolations ?? [],
        survivorProcesses: options.survivorProcesses ?? 0,
        outputBytes: 128,
      };
    },
  };
}

test("reference code workflow spans easy, medium, and hard sealed tasks", () => {
  const bindings = generateReferenceCodeWorkflowSuite();
  assert.deepEqual(
    bindings.map(({ difficulty }) => difficulty),
    ["easy", "medium", "hard"],
  );
  assert.equal(new Set(bindings.map(({ task }) => task.id)).size, 3);
  for (const binding of bindings) {
    const publicTask = workflowTaskFromCodeTask(binding);
    assert.equal(publicTask.family, "code");
    assert.equal(publicTask.difficulty, binding.difficulty);
    assert.equal(
      JSON.stringify(publicTask).includes(binding.task.oracleContent),
      false,
    );
  }
});

test("single code workflow emits a strict hash-bound candidate for VM evaluation", async () => {
  const binding = generateReferenceCodeWorkflowSuite()[0]!;
  const publicTask = workflowTaskFromCodeTask(binding);
  const artifact = canonicalCandidateText(candidate(binding.task.oracleContent));
  const executor = new SingleCodeWorkflowExecutor({
    engine: scriptedEngine([
      JSON.stringify({ plan: "Implement every transition and public example." }),
      artifact,
    ]),
    binding,
  });
  const setup = await executor.orient({ task: publicTask });
  const directive = publicTask.initialImplementationBrief;
  const execution = await executor.execute({
    task: publicTask,
    submission: 1,
    feedbackRound: 0,
    directive,
    directiveHash: createHash("sha256").update(directive).digest("hex"),
    remainingModelCalls: 16,
    previousArtifact: null,
  });
  assert.equal(setup.modelCalls, 1);
  assert.equal(execution.contractValid, true);
  assert.equal(execution.artifact, artifact);
  assert.match(execution.humanView, /solution\.mjs/u);
});

test("team code workflow reaches review only after a command-mediated worker handoff", async () => {
  const binding = generateReferenceCodeWorkflowSuite()[0]!;
  const publicTask = workflowTaskFromCodeTask(binding);
  const artifact = canonicalCandidateText(candidate(binding.task.oracleContent));
  let cLevelCalls = 0;
  const engine: ModelEngine = {
    ...scriptedEngine([]),
    async generate(request) {
      const system =
        request.messages.find(({ role }) => role === "system")?.content ?? "";
      if (system.includes("Design a task-specific code-maintenance peer team")) {
        return result(
          request,
          JSON.stringify({
            plan: "Delegate a public-contract check and synthesize the code.",
            cLevelRole: "chief",
            roles: [
              {
                id: "chief",
                name: "Chief",
                class: "c_level",
                description: "Coordinates implementation and requests review.",
              },
              {
                id: "reviewer",
                name: "Reviewer",
                class: "worker",
                description: "Checks the maintenance contract.",
              },
            ],
          }),
        );
      }
      if (system.includes("You are worker role")) {
        return result(request, "The public transition contract is covered.");
      }
      if (system.includes("You are the C-level coordinator")) {
        cLevelCalls += 1;
        return result(
          request,
          cLevelCalls === 1
            ? JSON.stringify({
                action: "dispatch",
                reason: "A worker must check the public contract.",
                recipients: [
                  {
                    role: "reviewer",
                    instruction: "Check the candidate requirements.",
                    artifactAccess: "read_only",
                  },
                ],
              })
            : JSON.stringify({
                action: "request_review",
                reason: "The worker check was incorporated.",
                artifact: {
                  apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
                  summary: "Code candidate ready for sealed VM evaluation.",
                  deliverable: artifact,
                  checks: ["Worker response returned through the command channel."],
                  risks: ["Hidden VM cases remain sealed."],
                  nextActions: ["Run the sealed VM evaluator."],
                  confidence: "high",
                },
              }),
        );
      }
      throw new Error(`Unexpected system prompt: ${system}`);
    },
  };
  const executor = new PeerTeamCodeWorkflowExecutor({
    engine,
    binding,
    maxParallelAgents: 2,
  });
  await executor.orient({ task: publicTask });
  const directive = publicTask.initialImplementationBrief;
  const execution = await executor.execute({
    task: publicTask,
    submission: 1,
    feedbackRound: 0,
    directive,
    directiveHash: createHash("sha256").update(directive).digest("hex"),
    remainingModelCalls: 16,
    previousArtifact: null,
  });
  assert.equal(cLevelCalls, 2);
  assert.equal(execution.handoffs, 1);
  assert.equal(execution.modelCalls, 3);
  assert.equal(execution.contractValid, true);
  assert.equal(execution.artifact, artifact);
});

test("sealed code evaluator records VM policy violations as safety failures", async () => {
  const binding = generateReferenceCodeWorkflowSuite()[0]!;
  const artifact = canonicalCandidateText(candidate(binding.task.oracleContent));
  const evaluator = new CodeWorkflowSealedEvaluator(
    binding.task,
    vmBackend({
      policyViolations: ["HOST_FILESYSTEM_ESCAPE"],
      survivorProcesses: 1,
    }),
  );
  const evaluation = await evaluator.evaluate({
    taskId: binding.task.id,
    artifact,
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
  });
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.score, 0);
  assert.equal(evaluation.safety?.unauthorizedExternalEffects, 1);
  assert.equal(evaluation.safety?.workspaceEscapes, 1);
  assert.equal(evaluation.safety?.sandboxCanaryFailures, 1);
});

test("sealed code evaluator propagates infrastructure failure instead of blaming the candidate", async () => {
  const binding = generateReferenceCodeWorkflowSuite()[0]!;
  const artifact = canonicalCandidateText(candidate(binding.task.oracleContent));
  const backend = vmBackend();
  backend.run = async () => {
    throw new Error("SANDBOX_INFRASTRUCTURE_FAILURE");
  };
  const evaluator = new CodeWorkflowSealedEvaluator(binding.task, backend);
  await assert.rejects(
    evaluator.evaluate({
      taskId: binding.task.id,
      artifact,
      artifactHash: createHash("sha256").update(artifact).digest("hex"),
    }),
    /SANDBOX_INFRASTRUCTURE_FAILURE/u,
  );
});

test("sealed code evaluator forwards cancellation to the sandbox backend", async () => {
  const binding = generateReferenceCodeWorkflowSuite()[0]!;
  const artifact = canonicalCandidateText(candidate(binding.task.oracleContent));
  const controller = new AbortController();
  let receivedProbeSignal: AbortSignal | undefined;
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const backend: CodeSandboxBackend = {
    manifest: {
      id: "test-attested-vm",
      isolation: "vm",
      network: "disabled",
      hostFilesystem: "mapped-allowlist",
      generatedCodeExecution: true,
    },
    async probe(options) {
      receivedProbeSignal = options?.signal;
      return structuredClone(passingProbe);
    },
    async run(_task, _candidate, _cases, _jobId, options) {
      receivedSignal = options?.signal;
      markStarted();
      return await new Promise((_, reject) => {
        const rejectCanceled = (): void => {
          reject(
            options?.signal?.reason ??
              new Error("CODE_SANDBOX_EVALUATION_CANCELED"),
          );
        };
        if (options?.signal?.aborted) {
          rejectCanceled();
          return;
        }
        options?.signal?.addEventListener("abort", rejectCanceled, {
          once: true,
        });
      });
    },
  };
  const evaluator = new CodeWorkflowSealedEvaluator(binding.task, backend);
  const evaluation = evaluator.evaluate({
    taskId: binding.task.id,
    artifact,
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
    signal: controller.signal,
  });
  await started;
  const cancellation = new Error("synthetic evaluator cancellation");
  controller.abort(cancellation);
  await assert.rejects(evaluation, (error) => error === cancellation);
  assert.equal(receivedProbeSignal, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("code workflow preflight rejects a non-VM backend before execution", async () => {
  const unsafe: CodeSandboxBackend = {
    manifest: {
      id: "host-process",
      isolation: "simulated",
      network: "unknown",
      hostFilesystem: "unknown",
      generatedCodeExecution: true,
    },
    async probe() {
      return {
        ...structuredClone(passingProbe),
        backendId: "host-process",
      };
    },
    async run() {
      throw new Error("must not run");
    },
  };
  await assert.rejects(
    () => preflightCodeWorkflowSandbox(unsafe),
    /CODE_SANDBOX_UNAVAILABLE/u,
  );
});
