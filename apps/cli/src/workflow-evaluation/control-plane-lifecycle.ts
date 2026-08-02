import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../../packages/adapter-sdk/src/types.ts";
import type { ControlPlane } from "../../../../packages/control-plane/src/index.ts";
import {
  PeerTeamControllerError,
  type PeerHandoffEnvelope,
  type PeerTeamLifecycle,
} from "../../../../packages/runtime/src/index.ts";

export class WorkflowAttemptRegistry {
  readonly #rootAttemptId: string;
  readonly #stageAttempts = new Set<string>();

  constructor(rootAttemptId: string) {
    this.#rootAttemptId = rootAttemptId;
  }

  add(attemptId: string): void {
    this.#stageAttempts.add(attemptId);
  }

  resolve(invocationId: string): string {
    const prefix = invocationId.split(":", 1)[0] ?? "";
    return this.#stageAttempts.has(prefix)
      ? prefix
      : this.#rootAttemptId;
  }

  attemptIds(): string[] {
    return [this.#rootAttemptId, ...this.#stageAttempts];
  }
}

export class ControlPlaneRecordingModelEngine implements ModelEngine {
  readonly manifest: ModelEngine["manifest"];
  readonly #engine: ModelEngine;
  readonly #controlPlane: ControlPlane;
  readonly #registry: WorkflowAttemptRegistry;
  readonly #modelId: string;

  constructor(input: {
    engine: ModelEngine;
    controlPlane: ControlPlane;
    registry: WorkflowAttemptRegistry;
    modelId: string;
  }) {
    this.#engine = input.engine;
    this.manifest = input.engine.manifest;
    this.#controlPlane = input.controlPlane;
    this.#registry = input.registry;
    this.#modelId = input.modelId;
  }

  async generate(
    request: InferenceRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InferenceResult> {
    const invocation = this.#controlPlane.startInvocation({
      attemptId: this.#registry.resolve(request.invocationId),
      engineId: this.manifest.profileId,
      modelId: this.#modelId,
    });
    try {
      const result = await this.#engine.generate(request, options);
      this.#controlPlane.finishInvocation({
        id: invocation.id,
        status:
          result.finishReason === "canceled"
            ? "canceled"
            : result.finishReason === "error"
              ? "failed"
              : "succeeded",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cost: result.usage.cost,
        measurementStatus: result.usage.measurementStatus,
      });
      return result;
    } catch (error) {
      this.#controlPlane.finishInvocation({
        id: invocation.id,
        status: options?.signal?.aborted ? "canceled" : "failed",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        measurementStatus: "unknown",
      });
      throw error;
    }
  }

  async cancel(invocationId: string): Promise<void> {
    await this.#engine.cancel?.(invocationId);
  }
}

function stageError(error: unknown): { code: string; message: string } {
  if (error instanceof PeerTeamControllerError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "PEER_STAGE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createControlPlanePeerTeamLifecycle(input: {
  controlPlane: ControlPlane;
  parentAttemptId: string;
  actor: string;
  registry: WorkflowAttemptRegistry;
  maxChildren: number;
}): Partial<PeerTeamLifecycle> {
  const envelopes = new Map<
    string,
    { envelope: PeerHandoffEnvelope; envelopeHash: string }
  >();
  return {
    createHandoff(value) {
      envelopes.set(value.envelopeHash, value);
    },
    startStage(stage) {
      const handoff = stage.envelopeHash
        ? envelopes.get(stage.envelopeHash)
        : undefined;
      const child = input.controlPlane.startChildAttempt({
        parentAttemptId: input.parentAttemptId,
        roleId: stage.role,
        actor: input.actor,
        maxChildren: input.maxChildren,
        stageIndex: stage.index,
        cycle: stage.cycle,
        stageKind: stage.kind,
        ...(stage.envelopeHash
          ? {
              handoffHash: stage.envelopeHash,
              ...(handoff
                ? { commandId: handoff.envelope.commandId }
                : {}),
            }
          : {}),
      });
      input.registry.add(child.id);
      return { attemptId: child.id };
    },
    finishStage(stage) {
      const failure = stage.error ? stageError(stage.error) : undefined;
      input.controlPlane.finishChildAttempt({
        id: stage.attemptId,
        status: stage.status,
        actor: input.actor,
        ...(failure
          ? {
              errorCode: failure.code,
              errorMessage: failure.message,
            }
          : {}),
      });
    },
    finishHandoff({ envelopeHash }) {
      envelopes.delete(envelopeHash);
    },
  };
}
