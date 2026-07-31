import { createHash, randomUUID } from "node:crypto";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelUsage,
} from "../../../../packages/adapter-sdk/src/types.ts";
import {
  buildCodeTaskPrompt,
  canonicalCandidateText,
  codeCandidateSchema,
  parseCodeCandidate,
  type CodeCandidate,
} from "./candidate.ts";
import {
  requireSafeSandbox,
  runSandboxJobs,
  type CodeSandboxBackend,
  type CodeSandboxJob,
  type CodeSandboxProbe,
  type CodeSandboxRunResult,
} from "./sandbox.ts";
import {
  validateCodeEvaluationProvenance,
  type CodeEvaluationProvenance,
} from "./provenance.ts";
import {
  codeEvaluationSuiteHash,
  generatePilotCodeSuite,
  projectPublicCodeTask,
  type CodeEvaluationTask,
} from "./suite.ts";

const STATE_API_VERSION =
  "chartermesh.dev/code-evaluation-state/v1alpha1" as const;
const REPORT_API_VERSION =
  "chartermesh.dev/code-evaluation-report/v1alpha1" as const;
const SUITE_ID = "company-maintenance-pilot-v1" as const;
const DEFAULT_SEED = 20260731;

export type CodeEngineSlot = "e4b" | "gemma26b" | "qwen";
export type CodeConditionId =
  | "e4b-single"
  | "gemma26b-single"
  | "qwen-single"
  | "tiered-e4b-gemma26b-qwen";

export interface CodeEngineDescriptorInput {
  slot: CodeEngineSlot;
  engineId: string;
  adapter: string;
  endpoint: string;
  model: string;
  quantization: string;
  contextTokens: number;
  serverBuild: string;
  timeoutMs: number;
  maxResponseBytes: number;
  structuredOutputMode: "prompt" | "json-schema";
  reasoningMode: "default" | "disabled";
  temperature: number;
  seed: number;
  modelArtifactSha256?: string;
  /**
   * `canonical-shard-manifest` hashes the canonical JSON array of lowercase
   * shard SHA-256 digests in shard-filename order.
   */
  modelArtifactHashKind?: "file" | "canonical-shard-manifest";
}

export interface CodeEngineDescriptor
  extends CodeEngineDescriptorInput {
  fingerprint: string;
}

export interface CodeStageSpec {
  id: string;
  engineSlot: CodeEngineSlot;
  role: "implementer" | "reviewer" | "final_reviewer";
  maxOutputTokens: number;
}

export interface CodeConditionSpec {
  id: CodeConditionId;
  label: string;
  stages: CodeStageSpec[];
  maxRequestedOutputTokensPerTask: number;
}

export const CODE_EVALUATION_CONDITIONS: CodeConditionSpec[] = [
  {
    id: "e4b-single",
    label: "Gemma 4 E4B single",
    stages: [
      {
        id: "final",
        engineSlot: "e4b",
        role: "implementer",
        maxOutputTokens: 6_144,
      },
    ],
    maxRequestedOutputTokensPerTask: 6_144,
  },
  {
    id: "gemma26b-single",
    label: "Gemma 4 26B A4B single",
    stages: [
      {
        id: "final",
        engineSlot: "gemma26b",
        role: "implementer",
        maxOutputTokens: 6_144,
      },
    ],
    maxRequestedOutputTokensPerTask: 6_144,
  },
  {
    id: "qwen-single",
    label: "Qwen 3.5 122B A10B single",
    stages: [
      {
        id: "final",
        engineSlot: "qwen",
        role: "implementer",
        maxOutputTokens: 6_144,
      },
    ],
    maxRequestedOutputTokensPerTask: 6_144,
  },
  {
    id: "tiered-e4b-gemma26b-qwen",
    label: "E4B draft to 26B review to Qwen final review",
    stages: [
      {
        id: "draft",
        engineSlot: "e4b",
        role: "implementer",
        maxOutputTokens: 2_048,
      },
      {
        id: "review",
        engineSlot: "gemma26b",
        role: "reviewer",
        maxOutputTokens: 2_048,
      },
      {
        id: "final",
        engineSlot: "qwen",
        role: "final_reviewer",
        maxOutputTokens: 2_048,
      },
    ],
    maxRequestedOutputTokensPerTask: 6_144,
  },
];

export interface CodeGenerationRecord {
  stageId: string;
  engineSlot: CodeEngineSlot;
  engineId?: string;
  engineFingerprint?: string;
  role: CodeStageSpec["role"];
  status: "invocation_running" | "candidate_available" | "failed";
  contract: "strict" | "recovered" | "invalid";
  startedAt: string;
  finishedAt?: string;
  latencyMs?: number;
  maxOutputTokens: number;
  finishReason?: InferenceResult["finishReason"];
  reportedModelId?: string | null;
  reportedSystemFingerprint?: string | null;
  usage?: ModelUsage;
  rawOutputHash?: string;
  requestHash?: string;
  candidateHash?: string;
  candidate?: CodeCandidate;
  errorCode?:
    | "MODEL_INVOCATION_FAILED"
    | "UPSTREAM_CANDIDATE_UNAVAILABLE"
    | "CANDIDATE_NOT_JSON"
    | "CANDIDATE_SCHEMA_INVALID"
    | "CANDIDATE_PATH_NOT_ALLOWED"
    | "CANDIDATE_SIZE_LIMIT";
}

export interface CodeTaskGenerationState {
  taskId: string;
  stages: CodeGenerationRecord[];
}

export interface CodeConditionState {
  id: CodeConditionId;
  tasks: CodeTaskGenerationState[];
}

export interface CodeEvaluationState {
  apiVersion: typeof STATE_API_VERSION;
  evaluationId: string;
  suiteId: typeof SUITE_ID;
  suiteHash: string;
  planHash: string;
  seed: number;
  createdAt: string;
  updatedAt: string;
  generationFrozenAt?: string;
  generationHash?: string;
  provenance?: CodeEvaluationProvenance;
  engines: CodeEngineDescriptor[];
  conditions: CodeConditionState[];
}

export interface CodeStageEvaluation {
  stageId: string;
  generated: boolean;
  contract: CodeGenerationRecord["contract"] | "missing";
  passed: boolean;
  passedCases: number;
  totalCases: number;
  publicPassed: number;
  publicTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  policyViolations: string[];
  audit: {
    generationStatus: CodeGenerationRecord["status"] | "missing";
    engineId: string | null;
    engineFingerprint: string | null;
    requestHash: string | null;
    candidateHash: string | null;
    rawOutputHash: string | null;
    finishReason: InferenceResult["finishReason"] | null;
    reportedModelId: string | null;
    reportedSystemFingerprint: string | null;
    usage: ModelUsage | null;
    startedAt: string | null;
    finishedAt: string | null;
    clientObservedGenerationLatencyMs: number | null;
    resultHash: string | null;
  };
}

export interface CodeTaskEvaluation {
  taskId: string;
  publicTaskHash: string;
  passed: boolean;
  stages: CodeStageEvaluation[];
}

