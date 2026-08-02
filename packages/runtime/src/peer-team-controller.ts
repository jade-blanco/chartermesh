import { createHash, randomUUID } from "node:crypto";
import type {
  HostRunRequest,
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelUsage,
} from "../../adapter-sdk/src/types.ts";
import {
  parseStructuredArtifact,
  structuredArtifactSchema,
  type StructuredArtifact,
} from "./managed-runner.ts";

export const PEER_TEAM_CONCURRENCY_CAPABILITY =
  "model.generate.concurrent" as const;

export type PeerArtifactAccess = "read_only" | "isolated";

export interface PeerTeamRole {
  id: string;
  name: string;
  class: "c_level" | "worker";
  description: string;
}

export interface PeerTeamSetup {
  cLevelRole: string;
  roles: PeerTeamRole[];
}

export interface PeerDispatchRecipient {
  role: string;
  instruction: string;
  artifactAccess: PeerArtifactAccess;
}

export interface PeerDispatchDirective {
  action: "dispatch";
  reason: string;
  recipients: PeerDispatchRecipient[];
}

export interface PeerFinalArtifactContract<T> {
  schema: Record<string, unknown>;
  instruction: string;
  parse(value: unknown): T | null;
}

export interface PeerReviewDirective<T = StructuredArtifact> {
  action: "request_review";
  reason: string;
  artifact: T;
}

export type PeerTeamDirective<T = StructuredArtifact> =
  | PeerDispatchDirective
  | PeerReviewDirective<T>;

export interface PeerHandoffEnvelope {
  apiVersion: "chartermesh.dev/peer-handoff/v1alpha1";
  commandId: string;
  workItemId: string;
  runId: string;
  cycle: number;
  sequence: number;
  fromRole: string;
  toRole: string;
  instruction: string;
  artifactAccess: PeerArtifactAccess;
  previousHandoffHashes: string[];
}

export interface PeerTeamStage {
  index: number;
  cycle: number;
  kind: "c_level" | "worker";
  role: string;
  attemptId: string;
  engineId: string;
  status: "succeeded" | "failed" | "canceled";
  latencyMs: number;
  inference?: InferenceResult;
  errorCode?: PeerTeamErrorCode;
}

export interface PeerHandoffRecord {
  envelope: PeerHandoffEnvelope;
  envelopeHash: string;
  engineId: string;
  latencyMs: number;
  inference: InferenceResult;
}

export interface PeerTeamLifecycle {
  setupTeam(input: {
    request: HostRunRequest;
    team: PeerTeamSetup;
  }): Promise<void> | void;
  startStage(input: {
    index: number;
    cycle: number;
    kind: "c_level" | "worker";
    role: string;
    engineId: string;
    envelopeHash?: string;
  }): Promise<{ attemptId: string } | void> | { attemptId: string } | void;
  finishStage(input: {
    index: number;
    cycle: number;
    kind: "c_level" | "worker";
    role: string;
    attemptId: string;
    status: "succeeded" | "failed" | "canceled";
    inference?: InferenceResult;
    error?: unknown;
  }): Promise<void> | void;
  createHandoff(input: {
    envelope: PeerHandoffEnvelope;
    envelopeHash: string;
  }): Promise<void> | void;
  finishHandoff(input: {
    envelope: PeerHandoffEnvelope;
    envelopeHash: string;
    status: "succeeded" | "failed" | "canceled";
    inference?: InferenceResult;
    error?: unknown;
  }): Promise<void> | void;
}

export interface PeerTeamRunMetrics {
  setupModelCalls: 0;
  internalCycles: number;
  cLevelCalls: number;
  workerCalls: number;
  stageCalls: number;
  handoffCount: number;
  configuredMaxParallel: number;
  effectiveMaxParallel: number;
  maxObservedParallel: number;
  usage: ModelUsage;
}

export interface PeerTeamRunResult<T = StructuredArtifact> {
  hostRunId: string;
  inference: InferenceResult;
  artifact: T;
  reviewReason: string;
  stages: PeerTeamStage[];
  handoffs: PeerHandoffRecord[];
  metrics: PeerTeamRunMetrics;
}

export interface PeerTeamControllerConfig {
  maxInternalCycles?: number;
  maxHandoffs?: number;
  maxStageCalls?: number;
  maxParallel?: number;
  maxOutputTokensPerCall?: number;
  maxTotalTokens?: number | null;
  maxDirectiveChars?: number;
  maxWorkerResponseChars?: number;
  maxTranscriptChars?: number;
  abortSettlementMs?: number;
}

export type PeerTeamErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_TEAM_SETUP"
  | "INVALID_TASK_PACKET"
  | "ENGINE_RESOLUTION_FAILED"
  | "STAGE_EXECUTION_FAILED"
  | "LIFECYCLE_FAILED"
  | "CONTROLLER_EXECUTION_FAILED"
  | "PROTOCOL_INVALID_JSON"
  | "PROTOCOL_INVALID_DIRECTIVE"
  | "PROTOCOL_OUTPUT_LIMIT"
  | "PROTOCOL_FINISH_REASON"
  | "INVALID_TARGET"
  | "C_LEVEL_TARGET_FORBIDDEN"
  | "C_LEVEL_ONLY_REVIEW"
  | "REVIEW_BEFORE_HANDOFF"
  | "WORKER_DIRECTIVE_FORBIDDEN"
  | "HANDOFF_LIMIT_EXCEEDED"
  | "STAGE_CALL_LIMIT_EXCEEDED"
  | "TOKEN_LIMIT_EXCEEDED"
  | "TOKEN_USAGE_UNKNOWN"
  | "TRANSCRIPT_LIMIT_EXCEEDED"
  | "LIVENESS_EXHAUSTED"
  | "CANCELLATION_UNSETTLED"
  | "CANCELED";

export interface PeerTeamFailureContext {
  stage:
    | "setup"
    | "c_level"
    | "dispatch"
    | "worker"
    | "review"
    | "liveness"
    | "controller";
  stageIndex: number | null;
  cycle: number | null;
  role: string | null;
}

