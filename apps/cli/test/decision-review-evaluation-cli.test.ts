import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createDecisionReviewEvaluationPlan } from "../src/decision-review-evaluation/runner.ts";
import {
  createInitialDecisionReviewCheckpoint,
  parseDecisionReviewCheckpoint,
} from "../src/decision-review-evaluation/resume.ts";

const executable = resolve("bin", "chartermesh.mjs");

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

test("decision-review CLI plans twenty calls without spawning Codex", (t) => {
  const target = mkdtempSync(join(tmpdir(), "decision-review-cli-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const executableHash = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  const args = [
    "evaluate-decision-review",
    "--target",
    target,
    "--codex-executable",
    process.execPath,
    "--codex-sha256",
    executableHash,
    "--codex-model",
    "offline-plan-only",
    "--json",
  ];
  const planned = cli(args);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout).data;
  assert.equal(plan.plannedCalls, 20);
  assert.equal(plan.schedule.length, 20);
  assert.equal(plan.liveReady, true);
  assert.equal(plan.mayResolveHumanApproval, false);
  assert.equal(plan.toolsEnabled, false);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(plan).includes(process.execPath), false);

  const changedArgs = [...args];
  changedArgs[changedArgs.indexOf("--codex-model") + 1] = "different-model";
  const changed = cli(changedArgs);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  assert.notEqual(JSON.parse(changed.stdout).data.planHash, plan.planHash);

  const rejected = cli([...args, "--live", "--approve", "0".repeat(64)]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(
    rejected.stdout,
    new RegExp(`requires --approve ${plan.planHash}`, "u"),
  );
});