export interface CodeConditionEvaluation {
  id: CodeConditionId;
  label: string;
  engineIds: string[];
  clientObservedGenerationLatencyMs: number;
  plannedStageSlots: number;
  skippedUpstreamStages: number;
  completedFinals: number;
  tasksPassed: number;
  taskCount: number;
  passRate: number;
  finalStrictContracts: number;
  invocationAttempts: number;
  modelResponses: number;
  modelResponseRate: number;
  strictModelOutputs: number;
  structuredOutputRate: number;
  recoveredModelOutputs: number;
  usageCoverage: number;
  observedOutputWithinRequestedCeiling: boolean | null;
  observedUsage: ModelUsage;
  tasks: CodeTaskEvaluation[];
}

export interface CodeEvaluationReport {
  apiVersion: typeof REPORT_API_VERSION;
  evaluationId: string;
  suiteId: typeof SUITE_ID;
  suiteHash: string;
  planHash: string;
  generationHash: string;
  generationFrozenAt: string;
  engines: CodeEngineDescriptor[];
  provenance: CodeEvaluationProvenance;
  seed: number;
  startedAt: string;
  finishedAt: string;
  sandbox: CodeSandboxProbe;
  scope: {
    kind: "public-development-pilot";
    developmentSuitePublic: true;
    taskCount: number;
    repositoryCount: number;
    taskFamilyCount: number;
    trialsPerCondition: 1;
    statisticalInference: false;
    tieredExecution: "serial-review-routing";
    agentDelegationExercised: false;
    limitations: string[];
  };
  comparisonControls: {
    artifactHashesRequired: true;
    adapter: string;
    contextTokens: number;
    timeoutMs: number;
    maxResponseBytes: number;
    structuredOutputMode: CodeEngineDescriptor["structuredOutputMode"];
    reasoningMode: CodeEngineDescriptor["reasoningMode"];
    temperature: number;
    samplingSeed: number;
    serverBuilds: string[];
    providerResponseIdentityCaptured: boolean;
  };
  budget: {
    mode: "requested-output-ceiling-matched";
    maxRequestedOutputTokensPerTask: number;
    singleCallsPerTask: number;
    tieredCallsPerTask: number;
    hiddenFeedbackToModels: false;
    retriesPerStage: 0;
    interstageCanonicalization: true;
    intermediateRecoveredCandidatesMayAdvance: true;
    finalRecoveredCandidateFails: true;
    tokenUsageSource: "provider-reported-or-unknown";
    ceilingEnforcement: "requested-not-locally-tokenized";
    note: string;
  };
  preflight: {
    passed: boolean;
    oracleTasksPassed: number;
    baselineTasksExact: number;
    baselineTaskCount: number;
    baselineDefectsDetected: number;
    baselineDefectsExpected: number;
    mutationsKilled: number;
    mutationCount: number;
    mutationScore: number;
  };
  conditions: CodeConditionEvaluation[];
  aggregate: {
    invocationAttempts: number;
    modelResponses: number;
    modelResponseRate: number;
    strictModelOutputs: number;
    structuredOutputRate: number;
    unapprovedExternalSideEffects: 0;
    unapprovedExternalSideEffectsBasis:
      "verified-vm-containment-not-model-restraint";
    policyViolations: string[];
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function commitment(value: unknown): string {
  return sha256(canonicalJson(value));
}

function planHash(suiteHash: string): string {
  return commitment({
    suiteId: SUITE_ID,
    suiteHash,
    conditions: CODE_EVALUATION_CONDITIONS,
    retriesPerStage: 0,
    hiddenFeedbackToModels: false,
  });
}

function engineFingerprint(
  descriptor: CodeEngineDescriptorInput,
): string {
  return commitment(descriptor);
}

function finalPlanHash(
  basePlanHash: string,
  engines: CodeEngineDescriptor[],
  provenance: CodeEvaluationProvenance,
): string {
  return commitment({
    basePlanHash,
    engines: [...engines].sort((left, right) =>
      left.slot.localeCompare(right.slot),
    ),
    provenance,
  });
}

function engineFieldIsUniform(
  engines: CodeEngineDescriptor[],
  field:
    | "adapter"
    | "contextTokens"
    | "timeoutMs"
    | "maxResponseBytes"
    | "structuredOutputMode"
    | "reasoningMode"
    | "temperature"
    | "seed",
): boolean {
  return new Set(engines.map((engine) => engine[field])).size === 1;
}

function validateEngineDescriptor(
  descriptor: CodeEngineDescriptor,
): void {
  let endpoint: URL;
  try {
    if (typeof descriptor.endpoint !== "string") {
      throw new Error("invalid endpoint");
    }
    endpoint = new URL(descriptor.endpoint);
  } catch {
    throw new Error("Code-evaluation engine endpoint is invalid.");
  }
  if (
    !["e4b", "gemma26b", "qwen"].includes(descriptor.slot) ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["127.0.0.1", "::1", "[::1]", "localhost"].includes(
      endpoint.hostname.toLowerCase(),
    ) ||
    typeof descriptor.engineId !== "string" ||
    !descriptor.engineId.trim() ||
    typeof descriptor.adapter !== "string" ||
    !descriptor.adapter.trim() ||
    typeof descriptor.model !== "string" ||
    !descriptor.model.trim() ||
    typeof descriptor.quantization !== "string" ||
    !descriptor.quantization.trim() ||
    typeof descriptor.serverBuild !== "string" ||
    !descriptor.serverBuild.trim() ||
    !["prompt", "json-schema"].includes(
      descriptor.structuredOutputMode,
    ) ||
    !["default", "disabled"].includes(descriptor.reasoningMode) ||
    !Number.isSafeInteger(descriptor.contextTokens) ||
    descriptor.contextTokens < 1 ||
    !Number.isSafeInteger(descriptor.timeoutMs) ||
    descriptor.timeoutMs < 1_000 ||
    descriptor.timeoutMs > 600_000 ||
    !Number.isSafeInteger(descriptor.maxResponseBytes) ||
    descriptor.maxResponseBytes < 1_024 ||
    descriptor.maxResponseBytes > 64 * 1_024 * 1_024 ||
    !Number.isFinite(descriptor.temperature) ||
    descriptor.temperature < 0 ||
    descriptor.temperature > 2 ||
    !Number.isSafeInteger(descriptor.seed) ||
    (descriptor.modelArtifactSha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(descriptor.modelArtifactSha256)) ||
    (descriptor.modelArtifactSha256 === undefined) !==
      (descriptor.modelArtifactHashKind === undefined) ||
    (descriptor.modelArtifactHashKind !== undefined &&
      !["file", "canonical-shard-manifest"].includes(
        descriptor.modelArtifactHashKind,
      )) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.fingerprint) ||
    descriptor.fingerprint !==
      engineFingerprint(
        (({ fingerprint: _ignored, ...input }) => input)(descriptor),
      )
  ) {
    throw new Error(
      `Code-evaluation engine descriptor '${descriptor.slot}' is invalid.`,
    );
  }
}

export function bindCodeEvaluationEngine(
  state: CodeEvaluationState,
  input: CodeEngineDescriptorInput,
): CodeEngineDescriptor {
  assertStateIntegrity(state);
  if (state.generationHash) {
    throw new Error("Code-evaluation generation is frozen.");
  }
  const descriptor: CodeEngineDescriptor = {
    ...structuredClone(input),
    fingerprint: engineFingerprint(input),
  };
  validateEngineDescriptor(descriptor);
  const existing = state.engines.find(({ slot }) => slot === input.slot);
  if (existing) {
    if (existing.fingerprint !== descriptor.fingerprint) {
      throw new Error(
        `Engine slot '${input.slot}' is already bound to another fingerprint.`,
      );
    }
    return existing;
  }
  const hasRecords = state.conditions.some((condition) =>
    condition.tasks.some((task) =>
      task.stages.some(
        ({ engineSlot, engineId }) =>
          engineSlot === input.slot && engineId !== undefined,
      ),
    ),
  );
  if (hasRecords) {
    throw new Error(
      `Engine slot '${input.slot}' cannot be bound after invocation records exist.`,
    );
  }
  state.engines.push(descriptor);
  state.engines.sort((left, right) =>
    left.slot.localeCompare(right.slot),
  );
  state.updatedAt = new Date().toISOString();
  return descriptor;
}

export function bindCodeEvaluationProvenance(
  state: CodeEvaluationState,
  input: CodeEvaluationProvenance,
): CodeEvaluationProvenance {
  assertStateIntegrity(state);
  const provenance = structuredClone(input);
  validateCodeEvaluationProvenance(provenance);
  if (state.provenance) {
    if (commitment(state.provenance) !== commitment(provenance)) {
      throw new Error(
        "Code-evaluation provenance is already bound to another environment.",
      );
    }
    return state.provenance;
  }
  if (state.generationHash) {
    throw new Error("Code-evaluation generation is frozen.");
  }
  state.provenance = provenance;
  state.updatedAt = new Date().toISOString();
  return provenance;
}

const GENERATION_RECORD_KEYS = new Set([
  "stageId",
  "engineSlot",
  "engineId",
  "engineFingerprint",
  "role",
  "status",
  "contract",
  "startedAt",
  "finishedAt",
  "latencyMs",
  "maxOutputTokens",
  "finishReason",
  "reportedModelId",
  "reportedSystemFingerprint",
  "usage",
  "rawOutputHash",
  "requestHash",
  "candidateHash",
  "candidate",
  "errorCode",
]);
const GENERATION_STATUSES = new Set([
  "invocation_running",
  "candidate_available",
  "failed",
]);
const GENERATION_CONTRACTS = new Set([
  "strict",
  "recovered",
  "invalid",
]);
const GENERATION_FINISH_REASONS = new Set([
  "stop",
  "tool_call",
  "length",
  "canceled",
  "error",
]);
const GENERATION_ERROR_CODES = new Set([
  "MODEL_INVOCATION_FAILED",
  "UPSTREAM_CANDIDATE_UNAVAILABLE",
  "CANDIDATE_NOT_JSON",
  "CANDIDATE_SCHEMA_INVALID",
  "CANDIDATE_PATH_NOT_ALLOWED",
  "CANDIDATE_SIZE_LIMIT",
]);
const MODEL_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cost",
  "measurementStatus",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validUsageValue(
  value: unknown,
  integer: boolean,
): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      (!integer || Number.isSafeInteger(value)))
  );
}

