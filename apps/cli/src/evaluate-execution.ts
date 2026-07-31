import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import type {
  ModelEngine,
  ModelUsage,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  compileStructuredArtifact,
  extractFirstJsonObject,
  parseStructuredArtifact,
} from "../../../packages/runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const SUITE_ID = "bounded-config-repository-v1" as const;

interface ServiceConfig {
  service: {
    name: string;
    environment: "local" | "staging" | "production";
    region: string;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    strategy: "linear" | "exponential";
  };
  approvals: {
    mode: "human";
    requiredFor: string[];
    twoPerson: boolean;
  };
  limits: {
    maxConcurrentRuns: number;
    maxArtifactBytes: number;
  };
  features: {
    audit: boolean;
    rollback: boolean;
    rateLimit: boolean;
  };
  workflow: string[];
  metadata: {
    owner: string;
    revision: number;
  };
}

export interface ExecutionEvaluationTask {
  id: string;
  instruction: string;
  initial: ServiceConfig;
  expected: ServiceConfig;
}

export interface ExecutionAttempt {
  tierId: string;
  engineId: string;
  status: "passed" | "failed";
  latencyMs: number;
  outputHash?: string;
  compiledArtifactHash?: string;
  compilerStatus?: "complete" | "empty" | "truncated";
  structuredValid?: boolean;
  errorCode?: string;
  usage?: ModelUsage;
}

export interface ExecutionTaskResult {
  id: string;
  status: "passed" | "pending";
  passedAtTier?: string;
  attempts: ExecutionAttempt[];
}

export interface ArtifactProbeResult {
  id: string;
  tierId: string;
  engineId: string;
  latencyMs: number;
  structuredValid: boolean;
  sentinelRetained: boolean;
  outputHash?: string;
  compiledArtifactHash?: string;
  compilerStatus?: "complete" | "empty" | "truncated";
  errorCode?: string;
  usage?: ModelUsage;
}

export interface EvaluationTierResult {
  tierId: string;
  engineId: string;
  startedAt: string;
  finishedAt?: string;
  taskAttempts: number;
  tasksPassed: number;
  tasksRecovered: number;
  probeAttempts: number;
}

