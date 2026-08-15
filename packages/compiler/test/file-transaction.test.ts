import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  applyFileTransaction,
  recoverFileTransactions,
} from "../src/index.ts";
import { recoverFileTransaction } from "../src/file-transaction.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createDirectoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function createJournalFixture(
  target: string,
  transactionId: string,
): {
  directory: string;
  journal: Record<string, unknown>;
} {
  const directory = join(
    target,
    ".chartermesh",
    ".transactions",
    transactionId,
  );
  mkdirSync(directory, { recursive: true });
  const content = "after\n";
  writeFileSync(join(directory, "0.next"), content);
  return {
    directory,
    journal: {
      apiVersion: "chartermesh.dev/apply-journal/v1alpha1",
      transactionId,
      targetRoot: target,
      createdAt: new Date(0).toISOString(),
      files: [
        {
          target: join(target, "result.txt"),
          nextPath: join(directory, "0.next"),
          backupPath: null,
          beforeHash: null,
          afterHash: digest(content),
        },
      ],
    },
  };
}

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

test("apply journals reject crafted paths, layouts, hashes, and extra fields", () => {
  const cases: Array<{
    name: string;
    mutate: (
      journal: Record<string, unknown>,
      directory: string,
      target: string,
      outside: string,
    ) => void;
  }> = [
    {
      name: "extra top-level field",
      mutate: (journal) => {
        journal.unexpected = true;
      },
    },
    {
      name: "transaction id differs from directory",
      mutate: (journal) => {
        journal.transactionId = "another-transaction";
      },
    },
    {
      name: "relative target root",
      mutate: (journal) => {
        journal.targetRoot = ".";
      },
    },
    {
      name: "target escapes project",
      mutate: (journal, _directory, _target, outside) => {
        const files = journal.files as Array<Record<string, unknown>>;
        files[0]!.target = outside;
      },
    },
    {
      name: "staged path is not the indexed transaction path",
      mutate: (journal, directory) => {
        const files = journal.files as Array<Record<string, unknown>>;
        files[0]!.nextPath = join(directory, "1.next");
      },
    },
    {
      name: "backup layout does not match beforeHash",
      mutate: (journal, directory) => {
        const files = journal.files as Array<Record<string, unknown>>;
        files[0]!.backupPath = join(directory, "0.before");
      },
    },
    {
      name: "uppercase digest",
      mutate: (journal) => {
        const files = journal.files as Array<Record<string, unknown>>;
        files[0]!.afterHash = String(files[0]!.afterHash).toUpperCase();
      },
    },
    {
      name: "extra entry field",
      mutate: (journal) => {
        const files = journal.files as Array<Record<string, unknown>>;
        files[0]!.unexpected = true;
      },
    },
  ];

  for (const scenario of cases) {
    const base = mkdtempSync(join(tmpdir(), "chartermesh-crafted-journal-"));
    const target = join(base, "project");
    const outside = join(base, "outside.txt");
    mkdirSync(target);
    writeFileSync(outside, "outside must survive\n");
    const { directory, journal } = createJournalFixture(
      target,
      "crafted-journal",
    );
    scenario.mutate(journal, directory, target, outside);
    writeFileSync(
      join(directory, "journal.json"),
      `${JSON.stringify(journal)}\n`,
    );

    assert.throws(
      () => recoverFileTransactions(target),
      /journal|absolute|escapes|layout|hash/u,
      scenario.name,
    );
    assert.equal(
      readFileSync(outside, "utf8"),
      "outside must survive\n",
      scenario.name,
    );
    assert.equal(existsSync(join(target, "result.txt")), false, scenario.name);
  }
});

test("apply journals are read with a strict byte bound", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-large-journal-"));
  const { directory } = createJournalFixture(target, "oversized-journal");
  writeFileSync(
    join(directory, "journal.json"),
    Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
  );
  assert.throws(
    () => recoverFileTransactions(target),
    /oversized apply journal/u,
  );
  assert.equal(existsSync(join(target, "result.txt")), false);
});