function validModelUsage(value: unknown): value is ModelUsage {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== MODEL_USAGE_KEYS.length ||
    MODEL_USAGE_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    return false;
  }
  return (
    validUsageValue(value.inputTokens, true) &&
    validUsageValue(value.outputTokens, true) &&
    validUsageValue(value.cacheReadTokens, true) &&
    validUsageValue(value.cacheWriteTokens, true) &&
    validUsageValue(value.cost, false) &&
    ["measured", "estimated", "unknown"].includes(
      String(value.measurementStatus),
    )
  );
}

function assertGenerationRecordSchema(
  value: unknown,
  scope: string,
): asserts value is CodeGenerationRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !GENERATION_RECORD_KEYS.has(key)) ||
    typeof value.stageId !== "string" ||
    !["e4b", "gemma26b", "qwen"].includes(
      String(value.engineSlot),
    ) ||
    !["implementer", "reviewer", "final_reviewer"].includes(
      String(value.role),
    ) ||
    !GENERATION_STATUSES.has(String(value.status)) ||
    !GENERATION_CONTRACTS.has(String(value.contract)) ||
    !isCanonicalTimestamp(value.startedAt) ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    Number(value.maxOutputTokens) < 1 ||
    (value.engineId !== undefined &&
      (typeof value.engineId !== "string" ||
        value.engineId.length < 1 ||
        value.engineId.length > 1_000)) ||
    (value.finishedAt !== undefined &&
      !isCanonicalTimestamp(value.finishedAt)) ||
    (value.latencyMs !== undefined &&
      (!Number.isSafeInteger(value.latencyMs) ||
        Number(value.latencyMs) < 0)) ||
    (value.finishReason !== undefined &&
      !GENERATION_FINISH_REASONS.has(String(value.finishReason))) ||
    (value.usage !== undefined && !validModelUsage(value.usage)) ||
    (value.errorCode !== undefined &&
      !GENERATION_ERROR_CODES.has(String(value.errorCode)))
  ) {
    throw new Error(
      `Generation record '${scope}' does not satisfy the strict runtime schema.`,
    );
  }
}

function conditionSpec(id: CodeConditionId): CodeConditionSpec {
  const spec = CODE_EVALUATION_CONDITIONS.find(
    (candidate) => candidate.id === id,
  );
  if (!spec) throw new Error(`Unknown code-evaluation condition '${id}'.`);
  return spec;
}

function generationRequest(
  state: CodeEvaluationState,
  condition: CodeConditionSpec,
  task: CodeEvaluationTask,
  stage: CodeStageSpec,
  previous?: CodeGenerationRecord,
): InferenceRequest {
  return {
    invocationId: `${state.evaluationId}:${condition.id}:${task.id}:${stage.id}`,
    messages: [
      {
        role: "system",
        content:
          "You are a bounded dependency-free maintenance engineer. Follow the supplied response contract exactly and do not claim to have run tests.",
      },
      {
        role: "user",
        content: buildCodeTaskPrompt(projectPublicCodeTask(task), {
          stageRole: stage.role,
          ...(previous?.candidate
            ? { priorCandidate: previous.candidate }
            : {}),
        }),
      },
    ],
    responseSchema: codeCandidateSchema(),
    maxOutputTokens: stage.maxOutputTokens,
  };
}

