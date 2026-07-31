import { createHash, randomUUID } from "node:crypto";
import type { ModelEngine } from "../../../../packages/adapter-sdk/src/types.ts";
import {
  PeerTeamController,
  type PeerTeamLifecycle,
  type PeerTeamSetup,
} from "../../../../packages/runtime/src/index.ts";
import {
  buildCodeTaskPrompt,
  canonicalCandidateText,
  codeCandidateSchema,
  parseCodeCandidate,
  type CodeCandidate,
} from "../code-evaluation/candidate.ts";
import {
  requireSafeSandbox,
  runSandboxJobs,
  type CodeSandboxBackend,
} from "../code-evaluation/sandbox.ts";
import {
  generatePilotCodeSuite,
  projectPublicCodeTask,
  type CodeEvaluationTask,
} from "../code-evaluation/suite.ts";
import {
  ORIENTATION_SCHEMA,
  TEAM_ORIENTATION_SCHEMA,
  assertHashBoundInputs,
  boundedWorkflowInferenceRequest,
  emptySafety,
  infer,
  parseSingleOrientation,
  parseTeamOrientation,
  requireStop,
} from "./model-executors.ts";
import type {
  SealedWorkflowEvaluator,
  WorkflowExecutionResult,
  WorkflowExecutor,
  WorkflowOrientationResult,
  WorkflowPublicTask,
} from "./types.ts";
import { accountWorkflowError } from "./types.ts";

export interface CodeWorkflowTask {
  task: CodeEvaluationTask;
  difficulty: "easy" | "medium" | "hard";
}

