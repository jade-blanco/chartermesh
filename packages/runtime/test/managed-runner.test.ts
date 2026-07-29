import assert from "node:assert/strict";
import test from "node:test";
import { FakeModelEngine } from "../../../adapters/model-engines/fake/src/index.ts";
import type {
  InferenceResult,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import { BuiltInManagedRunner } from "../src/index.ts";

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