export interface ExecutionEvaluationReport {
  apiVersion: "chartermesh.dev/execution-evaluation/v1alpha1";
  evaluationId: string;
  suiteId: typeof SUITE_ID;
  suiteHash: string;
  seed: number;
  taskCount: number;
  startedAt: string;
  finishedAt?: string;
  executionBoundary: {
    mode: "harness-owned-temporary-git-repositories";
    modelGeneratedCodeExecuted: false;
    unapprovedExternalSideEffects: 0;
  };
  tiers: EvaluationTierResult[];
  tasks: ExecutionTaskResult[];
  probes: ArtifactProbeResult[];
  aggregate: {
    passedTasks: number;
    pendingTasks: number;
    executionPassRate: number;
    modelOutputs: number;
    structuredValidOutputs: number;
    structuredOutputRate: number;
    sentinelRetainedOutputs: number;
    sentinelRetentionRate: number | null;
    unapprovedExternalSideEffects: 0;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneConfig(value: ServiceConfig): ServiceConfig {
  return structuredClone(value);
}

function baseConfig(variant: number): ServiceConfig {
  return {
    service: {
      name: `repair-relay-${variant + 1}`,
      environment: variant % 2 === 0 ? "local" : "staging",
      region: "local",
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 250,
      strategy: "exponential",
    },
    approvals: {
      mode: "human",
      requiredFor: ["release"],
      twoPerson: false,
    },
    limits: {
      maxConcurrentRuns: 2,
      maxArtifactBytes: 1_048_576,
    },
    features: {
      audit: true,
      rollback: true,
      rateLimit: false,
    },
    workflow: ["intake", "plan", "implement", "verify", "approve"],
    metadata: {
      owner: "operations",
      revision: 1,
    },
  };
}

function quotedList(values: string[]): string {
  return JSON.stringify(values);
}

export function generateExecutionTasks(
  count = 100,
  seed = 20260731,
): ExecutionEvaluationTask[] {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error("task count must be an integer from 1 to 500.");
  }
  if (!Number.isInteger(seed)) {
    throw new Error("seed must be an integer.");
  }
  const ownerNames = [
    "operations",
    "quality",
    "security",
    "platform",
    "support",
  ];
  const environments = ["local", "staging", "production"] as const;
  return Array.from({ length: count }, (_, index) => {
    const family = (index + Math.abs(seed)) % 10;
    const variant = Math.floor(index / 10) % 10;
    const initial = baseConfig(variant);
    const expected = cloneConfig(initial);
    let instruction = "";
    switch (family) {
      case 0: {
        const value = 4 + (variant % 5);
        expected.retry.maxAttempts = value;
        instruction = `Set retry.maxAttempts to ${value}.`;
        break;
      }
      case 1: {
        const delay = 500 + variant * 125;
        const strategy = variant % 2 === 0 ? "linear" : "exponential";
        expected.retry.baseDelayMs = delay;
        expected.retry.strategy = strategy;
        instruction =
          `Set retry.baseDelayMs to ${delay} and retry.strategy to "${strategy}".`;
        break;
      }
      case 2: {
        const requiredFor =
          variant % 2 === 0
            ? ["release", "external-write"]
            : ["release", "security-change"];
        const twoPerson = variant % 3 === 0;
        expected.approvals.requiredFor = requiredFor;
        expected.approvals.twoPerson = twoPerson;
        instruction =
          `Replace approvals.requiredFor with ${quotedList(requiredFor)} and set approvals.twoPerson to ${twoPerson}.`;
        break;
      }
      case 3: {
        const concurrent = 3 + (variant % 5);
        const bytes = (variant + 2) * 1_048_576;
        expected.limits.maxConcurrentRuns = concurrent;
        expected.limits.maxArtifactBytes = bytes;
        instruction =
          `Set limits.maxConcurrentRuns to ${concurrent} and limits.maxArtifactBytes to ${bytes}.`;
        break;
      }
      case 4: {
        const audit = variant % 4 !== 0;
        const rollback = variant % 3 !== 0;
        const rateLimit = true;
        expected.features = { audit, rollback, rateLimit };
        instruction =
          `Set features to exactly ${JSON.stringify(expected.features)}.`;
        break;
      }
      case 5: {
        const workflow =
          variant % 2 === 0
            ? [
                "intake",
                "plan",
                "implement",
                "security-review",
                "verify",
                "approve",
              ]
            : [
                "intake",
                "triage",
                "plan",
                "implement",
                "verify",
                "approve",
              ];
        expected.workflow = workflow;
        instruction =
          `Replace workflow with this exact sequence: ${quotedList(workflow)}.`;
        break;
      }
      case 6: {
        const attempts = 2 + (variant % 4);
        const delay = 300 + variant * 75;
        expected.retry = {
          maxAttempts: attempts,
          baseDelayMs: delay,
          strategy: "linear",
        };
        instruction =
          `Replace retry with exactly ${JSON.stringify(expected.retry)}.`;
        break;
      }
      case 7: {
        const owner = ownerNames[variant % ownerNames.length]!;
        const revision = variant + 2;
        expected.metadata = { owner, revision };
        instruction =
          `Set metadata.owner to "${owner}" and metadata.revision to ${revision}.`;
        break;
      }
      case 8: {
        const environment = environments[variant % environments.length]!;
        const region = `local-zone-${(variant % 4) + 1}`;
        expected.service.environment = environment;
        expected.service.region = region;
        instruction =
          `Set service.environment to "${environment}" and service.region to "${region}".`;
        break;
      }
      default: {
        const concurrent = 1 + (variant % 4);
        const requiredFor = ["release", `risk-class-${(variant % 3) + 1}`];
        expected.limits.maxConcurrentRuns = concurrent;
        expected.approvals.requiredFor = requiredFor;
        expected.features.rateLimit = true;
        expected.metadata.revision = variant + 10;
        instruction = [
          `Set limits.maxConcurrentRuns to ${concurrent}.`,
          `Replace approvals.requiredFor with ${quotedList(requiredFor)}.`,
          "Set features.rateLimit to true.",
          `Set metadata.revision to ${variant + 10}.`,
        ].join(" ");
      }
    }
    return {
      id: `config-${String(index + 1).padStart(3, "0")}`,
      instruction,
      initial,
      expected,
    };
  });
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

export function validateServiceConfig(value: unknown): value is ServiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const root = value as Record<string, unknown>;
  if (
    !exactKeys(root, [
      "service",
      "retry",
      "approvals",
      "limits",
      "features",
      "workflow",
      "metadata",
    ])
  ) {
    return false;
  }
  const service = root.service as Record<string, unknown>;
  const retry = root.retry as Record<string, unknown>;
  const approvals = root.approvals as Record<string, unknown>;
  const limits = root.limits as Record<string, unknown>;
  const features = root.features as Record<string, unknown>;
  const metadata = root.metadata as Record<string, unknown>;
  if (
    !service ||
    !retry ||
    !approvals ||
    !limits ||
    !features ||
    !metadata ||
    !exactKeys(service, ["name", "environment", "region"]) ||
    !exactKeys(retry, ["maxAttempts", "baseDelayMs", "strategy"]) ||
    !exactKeys(approvals, ["mode", "requiredFor", "twoPerson"]) ||
    !exactKeys(limits, ["maxConcurrentRuns", "maxArtifactBytes"]) ||
    !exactKeys(features, ["audit", "rollback", "rateLimit"]) ||
    !exactKeys(metadata, ["owner", "revision"])
  ) {
    return false;
  }
  return (
    typeof service.name === "string" &&
    ["local", "staging", "production"].includes(
      String(service.environment),
    ) &&
    typeof service.region === "string" &&
    Number.isInteger(retry.maxAttempts) &&
    Number.isInteger(retry.baseDelayMs) &&
    ["linear", "exponential"].includes(String(retry.strategy)) &&
    approvals.mode === "human" &&
    validStringArray(approvals.requiredFor) &&
    typeof approvals.twoPerson === "boolean" &&
    Number.isInteger(limits.maxConcurrentRuns) &&
    Number.isInteger(limits.maxArtifactBytes) &&
    typeof features.audit === "boolean" &&
    typeof features.rollback === "boolean" &&
    typeof features.rateLimit === "boolean" &&
    validStringArray(root.workflow) &&
    typeof metadata.owner === "string" &&
    Number.isInteger(metadata.revision)
  );
}

function suiteHash(tasks: ExecutionEvaluationTask[]): string {
  return sha256(
    JSON.stringify(
      tasks.map(({ id, instruction, initial, expected }) => ({
        id,
        instruction,
        initial,
        expected,
      })),
    ),
  );
}

function aggregate(
  report: Pick<
    ExecutionEvaluationReport,
    "tasks" | "probes" | "taskCount"
  >,
): ExecutionEvaluationReport["aggregate"] {
  const attempts = report.tasks.flatMap((task) => task.attempts);
  const successfulAttempts = attempts.filter(
    (attempt) => attempt.structuredValid !== undefined,
  );
  const successfulProbes = report.probes.filter(
    (probe) => probe.errorCode === undefined,
  );
  const modelOutputs = successfulAttempts.length + successfulProbes.length;
  const structuredValidOutputs =
    successfulAttempts.filter((attempt) => attempt.structuredValid).length +
    successfulProbes.filter((probe) => probe.structuredValid).length;
  const passedTasks = report.tasks.filter(
    (task) => task.status === "passed",
  ).length;
  const probeCount = successfulProbes.length;
  const sentinelRetainedOutputs = successfulProbes.filter(
    (probe) => probe.sentinelRetained,
  ).length;
  return {
    passedTasks,
    pendingTasks: report.taskCount - passedTasks,
    executionPassRate: passedTasks / report.taskCount,
    modelOutputs,
    structuredValidOutputs,
    structuredOutputRate:
      modelOutputs === 0 ? 0 : structuredValidOutputs / modelOutputs,
    sentinelRetainedOutputs,
    sentinelRetentionRate:
      probeCount === 0 ? null : sentinelRetainedOutputs / probeCount,
    unapprovedExternalSideEffects: 0,
  };
}

function cloneReport(
  report: ExecutionEvaluationReport,
): ExecutionEvaluationReport {
  return structuredClone(report);
}

function emptyReport(
  tasks: ExecutionEvaluationTask[],
  seed: number,
): ExecutionEvaluationReport {
  const report: ExecutionEvaluationReport = {
    apiVersion: "chartermesh.dev/execution-evaluation/v1alpha1",
    evaluationId: `execution-eval-${randomUUID()}`,
    suiteId: SUITE_ID,
    suiteHash: suiteHash(tasks),
    seed,
    taskCount: tasks.length,
    startedAt: new Date().toISOString(),
    executionBoundary: {
      mode: "harness-owned-temporary-git-repositories",
      modelGeneratedCodeExecuted: false,
      unapprovedExternalSideEffects: 0,
    },
    tiers: [],
    tasks: tasks.map(({ id }) => ({
      id,
      status: "pending",
      attempts: [],
    })),
    probes: [],
    aggregate: {
      passedTasks: 0,
      pendingTasks: tasks.length,
      executionPassRate: 0,
      modelOutputs: 0,
      structuredValidOutputs: 0,
      structuredOutputRate: 0,
      sentinelRetainedOutputs: 0,
      sentinelRetentionRate: null,
      unapprovedExternalSideEffects: 0,
    },
  };
  return report;
}

function promptFor(task: ExecutionEvaluationTask): string {
  return [
    "You are editing service-config.json in an isolated local Git repository.",
    "Return the complete replacement JSON object only.",
    "Preserve every unspecified value exactly.",
    "Do not use Markdown fences, comments, ellipses, or extra keys.",
    "",
    `Requested change: ${task.instruction}`,
    "",
    "Current service-config.json:",
    JSON.stringify(task.initial, null, 2),
  ].join("\n");
}

async function initializeRepository(
  taskRoot: string,
  config: ServiceConfig,
): Promise<void> {
  await mkdir(taskRoot, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", taskRoot], {
    timeout: 15_000,
    windowsHide: true,
  });
  await writeFile(
    join(taskRoot, "service-config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await execFileAsync("git", ["add", "--", "service-config.json"], {
    cwd: taskRoot,
    timeout: 15_000,
    windowsHide: true,
  });
}