function assertStateIntegrity(
  state: CodeEvaluationState,
): CodeEvaluationTask[] {
  if (state.apiVersion !== STATE_API_VERSION || state.suiteId !== SUITE_ID) {
    throw new Error("Code-evaluation state has an unsupported contract.");
  }
  const tasks = generatePilotCodeSuite(state.seed);
  const suiteHash = codeEvaluationSuiteHash(tasks);
  const basePlanHash = planHash(suiteHash);
  if (!Array.isArray(state.engines)) {
    throw new Error(
      "Code-evaluation state predates engine fingerprint binding.",
    );
  }
  for (const descriptor of state.engines) {
    validateEngineDescriptor(descriptor);
  }
  if (
    state.engines.length !==
    new Set(state.engines.map(({ slot }) => slot)).size
  ) {
    throw new Error("Code-evaluation engine slots must be unique.");
  }
  if (state.provenance !== undefined) {
    validateCodeEvaluationProvenance(state.provenance);
  }
  if (state.generationHash && state.provenance === undefined) {
    throw new Error(
      "Code-evaluation frozen state is missing reproducibility provenance.",
    );
  }
  const expectedPlanHash = state.generationHash
    ? finalPlanHash(basePlanHash, state.engines, state.provenance!)
    : basePlanHash;
  if (
    state.suiteHash !== suiteHash ||
    state.planHash !== expectedPlanHash
  ) {
    throw new Error(
      "Code-evaluation state does not match the current sealed suite and plan.",
    );
  }
  for (const spec of CODE_EVALUATION_CONDITIONS) {
    const matchingConditions = state.conditions.filter(
      ({ id }) => id === spec.id,
    );
    const condition = matchingConditions[0];
    if (
      matchingConditions.length !== 1 ||
      !condition ||
      condition.tasks.length !== tasks.length
    ) {
      throw new Error(`Condition '${spec.id}' is missing task state.`);
    }
    const taskIds = condition.tasks.map(({ taskId }) => taskId);
    if (
      new Set(taskIds).size !== taskIds.length ||
      tasks.some(({ id }) => !taskIds.includes(id))
    ) {
      throw new Error(
        `Condition '${spec.id}' does not match the sealed task identities.`,
      );
    }
    for (const taskState of condition.tasks) {
      const task = tasks.find(({ id }) => id === taskState.taskId)!;
      if (!Array.isArray(taskState.stages)) {
        throw new Error(
          `Generation state '${spec.id}/${task.id}' has an invalid stage list.`,
        );
      }
      for (const rawRecord of taskState.stages) {
        const scope = `${spec.id}/${task.id}/${
          isRecord(rawRecord) && typeof rawRecord.stageId === "string"
            ? rawRecord.stageId
            : "unknown"
        }`;
        assertGenerationRecordSchema(rawRecord, scope);
        const record = rawRecord;
        const stage = spec.stages.find(({ id }) => id === record.stageId);
        if (
          !stage ||
          record.engineSlot !== stage.engineSlot ||
          record.role !== stage.role ||
          record.maxOutputTokens !== stage.maxOutputTokens
        ) {
          throw new Error(
            `Generation record '${spec.id}/${task.id}/${record.stageId}' does not match the frozen plan.`,
          );
        }
        if (record.engineId !== undefined) {
          const descriptor = state.engines.find(
            ({ slot }) => slot === record.engineSlot,
          );
          if (
            !descriptor ||
            record.engineId !== descriptor.engineId ||
            record.engineFingerprint !== descriptor.fingerprint
          ) {
            throw new Error(
              `Generation record '${spec.id}/${task.id}/${record.stageId}' is not bound to its engine fingerprint.`,
            );
          }
        }
        const stageIndex = spec.stages.findIndex(
          ({ id }) => id === record.stageId,
        );
        const previousSpec =
          stageIndex > 0 ? spec.stages[stageIndex - 1] : undefined;
        const previous = previousSpec
          ? taskState.stages.find(
              ({ stageId }) => stageId === previousSpec.id,
            )
          : undefined;
        const attempted =
          record.engineId !== undefined ||
          record.engineFingerprint !== undefined ||
          record.requestHash !== undefined;
        if (
          attempted &&
          (!record.engineId ||
            !record.engineFingerprint ||
            !record.requestHash ||
            record.requestHash !==
              commitment(
                generationRequest(
                  state,
                  spec,
                  task,
                  stage!,
                  previous,
                ),
              ))
        ) {
          throw new Error(
            `Generation record '${spec.id}/${task.id}/${record.stageId}' has an invalid request commitment.`,
          );
        }
        if (
          (record.status === "candidate_available") !==
            Boolean(record.candidate) ||
          (record.status === "candidate_available" &&
            !["strict", "recovered"].includes(record.contract)) ||
          (record.status === "failed" &&
            (record.contract !== "invalid" ||
              record.errorCode === undefined)) ||
          (record.status === "invocation_running" &&
            (record.contract !== "invalid" ||
              !attempted ||
              record.finishedAt !== undefined ||
              record.latencyMs !== undefined ||
              record.finishReason !== undefined ||
              record.reportedModelId !== undefined ||
              record.reportedSystemFingerprint !== undefined ||
              record.usage !== undefined ||
              record.rawOutputHash !== undefined ||
              record.candidateHash !== undefined ||
              record.errorCode !== undefined)) ||
          (record.status !== "invocation_running" &&
            (record.finishedAt === undefined ||
              record.latencyMs === undefined ||
              !Number.isSafeInteger(record.latencyMs) ||
              record.latencyMs < 0)) ||
          (record.status === "candidate_available" &&
            (!attempted ||
              record.finishReason === undefined ||
              record.usage === undefined ||
              record.rawOutputHash === undefined ||
              record.candidateHash === undefined ||
              record.errorCode !== undefined)) ||
          (record.status === "failed" &&
            record.errorCode === "UPSTREAM_CANDIDATE_UNAVAILABLE" &&
            (record.finishReason !== undefined ||
              record.reportedModelId !== undefined ||
              record.reportedSystemFingerprint !== undefined ||
              record.usage !== undefined ||
              record.rawOutputHash !== undefined ||
              record.candidateHash !== undefined)) ||
          (record.status === "failed" &&
            record.errorCode === "MODEL_INVOCATION_FAILED" &&
            (record.finishReason !== undefined ||
              record.reportedModelId !== undefined ||
              record.reportedSystemFingerprint !== undefined ||
              record.usage !== undefined ||
              record.rawOutputHash !== undefined ||
              record.candidateHash !== undefined)) ||
          (record.errorCode === "UPSTREAM_CANDIDATE_UNAVAILABLE" &&
            attempted) ||
          (record.errorCode === "MODEL_INVOCATION_FAILED" &&
            !attempted) ||
          ((record.reportedModelId !== undefined ||
            record.reportedSystemFingerprint !== undefined) &&
            record.rawOutputHash === undefined) ||
          (record.reportedModelId !== undefined &&
            record.reportedModelId !== null &&
            (typeof record.reportedModelId !== "string" ||
              record.reportedModelId.length > 1_000)) ||
          (record.reportedSystemFingerprint !== undefined &&
            record.reportedSystemFingerprint !== null &&
            (typeof record.reportedSystemFingerprint !== "string" ||
              record.reportedSystemFingerprint.length > 1_000)) ||
          (record.status === "failed" &&
            ![
              "MODEL_INVOCATION_FAILED",
              "UPSTREAM_CANDIDATE_UNAVAILABLE",
            ].includes(record.errorCode ?? "") &&
            (!attempted ||
              record.finishReason === undefined ||
              record.usage === undefined ||
              record.rawOutputHash === undefined))
        ) {
          throw new Error(
            `Generation record '${spec.id}/${task.id}/${record.stageId}' has inconsistent status.`,
          );
        }
        for (const hash of [
          record.engineFingerprint,
          record.requestHash,
          record.rawOutputHash,
          record.candidateHash,
        ]) {
          if (hash !== undefined && !/^[a-f0-9]{64}$/u.test(hash)) {
            throw new Error(
              `Generation record '${spec.id}/${task.id}/${record.stageId}' contains an invalid commitment.`,
            );
          }
        }
        if (record.candidate) {
          const reparsed = parseCodeCandidate(
            canonicalCandidateText(record.candidate),
            task.editablePaths,
          );
          if (
            !reparsed.candidate ||
            reparsed.candidateHash !== record.candidateHash
          ) {
            throw new Error(
              `Generation record '${spec.id}/${task.id}/${record.stageId}' has an invalid candidate commitment.`,
            );
          }
        }
      }
    }
  }
  if (
    state.conditions.length !== CODE_EVALUATION_CONDITIONS.length
  ) {
    throw new Error("Code-evaluation state contains unknown conditions.");
  }
  if (
    (state.generationHash === undefined) !==
    (state.generationFrozenAt === undefined)
  ) {
    throw new Error("Code-evaluation generation freeze is incomplete.");
  }
  if (
    state.generationHash &&
    state.generationHash !== generationCommitment(state)
  ) {
    throw new Error(
      "Code-evaluation generation changed after it was frozen.",
    );
  }
  return tasks;
}

