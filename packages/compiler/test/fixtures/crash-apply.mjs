import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFileTransaction } from "../../src/file-transaction.ts";

const target = process.argv[2];
if (!target) throw new Error("target is required");
const before = join(target, "existing.txt");
const created = join(target, "created.txt");
const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const previous = existsSync(before) ? readFileSync(before) : null;
applyFileTransaction(target, "crash-fixture", [
  {
    path: before,
    content: "after\n",
    beforeHash: previous ? digest(previous) : null,
    afterHash: digest("after\n"),
  },
  {
    path: created,
    content: "created\n",
    beforeHash: null,
    afterHash: digest("created\n"),
  },
]);
