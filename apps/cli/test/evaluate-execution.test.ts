import assert from "node:assert/strict";
import test from "node:test";
import type {
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  evaluateExecutionTier,
  generateExecutionTasks,
} from "../src/evaluate-execution.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  measurementStatus: "measured",
};

function engine(
  profileId: string,
  output: (invocationId: string) => string,
): ModelEngine {
  return {
    manifest: {
      kind: "model_engine",
      profileId,
      adapter: "scripted",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return {
        invocationId: request.invocationId,
        text: output(request.invocationId),
        toolCalls: [],
        finishReason: "stop",
        usage,
      };
    },
  };
}

test("execution evaluator applies model output in real temporary Git repositories", async () => {
  const tasks = generateExecutionTasks(10, 20260731);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const oracle = engine("oracle", (invocationId) => {
    if (invocationId.startsWith("artifact-probe:")) {
      const number = invocationId.match(/artifact-(\d+)$/u)?.[1] ?? "";
      return `Compiler probe STRUCT-${number.padStart(6, "0")}.`;
    }
    const id = invocationId.split(":").at(-1)!;
    return JSON.stringify(byId.get(id)!.expected);
  });
  const report = await evaluateExecutionTier(oracle, {
    tierId: "small",
    taskCount: 10,
    seed: 20260731,
    probeCount: 3,
  });
  assert.equal(report.aggregate.executionPassRate, 1);
  assert.equal(report.aggregate.structuredOutputRate, 1);
  assert.equal(report.aggregate.sentinelRetentionRate, 1);
  assert.equal(report.aggregate.modelOutputs, 13);
  assert.equal(report.tiers[0]?.tasksPassed, 10);
  assert.equal(report.tiers[0]?.tasksRecovered, 0);
  assert.equal(
    report.executionBoundary.unapprovedExternalSideEffects,
    0,
  );
});

test("execution evaluator resumes only pending tasks at the next tier", async () => {
  const first = await evaluateExecutionTier(
    engine("small", () => "{}"),
    {
      tierId: "small",
      taskCount: 4,
      seed: 7,
    },
  );
  assert.equal(first.aggregate.pendingTasks, 4);
  const tasks = generateExecutionTasks(4, 7);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const second = await evaluateExecutionTier(
    engine("large", (invocationId) =>
      JSON.stringify(
        byId.get(invocationId.split(":").at(-1)!)!.expected,
      ),
    ),
    {
      tierId: "large",
      previous: first,
    },
  );
  assert.equal(second.aggregate.executionPassRate, 1);
  assert.equal(second.tiers[1]?.taskAttempts, 4);
  assert.equal(second.tiers[1]?.tasksPassed, 4);
  assert.equal(second.tiers[1]?.tasksRecovered, 4);
  assert.equal(
    second.tasks.every((task) => task.attempts.length === 2),
    true,
  );
});

test("every generated task requires an observable repository change", () => {
  for (const task of generateExecutionTasks(100, 20260731)) {
    assert.notDeepEqual(task.initial, task.expected, task.id);
  }
});
