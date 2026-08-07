import assert from "node:assert/strict";
import test from "node:test";
import { FakeModelEngine } from "../../../adapters/model-engines/fake/src/index.ts";
import type {
  InferenceResult,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import {
  BuiltInManagedRunner,
  DelegationController,
  parseStructuredArtifact,
} from "../src/index.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cost: 0,
  measurementStatus: "measured",
};

const manifest: ModelEngine["manifest"] = {
  kind: "model_engine",
  profileId: "test-engine",
  adapter: "test",
  contractVersion: "v1alpha1",
  capabilities: [
    { name: "model.text.generate", support: "native", stability: "stable" },
  ],
};

test("structured artifacts reject unknown fields instead of persisting them", () => {
  const value = {
    apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
    summary: "Bounded",
    deliverable: "Visible result",
    checks: [],
    risks: [],
    nextActions: [],
    confidence: "high",
    hiddenPayload: "must not survive",
  };
  assert.equal(parseStructuredArtifact(JSON.stringify(value)), null);
});

test("built-in managed runner executes an arbitrary model engine", async () => {
  const runner = new BuiltInManagedRunner();
  const handle = await runner.start(
    {
      taskPacket: {
        objective: "Produce a safe synthetic result.",
        acceptanceCriteria: ["No external side effects."],
      },
      organizationRevision: 1,
      workItemId: "work-000001",
      runId: "run-000001",
      attemptId: "attempt-000001",
      generation: 1,
    },
    { engine: new FakeModelEngine() },
  );
  const result = await runner.result(handle.hostRunId);

  assert.equal(handle.status, "running");
  assert.match(result.inference.text, /Simulated CharterMesh result/u);
  assert.equal(result.inference.usage.cost, 0);
  assert.equal(
    result.artifactSubmission.producerReport.source,
    "model_reported",
  );
});

