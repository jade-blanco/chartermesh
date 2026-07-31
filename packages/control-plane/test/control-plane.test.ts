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
    const runState = database
      .prepare("SELECT status, finished_at FROM runs WHERE id = ?")
      .get(claim.runId) as { status: string; finished_at: string | null };
    const attemptState = database
      .prepare("SELECT status, finished_at FROM attempts WHERE id = ?")
      .get(claim.attemptId) as { status: string; finished_at: string | null };
    const leaseState = database
      .prepare("SELECT released_at FROM leases WHERE id = ?")
      .get(claim.leaseId) as { released_at: string | null };
    assert.equal(runState.status, "succeeded");
    assert.ok(runState.finished_at);
    assert.equal(attemptState.status, "succeeded");
    assert.ok(attemptState.finished_at);
    assert.ok(leaseState.released_at);

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

test("delegated attempts retain bounded parent-child lineage", () => {
  const { database, controlPlane } = fixture();
  try {
    const work = controlPlane.intake({
      title: "Coordinate a bounded task",
      summary: "Exercise durable delegated attempt lineage.",
      actor: "human:test",
      idempotencyKey: "intake:delegated-attempts",
    });
    controlPlane.triage({
      id: work.id,
      ownerRole: "operator",
      executionTarget: "builtin-managed-runner",
      actor: "human:test",
      idempotencyKey: "triage:delegated-attempts",
    });
    const claim = controlPlane.claim({
      id: work.id,
      actor: "runner:test",
      idempotencyKey: "claim:delegated-attempts",
    });
    const planner = controlPlane.startChildAttempt({
      parentAttemptId: claim.attemptId,
      roleId: "planner",
      actor: "runner:test",
      maxChildren: 2,
    });
    const implementer = controlPlane.startChildAttempt({
      parentAttemptId: claim.attemptId,
      roleId: "implementer",
      actor: "runner:test",
      maxChildren: 2,
    });
    assert.equal(planner.parentAttemptId, claim.attemptId);
    assert.equal(planner.kind, "delegated");
    assert.equal(implementer.attemptNo, planner.attemptNo + 1);
    assert.throws(
      () =>
        controlPlane.startChildAttempt({
          parentAttemptId: claim.attemptId,
          roleId: "verifier",
          actor: "runner:test",
          maxChildren: 2,
        }),
      /child limit/u,
    );
    assert.throws(
      () =>
        controlPlane.startChildAttempt({
          parentAttemptId: planner.id,
          roleId: "nested",
          actor: "runner:test",
        }),
      /depth is limited/u,
    );
    assert.equal(
      controlPlane.finishChildAttempt({
        id: planner.id,
        status: "succeeded",
        actor: "runner:test",
      }).status,
      "succeeded",
    );
    assert.equal(
      controlPlane.finishChildAttempt({
        id: implementer.id,
        status: "canceled",
        actor: "runner:test",
        errorCode: "RUN_CANCELED",
        errorMessage: "Canceled by the parent signal.",
      }).status,
      "canceled",
    );
    const attempts = controlPlane.listAttempts(claim.runId);
    assert.deepEqual(
      attempts.map(({ kind, roleId, status }) => ({
        kind,
        roleId,
        status,
      })),
      [
        { kind: "primary", roleId: null, status: "running" },
        { kind: "delegated", roleId: "planner", status: "succeeded" },
        { kind: "delegated", roleId: "implementer", status: "canceled" },
      ],
    );
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

test("dashboard treats an unapproved pending tool call as human review", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Review exact tool arguments",
      summary: "A pending local write must surface in the review queue.",
      actor: "human:test",
      idempotencyKey: "tool-review:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool-review:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "tool-review:claim",
    });
    const callHash = "e".repeat(64);
    controlPlane.recordPendingToolCall({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      callHash,
      toolName: "workspace.write_file",
      arguments: { path: "src/result.ts", content: "export {};\n" },
      createdAt: new Date().toISOString(),
      actor: "runner:test",
    });

    const beforeApproval = controlPlane.dashboard();
    assert.equal(beforeApproval.summary.approvals, 1);
    assert.equal(beforeApproval.userActions[0]?.category, "human_review");
    assert.equal(beforeApproval.userActions[0]?.priority, 110);

    controlPlane.approveToolCall({
      id: item.id,
      callHash,
      toolName: "workspace.write_file",
      note: "Exact arguments reviewed.",
      actor: "human:test",
      idempotencyKey: "tool-review:approve",
    });
    const afterApproval = controlPlane.dashboard();
    assert.equal(afterApproval.summary.approvals, 0);
    assert.notEqual(afterApproval.userActions[0]?.category, "human_review");

    const malformedItem = controlPlane.intake({
      title: "Reject malformed tool arguments",
      summary: "Malformed arguments cannot enter the approval queue.",
      actor: "human:test",
      idempotencyKey: "tool-review:malformed-intake",
    });
    controlPlane.triage({
      id: malformedItem.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "tool-review:malformed-triage",
    });
    const malformedClaim = controlPlane.claim({
      id: malformedItem.id,
      actor: "runner:test",
      idempotencyKey: "tool-review:malformed-claim",
    });
    assert.throws(
      () =>
        controlPlane.recordPendingToolCall({
          id: malformedItem.id,
          runId: malformedClaim.runId,
          attemptId: malformedClaim.attemptId,
          callHash: "f".repeat(64),
          toolName: "workspace.write_file",
          arguments: { unparsed: "{\"path\":" },
          createdAt: new Date().toISOString(),
          actor: "runner:test",
        }),
      /fully parsed/u,
    );
    controlPlane.failRun({
      id: malformedItem.id,
      generation: malformedClaim.generation,
      attemptId: malformedClaim.attemptId,
      errorCode: "TOOL_ARGUMENTS_INVALID",
      errorMessage: "Tool arguments were incomplete.",
      actor: "runner:test",
      idempotencyKey: "tool-review:malformed-fail",
    });
    const unapprovable = controlPlane.dashboard();
    assert.equal(unapprovable.summary.approvals, 0);
    assert.notEqual(
      unapprovable.userActions.find(
        ({ workItemId }) => workItemId === malformedItem.id,
      )?.category,
      "human_review",
    );
  } finally {
    database.close();
  }
});

