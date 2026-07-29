import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../src/index.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-control-plane-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  return {
    database,
    controlPlane: new ControlPlane(database, join(directory, "artifacts")),
  };
}

test("intake through approval completes and resurfaces a successor", () => {
  const { database, controlPlane } = fixture();
  try {
    const first = controlPlane.intake({
      title: "Prepare implementation",
      summary: "Create a bounded implementation artifact.",
      actor: "human:test",
      idempotencyKey: "intake:first",
    });
    const second = controlPlane.intake({
      title: "Verify implementation",
      summary: "Verify only after implementation completes.",
      actor: "human:test",
      idempotencyKey: "intake:second",
    });
    controlPlane.triage({
      id: first.id,
      ownerRole: "implementation",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:first",
    });
    controlPlane.triage({
      id: second.id,
      ownerRole: "review",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:second",
    });
    controlPlane.addDependency({
      id: second.id,
      predecessorId: first.id,
      actor: "human:test",
      idempotencyKey: "dependency:first-second",
    });

    assert.equal(controlPlane.get(second.id).availability, "dependency_waiting");
    assert.throws(
      () =>
        controlPlane.claim({
          id: second.id,
          actor: "role:review",
          idempotencyKey: "claim:blocked",
        }),
      /not currently claimable/u,
    );

    const claim = controlPlane.claim({
      id: first.id,
      actor: "role:implementation",
      idempotencyKey: "claim:first",
    });
    assert.equal(claim.generation, 1);
    const submission = controlPlane.submitArtifact({
      id: first.id,
      content: "Synthetic implementation result.",
      generation: claim.generation,
      actor: "role:implementation",
      idempotencyKey: "submit:first",
    });
    assert.match(submission.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(submission.workItem.status, "review_pending");

    controlPlane.decide({
      id: first.id,
      decision: "approve",
      artifactHash: submission.sha256,
      note: "The synthetic artifact satisfies the acceptance criteria.",
      actor: "human:test",
      idempotencyKey: "approve:first",
    });
    const completion = controlPlane.complete({
      id: first.id,
      actor: "role:implementation",
      idempotencyKey: "complete:first",
    });
    assert.deepEqual(completion.resurfaced, [second.id]);
    assert.equal(controlPlane.get(second.id).availability, "ready");
  } finally {
    database.close();
  }
});

test("wait conditions are explicit and actionable counts exclude blocked work", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Need user input",
      summary: "Wait for a user-owned configuration decision.",
      actor: "human:test",
      idempotencyKey: "intake:input",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "triage:input",
    });
    controlPlane.wait({
      id: item.id,
      condition: {
        type: "user_input",
        reason: "Choose the model endpoint.",
      },
      actor: "role:operator",
      idempotencyKey: "wait:input",
    });

    const dashboard = controlPlane.dashboard();
    assert.equal(dashboard.summary.actionable, 1);
    assert.equal(dashboard.summary.userInput, 1);
    assert.equal(dashboard.userActions[0]?.category, "user_input");
    assert.equal(dashboard.userActions[0]?.actionable, true);
    const resumed = controlPlane.resume({
      id: item.id,
      actor: "human:test",
      idempotencyKey: "resume:input",
    });
    assert.equal(resumed.availability, "ready");
    assert.equal(resumed.wait, null);
  } finally {
    database.close();
  }
});

test("idempotency replays the original response and rejects command reuse", () => {
  const { database, controlPlane } = fixture();
  try {
    const input = {
      title: "Idempotent request",
      summary: "Create once.",
      actor: "human:test",
      idempotencyKey: "same-key",
    };
    const first = controlPlane.intake(input);
    const replay = controlPlane.intake(input);
    assert.deepEqual(replay, first);
    assert.equal(controlPlane.list().length, 1);
    assert.throws(
      () =>
        controlPlane.triage({
          id: first.id,
          ownerRole: "operator",
          executionTarget: "simulated-local",
          actor: "human:test",
          idempotencyKey: "same-key",
        }),
      /another command/u,
    );
  } finally {
    database.close();
  }
});

test("artifact evidence is fenced by run generation and exact hash", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Generation fencing",
      summary: "Only the active run may submit review evidence.",
      actor: "human:test",
      idempotencyKey: "fence:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "simulated-local",
      actor: "human:test",
      idempotencyKey: "fence:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "fence:claim",
    });
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          content: "Stale result",
          generation: claim.generation + 1,
          actor: "runner:test",
          idempotencyKey: "fence:stale-submit",
        }),
      /Stale or inactive run generation/u,
    );
    const submitted = controlPlane.submitArtifact({
      id: item.id,
      content: "Current result",
      generation: claim.generation,
      actor: "runner:test",
      idempotencyKey: "fence:submit",
    });
    assert.throws(
      () =>
        controlPlane.decide({
          id: item.id,
          decision: "approve",
          artifactHash: "0".repeat(64),
          note: "Wrong evidence.",
          actor: "human:test",
          idempotencyKey: "fence:wrong-review",
        }),
      /Review hash does not match/u,
    );
    const approved = controlPlane.decide({
      id: item.id,
      decision: "approve",
      artifactHash: submitted.sha256,
      note: "Exact artifact reviewed.",
      actor: "human:test",
      idempotencyKey: "fence:review",
    });
    assert.equal(approved.status, "approved");
  } finally {
    database.close();
  }
});

test("failed runs are retryable with a new fenced generation", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Retry a failed model call",
      summary: "Preserve failure evidence and create a new generation.",
      actor: "human:test",
      idempotencyKey: "retry:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "retry:triage",
    });
    const first = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "retry:claim:1",
    });
    controlPlane.failRun({
      id: item.id,
      generation: first.generation,
      attemptId: first.attemptId,
      errorCode: "MODEL_INVOCATION_FAILED",
      errorMessage: "Synthetic model failure.",
      actor: "runner:test",
      idempotencyKey: "retry:fail",
    });
    assert.equal(controlPlane.get(item.id).status, "failed");
    controlPlane.retry({
      id: item.id,
      actor: "human:test",
      idempotencyKey: "retry:ready",
    });
    const second = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "retry:claim:2",
    });
    assert.equal(second.generation, 2);
  } finally {
    database.close();
  }
});

test("expired leases recover to a visible failed state", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Recover abandoned work",
      summary: "An expired worker must not leave work in progress forever.",
      actor: "human:test",
      idempotencyKey: "lease:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "lease:triage",
    });
    controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "lease:claim",
      leaseMinutes: -1,
    });
    assert.deepEqual(controlPlane.recoverExpiredLeases(), [item.id]);
    assert.equal(controlPlane.get(item.id).status, "failed");
  } finally {
    database.close();
  }
});

test("run starts enforce declared concurrency and daily budgets", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-budget-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 1,
      maxDailyModelStarts: 1,
    },
  });
  try {
    const items = ["first", "second"].map((name) => {
      const item = controlPlane.intake({
        title: name,
        summary: `Synthetic ${name} work.`,
        actor: "human:test",
        idempotencyKey: `budget:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `budget:triage:${name}`,
      });
      return item;
    });
    controlPlane.claim({
      id: items[0]!.id,
      actor: "runner:test",
      idempotencyKey: "budget:claim:first",
    });
    assert.throws(
      () =>
        controlPlane.claim({
          id: items[1]!.id,
          actor: "runner:test",
          idempotencyKey: "budget:claim:second",
        }),
      /BUDGET_CONCURRENT_RUNS_EXCEEDED/u,
    );
  } finally {
    database.close();
  }
});