export interface PeerTeamFailureState {
  metrics: PeerTeamRunMetrics;
  stages: PeerTeamStage[];
}

export class PeerTeamControllerError extends Error {
  readonly code: PeerTeamErrorCode;
  context: PeerTeamFailureContext | null;
  failureState: PeerTeamFailureState | null;

  constructor(
    code: PeerTeamErrorCode,
    message: string,
    cause?: unknown,
    context: PeerTeamFailureContext | null = null,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PeerTeamControllerError";
    this.code = code;
    this.context = context;
    this.failureState = null;
  }

  withContext(context: PeerTeamFailureContext): PeerTeamControllerError {
    this.context ??= context;
    return this;
  }

  withFailureState(state: PeerTeamFailureState): PeerTeamControllerError {
    this.failureState = state;
    return this;
  }
}

interface NormalizedTask {
  objective: string;
  context: string;
  acceptanceCriteria: string[];
}

interface InvocationOutcome<T> {
  inference: InferenceResult;
  value: T;
  latencyMs: number;
  attemptId: string;
}

const roleIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const artifactKeys = [
  "apiVersion",
  "summary",
  "deliverable",
  "checks",
  "risks",
  "nextActions",
  "confidence",
] as const;

const dispatchDirectiveSchema = (
  workerRoleIds: readonly string[],
  maxRecipients = 16,
) => ({
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "recipients"],
  properties: {
    action: { const: "dispatch" },
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    recipients: {
      type: "array",
      minItems: 1,
      maxItems: Math.min(16, maxRecipients),
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "instruction", "artifactAccess"],
        properties: {
          role: { enum: [...workerRoleIds] },
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: 8_000,
          },
          artifactAccess: { enum: ["read_only", "isolated"] },
        },
      },
    },
  },
});

function directiveSchemaFor(
  workerRoleIds: readonly string[],
  artifactSchema: Record<string, unknown>,
  allowDispatch: boolean,
  allowReview: boolean,
  maxDispatchRecipients = 16,
): Record<string, unknown> {
  const dispatch = dispatchDirectiveSchema(
    workerRoleIds,
    maxDispatchRecipients,
  );
  const review = {
      type: "object",
      additionalProperties: false,
      required: ["action", "reason", "artifact"],
      properties: {
        action: { const: "request_review" },
        reason: { type: "string", minLength: 1, maxLength: 2_000 },
        artifact: artifactSchema,
      },
    };
  if (!allowReview) return dispatch;
  if (!allowDispatch) return review;
  return {
    oneOf: [dispatch, review],
  };
}

const defaultFinalArtifactContract: PeerFinalArtifactContract<StructuredArtifact> = {
  schema: structuredArtifactSchema,
  instruction:
    "Submit one complete human-reviewable StructuredArtifact matching the supplied response schema.",
  parse: strictArtifact,
};

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  const expected = [...required].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new PeerTeamControllerError(
        "PROTOCOL_INVALID_DIRECTIVE",
        "A hash-bound handoff contained a non-JSON value.",
      );
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeTask(taskPacket: unknown): NormalizedTask {
  if (!ownRecord(taskPacket)) {
    throw new PeerTeamControllerError(
      "INVALID_TASK_PACKET",
      "Peer-team taskPacket must be an object.",
    );
  }
  const objective = taskPacket.objective;
  const context = taskPacket.context ?? "";
  const criteria = taskPacket.acceptanceCriteria ?? [];
  if (
    !boundedString(objective, 8_000) ||
    typeof context !== "string" ||
    context.length > 20_000 ||
    !Array.isArray(criteria) ||
    criteria.length > 20 ||
    !criteria.every((item) => boundedString(item, 1_000))
  ) {
    throw new PeerTeamControllerError(
      "INVALID_TASK_PACKET",
      "Peer-team taskPacket exceeds its strict objective, context, or acceptance-criteria contract.",
    );
  }
  return {
    objective,
    context,
    acceptanceCriteria: criteria as string[],
  };
}

function validateTeam(team: PeerTeamSetup): Map<string, PeerTeamRole> {
  if (
    !ownRecord(team) ||
    !boundedString(team.cLevelRole, 64) ||
    !Array.isArray(team.roles) ||
    team.roles.length < 2 ||
    team.roles.length > 32
  ) {
    throw new PeerTeamControllerError(
      "INVALID_TEAM_SETUP",
      "A peer team requires one C-level role and at least one worker.",
    );
  }
  const roles = new Map<string, PeerTeamRole>();
  let cLevelCount = 0;
  for (const role of team.roles) {
    if (
      !ownRecord(role) ||
      !exactKeys(role, ["id", "name", "class", "description"]) ||
      typeof role.id !== "string" ||
      !roleIdPattern.test(role.id) ||
      !boundedString(role.name, 120) ||
      !["c_level", "worker"].includes(String(role.class)) ||
      !boundedString(role.description, 2_000) ||
      roles.has(role.id)
    ) {
      throw new PeerTeamControllerError(
        "INVALID_TEAM_SETUP",
        "Peer-team roles must be unique, bounded, and strictly shaped.",
      );
    }
    roles.set(role.id, role as PeerTeamRole);
    if (role.class === "c_level") cLevelCount += 1;
  }
  if (
    cLevelCount !== 1 ||
    roles.get(team.cLevelRole)?.class !== "c_level"
  ) {
    throw new PeerTeamControllerError(
      "INVALID_TEAM_SETUP",
      "cLevelRole must identify the team's only C-level role.",
    );
  }
  return roles;
}

function strictArtifact(value: unknown): StructuredArtifact | null {
  if (!ownRecord(value) || !exactKeys(value, artifactKeys)) return null;
  return parseStructuredArtifact(JSON.stringify(value));
}

