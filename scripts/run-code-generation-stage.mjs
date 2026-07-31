#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sourceAvailable = existsSync(
  new URL("../apps/cli/src/code-evaluation/evaluator.ts", import.meta.url),
);
const {
  OpenAICompatibleModelEngine,
  validateOpenAICompatibleConfig,
} = await import(
  sourceAvailable
    ? "../adapters/model-engines/openai-compatible/src/index.ts"
    : "../dist/adapters/model-engines/openai-compatible/src/index.js"
);
const {
  bindCodeEvaluationEngine,
  bindCodeEvaluationProvenance,
  createCodeEvaluationState,
  runCodeGenerationStage,
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

function integer(args, name, fallback) {
  const raw = args.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be a safe integer.`);
  }
  return value;
}

function number(args, name, fallback) {
  const raw = args.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a finite number.`);
  }
  return value;
}

function choice(args, name, allowed, fallback) {
  const value = args.get(name) ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(
      `--${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
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
  "condition",
  "context-tokens",
  "endpoint",
  "engine-id",
  "engine-slot",
  "max-response-bytes",
  "model",
  "model-artifact-hash-kind",
  "model-artifact-sha256",
  "quantization",
  "reasoning-mode",
  "sampling-seed",
  "seed",
  "server-build",
  "stage",
  "state",
  "structured-output-mode",
  "temperature",
  "timeout-ms",
]);
for (const name of args.keys()) {
  if (!allowedArguments.has(name)) {
    throw new Error(`Unknown argument '--${name}'.`);
  }
}
const statePath = resolve(required(args, "state"));
const provenance = await collectCodeEvaluationProvenance({
  packageJson: new URL("../package.json", import.meta.url),
  repositoryDirectory: new URL("../", import.meta.url),
  runtimeExecutable: process.execPath,
  guestBundleDirectory: new URL(
    "./windows-sandbox/",
    import.meta.url,
  ),
});
if (provenance.git.commit === null || provenance.git.dirty !== false) {
  throw new Error(
    "CODE_EVALUATION_SOURCE_NOT_PUBLISHABLE: generation requires a source checkout at a clean Git commit; installed packages without Git metadata and dirty worktrees are non-publishable.",
  );
}
await mkdir(dirname(statePath), { recursive: true });
const lockPath = `${statePath}.lock`;
const lock = await acquireStateLock(lockPath, statePath);
let operationError;
try {
  const initialSnapshot = await fileSnapshot(statePath);
  let expectedStateHash = initialSnapshot?.hash ?? null;
  const state = initialSnapshot
    ? JSON.parse(initialSnapshot.text)
    : createCodeEvaluationState(integer(args, "seed", 20260731));
  bindCodeEvaluationProvenance(state, provenance);
  const structuredOutputMode = choice(
    args,
    "structured-output-mode",
    ["prompt", "json-schema"],
    "prompt",
  );
  const reasoningMode = choice(
    args,
    "reasoning-mode",
    ["default", "disabled"],
    "disabled",
  );
  const samplingSeed = integer(
    args,
    "sampling-seed",
    20260731,
  );
  const temperature = number(args, "temperature", 0);
  const engineConfig = {
    id: required(args, "engine-id"),
    endpoint: required(args, "endpoint"),
    model: required(args, "model"),
    timeoutMs: integer(args, "timeout-ms", 300_000),
    maxResponseBytes: integer(
      args,
      "max-response-bytes",
      8_388_608,
    ),
    structuredOutputMode,
    reasoningMode,
    temperature,
    seed: samplingSeed,
  };
  const configIssues = validateOpenAICompatibleConfig(engineConfig, {});
  if (configIssues.length > 0) {
    throw new Error(
      `MODEL_ENGINE_CONFIG_INVALID: ${configIssues.join(" ")}`,
    );
  }
  const engine = new OpenAICompatibleModelEngine(engineConfig, {});
  const modelArtifactSha256 = required(
    args,
    "model-artifact-sha256",
  );
  const modelArtifactHashKind = required(
    args,
    "model-artifact-hash-kind",
  );
  if (
    !["file", "canonical-shard-manifest"].includes(
      modelArtifactHashKind,
    )
  ) {
    throw new Error(
      "--model-artifact-hash-kind must be file or canonical-shard-manifest.",
    );
  }
  const descriptor = bindCodeEvaluationEngine(state, {
    slot: required(args, "engine-slot"),
    engineId: engine.manifest.profileId,
    adapter: engine.manifest.adapter,
    endpoint: engineConfig.endpoint,
    model: engineConfig.model,
    quantization: required(args, "quantization"),
    contextTokens: integer(args, "context-tokens", undefined),
    serverBuild: required(args, "server-build"),
    timeoutMs: engineConfig.timeoutMs,
    maxResponseBytes: engineConfig.maxResponseBytes,
    structuredOutputMode,
    reasoningMode,
    temperature,
    seed: samplingSeed,
    modelArtifactSha256,
    modelArtifactHashKind,
  });

  await runCodeGenerationStage(state, engine, {
    conditionId: required(args, "condition"),
    stageId: required(args, "stage"),
    engineSlot: required(args, "engine-slot"),
    engineFingerprint: descriptor.fingerprint,
    async onProgress(checkpoint) {
      expectedStateHash = await atomicCompareAndSwap(
        statePath,
        checkpoint,
        expectedStateHash,
      );
    },
  });
  expectedStateHash = await atomicCompareAndSwap(
    statePath,
    state,
    expectedStateHash,
  );
  const condition = state.conditions.find(
    ({ id }) => id === required(args, "condition"),
  );
  const stageId = required(args, "stage");
  const records = condition.tasks.flatMap(({ stages }) =>
    stages.filter((stage) => stage.stageId === stageId),
  );
  console.log(
    JSON.stringify(
      {
        state: statePath,
        evaluationId: state.evaluationId,
        suiteHash: state.suiteHash,
        planHash: state.planHash,
        engineFingerprint: descriptor.fingerprint,
        condition: condition.id,
        stage: stageId,
        candidates: records.filter(
          ({ status }) => status === "candidate_available",
        ).length,
        strictContracts: records.filter(
          ({ contract }) => contract === "strict",
        ).length,
        recoveredContracts: records.filter(
          ({ contract }) => contract === "recovered",
        ).length,
        failed: records.filter(({ status }) => status === "failed")
          .length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  operationError = error;
  throw error;
} finally {
  try {
    await releaseStateLock(lockPath, lock);
  } catch (releaseError) {
    if (!operationError) throw releaseError;
    console.error(
      releaseError instanceof Error
        ? releaseError.message
        : String(releaseError),
    );
  }
}
