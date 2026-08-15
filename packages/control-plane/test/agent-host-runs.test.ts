import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPlane, openControlPlaneDatabase } from "../src/index.ts";

function claimedFixture(suffix: string) {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-agent-host-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  const item = controlPlane.intake({
    title: "Run through an external agent host",
    summary: "Keep provider state durably bound to the Control Plane run.",
    actor: "human:test",
    idempotencyKey: `host:${suffix}:intake`,
  });
  controlPlane.triage({
    id: item.id,
    ownerRole: "operator",
    executionTarget: "codex-host",
    actor: "human:test",
    idempotencyKey: `host:${suffix}:triage`,
  });
  const claim = controlPlane.claim({
    id: item.id,
    actor: "runner:test",
    idempotencyKey: `host:${suffix}:claim`,
  });
  return { database, controlPlane, item, claim };
}

test("an approved host activation retargets only the exact unclaimed work set", () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-host-retarget-"));
  const database = openControlPlaneDatabase(join(directory, "state.db"));
  const controlPlane = new ControlPlane(database, join(directory, "artifacts"));
  try {
    const first = controlPlane.intake({
      title: "Initial implementation",
      summary: "This ready item should follow the activated role.",
      actor: "human:test",
      idempotencyKey: "retarget:first:intake",
    });
    const ready = controlPlane.triage({
      id: first.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "retarget:first:triage",
    });
    const second = controlPlane.intake({
      title: "Other role",
      summary: "This item is outside the activated role.",
      actor: "human:test",
      idempotencyKey: "retarget:second:intake",
    });
    const untouched = controlPlane.triage({
      id: second.id,
      ownerRole: "reviewer",
      executionTarget: "local",
      actor: "human:test",
      idempotencyKey: "retarget:second:triage",
    });

    const changed = controlPlane.retargetUnclaimedWork({
      items: [{
        id: ready.id,
        expectedVersion: ready.version,
        ownerRole: "operator",
        fromExecutionTarget: "local",
        toExecutionTarget: "codex-host",
      }],
      actor: "human:test",
      idempotencyKey: "retarget:apply",
    });
    assert.equal(changed[0]?.executionTarget, "codex-host");
    assert.equal(changed[0]?.version, ready.version + 1);
    assert.equal(controlPlane.get(untouched.id).executionTarget, "local");
    assert.equal(
      controlPlane.auditRecords().some(
        ({ type, workItemId }) =>
          type === "work.execution-target.changed" && workItemId === ready.id,
      ),
      true,
    );
    assert.throws(
      () =>
        controlPlane.retargetUnclaimedWork({
          items: [{
            id: ready.id,
            expectedVersion: ready.version,
            ownerRole: "operator",
            fromExecutionTarget: "local",
            toExecutionTarget: "codex-host",
          }],
          actor: "human:test",
          idempotencyKey: "retarget:stale",
        }),
      /Version conflict/u,
    );
  } finally {
    database.close();
  }
});

test("agent-host ids remain durably bound to one Control Plane run", () => {
  const { database, controlPlane, item, claim } = claimedFixture("durable");
  try {
    const bound = controlPlane.bindAgentHostRun({
      workItemId: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      hostId: "codex-local",
      hostSessionId: "thread-42",
      hostRunId: "turn-7",
      actor: "runner:test",
      idempotencyKey: "host:bind",
    });
    assert.equal(bound.status, "running");
    assert.equal(controlPlane.activeAgentHostRun(item.id)?.hostRunId, "turn-7");

    const replay = controlPlane.bindAgentHostRun({
      workItemId: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      hostId: "codex-local",
      hostSessionId: "thread-42",
      hostRunId: "turn-7",
      actor: "runner:test",
      idempotencyKey: "host:bind",
    });
    assert.deepEqual(replay, bound);

    const waiting = controlPlane.checkpointAgentHostRun({
      workItemId: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      status: "waiting",
      lastEventCursor: "event-19",
      actor: "runner:test",
      idempotencyKey: "host:waiting",
    });
    assert.equal(waiting.lastEventCursor, "event-19");
    assert.equal(waiting.finishedAt, null);

    const finished = controlPlane.checkpointAgentHostRun({
      workItemId: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      status: "succeeded",
      lastEventCursor: "event-20",
      actor: "runner:test",
      idempotencyKey: "host:finished",
    });
    assert.equal(finished.status, "succeeded");
    assert.ok(finished.finishedAt);
    assert.equal(controlPlane.activeAgentHostRun(item.id), null);
    assert.throws(
      () =>
        controlPlane.checkpointAgentHostRun({
          workItemId: item.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          status: "failed",
          actor: "runner:test",
          idempotencyKey: "host:terminal-rewrite",
        }),
      /AGENT_HOST_BINDING_TERMINAL/u,
    );
  } finally {
    database.close();
  }
});

test("agent-host bindings reject unrelated run and attempt lineage", () => {
  const first = claimedFixture("first");
  try {
    const secondItem = first.controlPlane.intake({
      title: "A second host run",
      summary: "Create distinct lineage in the same Control Plane.",
      actor: "human:test",
      idempotencyKey: "host:second:intake",
    });
    first.controlPlane.triage({
      id: secondItem.id,
      ownerRole: "operator",
      executionTarget: "codex-host",
      actor: "human:test",
      idempotencyKey: "host:second:triage",
    });
    const secondClaim = first.controlPlane.claim({
      id: secondItem.id,
      actor: "runner:test",
      idempotencyKey: "host:second:claim",
    });
    assert.throws(
      () =>
        first.controlPlane.bindAgentHostRun({
          workItemId: first.item.id,
          runId: first.claim.runId,
          attemptId: secondClaim.attemptId,
          leaseId: first.claim.leaseId,
          generation: first.claim.generation,
          hostId: "codex-local",
          hostSessionId: "thread-wrong",
          hostRunId: "turn-wrong",
          actor: "runner:test",
          idempotencyKey: "host:wrong-lineage",
        }),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
  } finally {
    first.database.close();
  }
});

test("lease recovery abandons the invocation and its durable host binding together", () => {
  const { database, controlPlane, item, claim } = claimedFixture("recovery");
  try {
    controlPlane.startInvocation({
      attemptId: claim.attemptId,
      engineId: "codex-host",
      modelId: "host-managed",
    });
    controlPlane.bindAgentHostRun({
      workItemId: item.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      hostId: "codex-host",
      hostSessionId: "thread-recovery",
      hostRunId: "turn-recovery",
      actor: "runner:test",
      idempotencyKey: "host:recovery:bind",
    });
    database
      .prepare("UPDATE leases SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", claim.leaseId);
    assert.deepEqual(controlPlane.recoverExpiredLeases(), [item.id]);
    const binding = controlPlane.agentHostRunBinding(claim.runId);
    assert.equal(binding?.status, "failed");
    assert.equal(binding?.errorCode, "LEASE_EXPIRED");
    assert.ok(binding?.finishedAt);
    assert.equal(controlPlane.listInvocations(claim.attemptId)[0]?.status, "abandoned");
    assert.equal(
      controlPlane.auditRecords().some(({ type }) => type === "agent-host.abandoned"),
      true,
    );
  } finally {
    database.close();
  }
});
