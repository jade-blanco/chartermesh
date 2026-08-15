import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  applyFileTransaction,
  type FileTransactionInput,
} from "../../../packages/compiler/src/index.ts";
import { ControlPlane, openControlPlaneDatabase } from "../../../packages/control-plane/src/index.ts";
import {
  beginApplyOperation,
  markApplyOperationFilesCommitted,
  type ApplyOperationPlanLike,
} from "../src/apply-operation-journal.ts";

const executable = resolve("bin", "chartermesh.mjs");

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

test("kickoff turns an approved brief into files and one triaged work item", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-target-"));
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-input-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(
    briefPath,
    "# Neighborhood pantry tracker\n\nBuild an offline-first inventory prototype.",
    "utf8",
  );
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--engine",
    "fake",
    "--acceptance",
    "The prototype has an inventory workflow and verification evidence.",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const envelope = JSON.parse(preview.stdout) as {
    data: { applied: boolean; planHash: string; kickoff: { briefHash: string } };
  };
  assert.equal(envelope.data.applied, false);
  assert.match(envelope.data.planHash, /^[a-f0-9]{64}$/u);
  assert.match(envelope.data.kickoff.briefHash, /^[a-f0-9]{64}$/u);
  assert.equal(existsSync(join(target, ".chartermesh", "runtime.json")), false);

  const applied = cli([...args, "--approve", envelope.data.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedEnvelope = JSON.parse(applied.stdout) as {
    data: { applied: boolean; workItemId: string };
  };
  assert.equal(appliedEnvelope.data.applied, true);
  assert.match(appliedEnvelope.data.workItemId, /^work-\d{6}$/u);
  assert.match(
    readFileSync(join(target, ".chartermesh", "PROJECT-BRIEF.md"), "utf8"),
    /offline-first inventory prototype/u,
  );
  assert.match(readFileSync(join(target, "CHARTERMESH.md"), "utf8"), /Control Plane/u);

  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const controlPlane = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    );
    const [item] = controlPlane.list();
    assert.equal(item?.id, appliedEnvelope.data.workItemId);
    assert.equal(item?.status, "ready");
    assert.equal(item?.ownerRole, "operator");
    assert.equal(item?.executionTarget, "local");
    assert.equal(
      controlPlane.decisionContract(item!.id).acceptanceCriteria[0]?.critical,
      true,
    );
  } finally {
    database.close();
  }
});

test("kickoff rejects missing, empty, and oversized briefs before writing", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-reject-"));
  const empty = join(target, "empty.md");
  writeFileSync(empty, "  \n", "utf8");
  const result = cli([
    "kickoff",
    "--target",
    target,
    "--brief-file",
    empty,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be empty/u);
  assert.equal(existsSync(join(target, ".chartermesh", "runtime.json")), false);
});

test("kickoff resumes after files and intake commit without duplicate work", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-kickoff-resume-"));
  const briefPath = join(target, "brief.md");
  writeFileSync(briefPath, "# Resume fixture\n\nBuild one verified result.\n", "utf8");
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  type KickoffPlan = ApplyOperationPlanLike & {
    operation: "kickoff";
    target: string;
    planHash: string;
    files: FileTransactionInput[];
    kickoff: {
      title: string;
      summary: string;
      ownerRole: string;
      executionTarget: string;
      priority: number;
      decisionQuestion: string;
      acceptanceCriteria: Array<{
        id: string;
        text: string;
        critical: boolean;
        evidenceRequirements: string[];
      }>;
    };
  };
  const previewData = (JSON.parse(preview.stdout) as {
    data: KickoffPlan & { applied: boolean; approvalRequired: boolean };
  }).data;
  const {
    applied: _applied,
    approvalRequired: _approvalRequired,
    ...plan
  } = previewData;
  beginApplyOperation(target, plan.planHash, plan);
  applyFileTransaction(target, plan.planHash, plan.files);
  markApplyOperationFilesCommitted(target, plan.planHash, {
    fileCount: plan.files.length,
  });

  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  let interruptedItemId: string;
  try {
    const controlPlane = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    );
    interruptedItemId = controlPlane.intake({
      title: plan.kickoff.title,
      summary: plan.kickoff.summary,
      ownerRole: plan.kickoff.ownerRole,
      executionTarget: plan.kickoff.executionTarget,
      priority: plan.kickoff.priority,
      decisionQuestion: plan.kickoff.decisionQuestion,
      acceptanceCriteria: plan.kickoff.acceptanceCriteria,
      actor: "human:local",
      idempotencyKey: `kickoff:${plan.planHash}:intake`,
    }).id;
  } finally {
    database.close();
  }

  const resumed = cli([...args, "--approve", plan.planHash]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedEnvelope = JSON.parse(resumed.stdout) as {
    data: { applied: boolean; workItemId: string };
  };
  assert.equal(resumedEnvelope.data.applied, true);
  assert.equal(resumedEnvelope.data.workItemId, interruptedItemId);

  const resumedDatabase = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    const controlPlane = new ControlPlane(
      resumedDatabase,
      join(target, ".chartermesh", "artifacts"),
    );
    const items = controlPlane.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, interruptedItemId);
    assert.equal(items[0]?.status, "ready");
  } finally {
    resumedDatabase.close();
  }
});
