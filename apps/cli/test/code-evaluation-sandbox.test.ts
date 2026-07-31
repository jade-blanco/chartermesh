import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  requireSafeSandbox,
  sandboxProbePassed,
  validateSandboxResults,
  type CodeSandboxBackend,
  type CodeSandboxJob,
  type CodeSandboxProbe,
  type CodeSandboxRunResult,
} from "../src/code-evaluation/sandbox.ts";
import {
  attestWindowsSandboxLauncher,
  cleanupSandboxSession,
  compareSandboxCase,
  createWindowsSandboxSessionJournal,
  inspectSandboxOutputTree,
  parseAuthenticatedCandidateEnvelope,
  parseWindowsSandboxSessionJournal,
  persistWindowsSandboxSessionJournal,
  PROGRAM_OUTPUT_LIMIT_BYTES,
  recoverWindowsSandboxSessionJournal,
  stageNodeRuntime,
  stageProvenanceFile,
  validateCanaryArtifacts,
  verifyStagedProvenanceFiles,
  windowsSandboxListAttestsStopped,
  windowsSandboxConfiguration,
} from "../src/code-evaluation/windows-sandbox.ts";

const passingManifest = {
  id: "test-vm",
  isolation: "vm",
  network: "disabled",
  hostFilesystem: "mapped-allowlist",
  generatedCodeExecution: true,
} as const;

const passingProbe: CodeSandboxProbe = {
  ok: true,
  backendId: "test-vm",
  evidence: {
    networkDenied: true,
    hostReadDenied: true,
    hostWriteDenied: true,
    childEscapeDenied: true,
    timeoutEnforced: true,
    outputAllowlistEnforced: true,
  },
  issues: [],
};

function backend(
  probe: CodeSandboxProbe,
  manifest: CodeSandboxBackend["manifest"] = passingManifest,
): CodeSandboxBackend {
  return {
    manifest,
    async probe() {
      return structuredClone(probe);
    },
    async run() {
      throw new Error("The offline canary test never executes code.");
    },
  };
}

test("Windows Sandbox configuration disables ambient channels", () => {
  const configuration = windowsSandboxConfiguration({
    input: "C:\\canary & input",
    output: "C:\\canary output",
    runtime: "C:\\node runtime",
  });

  for (const setting of [
    "<VGpu>Disable</VGpu>",
    "<Networking>Disable</Networking>",
    "<AudioInput>Disable</AudioInput>",
    "<VideoInput>Disable</VideoInput>",
    "<PrinterRedirection>Disable</PrinterRedirection>",
    "<ClipboardRedirection>Disable</ClipboardRedirection>",
    "<ProtectedClient>Enable</ProtectedClient>",
  ]) {
    assert.match(configuration, new RegExp(setting, "u"), setting);
  }
  assert.match(configuration, /C:\\canary &amp; input/u);

  const mappings = [
    ...configuration.matchAll(
      /<MappedFolder>([\s\S]*?)<\/MappedFolder>/gu,
    ),
  ].map((match) => match[1]!);
  assert.equal(mappings.length, 3);
  assert.match(mappings[0]!, /C:\\CharterMesh\\Input/u);
  assert.match(mappings[0]!, /<ReadOnly>true<\/ReadOnly>/u);
  assert.match(mappings[1]!, /C:\\CharterMesh\\Output/u);
  assert.match(mappings[1]!, /<ReadOnly>false<\/ReadOnly>/u);
  assert.match(mappings[2]!, /C:\\CharterMesh\\Runtime/u);
  assert.match(mappings[2]!, /<ReadOnly>true<\/ReadOnly>/u);
  assert.equal(
    (configuration.match(/<ReadOnly>false<\/ReadOnly>/gu) ?? [])
      .length,
    1,
  );
});

