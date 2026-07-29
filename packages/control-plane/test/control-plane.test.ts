import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  dispatchOutboxBatch,
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

test("human-controlled global pause blocks only new run claims", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Pause-aware work",
      summary: "The item remains ready while run starts are paused.",
      actor: "human:test",
      idempotencyKey: "pause:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "pause:triage",
    });
    const paused = controlPlane.pauseOperations({
      reason: "Operator requested a quiet window.",
      actor: "human:test",
      idempotencyKey: "pause:start",
    });
    assert.equal(paused.paused, true);
    assert.equal(controlPlane.get(item.id).status, "ready");
    assert.throws(
      () =>
        controlPlane.claim({
          id: item.id,
          actor: "role:operator",
          idempotencyKey: "pause:blocked-claim",
        }),
      /OPERATIONS_PAUSED/u,
    );
    assert.throws(
      () =>
        controlPlane.resumeOperations({
          actor: "role:operator",
          idempotencyKey: "pause:invalid-resume",
        }),
      /REQUIRES_HUMAN/u,
    );
    assert.equal(
      controlPlane.resumeOperations({
        actor: "human:test",
        idempotencyKey: "pause:resume",
      }).paused,
      false,
    );
    assert.equal(
      controlPlane.claim({
        id: item.id,
        actor: "role:operator",
        idempotencyKey: "pause:claim",
      }).generation,
      1,
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

test("artifact byte limits are enforced before evidence is written", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-artifact-limit-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 1,
      maxDailyModelStarts: 10,
      maxArtifactBytes: 8,
      maxWorkItemArtifactBytes: 12,
    },
  });
  try {
    const item = controlPlane.intake({
      title: "Bounded artifact",
      summary: "Reject oversized evidence.",
      actor: "human:test",
      idempotencyKey: "artifact-limit:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "artifact-limit:triage",
    });
    const firstClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "artifact-limit:first-claim",
    });
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          content: "123456789",
          generation: firstClaim.generation,
          actor: "runner:test",
          idempotencyKey: "artifact-limit:oversized",
        }),
      /ARTIFACT_SIZE_LIMIT_EXCEEDED/u,
    );
    const first = controlPlane.submitArtifact({
      id: item.id,
      content: "12345678",
      generation: firstClaim.generation,
      actor: "runner:test",
      idempotencyKey: "artifact-limit:first-submit",
    });
    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: first.sha256,
      note: "Submit a revision.",
      actor: "human:test",
      idempotencyKey: "artifact-limit:changes",
    });
    const secondClaim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "artifact-limit:second-claim",
    });
    assert.throws(
      () =>
        controlPlane.submitArtifact({
          id: item.id,
          content: "12345",
          generation: secondClaim.generation,
          actor: "runner:test",
          idempotencyKey: "artifact-limit:work-total",
        }),
      /WORK_ITEM_ARTIFACT_BUDGET_EXCEEDED/u,
    );
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

