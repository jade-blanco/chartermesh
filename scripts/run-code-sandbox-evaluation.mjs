#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sourceAvailable = existsSync(
  new URL("../apps/cli/src/code-evaluation/evaluator.ts", import.meta.url),
);
const {
  bindCodeEvaluationProvenance,
  evaluateCodeGenerationState,
  freezeCodeEvaluationState,
} = await import(
  sourceAvailable
    ? "../apps/cli/src/code-evaluation/evaluator.ts"
    : "../dist/apps/cli/src/code-evaluation/evaluator.js"
);
const { collectCodeEvaluationProvenance } = await import(
  sourceAvailable
    ? "../apps/cli/src/code-evaluation/provenance.ts"
    : "../dist/apps/cli/src/code-evaluation/provenance.js"
);
const { WindowsSandboxCodeBackend } = await import(
  sourceAvailable
    ? "../apps/cli/src/code-evaluation/windows-sandbox.ts"
    : "../dist/apps/cli/src/code-evaluation/windows-sandbox.js"
);

function argumentsOf(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected argument '${key ?? ""}'.`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument '${key}' requires a value.`);
    }
    const name = key.slice(2);
    if (result.has(name)) {
      throw new Error(`Argument '${key}' was supplied more than once.`);
    }
    result.set(name, value);
    index += 1;
  }
  return result;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSnapshot(path) {
  try {
    const text = await readFile(path, "utf8");
    return { text, hash: sha256(text) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicCompareAndSwap(path, value, expectedHash) {
  const before = await fileSnapshot(path);
  if ((before?.hash ?? null) !== expectedHash) {
    throw new Error(
      `STATE_CAS_MISMATCH: '${path}' changed after this process acquired its snapshot.`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, text, {
      encoding: "utf8",
      flag: "wx",
    });
    const immediatelyBefore = await fileSnapshot(path);
    if ((immediatelyBefore?.hash ?? null) !== expectedHash) {
      throw new Error(
        `STATE_CAS_MISMATCH: '${path}' changed before atomic replacement.`,
      );
    }
    await rename(temporary, path);
    return sha256(text);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireStateLock(path, statePath) {
  const token = `${JSON.stringify({
    nonce: randomUUID(),
    pid: process.pid,
    statePath,
    startedAt: new Date().toISOString(),
  })}\n`;
  let handle;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(token, "utf8");
    await handle.sync();
    return { handle, token };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true });
    if (error?.code === "EEXIST") {
      throw new Error(
        `STATE_LOCKED: '${path}' exists. Verify that no evaluation process is running before removing a stale lock.`,
      );
    }
    throw error;
  }
}

async function releaseStateLock(path, lock) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } finally {
    await lock.handle.close();
  }
  if (contents !== lock.token) {
    throw new Error(
      `STATE_LOCK_OWNERSHIP_LOST: '${path}' no longer contains this process's lock token; it was not removed.`,
    );
  }
  await rm(path);
}

const args = argumentsOf(process.argv.slice(2));
const allowedArguments = new Set([
  "output",
  "runtime-directory",
  "runtime-executable",
  "state",
  "wsb",
]);
for (const name of args.keys()) {
  if (!allowedArguments.has(name)) {
    throw new Error(`Unknown argument '--${name}'.`);
  }
}
const statePath = resolve(required(args, "state"));
const outputPath = resolve(required(args, "output"));
if (statePath.toLowerCase() === outputPath.toLowerCase()) {
  throw new Error("--state and --output must resolve to different files.");
}
if (
  args.has("runtime-executable") &&
  args.has("runtime-directory")
) {
  throw new Error(
    "Use --runtime-executable or legacy --runtime-directory, not both.",
  );
}
const runtimeExecutable = args.get("runtime-executable")
  ? resolve(args.get("runtime-executable"))
  : args.get("runtime-directory")
    ? join(resolve(args.get("runtime-directory")), "node.exe")
    : process.execPath;
const provenance = await collectCodeEvaluationProvenance({
  packageJson: new URL("../package.json", import.meta.url),
  repositoryDirectory: new URL("../", import.meta.url),
  runtimeExecutable,
  guestBundleDirectory: new URL(
    "./windows-sandbox/",
    import.meta.url,
  ),
});
await mkdir(dirname(statePath), { recursive: true });
const lockPath = `${statePath}.lock`;
const lock = await acquireStateLock(lockPath, statePath);
const outputLockPath = `${outputPath}.lock`;
let outputLock;
let operationError;
try {
  outputLock = await acquireStateLock(outputLockPath, outputPath);
  const initialState = await fileSnapshot(statePath);
  if (!initialState) {
    throw new Error(`Evaluation state '${statePath}' does not exist.`);
  }
  const expectedStateHash = initialState.hash;
  const initialOutput = await fileSnapshot(outputPath);
  const expectedOutputHash = initialOutput?.hash ?? null;
  const state = JSON.parse(initialState.text);
  bindCodeEvaluationProvenance(state, provenance);
  freezeCodeEvaluationState(state);
  await atomicCompareAndSwap(
    statePath,
    state,
    expectedStateHash,
  );
  const backend = new WindowsSandboxCodeBackend({
    ...(args.get("wsb")
      ? { wsbExecutable: resolve(args.get("wsb")) }
      : {}),
    runtimeExecutable,
    provenance,
  });
  const report = await evaluateCodeGenerationState(state, backend);
  await atomicCompareAndSwap(
    outputPath,
    report,
    expectedOutputHash,
  );
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        evaluationId: report.evaluationId,
        suiteHash: report.suiteHash,
        planHash: report.planHash,
        preflight: report.preflight,
        conditions: report.conditions.map(
          ({
            id,
            tasksPassed,
            taskCount,
            passRate,
            finalStrictContracts,
            plannedStageSlots,
            skippedUpstreamStages,
            completedFinals,
            invocationAttempts,
            modelResponses,
            modelResponseRate,
            structuredOutputRate,
            usageCoverage,
            observedOutputWithinRequestedCeiling,
            clientObservedGenerationLatencyMs,
            observedUsage,
          }) => ({
            id,
            tasksPassed,
            taskCount,
            passRate,
            finalStrictContracts,
            plannedStageSlots,
            skippedUpstreamStages,
            completedFinals,
            invocationAttempts,
            modelResponses,
            modelResponseRate,
            structuredOutputRate,
            usageCoverage,
            observedOutputWithinRequestedCeiling,
            clientObservedGenerationLatencyMs,
            observedUsage,
          }),
        ),
        aggregate: report.aggregate,
      },
      null,
      2,
    ),
  );
} catch (error) {
  operationError = error;
  throw error;
} finally {
  const releaseErrors = [];
  if (outputLock) {
    try {
      await releaseStateLock(outputLockPath, outputLock);
    } catch (releaseError) {
      releaseErrors.push(releaseError);
    }
  }
  try {
    await releaseStateLock(lockPath, lock);
  } catch (releaseError) {
    releaseErrors.push(releaseError);
  }
  if (!operationError && releaseErrors[0]) {
    throw releaseErrors[0];
  }
  for (const releaseError of releaseErrors) {
    console.error(
      releaseError instanceof Error
        ? releaseError.message
        : String(releaseError),
    );
  }
}