test("decision-review CLI rejects partial reviewer bindings", (t) => {
  const target = mkdtempSync(join(tmpdir(), "decision-review-partial-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const result = cli([
    "evaluate-decision-review",
    "--target",
    target,
    "--codex-model",
    "missing-executable-and-hash",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Bind --codex-executable/u);
});

test("decision-review CLI creates a read-only, exact-hash resume plan", (t) => {
  const target = mkdtempSync(join(tmpdir(), "decision-review-resume-cli-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const executableHash = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  const reviewer = {
    executableSha256: executableHash,
    modelId: "offline-resume-plan-only",
    timeoutMs: 120_000,
    maxOutputBytes: 1_048_576,
    engineProfileId: "codex-cli-decision-review" as const,
  };
  const plan = createDecisionReviewEvaluationPlan({ reviewer });
  const initial = createInitialDecisionReviewCheckpoint(plan, plan.planHash);
  const checkpoint = parseDecisionReviewCheckpoint({
    ...initial,
    status: "paused",
    processAttempts: 1,
    nonScoringPauses: [
      {
        reasonCode: "usage_limit_reached",
        sequence: 1,
        segmentIndex: 0,
      },
    ],
    pause: { reasonCode: "usage_limit_reached", sequence: 1 },
  });
  const evaluation = join(
    target,
    ".chartermesh",
    "evaluations",
    plan.benchmarkId,
  );
  mkdirSync(evaluation, { recursive: true });
  const planPath = join(evaluation, "plan.json");
  const checkpointPath = join(evaluation, "checkpoint.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeFileSync(
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf8",
  );
  const before = readFileSync(checkpointPath, "utf8");
  const baseArgs = [
    "evaluate-decision-review",
    "--target",
    target,
    "--codex-executable",
    process.execPath,
    "--codex-sha256",
    executableHash,
    "--codex-model",
    reviewer.modelId,
    "--resume",
    "--json",
  ];
  const changed = cli([...baseArgs, "--account-context", "changed"]);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  const changedPlan = JSON.parse(changed.stdout).data;
  assert.equal(changedPlan.basePlanHash, plan.planHash);
  assert.equal(changedPlan.completedCount, 0);
  assert.equal(changedPlan.nextSequence, 1);
  assert.equal(changedPlan.accountContext, "changed");
  assert.match(changedPlan.resumePlanHash, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(checkpointPath, "utf8"), before);

  const same = cli([...baseArgs, "--account-context", "same"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.notEqual(
    JSON.parse(same.stdout).data.resumePlanHash,
    changedPlan.resumePlanHash,
  );

  const rejected = cli([
    ...baseArgs,
    "--account-context",
    "changed",
    "--live",
    "--approve",
    plan.planHash,
  ]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout, new RegExp(changedPlan.resumePlanHash, "u"));
  assert.equal(existsSync(join(evaluation, "lock.json")), false);
  assert.equal(readFileSync(checkpointPath, "utf8"), before);

  writeFileSync(
    join(evaluation, "lock.json"),
    `${JSON.stringify({
      apiVersion: "chartermesh.dev/collaboration-study-lock/v1alpha1",
      planHash: plan.planHash,
      pid: 999_999_999,
      nonce: "stale-test-lock",
      createdAt: new Date(0).toISOString(),
    })}\n`,
    "utf8",
  );
  const resumed = cli([
    ...baseArgs,
    "--account-context",
    "changed",
    "--live",
    "--approve",
    changedPlan.resumePlanHash,
  ]);
  assert.equal(resumed.status, 2, resumed.stdout + resumed.stderr);
  const report = JSON.parse(resumed.stdout).data.report;
  assert.equal(report.trials.length, 20);
  assert.equal(report.execution.processAttempts, 21);
  assert.equal(report.execution.resumeCount, 1);
  assert.equal(report.execution.contextConfounded, true);
  assert.equal(report.gates.demonstratedPilotBenefit, false);
  assert.equal(existsSync(checkpointPath), false);
  assert.equal(existsSync(join(evaluation, "lock.json")), false);
  assert.equal(
    existsSync(
      join(
        evaluation,
        "used-approvals",
        `${changedPlan.resumePlanHash}.json`,
      ),
    ),
    true,
  );
  assert.equal(
    readdirSync(evaluation).some((name) =>
      name.startsWith("lock.json.abandoned-"),
    ),
    true,
  );
});

test("decision-review live mode rejects a reparse-point state root", (t) => {
  const target = mkdtempSync(join(tmpdir(), "decision-review-reparse-target-"));
  const outside = mkdtempSync(join(tmpdir(), "decision-review-reparse-outside-"));
  t.after(() => {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const executableHash = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  const baseArgs = [
    "evaluate-decision-review",
    "--target",
    target,
    "--codex-executable",
    process.execPath,
    "--codex-sha256",
    executableHash,
    "--codex-model",
    "offline-reparse-test",
    "--json",
  ];
  const planned = cli(baseArgs);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout).data;
  try {
    symlinkSync(outside, join(target, ".chartermesh"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("junction creation is unavailable in this environment");
      return;
    }
    throw error;
  }
  const rejected = cli([
    ...baseArgs,
    "--live",
    "--approve",
    plan.planHash,
  ]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(
    rejected.stdout,
    /DECISION_REVIEW_STATE_REPARSE_POINT_REJECTED|PROJECT_STATE_LINK_REJECTED/u,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("decision-review live state separates the durable checkpoint from the final report", (t) => {
  const target = mkdtempSync(join(tmpdir(), "decision-review-live-state-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const executableHash = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  const baseArgs = [
    "evaluate-decision-review",
    "--target",
    target,
    "--codex-executable",
    process.execPath,
    "--codex-sha256",
    executableHash,
    "--codex-model",
    "offline-non-provider-process",
    "--codex-timeout-ms",
    "5000",
    "--json",
  ];
  const planned = cli(baseArgs);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout).data;
  const completed = cli([
    ...baseArgs,
    "--live",
    "--approve",
    plan.planHash,
  ]);
  assert.equal(completed.status, 2, completed.stdout + completed.stderr);
  const report = JSON.parse(completed.stdout).data.report;
  assert.equal(report.trials.length, 20);
  assert.equal(report.execution.processAttempts, 20);
  assert.equal(
    report.trials.every(
      (trial: { failure?: { code?: string } }) =>
        trial.failure?.code === "CODEX_PROXY_EXIT_NONZERO",
    ),
    true,
  );
  const evaluation = join(
    target,
    ".chartermesh",
    "evaluations",
    plan.benchmarkId,
  );
  const output = join(
    target,
    ".chartermesh",
    "exports",
    `${plan.benchmarkId}.json`,
  );
  assert.equal(existsSync(join(evaluation, "plan.json")), true);
  assert.equal(existsSync(join(evaluation, "checkpoint.json")), false);
  assert.equal(existsSync(join(evaluation, "lock.json")), false);
  assert.equal(existsSync(output), true);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "completed");
});
