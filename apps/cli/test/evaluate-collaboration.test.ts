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