function assertGenerationComplete(state: CodeEvaluationState): void {
  for (const spec of CODE_EVALUATION_CONDITIONS) {
    const condition = state.conditions.find(({ id }) => id === spec.id)!;
    for (const task of condition.tasks) {
      const stageIds = task.stages.map(({ stageId }) => stageId);
      if (
        stageIds.length !== spec.stages.length ||
        spec.stages.some(
          ({ id }) =>
            stageIds.filter((stageId) => stageId === id).length !== 1,
        )
      ) {
        throw new Error(
          `GENERATION_MATRIX_INCOMPLETE: '${condition.id}/${task.taskId}' does not contain every planned stage exactly once.`,
        );
      }
      const indeterminate = task.stages.find(
        ({ status }) => status === "invocation_running",
      );
      if (indeterminate) {
        throw new Error(
          `GENERATION_INVOCATION_INDETERMINATE: '${condition.id}/${task.taskId}/${indeterminate.stageId}' started but did not durably finish; automatic retry is forbidden.`,
        );
      }
    }
  }
}

function generationCommitment(state: CodeEvaluationState): string {
  return commitment({
    evaluationId: state.evaluationId,
    seed: state.seed,
    createdAt: state.createdAt,
    generationFrozenAt: state.generationFrozenAt,
    suiteHash: state.suiteHash,
    planHash: state.planHash,
    engines: state.engines,
    provenance: state.provenance,
    conditions: state.conditions,
  });
}

export function freezeCodeEvaluationState(
  state: CodeEvaluationState,
): CodeEvaluationState {
  assertStateIntegrity(state);
  assertGenerationComplete(state);
  if (
    state.engines.length !== 3 ||
    (["e4b", "gemma26b", "qwen"] as const).some(
      (slot) => !state.engines.some((engine) => engine.slot === slot),
    )
  ) {
    throw new Error(
      "GENERATION_ENGINE_MATRIX_INCOMPLETE: bind all three engine slots before freezing.",
    );
  }
  if (
    state.engines.some(
      ({ modelArtifactSha256, modelArtifactHashKind }) =>
        !modelArtifactSha256 || !modelArtifactHashKind,
    )
  ) {
    throw new Error(
      "GENERATION_MODEL_ARTIFACT_UNATTESTED: every publishable pilot engine requires a file or canonical shard-manifest hash.",
    );
  }
  const mismatchedControls = (
    [
      "adapter",
      "contextTokens",
      "timeoutMs",
      "maxResponseBytes",
      "structuredOutputMode",
      "reasoningMode",
      "temperature",
      "seed",
    ] as const
  ).filter((field) => !engineFieldIsUniform(state.engines, field));
  if (mismatchedControls.length > 0) {
    throw new Error(
      `GENERATION_COMPARISON_CONTROLS_MISMATCH: ${mismatchedControls.join(", ")} must be identical across engine slots.`,
    );
  }
  if (!state.provenance) {
    throw new Error(
      "GENERATION_PROVENANCE_UNATTESTED: publishable evaluation requires runtime and sandbox guest-bundle provenance.",
    );
  }
  validateCodeEvaluationProvenance(state.provenance);
  if (!state.generationHash) {
    state.planHash = finalPlanHash(
      state.planHash,
      state.engines,
      state.provenance,
    );
    state.generationFrozenAt = new Date().toISOString();
    state.generationHash = generationCommitment(state);
    state.updatedAt = state.generationFrozenAt;
  }
  return state;
}

export function createCodeEvaluationState(
  seed = DEFAULT_SEED,
): CodeEvaluationState {
  const tasks = generatePilotCodeSuite(seed);
  const suiteHash = codeEvaluationSuiteHash(tasks);
  const now = new Date().toISOString();
  return {
    apiVersion: STATE_API_VERSION,
    evaluationId: `code-evaluation-${randomUUID()}`,
    suiteId: SUITE_ID,
    suiteHash,
    planHash: planHash(suiteHash),
    seed,
    createdAt: now,
    updatedAt: now,
    engines: [],
    conditions: CODE_EVALUATION_CONDITIONS.map(({ id }) => ({
      id,
      tasks: tasks.map(({ id: taskId }) => ({ taskId, stages: [] })),
    })),
  };
}

function strictJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function invocationErrorCode(
  error: unknown,
): CodeGenerationRecord["errorCode"] {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CANDIDATE_SIZE_LIMIT")) {
    return "CANDIDATE_SIZE_LIMIT";
  }
  return "MODEL_INVOCATION_FAILED";
}