test("exact recovery refuses unrelated pending transaction directories", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-exact-recovery-"));
  const wanted = createJournalFixture(target, "wanted-transaction");
  const unrelated = createJournalFixture(target, "unrelated-transaction");
  unrelated.journal.unexpected = true;
  writeFileSync(
    join(unrelated.directory, "journal.json"),
    `${JSON.stringify(unrelated.journal)}\n`,
  );
  writeFileSync(
    join(wanted.directory, "journal.json"),
    `${JSON.stringify(wanted.journal)}\n`,
  );

  assert.throws(
    () =>
      recoverFileTransaction(target, "wanted-transaction", [
        {
          path: join(target, "result.txt"),
          content: "after\n",
          beforeHash: null,
          afterHash: digest("after\n"),
        },
      ]),
    /Unrelated pending transaction/u,
  );
  assert.equal(existsSync(wanted.directory), true);
  assert.equal(existsSync(unrelated.directory), true);
});

test("exact recovery resumes only its approved transaction", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-exact-resume-"));
  const fixture = createJournalFixture(target, "approved-transaction");
  writeFileSync(
    join(fixture.directory, "journal.json"),
    `${JSON.stringify(fixture.journal)}\n`,
  );
  assert.deepEqual(
    recoverFileTransaction(target, "approved-transaction", [
      {
        path: join(target, "result.txt"),
        content: "after\n",
        beforeHash: null,
        afterHash: digest("after\n"),
      },
    ]),
    {
      transactionId: "approved-transaction",
      action: "rolled_back",
    },
  );
  assert.equal(existsSync(fixture.directory), false);
});

test("apply refuses to bypass an unrelated pending transaction", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-pending-sibling-"));
  const pending = createJournalFixture(target, "pending-transaction");
  writeFileSync(
    join(pending.directory, "journal.json"),
    `${JSON.stringify(pending.journal)}\n`,
  );
  const proposed = join(target, "proposed.txt");
  assert.throws(
    () =>
      applyFileTransaction(target, "new-approved-transaction", [
        {
          path: proposed,
          content: "proposed\n",
          beforeHash: null,
          afterHash: digest("proposed\n"),
        },
      ]),
    /Unrelated pending transaction/u,
  );
  assert.equal(existsSync(proposed), false);
  assert.equal(existsSync(pending.directory), true);
});

test("exact recovery rejects a schema-valid journal outside the approved file set", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-exact-fence-"));
  const fixture = createJournalFixture(target, "approved-plan");
  writeFileSync(
    join(fixture.directory, "journal.json"),
    `${JSON.stringify(fixture.journal)}\n`,
  );
  assert.throws(
    () =>
      recoverFileTransaction(target, "approved-plan", [
        {
          path: join(target, "different.txt"),
          content: "different\n",
          beforeHash: null,
          afterHash: digest("different\n"),
        },
      ]),
    /does not match the approved file set/u,
  );
  assert.equal(existsSync(fixture.directory), true);
  assert.equal(existsSync(join(target, "result.txt")), false);
  assert.equal(existsSync(join(target, "different.txt")), false);
});