export function parsePeerTeamDirective<T = StructuredArtifact>(
  text: string,
  maxChars = 64_000,
  options: {
    finalArtifactContract?: PeerFinalArtifactContract<T>;
    allowedWorkerRoles?: readonly string[];
    allowDispatch?: boolean;
    allowReview?: boolean;
    maxDispatchRecipients?: number;
  } = {},
): PeerTeamDirective<T> {
  const finalArtifactContract =
    options.finalArtifactContract ??
    (defaultFinalArtifactContract as unknown as PeerFinalArtifactContract<T>);
  const allowedWorkerRoles = options.allowedWorkerRoles
    ? new Set(options.allowedWorkerRoles)
    : null;
  if (text.length > maxChars) {
    throw new PeerTeamControllerError(
      "PROTOCOL_OUTPUT_LIMIT",
      `C-level directive exceeded ${maxChars} characters.`,
    );
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new PeerTeamControllerError(
      "PROTOCOL_INVALID_JSON",
      "C-level output must be exactly one JSON object without prose or fences.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new PeerTeamControllerError(
      "PROTOCOL_INVALID_JSON",
      "C-level output was not valid JSON.",
      error,
    );
  }
  if (!ownRecord(value) || typeof value.action !== "string") {
    throw new PeerTeamControllerError(
      "PROTOCOL_INVALID_DIRECTIVE",
      "C-level JSON did not contain a supported action.",
    );
  }
  if (value.action === "dispatch") {
    if (options.allowDispatch === false) {
      throw new PeerTeamControllerError(
        "HANDOFF_LIMIT_EXCEEDED",
        "C-level cannot dispatch another handoff at this stage.",
      );
    }
    if (
      !exactKeys(value, ["action", "reason", "recipients"]) ||
      !boundedString(value.reason, 2_000) ||
      !Array.isArray(value.recipients) ||
      value.recipients.length < 1 ||
      value.recipients.length > (options.maxDispatchRecipients ?? 16)
    ) {
      throw new PeerTeamControllerError(
        "PROTOCOL_INVALID_DIRECTIVE",
        "dispatch must contain bounded reason and recipients fields only.",
      );
    }
    const recipients: PeerDispatchRecipient[] = [];
    for (const candidate of value.recipients) {
      if (
        !ownRecord(candidate) ||
        !exactKeys(candidate, ["role", "instruction", "artifactAccess"]) ||
        !boundedString(candidate.role, 64) ||
        !boundedString(candidate.instruction, 8_000) ||
        !["read_only", "isolated"].includes(String(candidate.artifactAccess))
      ) {
        throw new PeerTeamControllerError(
          "PROTOCOL_INVALID_DIRECTIVE",
          "Each dispatch recipient must have a bounded role, instruction, and safe artifactAccess.",
        );
      }
      if (allowedWorkerRoles && !allowedWorkerRoles.has(candidate.role)) {
        throw new PeerTeamControllerError(
          "INVALID_TARGET",
          `C-level dispatched unknown role ${candidate.role}.`,
        );
      }
      recipients.push(candidate as unknown as PeerDispatchRecipient);
    }
    return {
      action: "dispatch",
      reason: value.reason,
      recipients,
    };
  }
  if (value.action === "request_review") {
    if (options.allowReview === false) {
      throw new PeerTeamControllerError(
        "REVIEW_BEFORE_HANDOFF",
        "C-level must complete at least one command handoff before requesting review.",
      );
    }
    let artifact: T | null = null;
    try {
      artifact = finalArtifactContract.parse(value.artifact);
    } catch (error) {
      throw new PeerTeamControllerError(
        "PROTOCOL_INVALID_DIRECTIVE",
        "The final artifact contract parser rejected the review artifact.",
        error,
      );
    }
    if (
      !exactKeys(value, ["action", "reason", "artifact"]) ||
      !boundedString(value.reason, 2_000) ||
      !artifact
    ) {
      throw new PeerTeamControllerError(
        "PROTOCOL_INVALID_DIRECTIVE",
        "request_review must contain an artifact accepted by the caller-owned final contract.",
      );
    }
    return { action: "request_review", reason: value.reason, artifact };
  }
  throw new PeerTeamControllerError(
    "PROTOCOL_INVALID_DIRECTIVE",
    `Unsupported C-level action: ${value.action}.`,
  );
}

function aggregateUsage(results: readonly InferenceResult[]): ModelUsage {
  const sum = (field: keyof Omit<ModelUsage, "measurementStatus">) => {
    const values = results.map(({ usage }) => usage[field]);
    return values.some((value) => value === null)
      ? null
      : values.reduce<number>((total, value) => total + value!, 0);
  };
  const statuses = results.map(({ usage }) => usage.measurementStatus);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    cost: sum("cost"),
    measurementStatus: statuses.includes("unknown")
      ? "unknown"
      : statuses.includes("estimated")
        ? "estimated"
        : "measured",
  };
}

function engineKey(engine: ModelEngine): string {
  return sha256(engine.manifest);
}

function engineParallelLimit(engine: ModelEngine, configured: number): number {
  const capability = engine.manifest.capabilities.find(
    ({ name }) => name === PEER_TEAM_CONCURRENCY_CAPABILITY,
  );
  if (capability?.support !== "native") return 1;
  const declared = capability.constraints?.maxParallel;
  return typeof declared === "number" && integerInRange(declared, 1, 32)
    ? Math.min(configured, declared)
    : 1;
}

function canceled(cause?: unknown): PeerTeamControllerError {
  return new PeerTeamControllerError(
    "CANCELED",
    "Peer-team execution was canceled.",
    cause,
  );
}

function errorCode(error: unknown): PeerTeamErrorCode | undefined {
  return error instanceof PeerTeamControllerError ? error.code : undefined;
}

function assertEngine(value: unknown, role: string): asserts value is ModelEngine {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Partial<ModelEngine>).generate !== "function" ||
    !ownRecord((value as Partial<ModelEngine>).manifest) ||
    !boundedString((value as ModelEngine).manifest.profileId, 200)
  ) {
    throw new PeerTeamControllerError(
      "ENGINE_RESOLUTION_FAILED",
      `engineForRole did not resolve a valid ModelEngine for ${role}.`,
    );
  }
}

export class PeerTeamController {
  readonly capability: {
    readonly name: "orchestration.peer_team";
    readonly support: "emulated";
    readonly stability: "experimental";
    readonly constraints: {
      readonly communication: "command_handoff";
      readonly humanApprovalAuthority: "control_plane_only";
      readonly setupModelCalls: 0;
      readonly maxInternalCycles: number;
      readonly maxHandoffs: number;
      readonly maxStageCalls: number;
      readonly maxParallel: number;
      readonly abortSettlementMs: number;
      readonly maxTotalTokens: number | null;
    };
  };