export async function runCodeGenerationStage(
  state: CodeEvaluationState,
  engine: ModelEngine,
  options: {
    conditionId: CodeConditionId;
    stageId: string;
    engineSlot: CodeEngineSlot;
    engineFingerprint: string;
    onProgress: (
      state: CodeEvaluationState,
    ) => Promise<void> | void;
  },
): Promise<CodeEvaluationState> {
  const tasks = assertStateIntegrity(state);
  if (state.generationHash) {
    throw new Error("Code-evaluation generation is frozen.");
  }
  const spec = conditionSpec(options.conditionId);
  const stageIndex = spec.stages.findIndex(({ id }) => id === options.stageId);
  const stage = spec.stages[stageIndex];
  if (!stage || stage.engineSlot !== options.engineSlot) {
    throw new Error(
      `Stage '${options.conditionId}/${options.stageId}' does not use engine slot '${options.engineSlot}'.`,
    );
  }
  const boundEngine = state.engines.find(
    ({ slot }) => slot === stage.engineSlot,
  );
  if (
    !boundEngine ||
    boundEngine.engineId !== engine.manifest.profileId ||
    boundEngine.adapter !== engine.manifest.adapter ||
    boundEngine.fingerprint !== options.engineFingerprint
  ) {
    throw new Error(
      `Engine slot '${stage.engineSlot}' is not bound to the supplied engine fingerprint.`,
    );
  }
  const condition = state.conditions.find(
    ({ id }) => id === options.conditionId,
  )!;
  for (const task of tasks) {
    const taskState = condition.tasks.find(({ taskId }) => taskId === task.id)!;
    if (taskState.stages.some(({ stageId }) => stageId === stage.id)) {
      continue;
    }
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const previousSpec =
      stageIndex > 0 ? spec.stages[stageIndex - 1] : undefined;
    const previous = previousSpec
      ? taskState.stages.find(
          ({ stageId }) => stageId === previousSpec.id,
        )
      : undefined;
    if (previousSpec && !previous?.candidate) {
      taskState.stages.push({
        stageId: stage.id,
        engineSlot: stage.engineSlot,
        role: stage.role,
        status: "failed",
        contract: "invalid",
        startedAt,
        finishedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        maxOutputTokens: stage.maxOutputTokens,
        errorCode: "UPSTREAM_CANDIDATE_UNAVAILABLE",
      });
      state.updatedAt = new Date().toISOString();
      await options.onProgress(structuredClone(state));
      continue;
    }
    const request = generationRequest(
      state,
      spec,
      task,
      stage,
      previous,
    );
    const requestHash = commitment(request);
    const record: CodeGenerationRecord = {
      stageId: stage.id,
      engineSlot: stage.engineSlot,
      engineId: engine.manifest.profileId,
      engineFingerprint: boundEngine.fingerprint,
      role: stage.role,
      status: "invocation_running",
      contract: "invalid",
      startedAt,
      maxOutputTokens: stage.maxOutputTokens,
      requestHash,
    };
    taskState.stages.push(record);
    state.updatedAt = new Date().toISOString();
    await options.onProgress(structuredClone(state));
    try {
      const inference = await engine.generate(request);
      const parsed = parseCodeCandidate(
        inference.text,
        task.editablePaths,
      );
      Object.assign(record, {
        status: parsed.candidate ? "candidate_available" : "failed",
        contract: parsed.candidate
          ? strictJson(inference.text)
            ? "strict"
            : "recovered"
          : "invalid",
        startedAt,
        finishedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        maxOutputTokens: stage.maxOutputTokens,
        finishReason: inference.finishReason,
        reportedModelId:
          inference.providerIdentity?.reportedModelId ?? null,
        reportedSystemFingerprint:
          inference.providerIdentity?.reportedSystemFingerprint ?? null,
        usage: structuredClone(inference.usage),
        rawOutputHash: parsed.rawOutputHash,
        ...(parsed.candidateHash
          ? { candidateHash: parsed.candidateHash }
          : {}),
        ...(parsed.candidate ? { candidate: parsed.candidate } : {}),
        ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      });
    } catch (error) {
      Object.assign(record, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        errorCode: invocationErrorCode(error),
      });
    }
    state.updatedAt = new Date().toISOString();
    await options.onProgress(structuredClone(state));
  }
  return state;
}

function candidate(content: string): CodeCandidate {
  return {
    apiVersion: "chartermesh.dev/code-candidate/v1alpha1",
    files: [{ path: "solution.mjs", content }],
    summary: "Evaluation fixture candidate.",
  };
}

interface PreflightJob {
  kind: "baseline" | "oracle" | "mutation";
  task: CodeEvaluationTask;
  mutationId?: string;
  job: CodeSandboxJob;
}

function preflightJobs(tasks: CodeEvaluationTask[]): PreflightJob[] {
  return tasks.flatMap((task) => {
    const baseline = task.baseFiles.find(
      ({ path }) => path === "solution.mjs",
    );
    if (!baseline) throw new Error(`Task '${task.id}' has no solution.`);
    const cases = [...task.publicCases, ...task.hiddenCases];
    return [
      {
        kind: "baseline" as const,
        task,
        job: {
          id: `preflight:${task.id}:baseline`,
          task,
          candidate: candidate(baseline.content),
          cases,
        },
      },
      {
        kind: "oracle" as const,
        task,
        job: {
          id: `preflight:${task.id}:oracle`,
          task,
          candidate: candidate(task.oracleContent),
          cases,
        },
      },
      ...task.mutations.map((mutation) => ({
        kind: "mutation" as const,
        task,
        mutationId: mutation.id,
        job: {
          id: `preflight:${task.id}:mutation:${mutation.id}`,
          task,
          candidate: candidate(mutation.content),
          cases,
        },
      })),
    ];
  });
}

function usageSum(records: CodeGenerationRecord[]): ModelUsage {
  const attempts = records.filter(
    ({ engineFingerprint }) => engineFingerprint !== undefined,
  );
  const sum = (
    field:
      | "inputTokens"
      | "outputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "cost",
  ): number | null =>
    attempts.length === 0 ||
    attempts.some(
      ({ usage }) => !usage || usage[field] === null,
    )
      ? null
      : attempts.reduce<number>(
          (total, { usage }) => total + (usage?.[field] ?? 0),
          0,
        );
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    cost: sum("cost"),
    measurementStatus:
      attempts.length > 0 &&
      attempts.every(
        ({ usage }) => usage?.measurementStatus === "measured",
      )
      ? "measured"
      : attempts.length > 0 &&
          attempts.every(
            ({ usage }) =>
              usage !== undefined &&
              usage.measurementStatus !== "unknown",
          )
        ? "estimated"
        : "unknown",
  };
}

function resultMap(
  definitions: Array<{ job: CodeSandboxJob }>,
  results: CodeSandboxRunResult[],
): Map<string, CodeSandboxRunResult> {
  const expected = new Map(
    definitions.map((definition) => [
      definition.job.id,
      definition.job,
    ]),
  );
  if (
    expected.size !== definitions.length ||
    definitions.length !== results.length
  ) {
    throw new Error(
      "CODE_SANDBOX_RESULT_MISMATCH: sandbox returned an incomplete or ambiguous result batch.",
    );
  }
  const mapped = new Map<string, CodeSandboxRunResult>();
  for (const result of results) {
    const job = expected.get(result.jobId);
    if (
      !job ||
      mapped.has(result.jobId) ||
      result.taskId !== job.task.id
    ) {
      throw new Error(
        "CODE_SANDBOX_RESULT_MISMATCH: sandbox result identity did not match its committed job.",
      );
    }
    mapped.set(result.jobId, result);
  }
  if (mapped.size !== expected.size) {
    throw new Error(
      "CODE_SANDBOX_RESULT_MISMATCH: sandbox omitted a committed job.",
    );
  }
  return mapped;
}

function assertSafeResults(
  definitions: Array<{ job: CodeSandboxJob }>,
  results: Map<string, CodeSandboxRunResult>,
): void {
  for (const { job } of definitions) {
    const result = results.get(job.id);
    const allowed = new Set(job.task.editablePaths);
    const expectedCaseIds = new Set(job.cases.map(({ id }) => id));
    const resultCaseIds = new Set(
      result?.cases.map(({ id }) => id) ?? [],
    );
    if (
      !result ||
      !Array.isArray(result.policyViolations) ||
      result.policyViolations.length > 0 ||
      result.survivorProcesses !== 0 ||
      !Number.isSafeInteger(result.outputBytes) ||
      result.outputBytes < 0 ||
      !Array.isArray(result.changedPaths) ||
      result.changedPaths.some((path) => !allowed.has(path)) ||
      expectedCaseIds.size !== job.cases.length ||
      resultCaseIds.size !== result.cases.length ||
      result.cases.length !== job.cases.length ||
      [...expectedCaseIds].some((id) => !resultCaseIds.has(id)) ||
      result.passed !== result.cases.every(({ passed }) => passed)
    ) {
      throw new Error(
        `CODE_EVALUATION_CONTAINMENT_FAILED: sandbox job '${job.id}' reported an unsafe or unverifiable execution boundary.`,
      );
    }
  }
}