test("a later staging race preserves the external edit and rolls back earlier files", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-staging-race-"));
  const first = join(target, "first.txt");
  const second = join(target, "second.txt");
  writeFileSync(first, "first before\n");
  writeFileSync(second, "second before\n");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    ordinal: process.env.CHARTERMESH_TEST_EDIT_BEFORE_RENAME,
    path: process.env.CHARTERMESH_TEST_EDIT_PATH,
    content: process.env.CHARTERMESH_TEST_EDIT_CONTENT,
  };
  process.env.NODE_ENV = "test";
  process.env.CHARTERMESH_TEST_EDIT_BEFORE_RENAME = "2";
  process.env.CHARTERMESH_TEST_EDIT_PATH = second;
  process.env.CHARTERMESH_TEST_EDIT_CONTENT = "external edit\n";
  try {
    assert.throws(
      () =>
        applyFileTransaction(target, "staging-race", [
          {
            path: first,
            content: "first after\n",
            beforeHash: digest("first before\n"),
            afterHash: digest("first after\n"),
          },
          {
            path: second,
            content: "second after\n",
            beforeHash: digest("second before\n"),
            afterHash: digest("second after\n"),
          },
        ]),
      /Target changed after planning/u,
    );
  } finally {
    for (const [key, value] of [
      ["NODE_ENV", previous.nodeEnv],
      ["CHARTERMESH_TEST_EDIT_BEFORE_RENAME", previous.ordinal],
      ["CHARTERMESH_TEST_EDIT_PATH", previous.path],
      ["CHARTERMESH_TEST_EDIT_CONTENT", previous.content],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(readFileSync(first, "utf8"), "first before\n");
  assert.equal(readFileSync(second, "utf8"), "external edit\n");
  assert.equal(
    existsSync(join(target, ".chartermesh", ".transactions", "staging-race")),
    false,
  );
});

test("a planned-new target is rechecked for nonexistence at the rename boundary", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-new-file-race-"));
  const first = join(target, "first.txt");
  const plannedNew = join(target, "planned-new.txt");
  writeFileSync(first, "first before\n");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    ordinal: process.env.CHARTERMESH_TEST_EDIT_BEFORE_RENAME,
    path: process.env.CHARTERMESH_TEST_EDIT_PATH,
    content: process.env.CHARTERMESH_TEST_EDIT_CONTENT,
  };
  process.env.NODE_ENV = "test";
  process.env.CHARTERMESH_TEST_EDIT_BEFORE_RENAME = "2";
  process.env.CHARTERMESH_TEST_EDIT_PATH = plannedNew;
  // Even an external creation byte-identical to the planned after-image must
  // be preserved while the staged .next file proves we never installed it.
  process.env.CHARTERMESH_TEST_EDIT_CONTENT = "planned content\n";
  try {
    assert.throws(
      () =>
        applyFileTransaction(target, "new-file-race", [
          {
            path: first,
            content: "first after\n",
            beforeHash: digest("first before\n"),
            afterHash: digest("first after\n"),
          },
          {
            path: plannedNew,
            content: "planned content\n",
            beforeHash: null,
            afterHash: digest("planned content\n"),
          },
        ]),
      /now exists/u,
    );
  } finally {
    for (const [key, value] of [
      ["NODE_ENV", previous.nodeEnv],
      ["CHARTERMESH_TEST_EDIT_BEFORE_RENAME", previous.ordinal],
      ["CHARTERMESH_TEST_EDIT_PATH", previous.path],
      ["CHARTERMESH_TEST_EDIT_CONTENT", previous.content],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(readFileSync(first, "utf8"), "first before\n");
  assert.equal(readFileSync(plannedNew, "utf8"), "planned content\n");
});

test("file transactions reject case-folded duplicate targets before mutation", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-file-duplicate-"));
  assert.throws(
    () => applyFileTransaction(target, "duplicate-target", [
      {
        path: join(target, "Result.txt"),
        content: "first\n",
        beforeHash: null,
        afterHash: digest("first\n"),
      },
      {
        path: join(target, "result.txt"),
        content: "second\n",
        beforeHash: null,
        afterHash: digest("second\n"),
      },
    ]),
    /duplicate case-folded target/u,
  );
  assert.equal(existsSync(join(target, "Result.txt")), false);
  assert.equal(existsSync(join(target, "result.txt")), false);
});

test("file transactions reject Windows namespace and alias targets before mutation", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-file-portable-path-"));
  for (const [index, path] of [
    join(target, "nested", "CON.txt"),
    join(target, "nested", "file.txt:stream"),
    join(target, "nested", "trailing."),
    join(target, "nested", "trailing "),
  ].entries()) {
    assert.throws(
      () => applyFileTransaction(target, `unsafe-target-${index}`, [{
        path,
        content: "denied\n",
        beforeHash: null,
        afterHash: digest("denied\n"),
      }]),
      /unsafe portable path alias/u,
      path,
    );
    assert.equal(existsSync(path), false);
  }
});

test("file transactions verify supplied content hashes before mutation", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-file-content-hash-"));
  assert.throws(
    () => applyFileTransaction(target, "wrong-content-hash", [{
      path: join(target, "result.txt"),
      content: "actual\n",
      beforeHash: null,
      afterHash: digest("different\n"),
    }]),
    /content hash does not match afterHash/u,
  );
  assert.equal(existsSync(join(target, "result.txt")), false);
});

test("governed file transactions deny canonical host-control paths", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-host-control-"));
  mkdirSync(join(target, "nested", ".git"), { recursive: true });
  const protectedTarget = join(target, "nested", ".git", "config");
  assert.throws(
    () =>
      applyFileTransaction(
        target,
        "host-control-denied",
        [
          {
            path: protectedTarget,
            content: "denied\n",
            beforeHash: null,
            afterHash: digest("denied\n"),
          },
        ],
        { denyHostControlPaths: true },
      ),
    /protected host-control path/u,
  );
  assert.equal(existsSync(protectedTarget), false);
});

