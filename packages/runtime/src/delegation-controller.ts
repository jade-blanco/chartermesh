import { randomUUID } from "node:crypto";
import type {
  HostRunRequest,
  InferenceResult,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import {
  BuiltInManagedRunner,
  type ManagedRunResult,
} from "./managed-runner.ts";
import type { ToolRuntime } from "./tool-runtime.ts";

export type DelegatedRole =
  | "planner"
  | "implementer"
  | "verifier"
  | "synthesizer";

export interface DelegatedStage {
  role: DelegatedRole;
  attemptId: string;
  latencyMs: number;
  inference: InferenceResult;
}

export interface DelegationLifecycle {
  startStage(input: {
    role: DelegatedRole;
    index: number;
    engineId: string;
  }): Promise<{ attemptId: string }> | { attemptId: string };
  finishStage(input: {
    role: DelegatedRole;
    attemptId: string;
    status: "succeeded" | "failed" | "canceled";
    inference?: InferenceResult;
    error?: unknown;
  }): Promise<void> | void;
}

export interface DelegatedRunResult extends ManagedRunResult {
  stages: DelegatedStage[];
  generationBudget: {
    maxStageCalls: number;
    maxRepairCalls: number;
    maxOutputTokensPerCall: number;
    maxGeneratedTokensRequested: number;
  };
}

const roles: DelegatedRole[] = [
  "planner",
  "implementer",
  "verifier",
  "synthesizer",
];

function taskPacketFor(
  role: DelegatedRole,
  original: {
    objective?: string;
    context?: string;
    acceptanceCriteria?: string[];
  },
  stages: DelegatedStage[],
): HostRunRequest["taskPacket"] {
  const previous = stages
    .map(
      ({ role: previousRole, inference }) =>
        `${previousRole.toUpperCase()} HANDOFF:\n${inference.text}`,
    )
    .join("\n\n");
  const common = [
    `Original objective:\n${original.objective ?? "Complete the assigned work."}`,
    original.context ? `Original context:\n${original.context}` : "",
    original.acceptanceCriteria?.length
      ? `Original acceptance criteria:\n- ${original.acceptanceCriteria.join("\n- ")}`
      : "",
    previous,
    "This is depth-1, parent-only collaboration. Do not create more agents.",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (role === "planner") {
    return {
      objective:
        "Create a concise, bounded plan for another worker. Do not perform the work.",
      context: common,
      acceptanceCriteria: [
        "Identify constraints, ordered steps, and evidence needed.",
        "Do not claim files, tools, tests, or external systems were inspected.",
      ],
    };
  }
  if (role === "implementer") {
    return {
      objective: original.objective ?? "Complete the assigned work.",
      context: common,
      acceptanceCriteria: [
        ...(original.acceptanceCriteria ?? []),
        "Use the planner handoff as advice, not as evidence.",
      ],
    };
  }
  if (role === "verifier") {
    return {
      objective:
        "Review the proposed deliverable against the original request and identify exact corrections.",
      context: common,
      acceptanceCriteria: [
        "Separate supported facts from unsupported claims.",
        "Name missing acceptance criteria and concrete risks.",
        "Do not perform or claim new external actions.",
      ],
    };
  }
  return {
    objective:
      "Produce the final human-reviewable deliverable using the original request and all handoffs.",
    context: common,
    acceptanceCriteria: [
      ...(original.acceptanceCriteria ?? []),
      "Resolve verifier findings when possible.",
      "Preserve the evidence boundary and do not invent performed checks.",
      "Return one self-contained final result, not a discussion transcript.",
    ],
  };
}

export class DelegationController {
  readonly capability = {
    name: "orchestration.delegated",
    support: "emulated",
    stability: "experimental",
    constraints: {
      maxDepth: 1,
      maxChildren: 4,
      communication: "parent_only",
      concurrency: 1,
    },
  } as const;

  private readonly maxOutputTokensPerCall: number;

  constructor(maxOutputTokensPerCall = 1_024) {
    this.maxOutputTokensPerCall = maxOutputTokensPerCall;
    if (
      !Number.isInteger(maxOutputTokensPerCall) ||
      maxOutputTokensPerCall < 128 ||
      maxOutputTokensPerCall > 8_192
    ) {
      throw new Error(
        "maxOutputTokensPerCall must be an integer from 128 to 8192.",
      );
    }
  }

  async run(
    request: HostRunRequest,
    options: {
      engine: ModelEngine;
      engineForRole?: (role: DelegatedRole) => ModelEngine;
      signal?: AbortSignal;
      toolRuntime?: ToolRuntime;
      lifecycle?: DelegationLifecycle;
    },
  ): Promise<DelegatedRunResult> {
    const original = request.taskPacket as {
      objective?: string;
      context?: string;
      acceptanceCriteria?: string[];
    };
    const stages: DelegatedStage[] = [];
    const toolEvidence: DelegatedRunResult["toolEvidence"] = [];
    for (const [index, role] of roles.entries()) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("RUN_CANCELED");
      }
      const stageEngine =
        options.engineForRole?.(role) ?? options.engine;
      const started = await options.lifecycle?.startStage({
        role,
        index,
        engineId: stageEngine.manifest.profileId,
      });
      const attemptId =
        started?.attemptId ??
        `${request.attemptId}:${role}:${randomUUID()}`;
      const stageStartedAt = performance.now();
      try {
        const runner = new BuiltInManagedRunner({
          maxOutputTokens: this.maxOutputTokensPerCall,
        });
        const handle = await runner.start(
          {
            ...request,
            attemptId,
            taskPacket: taskPacketFor(role, original, stages),
          },
          {
            engine: stageEngine,
            signal: options.signal,
            ...(role === "implementer" && options.toolRuntime
              ? { toolRuntime: options.toolRuntime }
              : {}),
          },
        );
        const result = await runner.result(handle.hostRunId);
        const stage = {
          role,
          attemptId,
          latencyMs: Math.round(performance.now() - stageStartedAt),
          inference: result.inference,
        };
        stages.push(stage);
        toolEvidence.push(...result.toolEvidence);
        await options.lifecycle?.finishStage({
          role,
          attemptId,
          status: "succeeded",
          inference: result.inference,
        });
      } catch (error) {
        const status = options.signal?.aborted ? "canceled" : "failed";
        await options.lifecycle?.finishStage({
          role,
          attemptId,
          status,
          error,
        });
        throw error;
      }
    }
    const final = stages.at(-1);
    if (!final) throw new Error("DELEGATION_PRODUCED_NO_RESULT");
    return {
      hostRunId: `delegated-${randomUUID()}`,
      inference: final.inference,
      toolEvidence,
      stages,
      generationBudget: {
        maxStageCalls: roles.length,
        maxRepairCalls: roles.length,
        maxOutputTokensPerCall: this.maxOutputTokensPerCall,
        maxGeneratedTokensRequested:
          roles.length * this.maxOutputTokensPerCall * 2,
      },
    };
  }
}