test("changes requested retain the human review note", () => {
  const { database, controlPlane } = fixture();
  try {
    const item = controlPlane.intake({
      title: "Revise one artifact",
      summary: "The reviewer must be able to explain the requested change.",
      actor: "human:test",
      idempotencyKey: "review-note:intake",
    });
    controlPlane.triage({
      id: item.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "review-note:triage",
    });
    const claim = controlPlane.claim({
      id: item.id,
      actor: "runner:test",
      idempotencyKey: "review-note:claim",
    });
    const submission = controlPlane.submitArtifact({
      id: item.id,
      content: '{"summary":"draft"}',
      generation: claim.generation,
      actor: "runner:test",
      idempotencyKey: "review-note:submit",
    });
    controlPlane.decide({
      id: item.id,
      decision: "changes_requested",
      artifactHash: submission.sha256,
      note: "검증 결과를 첨부하고 다시 제출하세요.",
      actor: "human:test",
      idempotencyKey: "review-note:decision",
    });
    const decision = controlPlane.latestArtifactDecision(item.id);
    assert.equal(decision?.decision, "changes_requested");
    assert.equal(
      decision?.note,
      "검증 결과를 첨부하고 다시 제출하세요.",
    );
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
    const failedProjection = controlPlane.dashboard();
    assert.equal(failedProjection.summary.actionable, 0);
    assert.equal(failedProjection.summary.approvals, 0);
    assert.equal(failedProjection.userActions[0]?.category, "retry");
    assert.equal(failedProjection.userActions[0]?.actionable, false);
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
      requiredTools: ["workspace.write_file"],
    });
    assert.deepEqual(controlPlane.requiredTools(item.id), [
      "workspace.write_file",
    ]);
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
    controlPlane.recordPendingToolCall({
      id: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      callHash,
      toolName: "workspace.write_file",
      arguments: {
        path: "src/result.ts",
        content: "export const result = true;\n",
      },
      createdAt: new Date().toISOString(),
      actor: "runner:test",
    });
    const waiting = controlPlane.get(item.id);
    assert.equal(waiting.status, "in_progress");
    assert.equal(waiting.availability, "approval_waiting");
    assert.equal(waiting.wait?.reference, callHash);
    assert.equal(
      (
        database
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(claim.runId) as { status: string }
      ).status,
      "waiting",
    );
    const pending = controlPlane.listPendingToolCalls(item.id);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]?.arguments, {
      path: "src/result.ts",
      content: "export const result = true;\n",
    });
    assert.equal(controlPlane.approvedPendingToolCall(item.id), null);
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
    const ready = controlPlane.get(item.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.availability, "ready");
    assert.equal(ready.wait, null);
    assert.equal(
      controlPlane.approvedPendingToolCall(item.id)?.callHash,
      callHash,
    );
    const executed = controlPlane.markPendingToolCallExecuted({
      id: item.id,
      callHash,
      actor: "runner:test",
      idempotencyKey: "tool:pending-executed",
    });
    assert.equal(executed.status, "executed");
    assert.equal(controlPlane.approvedPendingToolCall(item.id), null);
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
