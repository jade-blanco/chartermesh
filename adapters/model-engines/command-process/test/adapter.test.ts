import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  CommandProcessModelEngine,
  sha256Executable,
  validateCommandProcessConfig,
} from "../src/index.ts";

const fixture = resolve(
  "adapters",
  "model-engines",
  "command-process",
  "test",
  "fixtures",
  "engine.mjs",
);

test("command-process requires an absolute executable and no shell", () => {
  assert.deepEqual(
    validateCommandProcessConfig({
      id: "unsafe",
      command: "model-command",
      executableSha256: "0".repeat(64),
    }),
    ["Command-process executable must use an absolute path."],
  );
  assert.equal(isAbsolute(process.execPath), true);
});

test("command-process transports the neutral contract with bounded environment", async () => {
  const workingDirectory = mkdtempSync(
    join(tmpdir(), "chartermesh-command-process-"),
  );
  const engine = new CommandProcessModelEngine(
    {
      id: "fixture",
      command: process.execPath,
      executableSha256: sha256Executable(process.execPath),
      args: [fixture],
      environmentAllowlist: ["CHARTERMESH_FIXTURE_ALLOWED"],
      pricing: {
        inputPerMillionTokensUsd: 2,
        outputPerMillionTokensUsd: 6,
      },
    },
    workingDirectory,
    {
      ...process.env,
      CHARTERMESH_FIXTURE_ALLOWED: "available",
      CHARTERMESH_FIXTURE_HIDDEN: "must-not-pass",
    },
  );
  const result = await engine.generate({
    invocationId: "command-fixture",
    messages: [{ role: "user", content: "Return safe structured work." }],
  });
  const artifact = JSON.parse(result.text);
  assert.ok(artifact.checks.includes(`cwd:${workingDirectory}`));
  assert.ok(artifact.checks.includes("allowed-env:true"));
  assert.ok(artifact.checks.includes("hidden-env:false"));
  assert.equal(result.usage.cost, 0.005);
  assert.equal(result.usage.measurementStatus, "estimated");
});

test("command-process refuses an executable whose approved digest changed", () => {
  const workingDirectory = mkdtempSync(
    join(tmpdir(), "chartermesh-command-digest-"),
  );
  assert.throws(
    () =>
      new CommandProcessModelEngine(
        {
          id: "tampered",
          command: process.execPath,
          executableSha256: "0".repeat(64),
        },
        workingDirectory,
      ),
    /COMMAND_PROCESS_EXECUTABLE_DIGEST_MISMATCH/u,
  );
});