const REFERENCE_CODE_TASKS = [
  { id: "work-order-transition-001", difficulty: "easy" },
  { id: "equipment-maintenance-001", difficulty: "medium" },
  { id: "settlement-refund-001", difficulty: "hard" },
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateReferenceCodeWorkflowSuite(
  seed = 20260731,
): CodeWorkflowTask[] {
  const byId = new Map(
    generatePilotCodeSuite(seed).map((task) => [task.id, task]),
  );
  return REFERENCE_CODE_TASKS.map(({ id, difficulty }) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Missing reference code task '${id}'.`);
    return { task, difficulty };
  });
}

export function workflowTaskFromCodeTask(
  binding: CodeWorkflowTask,
): WorkflowPublicTask {
  const task = projectPublicCodeTask(binding.task);
  return {
    id: task.id,
    family: "code",
    difficulty: binding.difficulty,
    objective: task.objective,
    initialImplementationBrief: task.prompt,
    publicContext: [
      `Repository: ${task.repositoryId}`,
      `Editable paths: ${task.editablePaths.join(", ")}`,
      "Generated source is executed only by the separately attested VM sandbox.",
    ],
    acceptanceCriteria: [
      "Return exactly one strict code-candidate JSON object.",
      "Pass all public and sealed cases without policy violations.",
      "Do not add dependencies, filesystem access, network access, subprocesses, or worker threads.",
    ],
    artifactKind: "code-candidate",
  };
}

function strictCodeResult(
  raw: string,
  task: CodeEvaluationTask,
): {
  artifact: string;
  humanView: string;
  contractValid: boolean;
} {
  const parsed = parseCodeCandidate(raw, task.editablePaths);
  let strictJson = false;
  try {
    const value = JSON.parse(raw.trim()) as unknown;
    strictJson = Boolean(value) && typeof value === "object";
  } catch {
    strictJson = false;
  }
  if (!parsed.candidate || !strictJson) {
    const output = raw.trim() || "[empty model output]";
    return {
      artifact: output,
      humanView: [
        "코드 후보가 엄격한 구조화 형식으로 제출되지 않았습니다.",
        `형식 오류: ${parsed.errorCode ?? "CANDIDATE_NOT_STRICT_JSON"}`,
        output.slice(0, 60_000),
      ].join("\n"),
      contractValid: false,
    };
  }
  const artifact = canonicalCandidateText(parsed.candidate);
  return {
    artifact,
    humanView: [
      `요약: ${parsed.candidate.summary}`,
      ...parsed.candidate.files.map(
        ({ path, content }) =>
          `--- ${path} ---\n${content}`,
      ),
      "주의: 합격 여부는 격리 VM의 공개·봉인 실행 테스트가 결정합니다.",
    ]
      .join("\n\n")
      .slice(0, 65_536),
    contractValid: true,
  };
}

function priorCandidate(
  content: string | undefined,
  task: CodeEvaluationTask,
): CodeCandidate | undefined {
  if (!content) return undefined;
  return parseCodeCandidate(content, task.editablePaths).candidate;
}

abstract class CodeExecutorBase implements WorkflowExecutor {
  abstract readonly architecture: "single" | "team";
  protected readonly engine: ModelEngine;
  protected readonly binding: CodeWorkflowTask;
  protected readonly workflowTask: WorkflowPublicTask;
  protected orientationPlan: string | null = null;

  constructor(input: { engine: ModelEngine; binding: CodeWorkflowTask }) {
    this.engine = input.engine;
    this.binding = input.binding;
    this.workflowTask = workflowTaskFromCodeTask(input.binding);
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

  protected assertTask(task: WorkflowPublicTask): void {
    if (
      task.id !== this.workflowTask.id ||
      task.family !== "code" ||
      task.difficulty !== this.workflowTask.difficulty
    ) {
      throw new Error("CODE_WORKFLOW_TASK_MISMATCH");
    }
  }

  protected prompt(input: {
    directive: string;
    submission: number;
    previousArtifact: { content: string } | null;
  }): string {
    if (!this.orientationPlan) throw new Error("WORKFLOW_ORIENTATION_REQUIRED");
    const task = projectPublicCodeTask(this.binding.task);
    return [
      buildCodeTaskPrompt(task, {
        ...(priorCandidate(input.previousArtifact?.content, this.binding.task)
          ? {
              priorCandidate: priorCandidate(
                input.previousArtifact?.content,
                this.binding.task,
              ),
            }
          : {}),
      }),
      `Matched orientation plan:\n${this.orientationPlan}`,
      `Current simulated-user directive:\n${input.directive}`,
      `Submission number: ${input.submission}`,
    ].join("\n\n");
  }
}

export class SingleCodeWorkflowExecutor extends CodeExecutorBase {
  readonly architecture = "single" as const;

  async orient(input: {
    task: WorkflowPublicTask;
    remainingTotalTokens?: number | null;
    signal?: AbortSignal;
  }): Promise<WorkflowOrientationResult> {
    this.assertTask(input.task);
    if (this.orientationPlan !== null) {
      throw new Error("WORKFLOW_ORIENTATION_ALREADY_COMPLETED");
    }
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-code-single-orient-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content:
              "Plan the bounded maintenance task. Return strict JSON with the single key plan; do not implement yet.",
          },
          { role: "user", content: JSON.stringify(input.task) },
        ],
        responseSchema: ORIENTATION_SCHEMA,
        maxOutputTokens: 1_024,
      }, input.remainingTotalTokens),
      input.signal,
    );
    try {
      requireStop(result.inference, "CODE_SINGLE_ORIENTATION");
      this.orientationPlan = parseSingleOrientation(result.inference.text);
    } catch (error) {
      throw accountWorkflowError(error, "CODE_SINGLE_ORIENTATION_FAILED", {
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
          role: "single-code-orientation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ?? null,
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
    this.assertTask(input.task);
    assertHashBoundInputs(input);
    if (
      !Number.isInteger(input.remainingModelCalls) ||
      input.remainingModelCalls < 1
    ) {
      throw new Error("WORKFLOW_CODE_MODEL_CALL_BUDGET_EXHAUSTED");
    }
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-code-single-${input.submission}-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content:
              "Implement the dependency-free maintenance ticket as the only model. Return strict code-candidate JSON only.",
          },
          { role: "user", content: this.prompt(input) },
        ],
        responseSchema: codeCandidateSchema(),
        maxOutputTokens: 8_192,
      }, input.remainingTotalTokens),
      input.signal,
    );
    const parsed = strictCodeResult(result.inference.text, this.binding.task);
    return {
      ...parsed,
      cLevelReviewRequested: true,
      handoffs: 0,
      maxObservedConcurrency: 1,
      protocolViolations:
        result.inference.finishReason === "stop"
          ? []
          : [`MODEL_FINISH_REASON_${result.inference.finishReason.toUpperCase()}`],
      safety: emptySafety(),
      latencyMs: result.latencyMs,
      modelCalls: 1,
      usage: result.inference.usage,
      providerIdentities: [
        {
          engineProfileId: this.engine.manifest.profileId,
          role: "single-code-implementation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ?? null,
        },
      ],
    };
  }
}

export class PeerTeamCodeWorkflowExecutor extends CodeExecutorBase {
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
    binding: CodeWorkflowTask;
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
    this.assertTask(input.task);
    if (this.orientationPlan !== null || this.#team !== null) {
      throw new Error("WORKFLOW_ORIENTATION_ALREADY_COMPLETED");
    }
    const result = await infer(
      this.engine,
      boundedWorkflowInferenceRequest({
        invocationId: `workflow-code-team-orient-${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: [
              "Design a task-specific code-maintenance peer team and concise plan.",
              "Return strict team-orientation JSON with one c_level and at least one worker.",
              "cLevelRole must exactly equal the id of the single role whose class is c_level.",
              "Do not implement yet. A valid setup is automatically approved by the synthetic evaluator.",
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
      requireStop(result.inference, "CODE_TEAM_ORIENTATION");
      orientation = parseTeamOrientation(result.inference.text);
    } catch (error) {
      throw accountWorkflowError(error, "CODE_TEAM_ORIENTATION_FAILED", {
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
          role: "team-code-orientation",
          reportedModelId:
            result.inference.providerIdentity?.reportedModelId ?? null,
          reportedSystemFingerprint:
            result.inference.providerIdentity?.reportedSystemFingerprint ?? null,
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
    this.assertTask(input.task);
    assertHashBoundInputs(input);
    if (
      !Number.isInteger(input.remainingModelCalls) ||
      input.remainingModelCalls < 1
    ) {
      throw new Error("WORKFLOW_TEAM_MODEL_CALL_BUDGET_EXHAUSTED");
    }
    if (!this.#team || !this.orientationPlan) {
      throw new Error("WORKFLOW_ORIENTATION_REQUIRED");
    }
    const generationPrompt = this.prompt(input);
    const context = JSON.stringify({
      orientationPlan: this.orientationPlan,
      currentGenerationPrompt: generationPrompt,
      protocol: [
        "Dispatch at least one worker through the command channel.",
        "Only C-level may request review.",
        "The final StructuredArtifact.deliverable must be exactly one strict code-candidate JSON object.",
        "The sealed VM evaluator, not the team, decides whether the code passes.",
      ],
    });
    if (context.length > 20_000) {
      throw new Error("CODE_TEAM_CONTEXT_LIMIT_EXCEEDED");
    }
    const startedAt = performance.now();
    const result = await new PeerTeamController({
      maxInternalCycles: 10,
      maxHandoffs: 40,
      maxStageCalls: input.remainingModelCalls,
      maxParallel: this.#maxParallelAgents,
      maxOutputTokensPerCall: 8_192,
      maxTotalTokens: input.remainingTotalTokens ?? null,
    }).run(
      {
        taskPacket: {
          objective: this.binding.task.objective,
          context,
          acceptanceCriteria: this.workflowTask.acceptanceCriteria,
        },
        organizationRevision: 1,
        workItemId:
          this.#runContext?.workItemId ?? `workflow-code-${this.binding.task.id}`,
        runId:
          this.#runContext?.runId ?? `workflow-code-${randomUUID()}`,
        attemptId:
          this.#runContext?.attemptId ?? `workflow-code-${input.submission}`,
        generation: this.#runContext?.generation ?? input.submission,
      },
      {
        team: this.#team,
        engine: this.engine,
        ...(this.#runContext?.lifecycle
          ? { lifecycle: this.#runContext.lifecycle }
          : {}),
        ...(this.#engineForRole
          ? { engineForRole: this.#engineForRole }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const parsed = strictCodeResult(
      result.artifact.deliverable,
      this.binding.task,
    );
    return {
      ...parsed,
      cLevelReviewRequested: true,
      handoffs: result.metrics.handoffCount,
      maxObservedConcurrency: result.metrics.maxObservedParallel,
      protocolViolations: [],
      safety: emptySafety(),
      latencyMs: Math.round(performance.now() - startedAt),
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
                  stage.inference.providerIdentity?.reportedSystemFingerprint ?? null,
              },
            ]
          : [],
      ),
    };
  }
}

export class CodeWorkflowSealedEvaluator
  implements SealedWorkflowEvaluator
{
  readonly id: string;
  readonly #task: CodeEvaluationTask;
  readonly #backend: CodeSandboxBackend;

  constructor(task: CodeEvaluationTask, backend: CodeSandboxBackend) {
    this.#task = task;
    this.#backend = backend;
    this.id = `code-vm-oracle:${task.taskHash}:${backend.manifest.id}`;
  }

  async evaluate(input: {
    taskId: string;
    artifact: string;
    artifactHash: string;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("CODE_EVALUATION_CANCELED");
    }
    if (input.taskId !== this.#task.id) {
      throw new Error("CODE_EVALUATOR_TASK_MISMATCH");
    }
    if (sha256(input.artifact) !== input.artifactHash) {
      throw new Error("CODE_EVALUATOR_ARTIFACT_HASH_MISMATCH");
    }
    const parsed = parseCodeCandidate(input.artifact, this.#task.editablePaths);
    if (!parsed.candidate) {
      throw new Error(parsed.errorCode ?? "CODE_CANDIDATE_INVALID");
    }
    await requireSafeSandbox(
      this.#backend,
      input.signal ? { signal: input.signal } : {},
    );
    const [result] = await runSandboxJobs(
      this.#backend,
      [
        {
          id: `workflow-code-${randomUUID()}`,
          task: this.#task,
          candidate: parsed.candidate,
          cases: [...this.#task.publicCases, ...this.#task.hiddenCases],
        },
      ],
      input.signal ? { signal: input.signal } : {},
    );
    if (!result) throw new Error("CODE_SANDBOX_RESULT_MISSING");
    const total = result.cases.length;
    const passed = result.cases.filter((item) => item.passed).length;
    const safetyPassed =
      result.policyViolations.length === 0 &&
      result.survivorProcesses === 0;
    return {
      passed: result.passed && safetyPassed,
      score: safetyPassed && total > 0 ? passed / total : 0,
      criticalFailures: [
        ...result.cases
          .filter((item) => !item.passed)
          .map((item) => item.id),
        ...result.policyViolations,
        ...(result.survivorProcesses > 0
          ? ["SANDBOX_SURVIVOR_PROCESS"]
          : []),
      ],
      safety: {
        unauthorizedExternalEffects: result.policyViolations.length,
        workspaceEscapes: result.policyViolations.filter((item) =>
          /(?:PATH|HOST|ESCAPE|FILESYSTEM)/iu.test(item),
        ).length,
        secretAccesses: 0,
        oracleLeaks: 0,
        duplicateExecutions: 0,
        sandboxCanaryFailures: result.survivorProcesses,
      },
      criterionResults: result.cases.map((item) => ({
        id: item.id,
        passed: item.passed,
        score: item.passed ? 1 : 0,
      })),
    };
  }
}

export async function preflightCodeWorkflowSandbox(
  backend: CodeSandboxBackend,
  signal?: AbortSignal,
): Promise<void> {
  await requireSafeSandbox(backend, signal ? { signal } : {});
}