export async function evaluateCodeGenerationState(
  state: CodeEvaluationState,
  backend: CodeSandboxBackend,
): Promise<CodeEvaluationReport> {
  const tasks = assertStateIntegrity(state);
  assertGenerationComplete(state);
  if (!state.generationHash || !state.generationFrozenAt) {
    throw new Error(
      "GENERATION_NOT_FROZEN: freeze the complete model matrix before running hidden tests.",
    );
  }
  const startedAt = new Date().toISOString();
  const sandbox = await requireSafeSandbox(backend);
  const preflightDefinitions = preflightJobs(tasks);
  const preflightResults = resultMap(
    preflightDefinitions,
    await runSandboxJobs(
      backend,
      preflightDefinitions.map(({ job }) => job),
    ),
  );
  assertSafeResults(preflightDefinitions, preflightResults);
  let oracleTasksPassed = 0;
  let baselineTasksExact = 0;
  let baselineDefectsDetected = 0;
  const baselineDefectsExpected = tasks.reduce(
    (total, task) =>
      total + task.baselineExpectedFailureCaseIds.length,
    0,
  );
  let mutationsKilled = 0;
  const mutationCount = tasks.reduce(
    (total, task) => total + task.mutations.length,
    0,
  );
  for (const definition of preflightDefinitions) {
    const result = preflightResults.get(definition.job.id)!;
    if (definition.kind === "oracle" && result.passed) {
      oracleTasksPassed += 1;
    } else if (definition.kind === "baseline") {
      const failed = new Set(
        result.cases
          .filter(({ passed }) => !passed)
          .map(({ id }) => id),
      );
      baselineDefectsDetected +=
        definition.task.baselineExpectedFailureCaseIds.filter((id) =>
          failed.has(id),
        ).length;
      const expected = new Set(
        definition.task.baselineExpectedFailureCaseIds,
      );
      if (
        failed.size === expected.size &&
        [...failed].every((id) => expected.has(id))
      ) {
        baselineTasksExact += 1;
      }
    } else if (definition.kind === "mutation") {
      const failures = result.cases.filter(({ passed }) => !passed);
      if (
        result.policyViolations.length === 0 &&
        failures.length > 0 &&
        failures.every(({ errorCode }) =>
          [
            "EXPECTED_OUTPUT_MISMATCH",
            "EXPECTED_ERROR_MISMATCH",
            "INPUT_MUTATED",
          ].includes(String(errorCode)),
        )
      ) {
        mutationsKilled += 1;
      }
    }
  }
  const mutationScore =
    mutationCount === 0 ? 0 : mutationsKilled / mutationCount;
  const preflightPassed =
    oracleTasksPassed === tasks.length &&
    baselineTasksExact === tasks.length &&
    baselineDefectsDetected === baselineDefectsExpected &&
    mutationScore >= 0.95 &&
    [...preflightResults.values()].every(
      ({ policyViolations }) => policyViolations.length === 0,
    );
  if (!preflightPassed) {
    throw new Error(
      "CODE_EVALUATION_PREFLIGHT_FAILED: oracle, baseline, mutation, or sandbox policy checks did not pass.",
    );
  }

  const generatedDefinitions: Array<{
    condition: CodeConditionState;
    task: CodeEvaluationTask;
    record: CodeGenerationRecord;
    job: CodeSandboxJob;
  }> = [];
  for (const condition of state.conditions) {
    for (const taskState of condition.tasks) {
      const task = tasks.find(({ id }) => id === taskState.taskId)!;
      for (const record of taskState.stages) {
        if (!record.candidate) continue;
        generatedDefinitions.push({
          condition,
          task,
          record,
          job: {
            id: `generated:${condition.id}:${task.id}:${record.stageId}`,
            task,
            candidate: record.candidate,
            cases: [...task.publicCases, ...task.hiddenCases],
          },
        });
      }
    }
  }
  const generatedResultList: CodeSandboxRunResult[] = [];
  for (const definition of generatedDefinitions) {
    const [result] = await runSandboxJobs(backend, [
      definition.job,
    ]);
    if (!result) {
      throw new Error(
        `Sandbox omitted generated job '${definition.job.id}'.`,
      );
    }
    const singleton = resultMap([definition], [result]);
    assertSafeResults([definition], singleton);
    generatedResultList.push(result);
  }
  const generatedResults = resultMap(
    generatedDefinitions,
    generatedResultList,
  );
  assertSafeResults(generatedDefinitions, generatedResults);
  const conditions: CodeConditionEvaluation[] =
    CODE_EVALUATION_CONDITIONS.map((spec) => {
      const condition = state.conditions.find(({ id }) => id === spec.id)!;
      const taskEvaluations = condition.tasks.map((taskState) => {
        const task = tasks.find(({ id }) => id === taskState.taskId)!;
        const stages = spec.stages.map((stageSpec) => {
          const record = taskState.stages.find(
            ({ stageId }) => stageId === stageSpec.id,
          );
          const definition = generatedDefinitions.find(
            (item) =>
              item.condition.id === condition.id &&
              item.task.id === task.id &&
              item.record.stageId === stageSpec.id,
          );
          const result = definition
            ? generatedResults.get(definition.job.id)
            : undefined;
          const publicIds = new Set(
            task.publicCases.map(({ id }) => id),
          );
          const publicPassed =
            result?.cases.filter(
              ({ id, passed }) => passed && publicIds.has(id),
            ).length ?? 0;
          const hiddenPassed =
            result?.cases.filter(
              ({ id, passed }) => passed && !publicIds.has(id),
            ).length ?? 0;
          return {
            stageId: stageSpec.id,
            generated: Boolean(record?.candidate),
            contract: record?.contract ?? "missing",
            passed: Boolean(result?.passed),
            passedCases:
              result?.cases.filter(({ passed }) => passed).length ?? 0,
            totalCases:
              task.publicCases.length + task.hiddenCases.length,
            publicPassed,
            publicTotal: task.publicCases.length,
            hiddenPassed,
            hiddenTotal: task.hiddenCases.length,
            policyViolations: result?.policyViolations ?? [],
            audit: {
              generationStatus: record?.status ?? "missing",
              engineId: record?.engineId ?? null,
              engineFingerprint: record?.engineFingerprint ?? null,
              requestHash: record?.requestHash ?? null,
              candidateHash: record?.candidateHash ?? null,
              rawOutputHash: record?.rawOutputHash ?? null,
              finishReason: record?.finishReason ?? null,
              reportedModelId: record?.reportedModelId ?? null,
              reportedSystemFingerprint:
                record?.reportedSystemFingerprint ?? null,
              usage: record?.usage
                ? structuredClone(record.usage)
                : null,
              startedAt: record?.startedAt ?? null,
              finishedAt: record?.finishedAt ?? null,
              clientObservedGenerationLatencyMs:
                record?.latencyMs ?? null,
              resultHash: result ? commitment(result) : null,
            },
          } satisfies CodeStageEvaluation;
        });
        const final = stages.at(-1)!;
        return {
          taskId: task.id,
          publicTaskHash: commitment(projectPublicCodeTask(task)),
          passed: final.contract === "strict" && final.passed,
          stages,
        } satisfies CodeTaskEvaluation;
      });
      const records = condition.tasks.flatMap(({ stages }) => stages);
      const tasksPassed = taskEvaluations.filter(
        ({ passed }) => passed,
      ).length;
      const invocationAttempts = records.filter(
        ({ engineFingerprint }) => engineFingerprint !== undefined,
      ).length;
      const modelResponses = records.filter(
        ({ rawOutputHash }) => rawOutputHash !== undefined,
      ).length;
      const strictModelOutputs = records.filter(
        ({ contract }) => contract === "strict",
      ).length;
      const usageRecords = records.filter(
        ({ engineFingerprint }) => engineFingerprint !== undefined,
      );
      const completeUsageRecords = usageRecords.filter(
        ({ usage }) =>
          usage !== undefined &&
          usage.inputTokens !== null &&
          usage.outputTokens !== null,
      );
      const usageCoverage =
        invocationAttempts === 0
          ? 0
          : completeUsageRecords.length / invocationAttempts;
      const observedOutputWithinRequestedCeiling =
        usageCoverage !== 1
          ? null
          : condition.tasks.every(
              ({ stages }) =>
                stages.reduce(
                  (total, { usage }) =>
                    total + (usage?.outputTokens ?? 0),
                  0,
                ) <= spec.maxRequestedOutputTokensPerTask,
            );
      return {
        id: spec.id,
        label: spec.label,
        engineIds: [
          ...new Set(
            records.flatMap(({ engineId }) =>
              engineId ? [engineId] : [],
            ),
          ),
        ],
        clientObservedGenerationLatencyMs: records.reduce(
          (total, { latencyMs }) => total + (latencyMs ?? 0),
          0,
        ),
        plannedStageSlots: tasks.length * spec.stages.length,
        skippedUpstreamStages: records.filter(
          ({ errorCode }) =>
            errorCode === "UPSTREAM_CANDIDATE_UNAVAILABLE",
        ).length,
        completedFinals: taskEvaluations.filter(
          ({ stages }) =>
            stages.at(-1)?.audit.generationStatus ===
            "candidate_available",
        ).length,
        tasksPassed,
        taskCount: tasks.length,
        passRate: tasksPassed / tasks.length,
        finalStrictContracts: taskEvaluations.filter(
          ({ stages }) => stages.at(-1)?.contract === "strict",
        ).length,
        invocationAttempts,
        modelResponses,
        modelResponseRate:
          invocationAttempts === 0
            ? 0
            : modelResponses / invocationAttempts,
        strictModelOutputs,
        structuredOutputRate:
          invocationAttempts === 0
            ? 0
            : strictModelOutputs / invocationAttempts,
        recoveredModelOutputs: records.filter(
          ({ contract }) => contract === "recovered",
        ).length,
        usageCoverage,
        observedOutputWithinRequestedCeiling,
        observedUsage: usageSum(records),
        tasks: taskEvaluations,
      };
    });
  const invocationAttempts = conditions.reduce(
    (total, condition) => total + condition.invocationAttempts,
    0,
  );
  const modelResponses = conditions.reduce(
    (total, condition) => total + condition.modelResponses,
    0,
  );
  const strictModelOutputs = conditions.reduce(
    (total, condition) => total + condition.strictModelOutputs,
    0,
  );
  return {
    apiVersion: REPORT_API_VERSION,
    evaluationId: state.evaluationId,
    suiteId: SUITE_ID,
    suiteHash: state.suiteHash,
    planHash: state.planHash,
    generationHash: state.generationHash,
    generationFrozenAt: state.generationFrozenAt,
    engines: structuredClone(state.engines),
    provenance: structuredClone(state.provenance!),
    seed: state.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox,
    scope: {
      kind: "public-development-pilot",
      developmentSuitePublic: true,
      taskCount: tasks.length,
      repositoryCount: new Set(
        tasks.map(({ repositoryId }) => repositoryId),
      ).size,
      taskFamilyCount: new Set(tasks.map(({ family }) => family)).size,
      trialsPerCondition: 1,
      statisticalInference: false,
      tieredExecution: "serial-review-routing",
      agentDelegationExercised: false,
      limitations: [
        "Results apply only to this public six-task development suite and exact engine configuration fingerprints.",
        "The tiered condition is serial review routing, not Control Plane child-agent delegation.",
        "Provider-reported model and system identity fields are captured when available but remain provider-attested; configured artifacts are operator-hash bound.",
        "Cold model load, total compute, and hardware utilization are outside client-observed generation latency.",
        "The tiered route has no same-model three-stage control, so any gain cannot be attributed specifically to model diversity.",
        "Equal requested output-token ceilings do not imply equal compute, input tokens, tokenizer units, calls, or final-stage output capacity.",
        "Zero unapproved external effects is a verified containment result, not evidence that a model avoided forbidden attempts.",
      ],
    },
    comparisonControls: {
      artifactHashesRequired: true,
      adapter: state.engines[0]!.adapter,
      contextTokens: state.engines[0]!.contextTokens,
      timeoutMs: state.engines[0]!.timeoutMs,
      maxResponseBytes: state.engines[0]!.maxResponseBytes,
      structuredOutputMode:
        state.engines[0]!.structuredOutputMode,
      reasoningMode: state.engines[0]!.reasoningMode,
      temperature: state.engines[0]!.temperature,
      samplingSeed: state.engines[0]!.seed,
      serverBuilds: [
        ...new Set(state.engines.map(({ serverBuild }) => serverBuild)),
      ].sort(),
      providerResponseIdentityCaptured: state.conditions.every(
        ({ tasks: conditionTasks }) =>
          conditionTasks.every(({ stages }) =>
            stages.every(
              ({ engineFingerprint, rawOutputHash, reportedModelId }) =>
                engineFingerprint === undefined ||
                rawOutputHash === undefined ||
                reportedModelId !== undefined,
            ),
          ),
      ),
    },
    budget: {
      mode: "requested-output-ceiling-matched",
      maxRequestedOutputTokensPerTask: 6_144,
      singleCallsPerTask: 1,
      tieredCallsPerTask: 3,
      hiddenFeedbackToModels: false,
      retriesPerStage: 0,
      interstageCanonicalization: true,
      intermediateRecoveredCandidatesMayAdvance: true,
      finalRecoveredCandidateFails: true,
      tokenUsageSource: "provider-reported-or-unknown",
      ceilingEnforcement: "requested-not-locally-tokenized",
      note:
        "Every condition receives the same requested output-token ceiling. Tiered review necessarily consumes more input tokens; intermediate candidates are canonically normalized before review, and both effects are reported separately.",
    },
    preflight: {
      passed: preflightPassed,
      oracleTasksPassed,
      baselineTasksExact,
      baselineTaskCount: tasks.length,
      baselineDefectsDetected,
      baselineDefectsExpected,
      mutationsKilled,
      mutationCount,
      mutationScore,
    },
    conditions,
    aggregate: {
      invocationAttempts,
      modelResponses,
      modelResponseRate:
        invocationAttempts === 0
          ? 0
          : modelResponses / invocationAttempts,
      strictModelOutputs,
      structuredOutputRate:
        invocationAttempts === 0
          ? 0
          : strictModelOutputs / invocationAttempts,
      unapprovedExternalSideEffects: 0,
      unapprovedExternalSideEffectsBasis:
        "verified-vm-containment-not-model-restraint",
      policyViolations: [],
    },
  };
}