test("runtime staging maps only one copied node executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "chartermesh-runtime-test-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "node.exe"), "trusted-node", "utf8");
    await writeFile(
      join(source, "unrelated-secret.txt"),
      "must-not-be-mapped",
      "utf8",
    );

    const runtime = await stageNodeRuntime(
      join(source, "node.exe"),
      root,
      createHash("sha256").update("trusted-node").digest("hex"),
    );
    assert.deepEqual(await readdir(runtime), ["node.exe"]);
    assert.equal(
      await readFile(join(runtime, "node.exe"), "utf8"),
      "trusted-node",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Sandbox launcher attestation rejects path and content changes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-wsb-launcher-test-"),
  );
  try {
    const launcher = join(root, "wsb.exe");
    const trusted = "trusted-wsb";
    const expected = createHash("sha256")
      .update(trusted)
      .digest("hex");
    await writeFile(launcher, trusted, "utf8");
    const first = await attestWindowsSandboxLauncher(
      launcher,
      expected,
    );
    await writeFile(launcher, "mutated-wsb", "utf8");
    await assert.rejects(
      attestWindowsSandboxLauncher(launcher, expected, first),
      /SANDBOX_WSB_PROVENANCE_(?:IDENTITY_CHANGED|HASH_MISMATCH)/u,
    );
    await assert.rejects(
      attestWindowsSandboxLauncher("wsb.exe", expected),
      /SANDBOX_WSB_PROVENANCE_PATH_NOT_ABSOLUTE/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Sandbox session journals have a bounded exact recovery contract", () => {
  const record = createWindowsSandboxSessionJournal({
    sandboxId: "12345678-1234-1234-1234-1234567890ab",
    ownerPid: 42,
    ownerNonce: "a".repeat(32),
    createdAtMs: 1,
    launcherSha256: null,
  });
  assert.deepEqual(
    parseWindowsSandboxSessionJournal(
      `${JSON.stringify(record)}\n`,
    ),
    record,
  );
  assert.throws(
    () =>
      parseWindowsSandboxSessionJournal(
        JSON.stringify({ ...record, root: "C:\\do-not-delete" }),
      ),
    /SANDBOX_SESSION_JOURNAL_INVALID/u,
  );
  assert.throws(
    () =>
      parseWindowsSandboxSessionJournal(
        JSON.stringify({ ...record, ownerPid: 43 }),
      ),
    /SANDBOX_SESSION_JOURNAL_CHECKSUM_MISMATCH/u,
  );
  assert.throws(
    () =>
      parseWindowsSandboxSessionJournal(
        JSON.stringify(record),
        "b".repeat(64),
      ),
    /SANDBOX_SESSION_JOURNAL_LAUNCHER_MISMATCH/u,
  );
  assert.throws(
    () =>
      parseWindowsSandboxSessionJournal(
        " ".repeat(4_097),
      ),
    /SANDBOX_SESSION_JOURNAL_LIMIT/u,
  );
});

