import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sourceAvailable = existsSync(
  new URL("../apps/cli/src/evaluate-execution.ts", import.meta.url),
);
const { OpenAICompatibleModelEngine } = await import(
  sourceAvailable
    ? "../adapters/model-engines/openai-compatible/src/index.ts"
    : "../dist/adapters/model-engines/openai-compatible/src/index.js"
);
const { evaluateExecutionTier } = await import(
  sourceAvailable
    ? "../apps/cli/src/evaluate-execution.ts"
    : "../dist/apps/cli/src/evaluate-execution.js"
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
    result.set(key.slice(2), value);
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
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer.`);
  }
  return value;
}

async function writeCheckpoint(path, report) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const args = argumentsOf(process.argv.slice(2));
const outputPath = resolve(required(args, "output"));
const resumePath = args.get("resume")
  ? resolve(args.get("resume"))
  : undefined;
await mkdir(dirname(outputPath), { recursive: true });
const previous = resumePath
  ? JSON.parse(await readFile(resumePath, "utf8"))
  : undefined;
const engine = new OpenAICompatibleModelEngine({
  id: required(args, "engine-id"),
  endpoint: required(args, "endpoint"),
  model: required(args, "model"),
  timeoutMs: integer(args, "timeout-ms", 180_000),
  maxResponseBytes: integer(args, "max-response-bytes", 8_388_608),
  structuredOutputMode: "prompt",
  reasoningMode:
    args.get("reasoning-mode") === "disabled" ? "disabled" : "default",
});
let lastReportedOutputs = -1;
const report = await evaluateExecutionTier(engine, {
  tierId: required(args, "tier-id"),
  taskCount: integer(args, "task-count", previous?.taskCount ?? 100),
  seed: integer(args, "seed", previous?.seed ?? 20260731),
  probeCount: integer(args, "probe-count", 0),
  previous,
  async onProgress(checkpoint) {
    await writeCheckpoint(outputPath, checkpoint);
    const outputs = checkpoint.aggregate.modelOutputs;
    if (
      outputs !== lastReportedOutputs &&
      (outputs % 10 === 0 ||
        checkpoint.aggregate.pendingTasks === 0)
    ) {
      lastReportedOutputs = outputs;
      console.log(
        JSON.stringify({
          outputs,
          passedTasks: checkpoint.aggregate.passedTasks,
          pendingTasks: checkpoint.aggregate.pendingTasks,
          structuredOutputRate:
            checkpoint.aggregate.structuredOutputRate,
        }),
      );
    }
  },
});
await writeCheckpoint(outputPath, report);
console.log(
  JSON.stringify(
    {
      output: outputPath,
      tier: report.tiers.at(-1),
      aggregate: report.aggregate,
    },
    null,
    2,
  ),
);