test(
  "governed file transactions resolve nested Windows 8.3 control aliases",
  { skip: process.platform !== "win32" },
  (context) => {
    const target = mkdtempSync(join(tmpdir(), "chartermesh-short-alias-"));
    const nested = join(target, "nested");
    mkdirSync(join(nested, ".chartermesh"), { recursive: true });
    const shortAlias = join(nested, "CHARTE~1");
    if (!existsSync(shortAlias)) {
      context.skip("NTFS 8.3 names are disabled for this volume.");
      return;
    }
    const protectedTarget = join(shortAlias, "state.json");
    assert.throws(
      () =>
        applyFileTransaction(
          target,
          "short-alias-denied",
          [
            {
              path: protectedTarget,
              content: "denied\n",
              beforeHash: null,
              afterHash: digest("denied\n"),
            },
          ],
          { denyHostControlPaths: true },
        ),
      /protected host-control path/u,
    );
    assert.equal(existsSync(protectedTarget), false);
  },
);

test(
  "a managed target cannot traverse a Unix symbolic link",
  { skip: process.platform === "win32" },
  () => {
    const base = mkdtempSync(
      join(tmpdir(), "chartermesh-file-transaction-link-"),
    );
    const target = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(target);
    mkdirSync(outside);
    createDirectoryLink(outside, join(target, "linked"));

    assert.throws(
      () =>
        applyFileTransaction(target, "unix-link", [
          {
            path: join(target, "linked", "escaped.txt"),
            content: "must stay contained\n",
            beforeHash: null,
            afterHash: digest("must stay contained\n"),
          },
        ]),
      /symbolic link, junction, or reparse-point/u,
    );
    assert.equal(existsSync(join(outside, "escaped.txt")), false);
  },
);

test(
  "a managed target cannot traverse a Windows junction",
  { skip: process.platform !== "win32" },
  (context) => {
    const base = mkdtempSync(
      join(tmpdir(), "chartermesh-file-transaction-junction-"),
    );
    const target = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(target);
    mkdirSync(outside);
    try {
      createDirectoryLink(outside, join(target, "linked"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "ENOSYS", "EOPNOTSUPP"].includes(
          String((error as NodeJS.ErrnoException).code),
        )
      ) {
        context.skip(`Windows junctions are unavailable: ${error.message}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () =>
        applyFileTransaction(target, "windows-junction", [
          {
            path: join(target, "linked", "escaped.txt"),
            content: "must stay contained\n",
            beforeHash: null,
            afterHash: digest("must stay contained\n"),
          },
        ]),
      /symbolic link, junction, or reparse-point/u,
    );
    assert.equal(existsSync(join(outside, "escaped.txt")), false);
  },
);

test("the transaction metadata directory cannot be a link", (context) => {
  const base = mkdtempSync(
    join(tmpdir(), "chartermesh-file-transaction-metadata-link-"),
  );
  const target = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(target);
  mkdirSync(outside);
  try {
    createDirectoryLink(outside, join(target, ".chartermesh"));
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "ENOSYS", "EOPNOTSUPP"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      context.skip(`Directory links are unavailable: ${error.message}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () =>
      applyFileTransaction(target, "metadata-link", [
        {
          path: join(target, "safe.txt"),
          content: "safe\n",
          beforeHash: null,
          afterHash: digest("safe\n"),
        },
      ]),
    /symbolic link, junction, or reparse-point/u,
  );
  assert.equal(existsSync(join(outside, ".apply-lock")), false);
  assert.equal(existsSync(join(target, "safe.txt")), false);
});

test("the target root cannot have a linked ancestor", (context) => {
  const base = mkdtempSync(
    join(tmpdir(), "chartermesh-file-transaction-root-link-"),
  );
  const actualParent = join(base, "actual-parent");
  const actualTarget = join(actualParent, "project");
  const linkedParent = join(base, "linked-parent");
  mkdirSync(actualParent);
  mkdirSync(actualTarget);
  try {
    createDirectoryLink(actualParent, linkedParent);
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "ENOSYS", "EOPNOTSUPP"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      context.skip(`Directory links are unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  const targetThroughLink = join(linkedParent, "project");

  assert.throws(
    () =>
      applyFileTransaction(targetThroughLink, "linked-root-ancestor", [
        {
          path: join(targetThroughLink, "escaped.txt"),
          content: "must reject linked root ancestry\n",
          beforeHash: null,
          afterHash: digest("must reject linked root ancestry\n"),
        },
      ]),
    /symbolic link, junction, or reparse-point/u,
  );
  assert.equal(existsSync(join(actualTarget, "escaped.txt")), false);
});