test("block cost policy refuses later claims after unknown monthly usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-cost-policy-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"), {
    budgets: {
      monthlyCostLimitUsd: 10,
      maxConcurrentRuns: 2,
      maxDailyModelStarts: 10,
      unknownCostPolicy: "block",
    },
  });
  try {
    const prepare = (name: string) => {
      const item = controlPlane.intake({
        title: name,
        summary: `Synthetic ${name} work.`,
        actor: "human:test",
        idempotencyKey: `cost-policy:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `cost-policy:triage:${name}`,
      });
      return item;
    };
    const first = prepare("first");
    const claim = controlPlane.claim({
      id: first.id,
      actor: "runner:test",
      idempotencyKey: "cost-policy:first-claim",
    });
    controlPlane.recordInvocation({
      attemptId: claim.attemptId,
      engineId: "unknown-cost-engine",
      modelId: "fixture",
      status: "failed",
      inputTokens: 10,
      outputTokens: 5,
      cost: null,
      measurementStatus: "unknown",
    });
    controlPlane.failRun({
      id: first.id,
      generation: claim.generation,
      attemptId: claim.attemptId,
      errorCode: "FIXTURE_FAILURE",
      errorMessage: "Synthetic failure.",
      actor: "runner:test",
      idempotencyKey: "cost-policy:first-fail",
    });
    const second = prepare("second");
    assert.throws(
      () =>
        controlPlane.claim({
          id: second.id,
          actor: "runner:test",
          idempotencyKey: "cost-policy:second-claim",
        }),
      /BUDGET_UNKNOWN_COST_BLOCKED/u,
    );
  } finally {
    database.close();
  }
});

test("tool approval and execution evidence stay bound to exact hashes", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Approved tool call",
      summary: "Record only hashes and safe path evidence.",
      actor: "human:test",
      idempotencyKey: "tool:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "tool:claim",
    });
    const callHash = "a".repeat(64);
    assert.equal(
      controlPlane.isToolCallApproved(
        item.id,
        callHash,
        "workspace.write_file",
      ),
      false,
    );
    assert.throws(
      () =>
        controlPlane.approveToolCall({
          id: item.id,
          callHash,
          toolName: "workspace.write_file",
          actor: "role:model",
          note: "A model cannot approve itself.",
          idempotencyKey: "tool:invalid-approval",
        }),
      /human actor/u,
    );
    controlPlane.approveToolCall({
      id: item.id,
      callHash,
      toolName: "workspace.write_file",
      actor: "human:test",
      note: "Exact arguments were reviewed.",
      idempotencyKey: "tool:approval",
    });
    assert.equal(
      controlPlane.isToolCallApproved(
        item.id,
        callHash,
        "workspace.write_file",
      ),
      true,
    );
    controlPlane.recordToolEvidence({
      evidenceId: "tool-evidence-test",
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      callHash,
      toolName: "workspace.write_file",
      status: "succeeded",
      inputHash: "b".repeat(64),
      outputHash: "c".repeat(64),
      paths: ["src/result.ts"],
      durationMs: 12,
      createdAt: new Date().toISOString(),
      actor: "runner:test",
    });
    const evidence = controlPlane.listToolEvidence(item.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.callHash, callHash);
    assert.deepEqual(evidence[0]?.paths, ["src/result.ts"]);
  } finally {
    database.close();
  }
});

test("audit export projection preserves allowlisted evidence and drops all other fields", () => {
  const { database, controlPlane } = fixture();
  try {
    database
      .prepare(
        `INSERT INTO events(
          event_type, work_item_id, actor, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fixture.audit",
        null,
        "must-not-export-actor-secret",
        JSON.stringify({
          sha256: "a".repeat(64),
          token: "must-not-export",
          nested: { arguments: { path: ".", content: "private" } },
        }),
        new Date().toISOString(),
      );
    const records = controlPlane.auditRecords();
    assert.equal(records[0]?.payload.sha256, "a".repeat(64));
    assert.equal(records[0]?.payload.token, undefined);
    assert.equal(records[0]?.payload.nested, undefined);
    assert.equal(records[0]?.actor, "system:unknown");
    assert.doesNotMatch(JSON.stringify(records), /must-not-export|private/u);
  } finally {
    database.close();
  }
});

test("model invocation lifecycle survives cancellation and lease recovery", () => {
  const { database, controlPlane } = fixture();
  try {
    const prepare = (name: string) => {
      const item = controlPlane.intake({
        title: name,
        summary: "Track the call before model execution starts.",
        actor: "human:test",
        idempotencyKey: `invocation:intake:${name}`,
      });
      controlPlane.triage({
        id: item.id,
        ownerRole: "operator",
        executionTarget: "local",
        actor: "human:test",
        idempotencyKey: `invocation:triage:${name}`,
      });
      return item;
    };
    const canceledItem = prepare("cancel");
    const canceledClaim = controlPlane.claim({
      id: canceledItem.id,
      actor: "runner:test",
      idempotencyKey: "invocation:claim:cancel",
    });
    const running = controlPlane.startInvocation({
      attemptId: canceledClaim.attemptId,
      engineId: "local-model",
      modelId: "fixture",
    });
    assert.equal(running.status, "running");
    assert.equal(running.finishedAt, null);
    const cancellation = controlPlane.requestRunCancellation({
      id: canceledItem.id,
      actor: "human:test",
      idempotencyKey: "invocation:cancel",
    });
    assert.equal(cancellation.runId, canceledClaim.runId);
    assert.equal(
      controlPlane.isRunCancellationRequested(canceledClaim.runId),
      true,
    );
    assert.equal(
      controlPlane.finishInvocation({
        id: running.id,
        status: "canceled",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        measurementStatus: "unknown",
      }).status,
      "canceled",
    );

    const abandonedItem = prepare("abandon");
    const abandonedClaim = controlPlane.claim({
      id: abandonedItem.id,
      actor: "runner:test",
      idempotencyKey: "invocation:claim:abandon",
      leaseMinutes: 0,
    });
    const abandoned = controlPlane.startInvocation({
      attemptId: abandonedClaim.attemptId,
      engineId: "local-model",
      modelId: "fixture",
    });
    controlPlane.recoverExpiredLeases();
    assert.equal(
      controlPlane
        .listInvocations(abandonedClaim.attemptId)
        .find(({ id }) => id === abandoned.id)?.status,
      "abandoned",
    );
    assert.ok(
      controlPlane
        .auditRecords()
        .some(
          ({ type, payload }) =>
            type === "model.invocation.abandoned" &&
            payload.invocationId === abandoned.id,
        ),
    );
  } finally {
    database.close();
  }
});

test("work pagination is stable and explicit archive hides terminal work", () => {
  const { database, controlPlane } = fixture();
  try {
    for (const name of ["one", "two", "three"]) {
      controlPlane.intake({
        title: name,
        summary: `Pagination fixture ${name}.`,
        actor: "human:test",
        idempotencyKey: `page:${name}`,
      });
    }
    const first = controlPlane.listPage({
      limit: 2,
      includeCompleted: true,
    });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = controlPlane.listPage({
      cursor: first.nextCursor!,
      limit: 2,
      includeCompleted: true,
    });
    assert.equal(second.items.length, 1);
    assert.equal(
      new Set([...first.items, ...second.items].map(({ id }) => id)).size,
      3,
    );
    const terminal = first.items[0]!;
    database
      .prepare(`
        UPDATE work_items
        SET status = 'done', availability = 'completed'
        WHERE id = ?
      `)
      .run(terminal.id);
    assert.ok(
      controlPlane.archive({
        id: terminal.id,
        actor: "human:test",
        idempotencyKey: "page:archive",
      }).archivedAt,
    );
    assert.equal(
      controlPlane.list().some(({ id }) => id === terminal.id),
      false,
    );
    assert.equal(
      controlPlane
        .list({ includeArchived: true })
        .some(({ id }) => id === terminal.id),
      true,
    );
  } finally {
    database.close();
  }
});

test("outbox dispatcher retries, dead-letters, and permits human replay", async () => {
  const { database, controlPlane } = fixture();
  try {
    controlPlane.intake({
      title: "Dispatch one event",
      summary: "Exercise local transactional outbox delivery.",
      actor: "human:test",
      idempotencyKey: "outbox:intake",
    });
    const failed = await dispatchOutboxBatch(controlPlane, {
      owner: "dispatcher:test",
      maxAttempts: 1,
      handler: () => {
        throw new Error("FIXTURE_DELIVERY_FAILED");
      },
    });
    assert.equal(failed.deadLettered, 1);
    const dead = controlPlane.listOutbox({
      deadLettersOnly: true,
    });
    assert.equal(dead.length, 1);
    controlPlane.retryDeadLetter({
      id: dead[0]!.id,
      actor: "human:test",
      idempotencyKey: "outbox:retry",
    });
    const delivered: number[] = [];
    const succeeded = await dispatchOutboxBatch(controlPlane, {
      owner: "dispatcher:test",
      handler: (delivery) => {
        delivered.push(delivery.id);
      },
    });
    assert.ok(succeeded.dispatched >= 1);
    assert.ok(delivered.includes(dead[0]!.id));
  } finally {
    database.close();
  }
});
