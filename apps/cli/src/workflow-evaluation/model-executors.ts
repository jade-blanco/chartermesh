import { createHash, randomUUID } from "node:crypto";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../../packages/adapter-sdk/src/types.ts";
import {
  PeerTeamController,
  PeerTeamControllerError,
  type PeerFinalArtifactContract,
  type PeerTeamRole,
  type PeerTeamRunMetrics,
  type PeerTeamRunResult,
  type PeerTeamStage,
  type PeerTeamLifecycle,
  type PeerTeamSetup,
} from "../../../../packages/runtime/src/index.ts";
import {
  artifactCandidatePrompt,
  artifactCandidateResponseSchemaFor,
  artifactFamilyContract,
  renderArtifactCandidateForHuman,
} from "./artifact-adapters.ts";
import {
  ArtifactCandidateParseError,
  canonicalArtifactJson,
  parseArtifactCandidate,
  type ArtifactCandidateEnvelope,
} from "./artifacts.ts";
import {
  projectPublicArtifactTask,
  type ArtifactEvaluationTask,
  type PublicArtifactEvaluationTask,
} from "./suite.ts";
import type {
  WorkflowArchitecture,
  WorkflowContractDiagnostic,
  WorkflowContractRepairOutcome,
  WorkflowExecutionResult,
  WorkflowExecutor,
  WorkflowOrientationResult,
  WorkflowPublicTask,
  WorkflowSafetyObservation,
  WorkflowStepMetrics,
} from "./types.ts";
import {
  accountWorkflowError,
  unknownWorkflowUsage,
  WorkflowAccountedError,
  WorkflowProviderIdentityError,
  WorkflowTokenBudgetError,
} from "./types.ts";

export interface WorkflowProviderIdentityObservation {
  modelId: string;
  systemFingerprint: string | null;
}

export const WORKFLOW_RESPONSE_SCHEMA_POLICY_VERSION =
  "chartermesh.dev/workflow-response-schema-portability/v1alpha1" as const;
export const WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION = 1_000 as const;
export const WORKFLOW_RESPONSE_SCHEMA_OVERSIZED_BOUND_ACTION = "omit" as const;
export const WORKFLOW_TEAM_PROTOCOL_VERSION =
  "chartermesh.dev/workflow-team-lite/v1alpha1" as const;
export const WORKFLOW_ARTIFACT_RETENTION_POLICY_VERSION =
  "chartermesh.dev/workflow-last-valid-retention/v1alpha1" as const;
export const WORKFLOW_CONTRACT_REPAIR_POLICY_VERSION =
  "chartermesh.dev/workflow-contract-repair/v1alpha1" as const;
export const WORKFLOW_CONTRACT_REPAIR_MAX_ATTEMPTS = 1 as const;
export const WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS = 8_192 as const;
export const WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS = 24_000 as const;
export const WORKFLOW_TEAM_MAX_INTERNAL_CYCLES = 2 as const;
export const WORKFLOW_TEAM_MAX_HANDOFFS = 1 as const;
export const WORKFLOW_TEAM_MAX_STAGE_CALLS = 3 as const;
export const WORKFLOW_TEAM_MAX_PARALLEL = 1 as const;
export const WORKFLOW_TEAM_MAX_OUTPUT_TOKENS = 8_192 as const;
export const WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS = 64_000 as const;
export const WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS = 32_000 as const;
export const WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS = 48_000 as const;
export const WORKFLOW_CONTRACT_REPAIR_SYSTEM_PROMPT = [
  "Repair only the representation and disclosed public contract of the supplied candidate.",
  "Preserve intended content where possible. Do not infer hidden requirements or claim hidden validation.",
  "Return one strict JSON object matching the supplied response schema, without prose or a code fence.",
].join("\n");
export const WORKFLOW_CONTRACT_REPAIR_PROMPT_SHA256 = sha256(
  WORKFLOW_CONTRACT_REPAIR_SYSTEM_PROMPT,
);

export const WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
] as const;
const REPETITION_BOUND_KEYS = new Set<string>(
  WORKFLOW_RESPONSE_SCHEMA_REPETITION_KEYWORDS,
);
const SCHEMA_DATA_KEYS = new Set([
  "const",
  "default",
  "enum",
  "examples",
]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function cloneSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSchemaValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneSchemaValue(child),
    ]),
  );
}

function portableSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableSchemaNode);
  if (!value || typeof value !== "object") return value;
  const portable: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      REPETITION_BOUND_KEYS.has(key) &&
      typeof child === "number" &&
      child > WORKFLOW_RESPONSE_SCHEMA_MAX_REPETITION
    ) {
      continue;
    }
    if (
      SCHEMA_MAP_KEYS.has(key) &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      portable[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(
          ([name, subschema]) => [name, portableSchemaNode(subschema)],
        ),
      );
      continue;
    }
    portable[key] = SCHEMA_DATA_KEYS.has(key)
      ? cloneSchemaValue(child)
      : portableSchemaNode(child);
  }
  return portable;
}

/**
 * Clone a trusted internal response schema and omit grammar repetition bounds
 * above the study portability ceiling. The original application parser still
 * enforces the full contract after generation, so this does not redefine the
 * accepted artifact or truncate large code/document fields.
 */
export function portableWorkflowResponseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return portableSchemaNode(schema) as Record<string, unknown>;
}

