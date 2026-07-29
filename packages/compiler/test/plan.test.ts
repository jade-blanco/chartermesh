import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalRequiredError,
  applyInstallPlan,
  createInstallPlan,
  createRollbackPlan,
  diffValues,
} from "../src/index.ts";
import type {
  InstallOperation,
  PlanApproval,
  PlanWriter,
} from "../src/types.ts";
import {
  loadOrganization,
  runtimeManifests,
} from "../../orgspec/test/fixtures.ts";

class RecordingWriter implements PlanWriter {
  readonly applied: InstallOperation[] = [];

  async apply(operation: InstallOperation): Promise<void> {
    this.applied.push(operation);
  }
}

function approvalFor(
  plan: ReturnType<typeof createInstallPlan>,
): PlanApproval {
  return {
    id: "approval-test",
    subject: "install_plan",
    status: "approved",
    specHash: plan.specHash,
    planHash: plan.planHash,
    approvedBy: "human:test",
  };
}

test("install plan is deterministic and marks proposed schedules manual", async () => {
  const organization = await loadOrganization();
  const left = createInstallPlan({ next: organization }, runtimeManifests);
  const right = createInstallPlan(
    { next: structuredClone(organization) },
    structuredClone(runtimeManifests),
  );

  assert.equal(left.planHash, right.planHash);
  assert.equal(left.specHash, right.specHash);
  assert.equal(
    left.operations.find(({ id }) => id === "schedule-implementation-dispatch")
      ?.applyMode,
    "manual",
  );
  assert.equal(
    left.operations.find(({ id }) => id === "role-strategy")?.resolution,
    "degraded",
  );
  assert.match(left.capabilitySnapshotHash, /^[a-f0-9]{64}$/u);
});

test("apply rejects a missing approval", async () => {
  const plan = createInstallPlan(
    { next: await loadOrganization() },
    runtimeManifests,
  );

  await assert.rejects(
    applyInstallPlan(plan, new RecordingWriter()),
    ApprovalRequiredError,
  );
});

test("apply rejects approval for a different plan hash", async () => {
  const plan = createInstallPlan(
    { next: await loadOrganization() },
    runtimeManifests,
  );
  const approval = approvalFor(plan);
  approval.planHash = "0".repeat(64);

  await assert.rejects(
    applyInstallPlan(plan, new RecordingWriter(), approval),
    /do not match/u,
  );
});

test("exact approval applies only managed operations", async () => {
  const plan = createInstallPlan(
    { next: await loadOrganization() },
    runtimeManifests,
  );
  const writer = new RecordingWriter();
  const manifest = await applyInstallPlan(
    plan,
    writer,
    approvalFor(plan),
  );

  assert.equal(
    writer.applied.length,
    plan.operations.filter(({ applyMode }) => applyMode === "managed").length,
  );
  assert.equal(manifest.planHash, plan.planHash);
  assert.equal(manifest.approvalId, "approval-test");
});

test("candidate changes produce new spec and plan hashes", async () => {
  const first = await loadOrganization();
  const firstPlan = createInstallPlan({ next: first }, runtimeManifests);
  const next = structuredClone(first);
  next.metadata.revision = 2;
  next.spec.mission = `${next.spec.mission} Preserve accessibility.`;
  const nextPlan = createInstallPlan(
    { current: first, next },
    runtimeManifests,
  );

  assert.notEqual(nextPlan.specHash, firstPlan.specHash);
  assert.notEqual(nextPlan.planHash, firstPlan.planHash);
  assert.ok(diffValues(first, next).some(({ path }) => path === "/metadata/revision"));
  assert.ok(diffValues(first, next).some(({ path }) => path === "/spec/mission"));
});

test("applied revision produces a hash-bound rollback plan", async () => {
  const current = await loadOrganization();
  const next = structuredClone(current);
  next.metadata.revision = 2;
  const installPlan = createInstallPlan(
    { current, next },
    runtimeManifests,
  );
  const manifest = await applyInstallPlan(
    installPlan,
    new RecordingWriter(),
    approvalFor(installPlan),
  );
  const rollback = createRollbackPlan(manifest, 1);

  assert.equal(rollback.fromRevision, 2);
  assert.equal(rollback.toRevision, 1);
  assert.equal(rollback.sourcePlanHash, installPlan.planHash);
  assert.match(rollback.rollbackPlanHash, /^[a-f0-9]{64}$/u);
  assert.ok(rollback.operations.every(({ approvalRequired }) => approvalRequired));
});

test("capability discovery changes are bound into a new plan hash", async () => {
  const organization = await loadOrganization();
  const first = createInstallPlan({ next: organization }, runtimeManifests);
  const changed = structuredClone(runtimeManifests);
  changed.modelEngines[0]!.capabilities.push({
    name: "model.vision.input",
    support: "native",
    stability: "stable",
  });
  const second = createInstallPlan({ next: organization }, changed);

  assert.equal(second.specHash, first.specHash);
  assert.notEqual(second.capabilitySnapshotHash, first.capabilitySnapshotHash);
  assert.notEqual(second.planHash, first.planHash);
});

test("capability snapshot hash ignores discovery ordering", async () => {
  const organization = await loadOrganization();
  const reordered = structuredClone(runtimeManifests);
  reordered.modelEngines.reverse();
  reordered.managedRunners.reverse();
  for (const engine of reordered.modelEngines) engine.capabilities.reverse();
  for (const runner of reordered.managedRunners) runner.capabilities.reverse();

  const first = createInstallPlan({ next: organization }, runtimeManifests);
  const second = createInstallPlan({ next: organization }, reordered);

  assert.equal(second.capabilitySnapshotHash, first.capabilitySnapshotHash);
  assert.equal(second.planHash, first.planHash);
});
