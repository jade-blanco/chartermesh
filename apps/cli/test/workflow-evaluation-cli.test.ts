import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";

const executable = resolve("bin", "chartermesh.mjs");

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

test("dry code-only planning binds three VM tasks without launching the sandbox", (t) => {
  const target = mkdtempSync(join(tmpdir(), "workflow-code-plan-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const planned = cli([
    "evaluate-workflow",
    "--target",
    target,
    "--code-only",
    "--json",
  ]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout).data;
  assert.equal(plan.tasks.length, 3);
  assert.equal(
    plan.tasks.every(
      (task: { family: string; executionBoundary: string }) =>
        task.family === "code" &&
        task.executionBoundary === "attested_vm",
    ),
    true,
  );
  assert.equal(plan.codeBoundary, "attested_vm_only");
  assert.equal(plan.liveReady, false);
  assert.equal(
    plan.limits.maxConsecutiveContractInvalidSubmissions,
    3,
  );
  assert.equal(
    plan.maximumConsecutiveContractInvalidSubmissionsPerTrajectory,
    3,
  );
  assert.match(
    plan.bindings.codeSandboxProvenanceHash,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    plan.bindings.codeSandboxLauncherCommitment,
    /^[a-f0-9]{64}$/u,
  );
  assert.ok(
    ["file_sha256", "command_name_only"].includes(
      plan.bindings.codeSandboxLauncherAttestation,
    ),
  );
  assert.equal(JSON.stringify(plan).includes("System32"), false);

  const changedGuard = cli([
    "evaluate-workflow",
    "--target",
    target,
    "--code-only",
    "--max-consecutive-contract-invalid-submissions",
    "4",
    "--json",
  ]);
  assert.equal(changedGuard.status, 0, changedGuard.stdout + changedGuard.stderr);
  const changedPlan = JSON.parse(changedGuard.stdout).data;
  assert.equal(
    changedPlan.limits.maxConsecutiveContractInvalidSubmissions,
    4,
  );
  assert.notEqual(changedPlan.planHash, plan.planHash);

  const invalidGuard = cli([
    "evaluate-workflow",
    "--target",
    target,
    "--code-only",
    "--max-consecutive-contract-invalid-submissions",
    "0",
    "--json",
  ]);
  assert.equal(invalidGuard.status, 1);
  assert.match(
    invalidGuard.stdout,
    /--max-consecutive-contract-invalid-submissions must be an integer from 1 to 100/u,
  );
});

test("evaluate-workflow requires a hash-bound plan and persists every trial in an isolated Control Plane", (t) => {
  const target = mkdtempSync(join(tmpdir(), "workflow-cli-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  const applied = cli([
    ...bootstrapArgs,
    "--approve",
    preview.data.planHash,
  ]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);

  const codexHash = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  const engineId = runtime.modelEngines[0].id;
  const studyArgs = [
    "evaluate-workflow",
    "--target",
    target,
    "--fixture",
    "product-package-easy-001",
    "--engine-id",
    engineId,
    "--codex-executable",
    process.execPath,
    "--codex-sha256",
    codexHash,
    "--codex-model",
    "offline-test-proxy",
    "--json",
  ];
  const planned = cli(studyArgs);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout).data;
  assert.equal(plan.liveReady, true);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/u);

  const rejected = cli([...studyArgs, "--live"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /requires --approve/u);

  const lockPath = join(
    target,
    ".chartermesh",
    "evaluations",
    `${plan.studyId}.lock`,
  );
  mkdirSync(
    join(target, ".chartermesh", "evaluations"),
    { recursive: true },
  );
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      apiVersion: "chartermesh.dev/collaboration-study-lock/v1alpha1",
      planHash: plan.planHash,
      pid: process.pid,
      nonce: "test-owner",
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const duplicate = cli([
    ...studyArgs,
    "--live",
    "--approve",
    plan.planHash,
  ]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /WORKFLOW_STUDY_ALREADY_RUNNING/u);
  rmSync(lockPath, { force: true });

  const executed = cli([
    ...studyArgs,
    "--live",
    "--approve",
    plan.planHash,
  ]);
  assert.equal(executed.status, 2, executed.stdout + executed.stderr);
  const payload = JSON.parse(executed.stdout).data;
  assert.equal(payload.report.trials.length, 6);
  assert.equal(payload.report.approvedPlanHash, plan.planHash);
  assert.deepEqual(
    JSON.parse(payload.report.approvedPlanCanonicalJson),
    plan,
  );
  assert.equal(payload.report.provenance.controlPlane.durableRuns, true);
  assert.equal(payload.report.provenance.productionHumanApprovalExercised, undefined);
  assert.equal(existsSync(payload.output), true);
  assert.equal(existsSync(payload.evaluationControlPlane), true);

  const database = openControlPlaneDatabase(payload.evaluationControlPlane);
  try {
    const artifacts = join(
      payload.evaluationControlPlane,
      "..",
      "artifacts",
    );
    const controlPlane = new ControlPlane(database, artifacts);
    assert.equal(controlPlane.list().length, 6);
    assert.equal(
      controlPlane.list().every(({ status }) => status === "review_pending"),
      true,
    );
    assert.equal(controlPlane.listInvocations().length, 6);
  } finally {
    database.close();
  }
});
