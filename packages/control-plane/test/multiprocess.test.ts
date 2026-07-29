import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../src/index.ts";

const worker = resolve(
  "packages",
  "control-plane",
  "test",
  "fixtures",
  "process-worker.mjs",
);

function child(args: string[]): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const processHandle = spawn(process.execPath, [worker, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    processHandle.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    processHandle.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    processHandle.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

test("only one of many processes can claim the same work generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-mp-claim-"));
  const databasePath = join(directory, "state.db");
  const artifacts = join(directory, "artifacts");
  const database = openControlPlaneDatabase(databasePath);
  const controlPlane = new ControlPlane(database, artifacts);
  const item = controlPlane.intake({
    title: "Contended work",
    summary: "Exactly one process may own generation one.",
    actor: "human:test",
    idempotencyKey: "mp:claim:intake",
  });
  controlPlane.triage({
    id: item.id,
    ownerRole: "operator",
    executionTarget: "local",
    actor: "human:test",
    idempotencyKey: "mp:claim:triage",
  });
  database.close();

  const barrier = join(directory, "start");
  const processes = Array.from({ length: 16 }, (_, index) =>
    child([
      "claim",
      databasePath,
      artifacts,
      barrier,
      item.id,
      `mp:claim:${index}`,
    ])
  );
  writeFileSync(barrier, "go\n");
  const results = await Promise.all(processes);
  const payloads = results.map((result) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      ok: boolean;
      error?: string;
      value?: { generation: number };
    };
  });
  assert.equal(payloads.filter(({ ok }) => ok).length, 1);
  assert.equal(payloads.find(({ ok }) => ok)?.value?.generation, 1);
  for (const failure of payloads.filter(({ ok }) => !ok)) {
    assert.match(failure.error ?? "", /not currently claimable/u);
    assert.doesNotMatch(failure.error ?? "", /SQLITE_BUSY/u);
  }
});

test("duplicate commands replay one result across processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-mp-idem-"));
  const databasePath = join(directory, "state.db");
  const artifacts = join(directory, "artifacts");
  const initial = openControlPlaneDatabase(databasePath);
  initial.close();
  const barrier = join(directory, "start");
  const processes = Array.from({ length: 16 }, () =>
    child([
      "intake",
      databasePath,
      artifacts,
      barrier,
      "mp:shared-command",
    ])
  );
  writeFileSync(barrier, "go\n");
  const results = await Promise.all(processes);
  const ids = results.map((result) => {
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      error?: string;
      value?: { id: string };
    };
    assert.equal(payload.ok, true, payload.error);
    return payload.value?.id;
  });
  assert.equal(new Set(ids).size, 1);
  const database = openControlPlaneDatabase(databasePath);
  const controlPlane = new ControlPlane(database, artifacts);
  assert.equal(controlPlane.list().length, 1);
  database.close();
});

test("busy timeout lets another process wait out a database writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chartermesh-mp-lock-"));
  const databasePath = join(directory, "state.db");
  const artifacts = join(directory, "artifacts");
  const initial = openControlPlaneDatabase(databasePath);
  initial.close();
  const ready = join(directory, "lock-ready");
  const holder = child([
    "hold-lock",
    databasePath,
    artifacts,
    "-",
    ready,
    "750",
  ]);
  await waitForFile(ready);
  const started = Date.now();
  const contender = await child([
    "intake",
    databasePath,
    artifacts,
    "-",
    "mp:after-lock",
  ]);
  const elapsed = Date.now() - started;
  const held = await holder;
  assert.equal(held.status, 0, held.stderr);
  assert.equal(contender.status, 0, contender.stderr);
  const payload = JSON.parse(contender.stdout) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(payload.ok, true, payload.error);
  assert.ok(elapsed >= 400, `contender waited only ${elapsed}ms`);
  assert.doesNotMatch(contender.stdout, /SQLITE_BUSY/u);
});
