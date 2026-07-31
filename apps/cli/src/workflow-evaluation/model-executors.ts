import { createHash, randomUUID } from "node:crypto";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../../packages/adapter-sdk/src/types.ts";
import {
  PeerTeamController,
  type PeerTeamRole,
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
  WorkflowExecutionResult,
  WorkflowExecutor,
  WorkflowOrientationResult,
  WorkflowPublicTask,
  WorkflowSafetyObservation,
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
      const inference = await engine.generate(request, options);
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
    };
  } catch (error) {
    const raw = rawText.trim() || "[empty model output]";
    const message = error instanceof Error ? error.message : String(error);
    return {
      artifact: raw,
      humanView: [
        "사람이 검토할 수 있는 구조화 산출물로 변환되지 않았습니다.",
        `형식 오류: ${message}`,
        raw.slice(0, 60_000),
      ].join("\n"),
      contractValid: false,
    };
  }
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
    const protocolViolations =
      result.inference.finishReason === "stop"
        ? []
        : [`MODEL_FINISH_REASON_${result.inference.finishReason.toUpperCase()}`];
    const parsed = candidateResult(result.inference.text, this.task);
    return {
      ...parsed,
      cLevelReviewRequested: true,
      handoffs: 0,
      maxObservedConcurrency: 1,
      protocolViolations,
      safety: emptySafety(),
      latencyMs: result.latencyMs,
      modelCalls: 1,
      usage: result.inference.usage,
      providerIdentities: [
        {
          engineProfileId: this.engine.manifest.profileId,
          role: "single-implementation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ??
            null,
        },
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
              "Design a small task-specific peer team and a concise implementation plan.",
              "Return exactly one JSON object matching the supplied schema.",
              "Create exactly one c_level coordinator and at least one worker.",
              "Worker role ids represent teams or specialties that the C-level may call by command.",
              `At most ${Math.min(7, this.#maxParallelAgents)} worker calls may be useful concurrently.`,
              "Do not implement the deliverable yet. The synthetic evaluator will always approve a valid setup.",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(input.task) },
        ],
        responseSchema: TEAM_ORIENTATION_SCHEMA,
        maxOutputTokens: 2_048,
      }, input.remainingTotalTokens),
      input.signal,
    );
    let orientation: ReturnType<typeof parseTeamOrientation>;
    try {
      requireStop(result.inference, "WORKFLOW_TEAM_ORIENTATION");
      orientation = parseTeamOrientation(result.inference.text);
    } catch (error) {
      throw accountWorkflowError(error, "WORKFLOW_TEAM_ORIENTATION_FAILED", {
        latencyMs: result.latencyMs,
        modelCalls: 1,
        usage: result.inference.usage,
      });
    }
    this.orientationPlan = orientation.plan;
    this.#team = orientation.team;
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
      input.remainingModelCalls < 1
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
        "When ready, request_review with a StructuredArtifact.",
        "StructuredArtifact.deliverable must contain exactly the strict artifact-candidate JSON object, without fences or prose.",
        artifactFamilyContract(this.publicTask.family),
      ].join(" "),
    });
    if (context.length > 20_000) {
      throw new Error("WORKFLOW_TEAM_CONTEXT_LIMIT_EXCEEDED");
    }
    const startedAt = performance.now();
    const controller = new PeerTeamController({
      maxInternalCycles: 10,
      maxHandoffs: 40,
      maxStageCalls: input.remainingModelCalls,
      maxParallel: this.#maxParallelAgents,
      maxOutputTokensPerCall: 8_192,
      maxTotalTokens: input.remainingTotalTokens ?? null,
      maxDirectiveChars: 64_000,
      maxWorkerResponseChars: 32_000,
      maxTranscriptChars: 256_000,
    });
    const result = await controller.run(
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
        ...(this.#engineForRole
          ? { engineForRole: this.#engineForRole }
          : {}),
        ...(this.#runContext?.lifecycle
          ? { lifecycle: this.#runContext.lifecycle }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const parsed = candidateResult(result.artifact.deliverable, this.task);
    return {
      ...parsed,
      cLevelReviewRequested: true,
      handoffs: result.metrics.handoffCount,
      maxObservedConcurrency: result.metrics.maxObservedParallel,
      protocolViolations: [],
      safety: emptySafety(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      modelCalls: result.metrics.stageCalls,
      usage: result.metrics.usage,
      providerIdentities: result.stages.flatMap((stage) =>
        stage.inference
          ? [
              {
                engineProfileId: stage.engineId,
                role: stage.role,
                reportedModelId:
                  stage.inference.providerIdentity?.reportedModelId ?? null,
                reportedSystemFingerprint:
                  stage.inference.providerIdentity
                    ?.reportedSystemFingerprint ?? null,
              },
            ]
          : [],
      ),
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