test("small-model prompt separates performed checks from proposed checks", async () => {
  let system = "";
  let user = "";
  const engine: ModelEngine = {
    manifest,
    async generate(request) {
      system = request.messages.find(({ role }) => role === "system")?.content ??
        "";
      user = request.messages.find(({ role }) => role === "user")?.content ?? "";
      return {
        invocationId: request.invocationId,
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: "Evidence boundary retained.",
          deliverable: "No project inspection was claimed.",
          checks: [],
          risks: ["No filesystem evidence was supplied."],
          nextActions: ["Inspect the requested files in a future run."],
          confidence: "low",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  };
  const runner = new BuiltInManagedRunner();
  const handle = await runner.start(
    {
      taskPacket: { objective: "Describe a verification plan." },
      organizationRevision: 1,
      workItemId: "work-evidence",
      runId: "run-evidence",
      attemptId: "attempt-evidence",
      generation: 1,
    },
    { engine },
  );
  await runner.result(handle.hostRunId);
  assert.match(system, /Never claim an action, inspection, test/u);
  assert.match(user, /If no check was performed, return `checks: \[\]`/u);
  assert.match(user, /using future tense/u);
  assert.match(user, /task packet's primary language/u);
  assert.match(system, /raw file text after one JSON transport encoding/u);
  assert.match(user, /Do not JSON-encode the file text a second time/u);
  assert.match(user, /prefer replacement mode/u);
  assert.match(user, /expectedOccurrences/u);
});

test("runner repairs one invalid response and accounts for both turns", async () => {
  let calls = 0;
  let schemaShapeWasPrompted = false;
  const engine: ModelEngine = {
    manifest,
    async generate(request) {
      calls += 1;
      schemaShapeWasPrompted ||= request.messages.some(({ content }) =>
        content.includes(
          '"apiVersion": "chartermesh.dev/structured-artifact/v1alpha1"',
        ),
      );
      return {
        invocationId: request.invocationId,
        text:
          calls === 1
            ? "not valid JSON"
            : JSON.stringify({
                apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
                summary: "Repaired output.",
                deliverable: "A bounded synthetic deliverable.",
                checks: ["Schema validated."],
                risks: [],
                nextActions: ["Human review."],
                confidence: "medium",
              }),
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  };
  const runner = new BuiltInManagedRunner();
  const handle = await runner.start(
    {
      taskPacket: { objective: "Repair the result." },
      organizationRevision: 1,
      workItemId: "work-repair",
      runId: "run-repair",
      attemptId: "attempt-repair",
      generation: 1,
    },
    { engine },
  );
  const result = await runner.result(handle.hostRunId);
  assert.equal(calls, 2);
  assert.equal(schemaShapeWasPrompted, true);
  assert.equal(result.inference.usage.inputTokens, 4);
  assert.equal(result.inference.usage.outputTokens, 6);
});

test("runtime artifact compiler owns the final envelope", async () => {
  let calls = 0;
  let schemaRequested = true;
  const engine: ModelEngine = {
    manifest,
    async generate(request) {
      calls += 1;
      schemaRequested = request.responseSchema !== undefined;
      return {
        invocationId: request.invocationId,
        text: "A human-readable bounded deliverable.",
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  };
  const runner = new BuiltInManagedRunner({
    artifactMode: "runtime_compiled",
  });
  const handle = await runner.start(
    {
      taskPacket: { objective: "Compile this result." },
      organizationRevision: 1,
      workItemId: "work-compiled",
      runId: "run-compiled",
      attemptId: "attempt-compiled",
      generation: 1,
    },
    { engine },
  );
  const result = await runner.result(handle.hostRunId);
  const artifact = parseStructuredArtifact(result.inference.text);
  assert.equal(calls, 1);
  assert.equal(schemaRequested, false);
  assert.equal(
    artifact?.deliverable,
    "A human-readable bounded deliverable.",
  );
  assert.equal(
    result.artifactSubmission.producerReport.source,
    "runtime_compiled",
  );
  assert.equal(
    result.artifactSubmission.content,
    "A human-readable bounded deliverable.",
  );
  assert.notEqual(result.artifactSubmission.content, result.inference.text);
});

test("runner cancellation aborts the active model request", async () => {
  let aborted = false;
  const engine: ModelEngine = {
    manifest,
    generate(_request, options) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(options.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };
  const runner = new BuiltInManagedRunner();
  const handle = await runner.start(
    {
      taskPacket: { objective: "Wait until canceled." },
      organizationRevision: 1,
      workItemId: "work-cancel",
      runId: "run-cancel",
      attemptId: "attempt-cancel",
      generation: 1,
    },
    { engine },
  );
  await runner.cancel(handle.hostRunId);
  assert.equal(aborted, true);
});

test("delegation controller runs four isolated bounded roles with typed lineage", async () => {
  const requests: Array<{
    invocationId: string;
    user: string;
    maxOutputTokens: number | undefined;
  }> = [];
  const engine: ModelEngine = {
    manifest,
    async generate(request) {
      requests.push({
        invocationId: request.invocationId,
        user:
          request.messages.find(({ role }) => role === "user")?.content ?? "",
        maxOutputTokens: request.maxOutputTokens,
      });
      const role =
        request.invocationId.match(/:(planner|implementer|verifier|synthesizer):/u)?.[1] ??
        "worker";
      return {
        invocationId: request.invocationId,
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: `${role} result`,
          deliverable: `${role} bounded deliverable`,
          checks: [],
          risks: [],
          nextActions: [],
          confidence: "medium",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  };
  const started: string[] = [];
  const finished: string[] = [];
  const controller = new DelegationController(256);
  assert.equal(
    new BuiltInManagedRunner().manifest.capabilities.some(
      ({ name, support, stability }) =>
        name === "orchestration.delegated" &&
        support === "emulated" &&
        stability === "experimental",
    ),
    true,
  );
  const result = await controller.run(
    {
      taskPacket: {
        objective: "Prepare a synthetic release note.",
        context: "Do not perform external actions.",
        acceptanceCriteria: ["Return a bounded result."],
      },
      organizationRevision: 1,
      workItemId: "work-delegated",
      runId: "run-delegated",
      attemptId: "attempt-parent",
      generation: 1,
    },
    {
      engine,
      lifecycle: {
        startStage({ role }) {
          started.push(role);
          return { attemptId: `attempt-parent:${role}` };
        },
        finishStage({ role, status }) {
          finished.push(`${role}:${status}`);
        },
      },
    },
  );
  assert.deepEqual(started, [
    "planner",
    "implementer",
    "verifier",
    "synthesizer",
  ]);
  assert.deepEqual(finished, started.map((role) => `${role}:succeeded`));
  assert.equal(result.stages.length, 4);
  assert.equal(result.generationBudget.maxGeneratedTokensRequested, 2_048);
  assert.equal(
    requests.every(({ maxOutputTokens }) => maxOutputTokens === 256),
    true,
  );
  assert.doesNotMatch(requests[0]!.user, /HANDOFF/u);
  assert.match(requests[1]!.user, /PLANNER HANDOFF/u);
  assert.match(requests[2]!.user, /IMPLEMENTER HANDOFF/u);
  assert.match(requests[3]!.user, /VERIFIER HANDOFF/u);
  assert.match(result.inference.text, /synthesizer bounded deliverable/u);
});

test("delegation controller can route reviewer roles to another engine", async () => {
  const calls: string[] = [];
  const engine = (profileId: string): ModelEngine => ({
    manifest: { ...manifest, profileId },
    async generate(request) {
      calls.push(profileId);
      return {
        invocationId: request.invocationId,
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: `${profileId} result`,
          deliverable: `${profileId} deliverable`,
          checks: [],
          risks: [],
          nextActions: [],
          confidence: "medium",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  });
  const worker = engine("small-worker");
  const reviewer = engine("large-reviewer");
  const result = await new DelegationController(256).run(
    {
      taskPacket: { objective: "Exercise hybrid routing." },
      organizationRevision: 1,
      workItemId: "work-hybrid",
      runId: "run-hybrid",
      attemptId: "attempt-hybrid",
      generation: 1,
    },
    {
      engine: worker,
      engineForRole: (role) =>
        ["verifier", "synthesizer"].includes(role)
          ? reviewer
          : worker,
    },
  );
  assert.deepEqual(calls, [
    "small-worker",
    "small-worker",
    "large-reviewer",
    "large-reviewer",
  ]);
  assert.match(result.inference.text, /large-reviewer deliverable/u);
});
