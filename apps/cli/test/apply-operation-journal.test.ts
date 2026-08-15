import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { sha256 } from "../../../packages/orgspec/src/index.ts";
import {
  APPLY_OPERATION_JOURNAL_MAX_BYTES,
  beginApplyOperation,
  completeApplyOperation,
  findApplyOperation,
  inspectApplyOperationFiles,
  listPendingApplyOperations,
  loadApplyOperation,
  markApplyOperationDatabaseCommitted,
  markApplyOperationFilesCommitted,
  type ApplyOperationPlanLike,
  type ApplyOperationReceipt,
} from "../src/apply-operation-journal.ts";

interface FixturePlan extends ApplyOperationPlanLike {
  apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1";
  operation: "kickoff";
  engine: string;
  kickoff: {
    title: string;
    summary: string;
  };
}

function bytesHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixturePlan(
  target: string,
  files: Array<{
    path: string;
    content: string;
    before: string | null;
  }>,
): FixturePlan {
  const body = {
    apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const,
    operation: "kickoff" as const,
    target: resolve(target),
    engine: "fixture",
    files: files.map(({ path, content, before }) => ({
      path,
      content,
      beforeHash: before === null ? null : bytesHash(before),
      afterHash: bytesHash(content),
    })),
    kickoff: {
      title: "Resume an approved operation",
      summary: "The exact plan survives a process crash.",
    },
  };
  return { ...body, planHash: sha256(body) };
}

function receiptFile(target: string, planHash: string): string {
  return join(target, ".chartermesh", "operations", `${planHash}.json`);
}

function reseal(value: Record<string, unknown>): void {
  const { receiptHash: _receiptHash, ...body } = value;
  value.receiptHash = sha256(body);
}

