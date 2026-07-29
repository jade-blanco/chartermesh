import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { recoverFileTransactions } from "../src/index.ts";

test("an interrupted file replacement is automatically rolled back", () => {
  const target = mkdtempSync(
    join(tmpdir(), "chartermesh-file-transaction-"),
  );
  writeFileSync(join(target, "existing.txt"), "before\n");
  const fixture = resolve(
    "packages",
    "compiler",
    "test",
    "fixtures",
    "crash-apply.mjs",
  );
  const crashed = spawnSync(process.execPath, [fixture, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      CHARTERMESH_TEST_CRASH_AFTER_RENAMES: "1",
    },
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(
    readFileSync(join(target, "existing.txt"), "utf8"),
    "after\n",
  );

  const recovered = recoverFileTransactions(target);
  assert.deepEqual(recovered, [
    { transactionId: "crash-fixture", action: "rolled_back" },
  ]);
  assert.equal(
    readFileSync(join(target, "existing.txt"), "utf8"),
    "before\n",
  );
  assert.equal(existsSync(join(target, "created.txt")), false);
  assert.equal(
    existsSync(
      join(target, ".chartermesh", ".transactions", "crash-fixture"),
    ),
    false,
  );
});