test("stale Sandbox journals clear only after an attested stop", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-session-journal-test-"),
  );
  const path = join(root, "session.json");
  const sandboxId = "12345678-1234-1234-1234-1234567890ab";
  const record = createWindowsSandboxSessionJournal({
    sandboxId,
    ownerPid: 42,
    ownerNonce: "a".repeat(32),
    createdAtMs: 1,
    launcherSha256: null,
  });
  try {
    await persistWindowsSandboxSessionJournal(path, record);
    await assert.rejects(
      persistWindowsSandboxSessionJournal(
        path,
        createWindowsSandboxSessionJournal({
          ...record,
          sandboxId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        }),
      ),
      /SANDBOX_SESSION_JOURNAL_BUSY/u,
    );
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: "b".repeat(32),
        ownerAppearsAlive: () => false,
        async stopAndAttest(id) {
          assert.equal(id, sandboxId);
          throw new Error("list state ambiguous");
        },
      }),
      /list state ambiguous/u,
    );
    assert.equal(
      await stat(path).then(
        (info) => info.isFile(),
        () => false,
      ),
      true,
    );
    const stops: string[] = [];
    assert.equal(
      await recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: "b".repeat(32),
        ownerAppearsAlive: () => false,
        async stopAndAttest(id) {
          stops.push(id);
        },
      }),
      sandboxId,
    );
    assert.deepEqual(stops, [sandboxId]);
    assert.equal(
      await stat(path).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live journal owner blocks recovery and an explicit owned retry is exact", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-session-owner-test-"),
  );
  const path = join(root, "session.json");
  const sandboxId = "12345678-1234-1234-1234-1234567890ab";
  const ownerNonce = "a".repeat(32);
  const record = createWindowsSandboxSessionJournal({
    sandboxId,
    ownerPid: process.pid,
    ownerNonce,
    createdAtMs: 1,
    launcherSha256: null,
  });
  try {
    await persistWindowsSandboxSessionJournal(path, record);
    let stops = 0;
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: "b".repeat(32),
        ownerAppearsAlive: () => true,
        async stopAndAttest() {
          stops += 1;
        },
      }),
      /SANDBOX_SESSION_JOURNAL_BUSY/u,
    );
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: ownerNonce,
        ownerAppearsAlive: () => false,
        async stopAndAttest() {
          stops += 1;
        },
      }),
      /SANDBOX_SESSION_JOURNAL_BUSY/u,
    );
    assert.equal(stops, 0);
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: ownerNonce,
        recoverableOwnedSandboxId:
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        ownerAppearsAlive: () => false,
        async stopAndAttest() {
          stops += 1;
        },
      }),
      /SANDBOX_SESSION_JOURNAL_BUSY/u,
    );
    await recoverWindowsSandboxSessionJournal({
      path,
      currentOwnerNonce: ownerNonce,
      recoverableOwnedSandboxId: sandboxId,
      ownerAppearsAlive: () => true,
      async stopAndAttest(id) {
        assert.equal(id, sandboxId);
        stops += 1;
      },
    });
    assert.equal(stops, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Sandbox recovery refuses a symlink journal without touching its target", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-session-link-test-"),
  );
  const target = join(root, "target");
  const path = join(root, "session.json");
  const marker = "do-not-touch";
  try {
    await mkdir(target);
    await writeFile(join(target, "marker.txt"), marker, "utf8");
    try {
      // Directory junctions exercise the same lstat/realpath defense and do
      // not require Windows Developer Mode on standard NTFS volumes.
      await symlink(target, path, "junction");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ["EPERM", "EACCES"].includes(String(error.code))
      ) {
        t.skip("Creating file symlinks is not permitted on this host.");
        return;
      }
      throw error;
    }
    let stopped = false;
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: "b".repeat(32),
        ownerAppearsAlive: () => false,
        async stopAndAttest() {
          stopped = true;
        },
      }),
      /SANDBOX_SESSION_JOURNAL_FILE_INVALID/u,
    );
    assert.equal(stopped, false);
    assert.equal(
      await readFile(join(target, "marker.txt"), "utf8"),
      marker,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Sandbox recovery never recursively removes a directory at the journal path", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-session-directory-test-"),
  );
  const path = join(root, "session.json");
  const marker = join(path, "must-remain.txt");
  try {
    await mkdir(path);
    await writeFile(marker, "keep", "utf8");
    let stopped = false;
    await assert.rejects(
      recoverWindowsSandboxSessionJournal({
        path,
        currentOwnerNonce: "b".repeat(32),
        ownerAppearsAlive: () => false,
        async stopAndAttest() {
          stopped = true;
        },
      }),
      /SANDBOX_SESSION_JOURNAL_FILE_INVALID/u,
    );
    assert.equal(stopped, false);
    assert.equal(await readFile(marker, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provenance staging rejects post-hash source and snapshot changes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "chartermesh-provenance-stage-test-"),
  );
  try {
    const source = join(root, "guest-runner.mjs");
    const destination = join(root, "snapshot", "guest-runner.mjs");
    const expected = createHash("sha256")
      .update("frozen-source")
      .digest("hex");
    await writeFile(source, "changed-after-hash", "utf8");
    await assert.rejects(
      stageProvenanceFile(source, destination, expected),
      /SANDBOX_PROVENANCE_SOURCE_MISMATCH/u,
    );
    assert.equal(
      await stat(destination).then(
        () => true,
        () => false,
      ),
      false,
    );

    await writeFile(source, "frozen-source", "utf8");
    const staged = await stageProvenanceFile(
      source,
      destination,
      expected,
    );
    await verifyStagedProvenanceFiles([staged]);
    await assert.rejects(
      stageProvenanceFile(source, destination, expected),
      /EEXIST/u,
    );
    assert.equal(
      await readFile(destination, "utf8"),
      "frozen-source",
    );
    await chmod(destination, 0o600);
    await writeFile(destination, "changed-after-stage", "utf8");
    await assert.rejects(
      verifyStagedProvenanceFiles([staged]),
      /SANDBOX_STAGED_SNAPSHOT_MISMATCH/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unattested stop preserves a quarantined sandbox root", async () => {
  const quarantined = await mkdtemp(
    join(tmpdir(), "chartermesh-quarantine-test-"),
  );
  await writeFile(join(quarantined, "evidence.txt"), "keep", "utf8");
  try {
    await assert.rejects(
      cleanupSandboxSession({
        root: quarantined,
        sandboxMayBeRunning: true,
        sandboxStopped: false,
        async stop() {
          throw new Error("stop unavailable");
        },
      }),
      /SANDBOX_CONTAINMENT_UNATTESTED/u,
    );
    assert.equal(
      await stat(join(quarantined, "evidence.txt")).then(
        (info) => info.isFile(),
        () => false,
      ),
      true,
    );
  } finally {
    await rm(quarantined, { recursive: true, force: true });
  }

  const stopped = await mkdtemp(
    join(tmpdir(), "chartermesh-stopped-test-"),
  );
  await cleanupSandboxSession({
    root: stopped,
    sandboxMayBeRunning: true,
    sandboxStopped: false,
    async stop() {},
  });
  assert.equal(
    await stat(stopped).then(
      () => true,
      () => false,
    ),
    false,
  );

  const invalidSnapshot = await mkdtemp(
    join(tmpdir(), "chartermesh-invalid-snapshot-test-"),
  );
  await assert.rejects(
    cleanupSandboxSession({
      root: invalidSnapshot,
      sandboxMayBeRunning: true,
      sandboxStopped: true,
      async stop() {},
      async beforeRemove() {
        throw new Error("SANDBOX_STAGED_SNAPSHOT_MISMATCH");
      },
    }),
    /SANDBOX_STAGED_SNAPSHOT_MISMATCH/u,
  );
  assert.equal(
    await stat(invalidSnapshot).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("Windows Sandbox stop requires an absent or stopped list record", () => {
  const id = "12345678-1234-1234-1234-1234567890ab";
  const otherId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.equal(
    windowsSandboxListAttestsStopped("[]", id),
    true,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify([{ id, status: "Stopped" }]),
      id,
    ),
    true,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify([
        { id: `{${id.toUpperCase()}}`, status: "Stopped" },
      ]),
      id,
    ),
    true,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify({
        sandboxes: [{ sandboxId: id, state: "Running" }],
      }),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify({
        sessions: [{ id: otherId, status: "Running" }],
      }),
      id,
    ),
    true,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify({
        sandboxes: [],
        sessions: [{ id, status: "Running" }],
      }),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify([
        { id, status: "Stopped" },
        { id, status: "Running" },
      ]),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify({ id }),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped("{}", id),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify({ message: `stopped ${id}` }),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify([{ id: otherId }]),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped(
      JSON.stringify([
        { id: otherId, status: "UnknownFutureState" },
      ]),
      id,
    ),
    false,
  );
  assert.equal(
    windowsSandboxListAttestsStopped("not-json", id),
    false,
  );
});

test("output inspection rejects excessive depth and entry counts", async () => {
  const deepRoot = await mkdtemp(
    join(tmpdir(), "chartermesh-tree-depth-test-"),
  );
  try {
    let current = deepRoot;
    for (let depth = 0; depth < 9; depth += 1) {
      current = join(current, `d${depth}`);
      await mkdir(current);
    }
    await assert.rejects(
      inspectSandboxOutputTree(deepRoot),
      /SANDBOX_OUTPUT_TREE_DEPTH_LIMIT/u,
    );
  } finally {
    await rm(deepRoot, { recursive: true, force: true });
  }

  const entryRoot = await mkdtemp(
    join(tmpdir(), "chartermesh-tree-entry-test-"),
  );
  try {
    await Promise.all(
      Array.from({ length: 513 }, (_, index) =>
        writeFile(join(entryRoot, `${index}.txt`), "", "utf8"),
      ),
    );
    await assert.rejects(
      inspectSandboxOutputTree(entryRoot),
      /SANDBOX_OUTPUT_TREE_ENTRY_LIMIT/u,
    );
  } finally {
    await rm(entryRoot, { recursive: true, force: true });
  }
});

test("sandbox probe fails closed if any canary evidence is absent", async () => {
  assert.equal(
    sandboxProbePassed(passingProbe, passingManifest),
    true,
  );
  await assert.doesNotReject(requireSafeSandbox(backend(passingProbe)));

  for (const evidenceName of Object.keys(
    passingProbe.evidence,
  ) as Array<keyof CodeSandboxProbe["evidence"]>) {
    const failed = structuredClone(passingProbe);
    failed.evidence[evidenceName] = false;
    assert.equal(
      sandboxProbePassed(failed, passingManifest),
      false,
      evidenceName,
    );
    await assert.rejects(
      requireSafeSandbox(backend(failed)),
      /CODE_SANDBOX_UNAVAILABLE/u,
      evidenceName,
    );
  }

  const issue = structuredClone(passingProbe);
  issue.issues.push("CANARY_FAILURE");
  await assert.rejects(
    requireSafeSandbox(backend(issue)),
    /CODE_SANDBOX_UNAVAILABLE/u,
  );

  const wrongBackend = structuredClone(passingProbe);
  wrongBackend.backendId = "different-vm";
  assert.equal(
    sandboxProbePassed(wrongBackend, passingManifest),
    false,
  );
  await assert.rejects(
    requireSafeSandbox(backend(wrongBackend)),
    /CODE_SANDBOX_UNAVAILABLE/u,
  );
});

test("sandbox manifest cannot substitute simulation for VM isolation", async () => {
  await assert.rejects(
    requireSafeSandbox(
      backend(passingProbe, {
        id: "simulated",
        isolation: "simulated",
        network: "disabled",
        hostFilesystem: "simulated",
        generatedCodeExecution: true,
      }),
    ),
    /CODE_SANDBOX_UNAVAILABLE/u,
  );
  await assert.rejects(
    requireSafeSandbox(
      backend(passingProbe, {
        id: "networked-vm",
        isolation: "vm",
        network: "unknown",
        hostFilesystem: "mapped-allowlist",
        generatedCodeExecution: true,
      }),
    ),
    /CODE_SANDBOX_UNAVAILABLE/u,
  );
});

test("canary artifacts require complete, exact versioned schemas", () => {
  const complete = {
    apiVersion:
      "chartermesh.dev/windows-sandbox-canary-complete/v1alpha1",
    complete: true,
  };
  const report = {
    apiVersion:
      "chartermesh.dev/windows-sandbox-canary-report/v1alpha1",
    evidence: {
      networkDenied: true,
      hostReadDenied: true,
      hostWriteDenied: true,
      childEscapeDenied: true,
      timeoutEnforced: true,
      outputAllowlistCanaryCreated: true,
    },
    unexpectedOutputRelativePath: "unexpected-output-canary.txt",
    timeoutObservation: {
      requestedMs: 1_000,
      durationMs: 1_010,
      exitCode: null,
      signal: "SIGTERM",
    },
    candidateObservations: {},
    issues: [],
  };
  assert.deepEqual(
    validateCanaryArtifacts(complete, report).evidence,
    report.evidence,
  );
  assert.throws(
    () =>
      validateCanaryArtifacts(
        { ...complete, complete: false },
        report,
      ),
    /CANARY_COMPLETE_INVALID/u,
  );
  assert.throws(
    () =>
      validateCanaryArtifacts(complete, {
        ...report,
        unexpectedOutputRelativePath: "../escape",
      }),
    /CANARY_REPORT_INVALID/u,
  );
  assert.throws(
    () =>
      validateCanaryArtifacts(complete, {
        ...report,
        evidence: {
          ...report.evidence,
          networkDenied: "true",
        },
      }),
    /CANARY_REPORT_INVALID/u,
  );
});

test("sandbox results are matched by immutable job id", () => {
  const jobs = [
    { id: "job-a", task: { id: "task-a" } },
    { id: "job-b", task: { id: "task-b" } },
  ] as unknown as CodeSandboxJob[];
  const result = (
    jobId: string,
    taskId: string,
  ): CodeSandboxRunResult => ({
    jobId,
    taskId,
    passed: true,
    cases: [],
    changedPaths: [],
    policyViolations: [],
    survivorProcesses: 0,
    outputBytes: 0,
  });
  const ordered = validateSandboxResults(jobs, [
    result("job-b", "task-b"),
    result("job-a", "task-a"),
  ]);
  assert.deepEqual(
    ordered.map(({ jobId }) => jobId),
    ["job-a", "job-b"],
  );
  assert.throws(
    () =>
      validateSandboxResults(jobs, [
        result("job-a", "task-a"),
        result("job-a", "task-b"),
      ]),
    /SANDBOX_RESULT_ID_MISMATCH/u,
  );
  assert.throws(
    () =>
      validateSandboxResults(jobs, [
        result("job-a", "task-b"),
        result("job-b", "task-b"),
      ]),
    /SANDBOX_RESULT_ID_MISMATCH/u,
  );
});

test("guest canary is fixed source and covers every runtime canary", async () => {
  const guest = await readFile(
    new URL(
      "../../../scripts/windows-sandbox/guest-canary.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const candidate = await readFile(
    new URL(
      "../../../scripts/windows-sandbox/canary-candidate.mjs",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(guest, /"--permission"/u);
  assert.match(guest, /--allow-fs-read=/u);
  assert.doesNotMatch(guest, /--allow-child-process/u);
  assert.doesNotMatch(guest, /--allow-fs-write=/u);
  assert.match(guest, /unexpected-output-canary\.txt/u);
  assert.match(guest, /CANARY_TIMEOUT_NOT_ENFORCED/u);

  assert.match(candidate, /networkInterfaces\(\)/u);
  assert.match(candidate, /hostReadDenied/u);
  assert.match(candidate, /hostWriteDenied/u);
  assert.match(candidate, /childEscapeDenied/u);
  assert.match(candidate, /mode === "hang"/u);
  assert.doesNotMatch(
    `${guest}\n${candidate}`,
    /\b(?:eval|Function|fetch)\s*\(/u,
  );
});

test("candidate framing supervisor never imports untrusted code", async () => {
  const executor = await readFile(
    new URL(
      "../../../scripts/windows-sandbox/candidate-executor.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const worker = await readFile(
    new URL(
      "../../../scripts/windows-sandbox/candidate-worker.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const guest = await readFile(
    new URL(
      "../../../scripts/windows-sandbox/guest-runner.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const handshake = executor.indexOf(
    "@@CHARTERMESH_HANDSHAKE_V1@@",
  );
  const candidateImport = worker.indexOf(
    "await import(pathToFileURL(modulePath).href)",
  );
  assert.ok(handshake >= 0);
  assert.ok(candidateImport >= 0);
  assert.doesNotMatch(
    executor,
    /await import\(pathToFileURL\(modulePath\)\.href\)/u,
  );
  assert.match(executor, /spawn\(/u);
  assert.match(executor, /candidate-worker\.mjs/u);
  assert.match(executor, /createHmac/u);
  assert.match(executor, /not an OS-user/u);
  assert.doesNotMatch(
    worker,
    /createHmac|randomBytes|secret|CHARTERMESH_HANDSHAKE/u,
  );
  assert.match(worker, /deepFreeze\(request\)/u);
  assert.match(worker, /objectCreate\(null\)/u);
  assert.match(executor, /objectCreate\(null\)/u);
  assert.match(guest, /"--allow-child-process"/u);
  const readFlags = [
    ...guest.matchAll(/`--allow-fs-read=\$\{[^`]+\}`/gu),
  ];
  assert.ok(readFlags.length >= 2);
  assert.equal(
    readFlags.some(
      (match) =>
        (match[0].match(/\$\{/gu) ?? []).length !== 1,
    ),
    false,
  );
});

test("candidate supervisor rejects incomplete worker lifecycle evidence", async () => {
  const supervisor = await import(
    new URL(
      "../../../scripts/windows-sandbox/candidate-executor.mjs",
      import.meta.url,
    ).href
  );
  const envelope = {
    kind: "return",
    value: { ok: true },
    inputMutated: false,
  };
  const success = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    stdout: JSON.stringify(envelope),
    stderr: "",
  };
  assert.deepEqual(
    supervisor.acceptWorkerResult(success),
    envelope,
  );
  assert.deepEqual(
    supervisor.acceptWorkerResult({
      ...success,
      stdout: JSON.stringify({
        ...envelope,
        inputMutated: true,
      }),
    }),
    {
      ...envelope,
      inputMutated: true,
    },
    "the trusted supervisor must preserve mutation evidence",
  );
  for (const failure of [
    { ...success, exitCode: 1 },
    { ...success, timedOut: true },
    { ...success, outputLimitExceeded: true },
    { ...success, launchError: "spawn failed" },
    { ...success, stdout: "" },
    { ...success, stdout: "{}" },
    {
      ...success,
      stdout: `${JSON.stringify(envelope)}\n${JSON.stringify(envelope)}`,
    },
  ]) {
    assert.equal(
      supervisor.acceptWorkerResult(failure),
      null,
    );
  }
});

test("sandbox case comparison distinguishes throws, returns, and input mutation", () => {
  const authenticated = (value: unknown) => {
    const session = "a".repeat(32);
    const secretHex = "b".repeat(64);
    const encoded = Buffer.from(JSON.stringify(value)).toString(
      "base64url",
    );
    const mac = createHmac(
      "sha256",
      Buffer.from(secretHex, "hex"),
    )
      .update(encoded)
      .digest("hex");
    return [
      `@@CHARTERMESH_HANDSHAKE_V1@@:${session}:${secretHex}`,
      `@@CHARTERMESH_RESULT_V1@@:${session}:${encoded}:${mac}`,
      "",
    ].join("\n");
  };
  const guest = (value: unknown) => {
    const stdout = authenticated(value);
    return {
      jobId: "job",
      id: "case",
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
      stdout,
      stdoutHash: createHash("sha256").update(stdout).digest("hex"),
      stderrHash: "hash",
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
    };
  };
  const expectedError = {
    id: "case",
    input: {},
    expectedErrorCode: "INVALID_REQUEST",
  } as const;
  assert.equal(
    compareSandboxCase(
      expectedError,
      guest({
          kind: "return",
          value: { errorCode: "INVALID_REQUEST" },
          inputMutated: false,
        }),
    ).passed,
    false,
  );
  assert.equal(
    compareSandboxCase(
      expectedError,
      guest({
          kind: "throw",
          errorCode: "INVALID_REQUEST",
          inputMutated: false,
        }),
    ).passed,
    true,
  );
  assert.equal(
    compareSandboxCase(
      {
        id: "case",
        input: {},
        expected: { ok: true },
      },
      guest({
          kind: "return",
          value: { ok: true },
          inputMutated: true,
        }),
    ).errorCode,
    "INPUT_MUTATED",
  );
  const handshakeOnly = [
    `@@CHARTERMESH_HANDSHAKE_V1@@:${"a".repeat(32)}:${"b".repeat(64)}`,
    "",
  ].join("\n");
  assert.equal(
    parseAuthenticatedCandidateEnvelope(handshakeOnly),
    null,
    "exit during import cannot forge a terminal result",
  );
  assert.equal(
    parseAuthenticatedCandidateEnvelope(
      [
        `@@CHARTERMESH_HANDSHAKE_V1@@:${"a".repeat(32)}:${"b".repeat(64)}`,
        `@@CHARTERMESH_RESULT_V1@@:${"a".repeat(32)}:e30:${"0".repeat(64)}`,
        "",
      ].join("\n"),
    ),
    null,
    "an unauthenticated candidate frame cannot pass",
  );
  const successful = authenticated({
    kind: "return",
    value: { ok: true },
    inputMutated: false,
  });
  const successfulLines = successful.trimEnd().split("\n");
  assert.deepEqual(
    parseAuthenticatedCandidateEnvelope(successful),
    {
      kind: "return",
      value: { ok: true },
      inputMutated: false,
    },
  );
  assert.equal(
    parseAuthenticatedCandidateEnvelope(
      [
        successfulLines[0],
        "ordinary candidate diagnostic",
        successfulLines[1],
        "",
      ].join("\n"),
    ),
    null,
    "the separate supervisor owns stdout framing exclusively",
  );
  assert.equal(
    parseAuthenticatedCandidateEnvelope(
      [
        successfulLines[0],
        successfulLines[1],
        successfulLines[1],
        "",
      ].join("\n"),
    ),
    null,
    "duplicate authenticated terminal frames fail closed",
  );
  assert.equal(
    parseAuthenticatedCandidateEnvelope(
      [
        successfulLines[0],
        `@@CHARTERMESH_RESULT_V1@@:${"a".repeat(32)}:e30:${"0".repeat(64)}`,
        successfulLines[1],
        "",
      ].join("\n"),
    ),
    null,
    "a forged reserved frame poisons the protocol",
  );
  assert.equal(
    parseAuthenticatedCandidateEnvelope(
      authenticated({
        kind: "return",
        value: true,
        inputMutated: false,
        extra: "not-contractual",
      }),
    ),
    null,
    "authenticated envelopes still require exact schema",
  );

  const limited = guest({
    kind: "return",
    value: true,
    inputMutated: false,
  });
  limited.outputLimitExceeded = true;
  limited.exitCode = 1;
  assert.equal(
    compareSandboxCase(
      { id: "case", input: {}, expected: true },
      limited,
    ).errorCode,
    "PROGRAM_OUTPUT_LIMIT",
  );
  assert.equal(PROGRAM_OUTPUT_LIMIT_BYTES, 128 * 1_024);
});