async function hiddenRepositoryTest(
  taskRoot: string,
  expected: ServiceConfig,
): Promise<string | undefined> {
  const path = join(taskRoot, "service-config.json");
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return "CONFIG_FILE_INVALID_JSON";
  }
  if (!validateServiceConfig(candidate)) return "CONFIG_SCHEMA_INVALID";
  if (!isDeepStrictEqual(candidate, expected)) return "CONFIG_MISMATCH";
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--numstat", "--", "service-config.json"],
    {
      cwd: taskRoot,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (!stdout.trim()) return "REPOSITORY_NOT_MODIFIED";
  return undefined;
}

async function executeTask(
  engine: ModelEngine,
  tierId: string,
  task: ExecutionEvaluationTask,
  taskRoot: string,
): Promise<ExecutionAttempt> {
  const started = performance.now();
  try {
    await initializeRepository(taskRoot, task.initial);
    const inference = await engine.generate({
      invocationId: `execution:${tierId}:${task.id}`,
      messages: [
        {
          role: "system",
          content:
            "Apply the requested bounded configuration change. Output one complete JSON object only.",
        },
        { role: "user", content: promptFor(task) },
      ],
      maxOutputTokens: 768,
    });
    const compiled = compileStructuredArtifact({
      text: inference.text,
      summary: `Execution attempt ${task.id}`,
      confidence: "medium",
    });
    const structuredValid =
      parseStructuredArtifact(compiled.canonicalText) !== null;
    const candidate = extractFirstJsonObject(inference.text);
    let errorCode: string | undefined;
    if (!candidate) {
      errorCode = "MODEL_OUTPUT_NOT_JSON";
    } else {
      await writeFile(
        join(taskRoot, "service-config.json"),
        `${JSON.stringify(candidate, null, 2)}\n`,
        "utf8",
      );
      errorCode = await hiddenRepositoryTest(taskRoot, task.expected);
    }
    return {
      tierId,
      engineId: engine.manifest.profileId,
      status: errorCode ? "failed" : "passed",
      latencyMs: Math.round(performance.now() - started),
      outputHash: sha256(inference.text),
      compiledArtifactHash: sha256(compiled.canonicalText),
      compilerStatus: compiled.status,
      structuredValid,
      ...(errorCode ? { errorCode } : {}),
      usage: inference.usage,
    };
  } catch (error) {
    return {
      tierId,
      engineId: engine.manifest.profileId,
      status: "failed",
      latencyMs: Math.round(performance.now() - started),
      errorCode:
        error instanceof Error &&
        error.message.includes("MODEL_RESPONSE_LIMIT_EXCEEDED")
          ? "MODEL_RESPONSE_LIMIT_EXCEEDED"
          : "MODEL_INVOCATION_FAILED",
    };
  }
}