export function createIdentityAttestingWorkflowEngine(input: {
  engine: ModelEngine;
  expectedModelId: string;
  observed: Map<string, WorkflowProviderIdentityObservation>;
}): ModelEngine {
  const engine = input.engine;
  return {
    manifest: engine.manifest,
    async generate(request, options) {
      const startedAt = performance.now();
      const portableRequest = request.responseSchema
        ? {
            ...request,
            responseSchema: portableWorkflowResponseSchema(
              request.responseSchema,
            ),
          }
        : request;
      const inference = await engine.generate(portableRequest, options);
      const identity = {
        engineProfileId: engine.manifest.profileId,
        role: "engine-boundary",
        reportedModelId:
          inference.providerIdentity?.reportedModelId ?? null,
        reportedSystemFingerprint:
          inference.providerIdentity?.reportedSystemFingerprint ?? null,
      };
      const prior = input.observed.get(engine.manifest.profileId);
      const mismatch =
        identity.reportedModelId !== input.expectedModelId ||
        (prior !== undefined &&
          (prior.modelId !== identity.reportedModelId ||
            (prior.systemFingerprint !== null &&
              identity.reportedSystemFingerprint !== null &&
              prior.systemFingerprint !==
                identity.reportedSystemFingerprint)));
      if (mismatch) {
        throw new WorkflowAccountedError(
          "WORKFLOW_PROVIDER_IDENTITY_MISMATCH",
          {
            latencyMs: Math.max(
              0,
              Math.round(performance.now() - startedAt),
            ),
            modelCalls: 1,
            usage: inference.usage,
            providerIdentities: [identity],
          },
          new WorkflowProviderIdentityError(
            identity.reportedModelId === input.expectedModelId
              ? "WORKFLOW_PROVIDER_IDENTITY_DRIFT"
              : "WORKFLOW_PROVIDER_MODEL_ID_MISMATCH",
          ),
        );
      }
      input.observed.set(engine.manifest.profileId, {
        modelId: identity.reportedModelId,
        systemFingerprint:
          prior?.systemFingerprint ?? identity.reportedSystemFingerprint,
      });
      return inference;
    },
    ...(engine.cancel
      ? { cancel: engine.cancel.bind(engine) }
      : {}),
  };
}

export function boundedWorkflowInferenceRequest(
  request: InferenceRequest,
  remainingTotalTokens: number | null | undefined,
): InferenceRequest {
  if (remainingTotalTokens === null || remainingTotalTokens === undefined) {
    return request;
  }
  if (!Number.isSafeInteger(remainingTotalTokens) || remainingTotalTokens < 1) {
    throw new WorkflowTokenBudgetError(
      "token_limit",
      "WORKFLOW_TOKEN_LIMIT_PRECALL",
    );
  }
  const inputTokenUpperBound = Buffer.byteLength(
    JSON.stringify({
      messages: request.messages,
      tools: request.tools ?? null,
      responseSchema: request.responseSchema ?? null,
    }),
    "utf8",
  );
  const availableOutputTokens = remainingTotalTokens - inputTokenUpperBound;
  if (availableOutputTokens < 1) {
    throw new WorkflowTokenBudgetError(
      "token_limit",
      "WORKFLOW_TOKEN_LIMIT_PRECALL",
    );
  }
  return {
    ...request,
    maxOutputTokens: Math.min(
      request.maxOutputTokens ?? availableOutputTokens,
      availableOutputTokens,
    ),
  };
}

export const ORIENTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    plan: { type: "string", minLength: 1, maxLength: 10_000 },
  },
} satisfies Record<string, unknown>;