test("an exact approved operation resumes across file and database settlement", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-apply-operation-"));
  const existing = join(target, "existing.txt");
  const created = join(target, "created.txt");
  writeFileSync(existing, "before\n");
  const plan = fixturePlan(target, [
    { path: existing, content: "after\n", before: "before\n" },
    { path: created, content: "created\n", before: null },
  ]);
  try {
    assert.equal(findApplyOperation(target, plan.planHash), null);
    const approved = beginApplyOperation(
      target,
      plan.planHash,
      plan,
      { approval: "human:local" },
    );
    assert.equal(approved.stage, "approved");
    assert.deepEqual(approved.plan, plan);
    assert.equal(inspectApplyOperationFiles(approved), "pending");
    assert.equal(listPendingApplyOperations(target).length, 1);
    assert.equal(lstatSync(receiptFile(target, plan.planHash)).isFile(), true);

    assert.throws(
      () => markApplyOperationDatabaseCommitted(target, plan.planHash),
      /cannot advance/u,
    );

    writeFileSync(existing, "after\n");
    assert.equal(inspectApplyOperationFiles(approved), "mixed");
    writeFileSync(existing, "before\n");
    writeFileSync(existing, "after\n");
    writeFileSync(created, "created\n");

    const recoveredWithoutRegeneration = loadApplyOperation<FixturePlan>(
      target,
      plan.planHash,
    );
    assert.deepEqual(recoveredWithoutRegeneration.plan, plan);
    assert.equal(
      inspectApplyOperationFiles(recoveredWithoutRegeneration),
      "committed",
    );

    const filesCommitted = markApplyOperationFilesCommitted(
      target,
      plan.planHash,
      { files: [existing, created] },
    );
    assert.equal(filesCommitted.stage, "files_committed");
    assert.deepEqual(
      markApplyOperationFilesCommitted(
        target,
        plan.planHash,
        { files: [existing, created] },
      ),
      filesCommitted,
    );
    assert.throws(
      () =>
        markApplyOperationFilesCommitted(target, plan.planHash, {
          files: ["another-result"],
        }),
      /another result/u,
    );

    const databaseCommitted = markApplyOperationDatabaseCommitted(
      target,
      plan.planHash,
      { workItemId: "work-000001", retargetedWorkItemIds: [] },
    );
    assert.equal(databaseCommitted.stage, "db_committed");
    const completed = completeApplyOperation(target, plan.planHash);
    assert.equal(completed.stage, "complete");
    assert.deepEqual(completed.result, databaseCommitted.result);
    assert.deepEqual(listPendingApplyOperations(target), []);

    const replay = beginApplyOperation(target, plan.planHash, plan);
    assert.deepEqual(replay, completed);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("receipt, plan, target, and size tampering fail closed", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-apply-tamper-"));
  const output = join(target, "output.txt");
  const plan = fixturePlan(target, [
    { path: output, content: "approved\n", before: null },
  ]);
  const path = receiptFile(target, plan.planHash);
  try {
    beginApplyOperation(target, plan.planHash, plan);
    const original = readFileSync(path, "utf8");

    const stageTamper = JSON.parse(original) as Record<string, unknown>;
    stageTamper.stage = "complete";
    writeFileSync(path, `${JSON.stringify(stageTamper)}\n`);
    assert.throws(
      () => loadApplyOperation(target, plan.planHash),
      /receipt hash/u,
    );

    const planTamper = JSON.parse(original) as Record<string, unknown>;
    const storedPlan = planTamper.plan as FixturePlan;
    storedPlan.files[0]!.content = "unapproved\n";
    reseal(planTamper);
    writeFileSync(path, `${JSON.stringify(planTamper)}\n`);
    assert.throws(
      () => loadApplyOperation(target, plan.planHash),
      /plan hash|afterHash/u,
    );

    const targetTamper = JSON.parse(original) as Record<string, unknown>;
    targetTamper.targetRoot = resolve(target, "elsewhere");
    reseal(targetTamper);
    writeFileSync(path, `${JSON.stringify(targetTamper)}\n`);
    assert.throws(
      () => loadApplyOperation(target, plan.planHash),
      /targets another project/u,
    );

    writeFileSync(path, original);
    truncateSync(path, APPLY_OPERATION_JOURNAL_MAX_BYTES + 1);
    assert.throws(
      () => loadApplyOperation(target, plan.planHash),
      /maximum byte size/u,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("operation paths reject escapes, non-regular receipts, and linked state", (context) => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-apply-path-"));
  const outside = mkdtempSync(join(tmpdir(), "chartermesh-apply-outside-"));
  try {
    const escaped = fixturePlan(target, [
      {
        path: join(outside, "escaped.txt"),
        content: "escape\n",
        before: null,
      },
    ]);
    assert.throws(
      () => beginApplyOperation(target, escaped.planHash, escaped),
      /escapes the target project/u,
    );
    const journalOverlap = fixturePlan(target, [
      {
        path: join(target, ".chartermesh", "operations", "owned.json"),
        content: "collision\n",
        before: null,
      },
    ]);
    assert.throws(
      () =>
        beginApplyOperation(
          target,
          journalOverlap.planHash,
          journalOverlap,
        ),
      /journal namespace/u,
    );
    assert.throws(
      () => loadApplyOperation(target, "../outside"),
      /lowercase SHA-256/u,
    );

    const plan = fixturePlan(target, [
      { path: join(target, "safe.txt"), content: "safe\n", before: null },
    ]);
    beginApplyOperation(target, plan.planHash, plan);
    const path = receiptFile(target, plan.planHash);
    rmSync(path);
    mkdirSync(path);
    assert.throws(
      () => loadApplyOperation(target, plan.planHash),
      /not a regular file/u,
    );

    rmSync(join(target, ".chartermesh", "operations"), {
      recursive: true,
      force: true,
    });
    try {
      symlinkSync(
        outside,
        join(target, ".chartermesh", "operations"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(
          String((error as NodeJS.ErrnoException).code),
        )
      ) {
        context.skip("This host does not permit a directory link fixture.");
        return;
      }
      throw error;
    }
    assert.throws(
      () => listPendingApplyOperations(target),
      /symbolic link|junction|reparse point/u,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("unserializable inputs and changed planned files are rejected", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-apply-json-"));
  const output = join(target, "output.txt");
  const plan = fixturePlan(target, [
    { path: output, content: "approved\n", before: null },
  ]);
  try {
    assert.throws(
      () =>
        beginApplyOperation(target, plan.planHash, plan, {
          invalid: undefined,
        } as never),
      /not JSON-serializable/u,
    );
    const receipt = beginApplyOperation(target, plan.planHash, plan);
    writeFileSync(output, "external change\n");
    assert.equal(inspectApplyOperationFiles(receipt), "changed");

    const forged = structuredClone(receipt) as ApplyOperationReceipt;
    forged.result = { changed: true };
    assert.throws(
      () => inspectApplyOperationFiles(forged),
      /receipt hash/u,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