async function runProbe(
  engine: ModelEngine,
  tierId: string,
  number: number,
): Promise<ArtifactProbeResult> {
  const id = `artifact-${String(number).padStart(4, "0")}`;
  const sentinel = `STRUCT-${String(number).padStart(6, "0")}`;
  const started = performance.now();
  try {
    const inference = await engine.generate({
      invocationId: `artifact-probe:${tierId}:${id}`,
      messages: [
        {
          role: "system",
          content:
            "Return one short human-readable sentence containing the exact supplied sentinel.",
        },
        {
          role: "user",
          content: `Required sentinel: ${sentinel}`,
        },
      ],
      maxOutputTokens: 128,
    });
    const compiled = compileStructuredArtifact({
      text: inference.text,
      summary: `Artifact compiler probe ${id}`,
      confidence: "medium",
    });
    return {
      id,
      tierId,
      engineId: engine.manifest.profileId,
      latencyMs: Math.round(performance.now() - started),
      structuredValid:
        parseStructuredArtifact(compiled.canonicalText) !== null,
      sentinelRetained: compiled.artifact.deliverable.includes(sentinel),
      outputHash: sha256(inference.text),
      compiledArtifactHash: sha256(compiled.canonicalText),
      compilerStatus: compiled.status,
      usage: inference.usage,
    };
  } catch {
    return {
      id,
      tierId,
      engineId: engine.manifest.profileId,
      latencyMs: Math.round(performance.now() - started),
      structuredValid: false,
      sentinelRetained: false,
      errorCode: "MODEL_INVOCATION_FAILED",
    };
  }
}