  private readonly maxInternalCycles: number;
  private readonly maxHandoffs: number;
  private readonly maxStageCalls: number;
  private readonly maxParallel: number;
  private readonly maxOutputTokensPerCall: number;
  private readonly maxTotalTokens: number | null;
  private readonly maxDirectiveChars: number;
  private readonly maxWorkerResponseChars: number;
  private readonly maxTranscriptChars: number;
  private readonly abortSettlementMs: number;

  constructor(config: PeerTeamControllerConfig = {}) {
    this.maxInternalCycles = config.maxInternalCycles ?? 10;
    this.maxHandoffs = config.maxHandoffs ?? 40;
    this.maxStageCalls = config.maxStageCalls ?? 1_000;
    this.maxParallel = config.maxParallel ?? 4;
    this.maxOutputTokensPerCall = config.maxOutputTokensPerCall ?? 2_048;
    this.maxTotalTokens = config.maxTotalTokens ?? null;
    this.maxDirectiveChars = config.maxDirectiveChars ?? 64_000;
    this.maxWorkerResponseChars = config.maxWorkerResponseChars ?? 32_000;
    this.maxTranscriptChars = config.maxTranscriptChars ?? 256_000;
    this.abortSettlementMs = config.abortSettlementMs ?? 65_000;
    if (
      !integerInRange(this.maxInternalCycles, 1, 100) ||
      !integerInRange(this.maxHandoffs, 1, 1_000) ||
      !integerInRange(this.maxStageCalls, 1, 100_000) ||
      !integerInRange(this.maxParallel, 1, 32) ||
      !integerInRange(this.maxOutputTokensPerCall, 128, 8_192) ||
      (this.maxTotalTokens !== null &&
        (!Number.isSafeInteger(this.maxTotalTokens) ||
          this.maxTotalTokens < 1)) ||
      !integerInRange(this.maxDirectiveChars, 1_024, 1_000_000) ||
      !integerInRange(this.maxWorkerResponseChars, 1_024, 1_000_000) ||
      !integerInRange(this.maxTranscriptChars, 4_096, 4_000_000) ||
      !integerInRange(this.abortSettlementMs, 10, 300_000)
    ) {
      throw new PeerTeamControllerError(
        "INVALID_CONFIGURATION",
        "Peer-team limits must be bounded positive integers.",
      );
    }
    this.capability = {
      name: "orchestration.peer_team",
      support: "emulated",
      stability: "experimental",
      constraints: {
        communication: "command_handoff",
        humanApprovalAuthority: "control_plane_only",
        setupModelCalls: 0,
        maxInternalCycles: this.maxInternalCycles,
        maxHandoffs: this.maxHandoffs,
        maxStageCalls: this.maxStageCalls,
        maxParallel: this.maxParallel,
        abortSettlementMs: this.abortSettlementMs,
        maxTotalTokens: this.maxTotalTokens,
      },
    };
  }

