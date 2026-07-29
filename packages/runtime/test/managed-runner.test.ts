import assert from "node:assert/strict";
import test from "node:test";
import { FakeModelEngine } from "../../../adapters/model-engines/fake/src/index.ts";
import { BuiltInManagedRunner } from "../src/index.ts";

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