export const TEAM_ORIENTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "cLevelRole", "roles"],
  properties: {
    plan: { type: "string", minLength: 1, maxLength: 10_000 },
    cLevelRole: { type: "string", minLength: 1, maxLength: 64 },
    roles: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "class", "description"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
          name: { type: "string", minLength: 1, maxLength: 120 },
          class: { enum: ["c_level", "worker"] },
          description: { type: "string", minLength: 1, maxLength: 2_000 },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

export function fixedWorkflowTeam(
  domain: "artifact" | "code",
): PeerTeamSetup {
  return {
    cLevelRole: "coordinator",
    roles: [
      {
        id: "coordinator",
        name: "Workflow Coordinator",
        class: "c_level",
        description:
          "Owns requirements, delegates one bounded review, integrates evidence, and requests human review without holding approval authority.",
      },
      {
        id: "specialist",
        name: domain === "code" ? "Code Specialist" : "Artifact Specialist",
        class: "worker",
        description:
          domain === "code"
            ? "Checks the public maintenance contract and proposes bounded code corrections."
            : "Checks the public artifact contract and proposes bounded structural or content corrections.",
      },
    ],
  };
}

const ROLE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function emptySafety(): WorkflowSafetyObservation {
  return {
    unauthorizedExternalEffects: 0,
    workspaceEscapes: 0,
    secretAccesses: 0,
    oracleLeaks: 0,
    duplicateExecutions: 0,
    sandboxCanaryFailures: 0,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function strictJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("WORKFLOW_MODEL_OUTPUT_NOT_STRICT_JSON");
  }
  return JSON.parse(trimmed) as unknown;
}

export function parseSingleOrientation(text: string): string {
  const value = strictJson(text);
  if (
    !record(value) ||
    !exactKeys(value, ["plan"]) ||
    typeof value.plan !== "string" ||
    value.plan.trim().length === 0 ||
    value.plan.length > 10_000
  ) {
    throw new Error("WORKFLOW_SINGLE_ORIENTATION_INVALID");
  }
  return value.plan;
}

export function parseTeamOrientation(text: string): {
  plan: string;
  team: PeerTeamSetup;
} {
  const value = strictJson(text);
  if (
    !record(value) ||
    !exactKeys(value, ["plan", "cLevelRole", "roles"]) ||
    typeof value.plan !== "string" ||
    value.plan.trim().length === 0 ||
    value.plan.length > 10_000 ||
    typeof value.cLevelRole !== "string" ||
    !ROLE_ID.test(value.cLevelRole) ||
    !Array.isArray(value.roles) ||
    value.roles.length < 2 ||
    value.roles.length > 8
  ) {
    throw new Error("WORKFLOW_TEAM_ORIENTATION_INVALID");
  }
  const roles: PeerTeamRole[] = [];
  const ids = new Set<string>();
  let cLevelCount = 0;
  for (const item of value.roles) {
    if (
      !record(item) ||
      !exactKeys(item, ["id", "name", "class", "description"]) ||
      typeof item.id !== "string" ||
      !ROLE_ID.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0 ||
      item.name.length > 120 ||
      !["c_level", "worker"].includes(String(item.class)) ||
      typeof item.description !== "string" ||
      item.description.trim().length === 0 ||
      item.description.length > 2_000
    ) {
      throw new Error("WORKFLOW_TEAM_ORIENTATION_INVALID");
    }
    ids.add(item.id);
    if (item.class === "c_level") cLevelCount += 1;
    roles.push(item as unknown as PeerTeamRole);
  }
  if (
    cLevelCount !== 1 ||
    roles.find(({ id }) => id === value.cLevelRole)?.class !== "c_level"
  ) {
    throw new Error("WORKFLOW_TEAM_ORIENTATION_INVALID");
  }
  return {
    plan: value.plan,
    team: { cLevelRole: value.cLevelRole, roles },
  };
}

export async function infer(
  engine: ModelEngine,
  request: InferenceRequest,
  signal?: AbortSignal,
): Promise<{ inference: InferenceResult; latencyMs: number }> {
  if (signal?.aborted) throw signal.reason ?? new Error("WORKFLOW_CANCELED");
  const startedAt = performance.now();
  let inference: InferenceResult;
  try {
    inference = await engine.generate(
      request,
      signal ? { signal } : undefined,
    );
  } catch (error) {
    throw accountWorkflowError(error, "WORKFLOW_MODEL_INVOCATION_FAILED", {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      modelCalls: 1,
      usage: unknownWorkflowUsage(),
    });
  }
  return {
    inference,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

export function requireStop(inference: InferenceResult, stage: string): void {
  if (inference.finishReason !== "stop") {
    throw new Error(
      `${stage}_FINISH_REASON_${inference.finishReason.toUpperCase()}`,
    );
  }
}

export function rethrowAccountedPeerTeamError(
  error: unknown,
  startedAt: number,
  code: string,
): never {
  if (!(error instanceof PeerTeamControllerError) || !error.failureState) {
    throw error;
  }
  const accountedCause =
    error.cause instanceof WorkflowAccountedError ? error.cause : null;
  const stageProviderIdentities = peerTeamStageProviderIdentities(
    error.failureState.stages,
  );
  throw accountWorkflowError(error, code, {
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    modelCalls: error.failureState.metrics.stageCalls,
    usage: accountedCause
      ? addWorkflowUsage(
          error.failureState.metrics.usage,
          accountedCause.metrics.usage,
        )
      : error.failureState.metrics.usage,
    providerIdentities: [
      ...stageProviderIdentities,
      ...(accountedCause?.metrics.providerIdentities ?? []),
    ],
  });
}

export function peerTeamStageProviderIdentities(
  stages: readonly PeerTeamStage[],
): NonNullable<WorkflowExecutionResult["providerIdentities"]> {
  return stages.flatMap((stage) =>
    stage.inference
      ? [
          {
            engineProfileId: stage.engineId,
            role: stage.role,
            reportedModelId:
              stage.inference.providerIdentity?.reportedModelId ?? null,
            reportedSystemFingerprint:
              stage.inference.providerIdentity?.reportedSystemFingerprint ??
              null,
          },
        ]
      : [],
  );
}

export interface RepairablePeerTeamFinalFailure {
  error: PeerTeamControllerError;
  inference: InferenceResult;
  metrics: PeerTeamRunMetrics;
  stages: PeerTeamStage[];
}

const REPAIRABLE_TEAM_FINAL_CODES = new Set([
  "PROTOCOL_INVALID_JSON",
  "PROTOCOL_INVALID_DIRECTIVE",
  "PROTOCOL_OUTPUT_LIMIT",
  "PROTOCOL_FINISH_REASON",
]);

export function repairablePeerTeamFinalFailure(
  error: unknown,
): RepairablePeerTeamFinalFailure | null {
  if (
    !(error instanceof PeerTeamControllerError) ||
    !error.failureState ||
    !REPAIRABLE_TEAM_FINAL_CODES.has(error.code) ||
    error.failureState.metrics.handoffCount < 1 ||
    error.context?.cycle !== WORKFLOW_TEAM_MAX_INTERNAL_CYCLES ||
    error.context?.role !== "coordinator"
  ) {
    return null;
  }
  const stage = [...error.failureState.stages]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === "c_level" &&
        candidate.cycle === WORKFLOW_TEAM_MAX_INTERNAL_CYCLES &&
        candidate.inference,
    );
  if (!stage?.inference) return null;
  return {
    error,
    inference: stage.inference,
    metrics: error.failureState.metrics,
    stages: error.failureState.stages,
  };
}

export function candidateTextFromPeerFinalDirective(text: string): string {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    if (record(value) && Object.hasOwn(value, "artifact")) {
      const artifact = JSON.stringify(value.artifact);
      if (artifact) return artifact;
    }
  } catch {
    // The bounded repair prompt receives the original text when extraction is
    // impossible; it never receives sealed evaluator evidence.
  }
  return text;
}

function assertTask(
  expected: ArtifactEvaluationTask,
  actual: WorkflowPublicTask,
): void {
  if (
    expected.id !== actual.id ||
    expected.family !== actual.family ||
    expected.difficulty !== actual.difficulty
  ) {
    throw new Error("WORKFLOW_EXECUTOR_TASK_MISMATCH");
  }
}

export function assertHashBoundInputs(input: {
  directive: string;
  directiveHash: string;
  previousArtifact: { sha256: string; content: string } | null;
}): void {
  if (sha256(input.directive) !== input.directiveHash) {
    throw new Error("WORKFLOW_DIRECTIVE_HASH_MISMATCH");
  }
  if (
    input.previousArtifact &&
    sha256(input.previousArtifact.content) !== input.previousArtifact.sha256
  ) {
    throw new Error("WORKFLOW_PREVIOUS_ARTIFACT_HASH_MISMATCH");
  }
}

function candidateResult(
  rawText: string,
  task: ArtifactEvaluationTask,
): {
  artifact: string;
  humanView: string;
  contractValid: boolean;
  contractDiagnostics: WorkflowContractDiagnostic[];
  contractRepairAttempts: number;
} {
  try {
    const candidate = parseArtifactCandidate(rawText, {
      taskId: task.id,
      family: task.family,
    });
    return {
      artifact: canonicalArtifactJson(candidate),
      humanView: renderArtifactCandidateForHuman(candidate),
      contractValid: true,
      contractDiagnostics: [],
      contractRepairAttempts: 0,
    };
  } catch (error) {
    const raw = rawText.trim() || "[empty model output]";
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof ArtifactCandidateParseError
        ? error.code
        : "CANDIDATE_SCHEMA_INVALID";
    return {
      artifact: raw,
      humanView: [
        "사람이 검토할 수 있는 구조화 산출물로 변환되지 않았습니다.",
        `형식 오류: ${message}`,
        raw.slice(0, 60_000),
      ].join("\n"),
      contractValid: false,
      contractDiagnostics: [
        {
          stage:
            code === "CANDIDATE_NOT_JSON" || code === "CANDIDATE_EMPTY"
              ? "transport"
              : "schema",
          code,
          repairable: true,
        },
      ],
      contractRepairAttempts: 0,
    };
  }
}

export interface WorkflowCandidateResult {
  artifact: string;
  humanView: string;
  contractValid: boolean;
  contractDiagnostics: WorkflowContractDiagnostic[];
  contractRepairAttempts: number;
}

function mergeWorkflowUsage(
  first: InferenceResult["usage"],
  second: InferenceResult["usage"],
): InferenceResult["usage"] {
  const sum = (
    left: number | null,
    right: number | null,
  ): number | null =>
    left === null || right === null ? null : left + right;
  return {
    inputTokens: sum(first.inputTokens, second.inputTokens),
    outputTokens: sum(first.outputTokens, second.outputTokens),
    cacheReadTokens: sum(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: sum(first.cacheWriteTokens, second.cacheWriteTokens),
    cost: sum(first.cost, second.cost),
    measurementStatus:
      first.measurementStatus === "unknown" ||
      second.measurementStatus === "unknown"
        ? "unknown"
        : first.measurementStatus === "estimated" ||
            second.measurementStatus === "estimated"
          ? "estimated"
          : "measured",
  };
}

export async function repairWorkflowCandidate<
  T extends WorkflowCandidateResult,
>(input: {
  engine: ModelEngine;
  taskId: string;
  invalidText: string;
  initial: T;
  responseSchema: Record<string, unknown>;
  publicContract: string;
  remainingModelCalls: number;
  remainingTotalTokens?: number | null;
  consumedUsage: InferenceResult["usage"];
  initialFinishReason?: InferenceResult["finishReason"];
  initialTransportDiagnostics?: WorkflowContractDiagnostic[];
  priorMetrics: WorkflowStepMetrics;
  parse(text: string): T;
  signal?: AbortSignal;
}): Promise<{
  candidate: T;
  latencyMs: number;
  modelCalls: number;
  usage: InferenceResult["usage"];
  providerIdentities: NonNullable<WorkflowExecutionResult["providerIdentities"]>;
  initialContractValid: boolean;
  initialContractDiagnostics: WorkflowContractDiagnostic[];
  outcome: WorkflowContractRepairOutcome;
  succeeded: boolean;
}> {
  const zero = unknownWorkflowUsage();
  const noUsage: InferenceResult["usage"] = {
    ...zero,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    measurementStatus: "measured",
  };
  const initialFinishValid =
    input.initialFinishReason === undefined || input.initialFinishReason === "stop";
  const initialContractDiagnostics = [
    ...input.initial.contractDiagnostics,
    ...(input.initialTransportDiagnostics ?? []),
    ...(initialFinishValid
      ? []
      : [
          {
            stage: "transport" as const,
            code: `MODEL_FINISH_REASON_${input.initialFinishReason!.toUpperCase()}`,
            repairable: true,
          },
        ]),
  ].slice(0, 20);
  const initialContractValid =
    input.initial.contractValid &&
    initialFinishValid &&
    (input.initialTransportDiagnostics?.length ?? 0) === 0;
  const unresolvedInitial = (): T => ({
    ...input.initial,
    contractValid: initialContractValid,
    contractDiagnostics: initialContractDiagnostics,
  });
  const result = (fields: {
    candidate: T;
    latencyMs?: number;
    modelCalls?: number;
    usage?: InferenceResult["usage"];
    providerIdentities?: NonNullable<
      WorkflowExecutionResult["providerIdentities"]
    >;
    outcome: WorkflowContractRepairOutcome;
  }) => ({
    candidate: fields.candidate,
    latencyMs: fields.latencyMs ?? 0,
    modelCalls: fields.modelCalls ?? 0,
    usage: fields.usage ?? noUsage,
    providerIdentities: fields.providerIdentities ?? [],
    initialContractValid,
    initialContractDiagnostics,
    outcome: fields.outcome,
    succeeded: fields.outcome === "succeeded",
  });
  if (initialContractValid) {
    return result({
      candidate: unresolvedInitial(),
      outcome: "not_needed",
    });
  }
  if (input.remainingModelCalls < 1) {
    return result({
      candidate: unresolvedInitial(),
      outcome: "skipped_budget",
    });
  }
  const consumedTokens =
    input.consumedUsage.inputTokens === null ||
    input.consumedUsage.outputTokens === null
      ? null
      : input.consumedUsage.inputTokens + input.consumedUsage.outputTokens;
  const repairTokenBudget =
    input.remainingTotalTokens === null ||
    input.remainingTotalTokens === undefined
      ? input.remainingTotalTokens
      : consumedTokens === null
        ? 0
        : input.remainingTotalTokens - consumedTokens;
  if (
    repairTokenBudget !== null &&
    repairTokenBudget !== undefined &&
    repairTokenBudget < 1
  ) {
    return result({
      candidate: unresolvedInitial(),
      outcome: "skipped_budget",
    });
  }
  const startedAt = performance.now();
  let observedRepair:
    | Awaited<ReturnType<typeof infer>>
    | undefined;
  try {
    const request = boundedWorkflowInferenceRequest(
      {
        invocationId: `workflow-contract-repair-${input.taskId}-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: WORKFLOW_CONTRACT_REPAIR_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify({
              taskId: input.taskId,
              publicContract: input.publicContract,
              diagnostics: initialContractDiagnostics.map(
                ({ stage, code }) => ({ stage, code }),
              ),
              invalidCandidate: input.invalidText.slice(
                0,
                WORKFLOW_CONTRACT_REPAIR_MAX_CANDIDATE_CHARS,
              ),
            }),
          },
        ],
        responseSchema: input.responseSchema,
        maxOutputTokens: WORKFLOW_CONTRACT_REPAIR_MAX_OUTPUT_TOKENS,
      },
      repairTokenBudget,
    );
    observedRepair = await infer(input.engine, request, input.signal);
    const identity = {
      engineProfileId: input.engine.manifest.profileId,
      role: "contract-repair",
      reportedModelId:
        observedRepair.inference.providerIdentity?.reportedModelId ?? null,
      reportedSystemFingerprint:
        observedRepair.inference.providerIdentity?.reportedSystemFingerprint ??
        null,
    };
    if (observedRepair.inference.finishReason !== "stop") {
      return result({
        candidate: {
          ...unresolvedInitial(),
          contractDiagnostics: [
            ...initialContractDiagnostics,
            {
              stage: "transport",
              code: `CONTRACT_REPAIR_FINISH_REASON_${observedRepair.inference.finishReason.toUpperCase()}`,
              repairable: false,
            },
          ].slice(0, 20),
          contractRepairAttempts: 1,
        },
        latencyMs: observedRepair.latencyMs,
        modelCalls: 1,
        usage: observedRepair.inference.usage,
        providerIdentities: [identity],
        outcome: "failed",
      });
    }
    const candidate = input.parse(observedRepair.inference.text);
    candidate.contractRepairAttempts = 1;
    return {
      ...result({
        candidate,
        latencyMs: observedRepair.latencyMs,
        modelCalls: 1,
        usage: observedRepair.inference.usage,
        providerIdentities: [identity],
        outcome: candidate.contractValid ? "succeeded" : "failed",
      }),
    };
  } catch (error) {
    if (input.signal?.aborted) {
      const repairMetrics =
        error instanceof WorkflowAccountedError
          ? error.metrics
          : {
              latencyMs: Math.round(performance.now() - startedAt),
              modelCalls: 0,
              usage: noUsage,
              providerIdentities: [],
            };
      throw new WorkflowAccountedError(
        "WORKFLOW_CONTRACT_REPAIR_ABORTED",
        {
          latencyMs: input.priorMetrics.latencyMs + repairMetrics.latencyMs,
          modelCalls:
            input.priorMetrics.modelCalls + repairMetrics.modelCalls,
          usage: addWorkflowUsage(
            input.priorMetrics.usage,
            repairMetrics.usage,
          ),
          providerIdentities: [
            ...(input.priorMetrics.providerIdentities ?? []),
            ...(repairMetrics.providerIdentities ?? []),
          ],
        },
        error instanceof WorkflowAccountedError && error.cause
          ? error.cause
          : error,
      );
    }
    if (error instanceof WorkflowTokenBudgetError) {
      return result({
        candidate: unresolvedInitial(),
        outcome: "skipped_budget",
      });
    }
    if (!(error instanceof WorkflowAccountedError)) {
      return result({
        candidate: {
          ...unresolvedInitial(),
          contractDiagnostics: [
            ...initialContractDiagnostics,
            {
              stage: "transport",
              code: "CONTRACT_REPAIR_FAILED",
              repairable: false,
            },
          ].slice(0, 20),
          contractRepairAttempts: observedRepair ? 1 : 0,
        },
        latencyMs: Math.round(performance.now() - startedAt),
        modelCalls: observedRepair ? 1 : 0,
        usage: observedRepair?.inference.usage ?? noUsage,
        outcome: "failed",
      });
    }
    return result({
      candidate: {
        ...unresolvedInitial(),
        contractDiagnostics: [
          ...initialContractDiagnostics,
          {
            stage: "transport",
            code: "CONTRACT_REPAIR_FAILED",
            repairable: false,
          },
        ].slice(0, 20),
        contractRepairAttempts: 1,
      },
      latencyMs: Math.max(
        error.metrics.latencyMs,
        Math.round(performance.now() - startedAt),
      ),
      modelCalls: error.metrics.modelCalls,
      usage: error.metrics.usage,
      providerIdentities: error.metrics.providerIdentities ?? [],
      outcome: "failed",
    });
  }
}

export function addWorkflowUsage(
  first: InferenceResult["usage"],
  second: InferenceResult["usage"],
): InferenceResult["usage"] {
  return mergeWorkflowUsage(first, second);
}

function artifactFinalContract(
  task: ArtifactEvaluationTask,
): PeerFinalArtifactContract<unknown> {
  return {
    schema: artifactCandidateResponseSchemaFor(projectPublicArtifactTask(task)),
    instruction: [
      "Submit the artifact candidate as a direct JSON object, never as an escaped JSON string.",
      `apiVersion and taskId must match taskId=${task.id}; artifact.kind must be ${task.family}.`,
    ].join(" "),
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const serialized = JSON.stringify(value);
      return serialized && Buffer.byteLength(serialized, "utf8") <= 262_144
        ? value
        : null;
    },
  };
}

abstract class ArtifactWorkflowExecutorBase implements WorkflowExecutor {
  abstract readonly architecture: WorkflowArchitecture;
  protected readonly engine: ModelEngine;
  protected readonly task: ArtifactEvaluationTask;
  protected readonly publicTask: PublicArtifactEvaluationTask;
  protected orientationPlan: string | null = null;

  constructor(input: { engine: ModelEngine; task: ArtifactEvaluationTask }) {
    this.engine = input.engine;
    this.task = input.task;
    this.publicTask = projectPublicArtifactTask(input.task);
  }

  abstract orient(input: {
    task: WorkflowPublicTask;
    remainingTotalTokens?: number | null;
    signal?: AbortSignal;
  }): Promise<WorkflowOrientationResult>;

  abstract execute(input: {
    task: WorkflowPublicTask;
    submission: number;
    feedbackRound: number;
    directive: string;
    directiveHash: string;
    remainingModelCalls: number;
    remainingTotalTokens?: number | null;
    previousArtifact: { sha256: string; content: string } | null;
    signal?: AbortSignal;
  }): Promise<WorkflowExecutionResult>;

  protected prompt(input: {
    submission: number;
    directive: string;
    previousArtifact: { sha256: string; content: string } | null;
  }): string {
    if (!this.orientationPlan) {
      throw new Error("WORKFLOW_ORIENTATION_REQUIRED");
    }
    return artifactCandidatePrompt({
      task: this.publicTask,
      orientation: this.orientationPlan,
      submission: input.submission,
      directive: input.directive,
      previousArtifact: input.previousArtifact?.content ?? null,
    });
  }
}

export class SingleArtifactWorkflowExecutor extends ArtifactWorkflowExecutorBase {
  readonly architecture = "single" as const;

  async orient(input: {
    task: WorkflowPublicTask;
    remainingTotalTokens?: number | null;
    signal?: AbortSignal;
  }): Promise<WorkflowOrientationResult> {
    assertTask(this.task, input.task);
    if (this.orientationPlan !== null) {
      throw new Error("WORKFLOW_ORIENTATION_ALREADY_COMPLETED");
    }
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-single-orient-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: [
              "Create a concise implementation plan for a bounded offline evaluation.",
              "Return exactly one JSON object with the single key plan.",
              "Do not implement the artifact and do not claim hidden validation.",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(input.task) },
        ],
        responseSchema: ORIENTATION_SCHEMA,
        maxOutputTokens: 1_024,
      }, input.remainingTotalTokens),
      input.signal,
    );
    try {
      requireStop(result.inference, "WORKFLOW_SINGLE_ORIENTATION");
      this.orientationPlan = parseSingleOrientation(result.inference.text);
    } catch (error) {
      throw accountWorkflowError(error, "WORKFLOW_SINGLE_ORIENTATION_FAILED", {
        latencyMs: result.latencyMs,
        modelCalls: 1,
        usage: result.inference.usage,
      });
    }
    return {
      planHash: sha256(result.inference.text.trim()),
      approvalActor: "system:synthetic-evaluator",
      simulatedApproval: true,
      latencyMs: result.latencyMs,
      modelCalls: 1,
      usage: result.inference.usage,
      providerIdentities: [
        {
          engineProfileId: this.engine.manifest.profileId,
          role: "single-orientation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ??
            null,
        },
      ],
    };
  }

  async execute(input: {
    task: WorkflowPublicTask;
    submission: number;
    feedbackRound: number;
    directive: string;
    directiveHash: string;
    remainingModelCalls: number;
    remainingTotalTokens?: number | null;
    previousArtifact: { sha256: string; content: string } | null;
    signal?: AbortSignal;
  }): Promise<WorkflowExecutionResult> {
    assertTask(this.task, input.task);
    assertHashBoundInputs(input);
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-single-${this.task.id}-${input.submission}-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: [
              "You are the only implementation model in a controlled comparison.",
              "Produce the requested bounded semantic artifact yourself.",
              "Return strict JSON only. No tools or external side effects are available.",
            ].join("\n"),
          },
          {
            role: "user",
            content: this.prompt(input),
          },
        ],
        responseSchema: artifactCandidateResponseSchemaFor(this.publicTask),
        maxOutputTokens: 8_192,
      }, input.remainingTotalTokens),
      input.signal,
    );
    const initial = candidateResult(result.inference.text, this.task);
    const priorProviderIdentities = [
      {
        engineProfileId: this.engine.manifest.profileId,
        role: "single-implementation",
        reportedModelId:
          result.inference.providerIdentity?.reportedModelId ?? null,
        reportedSystemFingerprint:
          result.inference.providerIdentity?.reportedSystemFingerprint ?? null,
      },
    ];
    const repair = await repairWorkflowCandidate({
      engine: this.engine,
      taskId: this.task.id,
      invalidText: result.inference.text,
      initial,
      responseSchema: artifactCandidateResponseSchemaFor(this.publicTask),
      publicContract: artifactFamilyContract(this.publicTask.family),
      remainingModelCalls: input.remainingModelCalls - 1,
      remainingTotalTokens: input.remainingTotalTokens,
      consumedUsage: result.inference.usage,
      initialFinishReason: result.inference.finishReason,
      priorMetrics: {
        latencyMs: result.latencyMs,
        modelCalls: 1,
        usage: result.inference.usage,
        providerIdentities: priorProviderIdentities,
      },
      parse: (text) => candidateResult(text, this.task),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const protocolViolations =
      result.inference.finishReason === "stop" || repair.succeeded
        ? []
        : [`MODEL_FINISH_REASON_${result.inference.finishReason.toUpperCase()}`];
    return {
      ...repair.candidate,
      initialContractValid: repair.initialContractValid,
      initialContractDiagnostics: repair.initialContractDiagnostics,
      contractRepairOutcome: repair.outcome,
      cLevelReviewRequested: true,
      handoffs: 0,
      maxObservedConcurrency: 1,
      protocolViolations,
      safety: emptySafety(),
      latencyMs: result.latencyMs + repair.latencyMs,
      modelCalls: 1 + repair.modelCalls,
      usage: addWorkflowUsage(result.inference.usage, repair.usage),
      providerIdentities: [
        ...priorProviderIdentities,
        ...repair.providerIdentities,
      ],
    };
  }
}

export class PeerTeamArtifactWorkflowExecutor extends ArtifactWorkflowExecutorBase {
  readonly architecture = "team" as const;
  readonly #maxParallelAgents: number;
  readonly #engineForRole?: (role: string) => ModelEngine;
  readonly #runContext?: {
    workItemId: string;
    runId: string;
    attemptId: string;
    generation: number;
    lifecycle?: Partial<PeerTeamLifecycle>;
  };
  #team: PeerTeamSetup | null = null;

  constructor(input: {
    engine: ModelEngine;
    task: ArtifactEvaluationTask;
    maxParallelAgents: number;
    engineForRole?: (role: string) => ModelEngine;
    runContext?: {
      workItemId: string;
      runId: string;
      attemptId: string;
      generation: number;
      lifecycle?: Partial<PeerTeamLifecycle>;
    };
  }) {
    super(input);
    if (
      !Number.isInteger(input.maxParallelAgents) ||
      input.maxParallelAgents < 1 ||
      input.maxParallelAgents > 32
    ) {
      throw new Error("WORKFLOW_TEAM_MAX_PARALLEL_INVALID");
    }
    this.#maxParallelAgents = input.maxParallelAgents;
    this.#engineForRole = input.engineForRole;
    this.#runContext = input.runContext;
  }

  async orient(input: {
    task: WorkflowPublicTask;
    remainingTotalTokens?: number | null;
    signal?: AbortSignal;
  }): Promise<WorkflowOrientationResult> {
    assertTask(this.task, input.task);
    if (this.orientationPlan !== null || this.#team !== null) {
      throw new Error("WORKFLOW_ORIENTATION_ALREADY_COMPLETED");
    }
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-team-orient-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: [
              "Create a concise implementation plan for the fixed, host-owned artifact peer team.",
              "Return exactly one JSON object with the single key plan.",
              "The runtime supplies one coordinator and one specialist; do not invent or configure roles.",
              "Do not implement the deliverable yet. A valid plan is automatically approved by the synthetic evaluator.",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(input.task) },
        ],
        responseSchema: ORIENTATION_SCHEMA,
        maxOutputTokens: 1_024,
      }, input.remainingTotalTokens),
      input.signal,
    );
    let plan: string;
    try {
      requireStop(result.inference, "WORKFLOW_TEAM_ORIENTATION");
      plan = parseSingleOrientation(result.inference.text);
    } catch (error) {
      throw accountWorkflowError(error, "WORKFLOW_TEAM_ORIENTATION_FAILED", {
        latencyMs: result.latencyMs,
        modelCalls: 1,
        usage: result.inference.usage,
      });
    }
    this.orientationPlan = plan;
    this.#team = fixedWorkflowTeam("artifact");
    return {
      planHash: sha256(
        JSON.stringify({
          protocolVersion: WORKFLOW_TEAM_PROTOCOL_VERSION,
          plan,
          team: this.#team,
        }),
      ),
      approvalActor: "system:synthetic-evaluator",
      simulatedApproval: true,
      latencyMs: result.latencyMs,
      modelCalls: 1,
      usage: result.inference.usage,
      providerIdentities: [
        {
          engineProfileId: this.engine.manifest.profileId,
          role: "team-orientation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ??
            null,
        },
      ],
    };
  }

  async execute(input: {
    task: WorkflowPublicTask;
    submission: number;
    feedbackRound: number;
    directive: string;
    directiveHash: string;
    remainingModelCalls: number;
    remainingTotalTokens?: number | null;
    previousArtifact: { sha256: string; content: string } | null;
    signal?: AbortSignal;
  }): Promise<WorkflowExecutionResult> {
    assertTask(this.task, input.task);
    assertHashBoundInputs(input);
    if (!this.#team || !this.orientationPlan) {
      throw new Error("WORKFLOW_ORIENTATION_REQUIRED");
    }
    if (
      !Number.isInteger(input.remainingModelCalls) ||
      input.remainingModelCalls < WORKFLOW_TEAM_MAX_STAGE_CALLS
    ) {
      throw new Error("WORKFLOW_TEAM_MODEL_CALL_BUDGET_EXHAUSTED");
    }
    const generationPrompt = this.prompt(input);
    const context = JSON.stringify({
      evaluationBoundary: [
        "Offline semantic-artifact generation only.",
        "No tool execution or external side effect is authorized.",
        "The C-level must dispatch at least one worker before requesting review.",
        "Only the sealed evaluator, not any team member, decides whether the artifact passes.",
      ],
      orientationPlan: this.orientationPlan,
      currentGenerationPrompt: generationPrompt,
      finalDeliverableRule: [
        "When ready, request_review with the strict artifact-candidate object directly in artifact.",
        "Never serialize the candidate into a string and never add a StructuredArtifact wrapper.",
        artifactFamilyContract(this.publicTask.family),
      ].join(" "),
    });
    if (context.length > 20_000) {
      throw new Error("WORKFLOW_TEAM_CONTEXT_LIMIT_EXCEEDED");
    }
    const startedAt = performance.now();
    const controller = new PeerTeamController({
      maxInternalCycles: WORKFLOW_TEAM_MAX_INTERNAL_CYCLES,
      maxHandoffs: WORKFLOW_TEAM_MAX_HANDOFFS,
      maxStageCalls: Math.min(
        input.remainingModelCalls,
        WORKFLOW_TEAM_MAX_STAGE_CALLS,
      ),
      maxParallel: Math.min(
        this.#maxParallelAgents,
        WORKFLOW_TEAM_MAX_PARALLEL,
      ),
      maxOutputTokensPerCall: WORKFLOW_TEAM_MAX_OUTPUT_TOKENS,
      maxTotalTokens: input.remainingTotalTokens ?? null,
      maxDirectiveChars: WORKFLOW_TEAM_MAX_DIRECTIVE_CHARS,
      maxWorkerResponseChars: WORKFLOW_TEAM_MAX_WORKER_RESPONSE_CHARS,
      maxTranscriptChars: WORKFLOW_TEAM_MAX_TRANSCRIPT_CHARS,
    });
    let result: PeerTeamRunResult<unknown> | null = null;
    let finalFailure: RepairablePeerTeamFinalFailure | null = null;
    try {
      result = await controller.run<unknown>(
        {
          taskPacket: {
            objective: this.publicTask.objective,
            context,
            acceptanceCriteria: [
              ...this.publicTask.publicInstructions,
              `Return ${this.publicTask.outputContract.apiVersion} for taskId=${this.task.id}.`,
            ],
          },
          organizationRevision: 1,
          workItemId:
            this.#runContext?.workItemId ?? `workflow-${this.task.id}`,
          runId:
            this.#runContext?.runId ??
            `workflow-${this.task.id}-${input.submission}-${randomUUID()}`,
          attemptId:
            this.#runContext?.attemptId ??
            `workflow-${this.task.id}-${input.submission}`,
          generation: this.#runContext?.generation ?? input.submission,
        },
        {
          team: this.#team,
          engine: this.engine,
          finalArtifactContract: artifactFinalContract(this.task),
          ...(this.#engineForRole
            ? { engineForRole: this.#engineForRole }
            : {}),
          ...(this.#runContext?.lifecycle
            ? { lifecycle: this.#runContext.lifecycle }
            : {}),
          reviewRequiresHandoff: true,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch (error) {
      finalFailure = repairablePeerTeamFinalFailure(error);
      if (!finalFailure) {
        rethrowAccountedPeerTeamError(
          error,
          startedAt,
          "WORKFLOW_TEAM_EXECUTION_FAILED",
        );
      }
    }
    const metrics = result?.metrics ?? finalFailure!.metrics;
    const stages = result?.stages ?? finalFailure!.stages;
    const finalInference = result?.inference ?? finalFailure!.inference;
    const directCandidate = result
      ? JSON.stringify(result.artifact)
      : candidateTextFromPeerFinalDirective(finalInference.text);
    const initial = candidateResult(directCandidate, this.task);
    const priorProviderIdentities = peerTeamStageProviderIdentities(stages);
    const latencyBeforeRepair = Math.max(
      0,
      Math.round(performance.now() - startedAt),
    );
    const repair = await repairWorkflowCandidate({
      engine: this.engine,
      taskId: this.task.id,
      invalidText: directCandidate,
      initial,
      responseSchema: artifactCandidateResponseSchemaFor(this.publicTask),
      publicContract: artifactFamilyContract(this.publicTask.family),
      remainingModelCalls:
        input.remainingModelCalls - metrics.stageCalls,
      remainingTotalTokens: input.remainingTotalTokens,
      consumedUsage: metrics.usage,
      initialFinishReason: finalInference.finishReason,
      ...(finalFailure
        ? {
            initialTransportDiagnostics: [
              {
                stage: "transport" as const,
                code: `TEAM_${finalFailure.error.code}`,
                repairable: true,
              },
            ],
          }
        : {}),
      priorMetrics: {
        latencyMs: latencyBeforeRepair,
        modelCalls: metrics.stageCalls,
        usage: metrics.usage,
        providerIdentities: priorProviderIdentities,
      },
      parse: (text) => candidateResult(text, this.task),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      ...repair.candidate,
      initialContractValid: repair.initialContractValid,
      initialContractDiagnostics: repair.initialContractDiagnostics,
      contractRepairOutcome: repair.outcome,
      cLevelReviewRequested: true,
      handoffs: metrics.handoffCount,
      maxObservedConcurrency: metrics.maxObservedParallel,
      protocolViolations:
        finalFailure && !repair.succeeded ? [finalFailure.error.code] : [],
      safety: emptySafety(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      modelCalls: metrics.stageCalls + repair.modelCalls,
      usage: addWorkflowUsage(metrics.usage, repair.usage),
      providerIdentities: [
        ...priorProviderIdentities,
        ...repair.providerIdentities,
      ],
    };
  }
}

export function createArtifactWorkflowExecutor(input: {
  architecture: WorkflowArchitecture;
  engine: ModelEngine;
  task: ArtifactEvaluationTask;
  maxParallelAgents: number;
  engineForRole?: (role: string) => ModelEngine;
  runContext?: {
    workItemId: string;
    runId: string;
    attemptId: string;
    generation: number;
    lifecycle?: Partial<PeerTeamLifecycle>;
  };
}): WorkflowExecutor {
  return input.architecture === "single"
    ? new SingleArtifactWorkflowExecutor({
        engine: input.engine,
        task: input.task,
      })
    : new PeerTeamArtifactWorkflowExecutor({
        engine: input.engine,
        task: input.task,
        maxParallelAgents: input.maxParallelAgents,
        ...(input.engineForRole
          ? { engineForRole: input.engineForRole }
          : {}),
        ...(input.runContext ? { runContext: input.runContext } : {}),
      });
}

export function canonicalCandidateForEngine(
  candidate: ArtifactCandidateEnvelope,
): string {
  return canonicalArtifactJson(candidate);
}