  async run<T = StructuredArtifact>(
    request: HostRunRequest,
    options: {
      team: PeerTeamSetup;
      engine: ModelEngine;
      finalArtifactContract?: PeerFinalArtifactContract<T>;
      engineForRole?: (role: string) => ModelEngine;
      lifecycle?: Partial<PeerTeamLifecycle>;
      reviewRequiresHandoff?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<PeerTeamRunResult<T>> {
    let task: NormalizedTask;
    let roleMap: Map<string, PeerTeamRole>;
    try {
      task = normalizeTask(request.taskPacket);
      roleMap = validateTeam(options.team);
    } catch (error) {
      throw error instanceof PeerTeamControllerError
        ? error.withContext({
            stage: "setup",
            stageIndex: null,
            cycle: null,
            role: null,
          })
        : error;
    }
    const cLevel = roleMap.get(options.team.cLevelRole);
    if (!cLevel) {
      throw new PeerTeamControllerError(
        "INVALID_TEAM_SETUP",
        "The configured C-level role was not found.",
        undefined,
        {
          stage: "setup",
          stageIndex: null,
          cycle: null,
          role: options.team.cLevelRole,
        },
      );
    }
    const finalArtifactContract =
      options.finalArtifactContract ??
      (defaultFinalArtifactContract as unknown as PeerFinalArtifactContract<T>);
    if (
      !ownRecord(finalArtifactContract) ||
      !ownRecord(finalArtifactContract.schema) ||
      !boundedString(finalArtifactContract.instruction, 4_000) ||
      typeof finalArtifactContract.parse !== "function"
    ) {
      throw new PeerTeamControllerError(
        "INVALID_CONFIGURATION",
        "The caller-owned final artifact contract is invalid.",
        undefined,
        {
          stage: "setup",
          stageIndex: null,
          cycle: null,
          role: cLevel.id,
        },
      );
    }
    const workerRoleIds = options.team.roles
      .filter(({ class: roleClass }) => roleClass === "worker")
      .map(({ id }) => id);
    assertEngine(options.engine, "default");
    if (options.signal?.aborted) throw canceled(options.signal.reason);

    const stages: PeerTeamStage[] = [];
    const handoffs: PeerHandoffRecord[] = [];
    let nextStageIndex = 0;
    let activeWorkers = 0;
    let maxObservedParallel = 0;
    let effectiveMaxParallel = 0;
    let cLevelCalls = 0;
    let workerCalls = 0;
    let consumedTokens = 0;
    let reservedTokens = 0;
    let currentCycle = 0;
    let currentContext: PeerTeamFailureContext = {
      stage: "setup",
      stageIndex: null,
      cycle: null,
      role: cLevel.id,
    };

    const captureFailureState = (
      error: PeerTeamControllerError,
      cycle: number,
    ): PeerTeamControllerError => {
      const orderedStages = [...stages].sort(
        (left, right) => left.index - right.index,
      );
      const successfulInferences = orderedStages.flatMap((stage) =>
        stage.inference ? [stage.inference] : [],
      );
      const hasStartedUnmeteredStage = orderedStages.some(
        (stage) => stage.status !== "succeeded" && !stage.inference,
      );
      const usage = hasStartedUnmeteredStage
        ? {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cost: null,
            measurementStatus: "unknown" as const,
          }
        : aggregateUsage(successfulInferences);
      return error.withFailureState({
        stages: orderedStages,
        metrics: {
          setupModelCalls: 0,
          internalCycles: Math.max(0, cycle),
          cLevelCalls,
          workerCalls,
          stageCalls: orderedStages.length,
          handoffCount: handoffs.length,
          configuredMaxParallel: this.maxParallel,
          effectiveMaxParallel,
          maxObservedParallel,
          usage,
        },
      });
    };

    const resolveEngine = (role: string): ModelEngine => {
      let engine: unknown;
      try {
        engine = options.engineForRole?.(role) ?? options.engine;
      } catch (error) {
        throw new PeerTeamControllerError(
          "ENGINE_RESOLUTION_FAILED",
          `engineForRole failed for ${role}.`,
          error,
        );
      }
      assertEngine(engine, role);
      return engine;
    };

    const generate = async (
      engine: ModelEngine,
      inferenceRequest: InferenceRequest,
      signal: AbortSignal | undefined,
    ): Promise<InferenceResult> => {
      if (signal?.aborted) throw canceled(signal.reason);
      let abortListener: (() => void) | undefined;
      let cancellation: Promise<void> | undefined;
      const abort = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        abortListener = () => {
          cancellation = engine
            .cancel?.(inferenceRequest.invocationId)
            .catch(() => undefined);
          reject(canceled(signal.reason));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });
      const generation = Promise.resolve().then(() =>
        engine.generate(
          inferenceRequest,
          signal ? { signal } : undefined,
        ),
      );
      try {
        return await Promise.race([generation, abort]);
      } catch (error) {
        if (signal?.aborted) {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.allSettled([
                generation,
                ...(cancellation ? [cancellation] : []),
              ]).then(() => {
                settled = true;
              }),
              new Promise<void>((resolveSettlement) => {
                timer = setTimeout(
                  resolveSettlement,
                  this.abortSettlementMs,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (!settled) {
            throw new PeerTeamControllerError(
              "CANCELLATION_UNSETTLED",
              `The model engine did not settle within ${this.abortSettlementMs}ms after cancellation.`,
              error,
            );
          }
        }
        throw error;
      } finally {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      }
    };

    const invoke = async <T>(input: {
      cycle: number;
      kind: "c_level" | "worker";
      role: string;
      engine: ModelEngine;
      messages: InferenceRequest["messages"];
      responseSchema?: Record<string, unknown>;
      envelopeHash?: string;
      signal?: AbortSignal;
      validate: (inference: InferenceResult) => T;
    }): Promise<InvocationOutcome<T>> => {
      if (nextStageIndex >= this.maxStageCalls) {
        throw new PeerTeamControllerError(
          "STAGE_CALL_LIMIT_EXCEEDED",
          `Peer-team execution reached the ${this.maxStageCalls} stage-call limit.`,
          undefined,
          {
            stage: input.kind,
            stageIndex: nextStageIndex,
            cycle: input.cycle,
            role: input.role,
          },
        );
      }
      let maxOutputTokens = this.maxOutputTokensPerCall;
      let tokenReservation = 0;
      let tokenReservationReleased = false;
      const releaseTokenReservation = (): void => {
        if (tokenReservationReleased || tokenReservation === 0) return;
        reservedTokens -= tokenReservation;
        tokenReservationReleased = true;
      };
      if (this.maxTotalTokens !== null) {
        const inputTokenUpperBound = Buffer.byteLength(
          JSON.stringify({
            messages: input.messages,
            responseSchema: input.responseSchema ?? null,
          }),
          "utf8",
        );
        const availableOutputTokens =
          this.maxTotalTokens -
          consumedTokens -
          reservedTokens -
          inputTokenUpperBound;
        if (availableOutputTokens < 1) {
          throw new PeerTeamControllerError(
            "TOKEN_LIMIT_EXCEEDED",
            "The next peer-team stage cannot fit within the remaining token budget.",
            undefined,
            {
              stage: input.kind,
              stageIndex: nextStageIndex,
              cycle: input.cycle,
              role: input.role,
            },
          );
        }
        maxOutputTokens = Math.min(
          maxOutputTokens,
          availableOutputTokens,
        );
        tokenReservation = inputTokenUpperBound + maxOutputTokens;
        reservedTokens += tokenReservation;
      }
      const index = nextStageIndex;
      nextStageIndex += 1;
      const engineId = input.engine.manifest.profileId;
      let started: Awaited<
        ReturnType<NonNullable<PeerTeamLifecycle["startStage"]>>
      >;
      try {
        started = await options.lifecycle?.startStage?.({
          index,
          cycle: input.cycle,
          kind: input.kind,
          role: input.role,
          engineId,
          ...(input.envelopeHash
            ? { envelopeHash: input.envelopeHash }
            : {}),
        });
      } catch (error) {
        releaseTokenReservation();
        throw captureFailureState(
          new PeerTeamControllerError(
            "LIFECYCLE_FAILED",
            `Lifecycle startStage failed for ${input.role}.`,
            error,
            {
              stage: input.kind,
              stageIndex: index,
              cycle: input.cycle,
              role: input.role,
            },
          ),
          input.cycle,
        );
      }
      const attemptId =
        started?.attemptId ??
        `${request.attemptId}:${input.role}:${input.cycle}:${randomUUID()}`;
      const invocationId = `${attemptId}:inference`;
      const startedAt = performance.now();
      let inference: InferenceResult | undefined;
      if (input.kind === "c_level") cLevelCalls += 1;
      else workerCalls += 1;
      try {
        inference = await generate(
          input.engine,
          {
            invocationId,
            messages: input.messages,
            ...(input.responseSchema
              ? { responseSchema: input.responseSchema }
              : {}),
            maxOutputTokens,
          },
          input.signal,
        );
        if (this.maxTotalTokens !== null) {
          if (
            inference.usage.inputTokens === null ||
            inference.usage.outputTokens === null
          ) {
            throw new PeerTeamControllerError(
              "TOKEN_USAGE_UNKNOWN",
              "A peer-team stage did not report token usage under an explicit cap.",
            );
          }
          releaseTokenReservation();
          consumedTokens +=
            inference.usage.inputTokens + inference.usage.outputTokens;
          if (consumedTokens + reservedTokens > this.maxTotalTokens) {
            throw new PeerTeamControllerError(
              "TOKEN_LIMIT_EXCEEDED",
              "A peer-team stage exceeded the explicit token budget.",
            );
          }
        }
        if (inference.finishReason !== "stop") {
          throw new PeerTeamControllerError(
            "PROTOCOL_FINISH_REASON",
            `${input.role} ended with ${inference.finishReason}; no partial output is accepted.`,
          );
        }
        const value = input.validate(inference);
        const latencyMs = Math.round(performance.now() - startedAt);
        stages.push({
          index,
          cycle: input.cycle,
          kind: input.kind,
          role: input.role,
          attemptId,
          engineId,
          status: "succeeded",
          latencyMs,
          inference,
        });
        await options.lifecycle?.finishStage?.({
          index,
          cycle: input.cycle,
          kind: input.kind,
          role: input.role,
          attemptId,
          status: "succeeded",
          inference,
        });
        return { inference, value, latencyMs, attemptId };
      } catch (error) {
        if (stages.some((stage) => stage.index === index)) {
          throw captureFailureState(
            new PeerTeamControllerError(
              "LIFECYCLE_FAILED",
              `Lifecycle finishStage failed for ${input.role}.`,
              error,
              {
                stage: input.kind,
                stageIndex: index,
                cycle: input.cycle,
                role: input.role,
              },
            ),
            input.cycle,
          );
        }
        const failureStage: PeerTeamFailureContext["stage"] =
          error instanceof PeerTeamControllerError &&
          ["INVALID_TARGET", "C_LEVEL_TARGET_FORBIDDEN"].includes(error.code)
            ? "dispatch"
            : error instanceof PeerTeamControllerError &&
                ["REVIEW_BEFORE_HANDOFF", "C_LEVEL_ONLY_REVIEW"].includes(
                  error.code,
                )
              ? "review"
              : input.kind;
        const contextualError =
          error instanceof PeerTeamControllerError
            ? error.withContext({
                stage: failureStage,
                stageIndex: index,
                cycle: input.cycle,
                role: input.role,
              })
            : new PeerTeamControllerError(
                "STAGE_EXECUTION_FAILED",
                `Model stage failed for ${input.role}.`,
                error,
                {
                  stage: failureStage,
                  stageIndex: index,
                  cycle: input.cycle,
                  role: input.role,
                },
              );
        const status =
          input.signal?.aborted ||
          (contextualError instanceof PeerTeamControllerError &&
            contextualError.code === "CANCELED")
            ? "canceled"
            : "failed";
        const latencyMs = Math.round(performance.now() - startedAt);
        const code = errorCode(contextualError);
        stages.push({
          index,
          cycle: input.cycle,
          kind: input.kind,
          role: input.role,
          attemptId,
          engineId,
          status,
          latencyMs,
          ...(inference ? { inference } : {}),
          ...(code ? { errorCode: code } : {}),
        });
        await options.lifecycle?.finishStage?.({
          index,
          cycle: input.cycle,
          kind: input.kind,
          role: input.role,
          attemptId,
          status,
          ...(inference ? { inference } : {}),
          error: contextualError,
        });
        throw captureFailureState(contextualError, input.cycle);
      } finally {
        releaseTokenReservation();
      }
    };

    try {
      await options.lifecycle?.setupTeam?.({ request, team: options.team });

    const transcript = () => {
      const value = handoffs.map(({ envelope, envelopeHash, inference }) => ({
          commandId: envelope.commandId,
          envelopeHash,
          fromRole: envelope.fromRole,
          toRole: envelope.toRole,
          artifactAccess: envelope.artifactAccess,
          instruction: envelope.instruction,
          result: inference.text,
        }));
      if (JSON.stringify(value).length > this.maxTranscriptChars) {
        throw new PeerTeamControllerError(
          "TRANSCRIPT_LIMIT_EXCEEDED",
          `Peer-team transcript exceeded ${this.maxTranscriptChars} characters.`,
        );
      }
      return value;
    };

    const cLevelMessages = (
      cycle: number,
      allowDispatch: boolean,
      allowReview: boolean,
    ): InferenceRequest["messages"] => [
      {
        role: "system",
        content: [
          "You are the C-level coordinator of a bounded peer team.",
          "Return exactly one JSON object and no Markdown, prose, or code fence.",
          ...(allowDispatch
            ? [
                "Use action=dispatch to send command-mediated work to declared worker roles.",
              ]
            : []),
          ...(allowReview
            ? [
                "Use action=request_review when the caller-owned final artifact is ready.",
              ]
            : []),
          finalArtifactContract.instruction,
          "Only you may request human review. Workers cannot approve work or substitute for a human.",
          "Parallel recipients are limited to read_only or isolated artifact access.",
          `This is internal cycle ${cycle} of ${this.maxInternalCycles}.`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          objective: task.objective,
          context: task.context,
          acceptanceCriteria: task.acceptanceCriteria,
          team: options.team,
          completedHandoffs: transcript(),
          finalArtifactInstruction: finalArtifactContract.instruction,
          allowedActions: {
            ...(allowDispatch
              ? {
                  dispatch: {
                    action: "dispatch",
                    reason: "Why these commands are needed",
                    recipients: [
                      {
                        role: "a declared worker role id",
                        instruction: "A bounded command",
                        artifactAccess: "read_only or isolated",
                      },
                    ],
                  },
                }
              : {}),
            ...(allowReview
              ? {
                  request_review: {
                    action: "request_review",
                    reason:
                      "Why the caller-owned artifact is ready for human review",
                    artifact:
                      "Emit the artifact object required by the supplied response schema, never a JSON string.",
                  },
                }
              : {}),
          },
        }),
      },
    ];

    const workerMessages = (
      envelope: PeerHandoffEnvelope,
      envelopeHash: string,
    ): InferenceRequest["messages"] => [
      {
        role: "system",
        content: [
          `You are worker role ${envelope.toRole} in a bounded peer team.`,
          "Execute only the supplied command using its declared artifact-access boundary.",
          "Return a concise work result, evidence, risks, and blockers for the C-level coordinator.",
          "Do not dispatch another role and do not request human review or approval.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          objective: task.objective,
          context: task.context,
          acceptanceCriteria: task.acceptanceCriteria,
          assignedRole: roleMap.get(envelope.toRole),
          command: envelope,
          envelopeHash,
        }),
      },
    ];

    const inspectWorkerResult = (inference: InferenceResult): string => {
      if (inference.text.length > this.maxWorkerResponseChars) {
        throw new PeerTeamControllerError(
          "PROTOCOL_OUTPUT_LIMIT",
          `Worker output exceeded ${this.maxWorkerResponseChars} characters.`,
        );
      }
      const trimmed = inference.text.trim();
      if (!trimmed) {
        throw new PeerTeamControllerError(
          "PROTOCOL_INVALID_DIRECTIVE",
          "Worker returned an empty result.",
        );
      }
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const value = JSON.parse(trimmed) as unknown;
          if (ownRecord(value) && value.action === "request_review") {
            throw new PeerTeamControllerError(
              "C_LEVEL_ONLY_REVIEW",
              "A worker attempted to request human review; only C-level may do so.",
            );
          }
          if (ownRecord(value) && value.action === "dispatch") {
            throw new PeerTeamControllerError(
              "WORKER_DIRECTIVE_FORBIDDEN",
              "A worker attempted to dispatch another role outside the command channel.",
            );
          }
        } catch (error) {
          if (error instanceof PeerTeamControllerError) throw error;
        }
      }
      return inference.text;
    };

    for (let cycle = 1; cycle <= this.maxInternalCycles; cycle += 1) {
      currentCycle = cycle;
      currentContext = {
        stage: "c_level",
        stageIndex: nextStageIndex,
        cycle,
        role: cLevel.id,
      };
      if (options.signal?.aborted) throw canceled(options.signal.reason);
      const cLevelEngine = resolveEngine(cLevel.id);
      const allowDispatch = handoffs.length < this.maxHandoffs;
      const allowReview =
        !options.reviewRequiresHandoff || handoffs.length > 0;
      const maxDispatchRecipients = Math.max(
        1,
        Math.min(16, this.maxHandoffs - handoffs.length),
      );
      const decision = await invoke({
        cycle,
        kind: "c_level",
        role: cLevel.id,
        engine: cLevelEngine,
        messages: cLevelMessages(cycle, allowDispatch, allowReview),
        responseSchema: directiveSchemaFor(
          workerRoleIds,
          finalArtifactContract.schema,
          allowDispatch,
          allowReview,
          maxDispatchRecipients,
        ),
        ...(options.signal ? { signal: options.signal } : {}),
        validate: ({ text }) =>
          parsePeerTeamDirective<T>(text, this.maxDirectiveChars, {
            finalArtifactContract,
            allowedWorkerRoles: workerRoleIds,
            allowDispatch,
            allowReview,
            maxDispatchRecipients,
          }),
      });

      if (decision.value.action === "request_review") {
        const artifactText = JSON.stringify(decision.value.artifact);
        if (!artifactText) {
          throw captureFailureState(new PeerTeamControllerError(
            "PROTOCOL_INVALID_DIRECTIVE",
            "The caller-owned final artifact was not JSON serializable.",
            undefined,
            {
              stage: "review",
              stageIndex: stages.length - 1,
              cycle,
              role: cLevel.id,
            },
          ), cycle);
        }
        const finalInference: InferenceResult = {
          ...decision.inference,
          text: artifactText,
        };
        const orderedStages = [...stages].sort(
          (left, right) => left.index - right.index,
        );
        const successfulInferences = orderedStages.flatMap((stage) =>
          stage.inference ? [stage.inference] : [],
        );
        return {
          hostRunId: `peer-team-${randomUUID()}`,
          inference: finalInference,
          artifact: decision.value.artifact,
          reviewReason: decision.value.reason,
          stages: orderedStages,
          handoffs,
          metrics: {
            setupModelCalls: 0,
            internalCycles: cycle,
            cLevelCalls,
            workerCalls,
            stageCalls: orderedStages.length,
            handoffCount: handoffs.length,
            configuredMaxParallel: this.maxParallel,
            effectiveMaxParallel,
            maxObservedParallel,
            usage: aggregateUsage(successfulInferences),
          },
        };
      }

      if (
        handoffs.length + decision.value.recipients.length >
        this.maxHandoffs
      ) {
        throw captureFailureState(new PeerTeamControllerError(
          "HANDOFF_LIMIT_EXCEEDED",
          `Dispatch would exceed the ${this.maxHandoffs} handoff limit.`,
          undefined,
          {
            stage: "dispatch",
            stageIndex: decision.value.recipients.length + stages.length,
            cycle,
            role: cLevel.id,
          },
        ), cycle);
      }

      currentContext = {
        stage: "dispatch",
        stageIndex: nextStageIndex,
        cycle,
        role: cLevel.id,
      };
      const pending = decision.value.recipients.map((recipient, offset) => {
        const role = roleMap.get(recipient.role);
        if (!role) {
          throw captureFailureState(new PeerTeamControllerError(
            "INVALID_TARGET",
            `C-level dispatched unknown role ${recipient.role}.`,
            undefined,
            {
              stage: "dispatch",
              stageIndex: stages.length,
              cycle,
              role: cLevel.id,
            },
          ), cycle);
        }
        if (role.class === "c_level") {
          throw captureFailureState(new PeerTeamControllerError(
            "C_LEVEL_TARGET_FORBIDDEN",
            "C-level cannot be used as its own worker target.",
            undefined,
            {
              stage: "dispatch",
              stageIndex: stages.length,
              cycle,
              role: cLevel.id,
            },
          ), cycle);
        }
        const engine = resolveEngine(role.id);
        const envelope: PeerHandoffEnvelope = {
          apiVersion: "chartermesh.dev/peer-handoff/v1alpha1",
          commandId: randomUUID(),
          workItemId: request.workItemId,
          runId: request.runId,
          cycle,
          sequence: handoffs.length + offset + 1,
          fromRole: cLevel.id,
          toRole: role.id,
          instruction: recipient.instruction,
          artifactAccess: recipient.artifactAccess,
          previousHandoffHashes: handoffs.map(({ envelopeHash }) => envelopeHash),
        };
        return {
          recipient,
          role,
          engine,
          envelope,
          envelopeHash: sha256(envelope),
          engineKey: engineKey(engine),
          engineLimit: engineParallelLimit(engine, this.maxParallel),
        };
      });

      const groupCounts = new Map<string, { count: number; limit: number }>();
      for (const item of pending) {
        const current = groupCounts.get(item.engineKey);
        groupCounts.set(item.engineKey, {
          count: (current?.count ?? 0) + 1,
          limit: item.engineLimit,
        });
      }
      const dispatchEffective = Math.min(
        this.maxParallel,
        [...groupCounts.values()].reduce(
          (total, { count, limit }) => total + Math.min(count, limit),
          0,
        ),
      );
      effectiveMaxParallel = Math.max(
        effectiveMaxParallel,
        dispatchEffective,
      );

      for (const item of pending) {
        await options.lifecycle?.createHandoff?.({
          envelope: item.envelope,
          envelopeHash: item.envelopeHash,
        });
      }

      const localAbort = new AbortController();
      const dispatchSignal = options.signal
        ? AbortSignal.any([options.signal, localAbort.signal])
        : localAbort.signal;
      const remaining = new Set(pending.map((_item, index) => index));
      const active = new Map<
        number,
        Promise<{ index: number; record: PeerHandoffRecord }>
      >();
      const activeByEngine = new Map<string, number>();

      const start = (index: number) => {
        const item = pending[index];
        if (!item) return;
        remaining.delete(index);
        activeByEngine.set(
          item.engineKey,
          (activeByEngine.get(item.engineKey) ?? 0) + 1,
        );
        activeWorkers += 1;
        maxObservedParallel = Math.max(maxObservedParallel, activeWorkers);
        const promise = (async () => {
          const startedAt = performance.now();
          try {
            const outcome = await invoke({
              cycle,
              kind: "worker",
              role: item.role.id,
              engine: item.engine,
              messages: workerMessages(item.envelope, item.envelopeHash),
              envelopeHash: item.envelopeHash,
              signal: dispatchSignal,
              validate: inspectWorkerResult,
            });
            const record: PeerHandoffRecord = {
              envelope: item.envelope,
              envelopeHash: item.envelopeHash,
              engineId: item.engine.manifest.profileId,
              latencyMs: Math.round(performance.now() - startedAt),
              inference: outcome.inference,
            };
            await options.lifecycle?.finishHandoff?.({
              envelope: item.envelope,
              envelopeHash: item.envelopeHash,
              status: "succeeded",
              inference: outcome.inference,
            });
            return { index, record };
          } catch (error) {
            const status = dispatchSignal.aborted ? "canceled" : "failed";
            await options.lifecycle?.finishHandoff?.({
              envelope: item.envelope,
              envelopeHash: item.envelopeHash,
              status,
              error,
            });
            throw error;
          } finally {
            activeWorkers -= 1;
            activeByEngine.set(
              item.engineKey,
              Math.max(0, (activeByEngine.get(item.engineKey) ?? 1) - 1),
            );
          }
        })();
        active.set(index, promise);
      };

      const records = new Map<number, PeerHandoffRecord>();
      try {
        while (remaining.size > 0 || active.size > 0) {
          let launched = false;
          if (active.size < this.maxParallel) {
            for (const index of remaining) {
              if (active.size >= this.maxParallel) break;
              const item = pending[index];
              if (
                item &&
                (activeByEngine.get(item.engineKey) ?? 0) < item.engineLimit
              ) {
                start(index);
                launched = true;
              }
            }
          }
          if (active.size === 0) {
            throw new PeerTeamControllerError(
              "INVALID_CONFIGURATION",
              "No dispatch recipient could acquire an engine concurrency slot.",
            );
          }
          if (!launched || active.size >= this.maxParallel || remaining.size === 0) {
            const settled = await Promise.race(active.values());
            active.delete(settled.index);
            records.set(settled.index, settled.record);
          }
        }
      } catch (error) {
        localAbort.abort(error);
        await Promise.allSettled(active.values());
        for (const index of remaining) {
          const item = pending[index];
          if (!item) continue;
          await options.lifecycle?.finishHandoff?.({
            envelope: item.envelope,
            envelopeHash: item.envelopeHash,
            status: "canceled",
            error,
          });
        }
        throw error instanceof PeerTeamControllerError
          ? captureFailureState(error, cycle)
          : error;
      }
      for (let index = 0; index < pending.length; index += 1) {
        const record = records.get(index);
        if (!record) {
          throw new PeerTeamControllerError(
            "PROTOCOL_INVALID_DIRECTIVE",
            "A dispatched handoff completed without a result record.",
          );
        }
        handoffs.push(record);
      }
    }

    throw new PeerTeamControllerError(
      "LIVENESS_EXHAUSTED",
      `C-level did not request human review within ${this.maxInternalCycles} internal cycles.`,
      undefined,
      {
        stage: "liveness",
        stageIndex: stages.length,
        cycle: this.maxInternalCycles,
        role: cLevel.id,
      },
    );
    } catch (error) {
      const normalized =
        error instanceof PeerTeamControllerError
          ? error.withContext(currentContext)
          : new PeerTeamControllerError(
              "CONTROLLER_EXECUTION_FAILED",
              "Peer-team execution failed outside a model-stage protocol boundary.",
              error,
              currentContext,
            );
      throw captureFailureState(normalized, currentCycle);
    }
  }
}