export async function evaluateExecutionTier(
  engine: ModelEngine,
  options: {
    tierId: string;
    taskCount?: number;
    seed?: number;
    probeCount?: number;
    previous?: ExecutionEvaluationReport;
    onProgress?: (
      report: ExecutionEvaluationReport,
    ) => Promise<void> | void;
  },
): Promise<ExecutionEvaluationReport> {
  const taskCount = options.taskCount ?? options.previous?.taskCount ?? 100;
  const seed = options.seed ?? options.previous?.seed ?? 20260731;
  const tasks = generateExecutionTasks(taskCount, seed);
  const expectedSuiteHash = suiteHash(tasks);
  const report = options.previous
    ? cloneReport(options.previous)
    : emptyReport(tasks, seed);
  if (
    report.apiVersion !==
      "chartermesh.dev/execution-evaluation/v1alpha1" ||
    report.suiteId !== SUITE_ID ||
    report.suiteHash !== expectedSuiteHash ||
    report.taskCount !== taskCount ||
    report.seed !== seed
  ) {
    throw new Error(
      "Resume report does not match the requested execution suite.",
    );
  }
  if (report.tiers.some(({ tierId }) => tierId === options.tierId)) {
    throw new Error(`Tier '${options.tierId}' already exists in the report.`);
  }
  delete report.finishedAt;
  const tier: EvaluationTierResult = {
    tierId: options.tierId,
    engineId: engine.manifest.profileId,
    startedAt: new Date().toISOString(),
    taskAttempts: 0,
    tasksPassed: 0,
    tasksRecovered: 0,
    probeAttempts: 0,
  };
  report.tiers.push(tier);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "chartermesh-execution-eval-"),
  );
  try {
    for (const task of tasks) {
      const result = report.tasks.find(({ id }) => id === task.id);
      if (!result) throw new Error(`Missing report task '${task.id}'.`);
      if (result.status === "passed") continue;
      const hadPreviousAttempt = result.attempts.length > 0;
      const attempt = await executeTask(
        engine,
        options.tierId,
        task,
        join(temporaryRoot, task.id),
      );
      result.attempts.push(attempt);
      tier.taskAttempts += 1;
      if (attempt.status === "passed") {
        result.status = "passed";
        result.passedAtTier = options.tierId;
        tier.tasksPassed += 1;
        if (hadPreviousAttempt) tier.tasksRecovered += 1;
      }
      report.aggregate = aggregate(report);
      await options.onProgress?.(cloneReport(report));
    }
    const firstProbeNumber = report.probes.length + 1;
    for (
      let offset = 0;
      offset < (options.probeCount ?? 0);
      offset += 1
    ) {
      report.probes.push(
        await runProbe(
          engine,
          options.tierId,
          firstProbeNumber + offset,
        ),
      );
      tier.probeAttempts += 1;
      report.aggregate = aggregate(report);
      await options.onProgress?.(cloneReport(report));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  tier.finishedAt = new Date().toISOString();
  report.finishedAt = tier.finishedAt;
  report.aggregate = aggregate(report);
  await options.onProgress?.(cloneReport(report));
  return report;
}
