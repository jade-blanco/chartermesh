import assert from "node:assert/strict";
import test from "node:test";
import type {
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import { evaluateCollaboration } from "../src/evaluate-collaboration.ts";

const allConcepts = [
  "RepairRelay Node.js 24 TypeScript SQLite planner implementer verifier human approval work-order API test audit rollback",
  "transaction lease generation idempot concurrent duplicate expired cancel recovery",
  "scope evidence risk human approve security deployment",
].join(" ");

test("collaboration evaluation compares paired bounded conditions", async () => {
  const limits: number[] = [];
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "scripted-evaluation",
      adapter: "scripted",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request): Promise<InferenceResult> {
      limits.push(request.maxOutputTokens ?? 0);
      return {
        invocationId: request.invocationId,
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: "Bounded result.",
          deliverable: allConcepts,
          checks: [],
          risks: ["No external evidence was supplied."],
          nextActions: ["A human will review the proposed result."],
          confidence: "medium",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          measurementStatus: "measured",
        },
      };
    },
  };
  const report = await evaluateCollaboration(engine);
  assert.equal(report.trials.length, 3);
  assert.deepEqual(report.conditionEngines, {
    single: ["scripted-evaluation"],
    delegated: ["scripted-evaluation"],
  });
  assert.deepEqual(report.fixtureIds, [
    "repair-relay-company-bootstrap",
    "concurrent-claim-hardening",
    "human-review-release-gate",
  ]);
  assert.equal(report.aggregate.singlePassRate, 1);
  assert.equal(report.aggregate.delegatedPassRate, 1);
  assert.deepEqual(report.aggregate.observedTokens, {
    single: 90,
    delegated: 360,
    delegatedToSingleRatio: 4,
  });
  assert.deepEqual(report.generationBudget.maxGeneratedTokensRequested, {
    single: 8_192,
    delegated: 8_192,
  });
  assert.equal(limits.filter((value) => value === 4_096).length, 3);
  assert.equal(limits.filter((value) => value === 1_024).length, 12);
  assert.equal(
    report.trials.every(
      ({ delegated }) =>
        delegated.stages === 4 &&
        delegated.usage.inputTokens === 40 &&
        delegated.usage.outputTokens === 80,
    ),
    true,
  );
});

test("collaboration evaluation reports hybrid role engines", async () => {
  const generated = (profileId: string): ModelEngine => ({
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
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: "Hybrid result.",
          deliverable: allConcepts,
          checks: [],
          risks: [],
          nextActions: [],
          confidence: "medium",
        }),
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
  });
  const worker = generated("small-worker");
  const reviewer = generated("large-reviewer");
  const report = await evaluateCollaboration(worker, {
    delegatedEngineForRole: (role) =>
      ["verifier", "synthesizer"].includes(role)
        ? reviewer
        : worker,
  });
  assert.deepEqual(report.conditionEngines, {
    single: ["small-worker"],
    delegated: ["small-worker", "large-reviewer"],
  });
});

test("collaboration evaluation can screen an exact fixture subset", async () => {
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "fixture-screen",
      adapter: "scripted",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      return {
        invocationId: request.invocationId,
        text: JSON.stringify({
          apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
          summary: "Fixture screen.",
          deliverable: allConcepts,
          checks: [],
          risks: [],
          nextActions: [],
          confidence: "medium",
        }),
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
  const report = await evaluateCollaboration(engine, {
    fixtureIds: ["concurrent-claim-hardening"],
  });
  assert.deepEqual(report.fixtureIds, ["concurrent-claim-hardening"]);
  assert.equal(report.trials.length, 1);
  await assert.rejects(
    evaluateCollaboration(engine, {
      fixtureIds: ["not-a-fixture"],
    }),
    /Unknown collaboration fixture/u,
  );
});

test("collaboration evaluation records a condition failure and continues", async () => {
  let calls = 0;
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "failing-engine",
      adapter: "scripted",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    async generate(request) {
      calls += 1;
      return {
        invocationId: request.invocationId,
        text: "not-json",
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
  const report = await evaluateCollaboration(engine);
  assert.equal(report.trials.length, 3);
  assert.equal(
    report.trials.every(
      ({ single, delegated }) =>
        single.errorCode === "STRUCTURED_ARTIFACT_INVALID" &&
        delegated.errorCode === "STRUCTURED_ARTIFACT_INVALID",
    ),
    true,
  );
  assert.equal(calls, 12);
});
