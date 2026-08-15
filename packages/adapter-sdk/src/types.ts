export type CapabilityStability = "stable" | "beta" | "experimental";

export type CapabilitySupport =
  | "native"
  | "emulated"
  | "manual_step_required"
  | "unsupported";

export type PermissionClass =
  | "read_only"
  | "workspace_write"
  | "external_side_effect";

export interface CapabilityDescriptor {
  name: string;
  support: CapabilitySupport;
  stability: CapabilityStability;
  constraints?: Record<string, unknown>;
  permissionBehavior?: "callback" | "inherited" | "unattended" | "unknown";
  workspaceIsolation?: "native" | "optional" | "none" | "unknown";
  costVisibility?: "measured" | "estimated" | "unknown";
}

export interface ModelEngineManifest {
  kind: "model_engine";
  profileId: string;
  adapter: string;
  contractVersion: "v1alpha1";
  capabilities: CapabilityDescriptor[];
}

export interface AgentHostManifest {
  kind: "agent_host";
  profileId: string;
  adapter: string;
  contractVersion: "v1alpha2";
  permissionCeiling: PermissionClass;
  engineBinding: "host_managed";
  modelCapabilities?: CapabilityDescriptor[];
  capabilities: CapabilityDescriptor[];
}

export interface ManagedRunnerManifest {
  kind: "managed_runner";
  profileId: string;
  adapter: string;
  contractVersion: "v1alpha1";
  permissionCeiling: PermissionClass;
  engineBinding: "injectable";
  capabilities: CapabilityDescriptor[];
}

export interface RuntimeManifestSet {
  modelEngines: ModelEngineManifest[];
  agentHosts: AgentHostManifest[];
  managedRunners: ManagedRunnerManifest[];
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InferenceRequest {
  invocationId: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
  measurementStatus: "measured" | "estimated" | "unknown";
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface InferenceResult {
  invocationId: string;
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: "stop" | "tool_call" | "length" | "canceled" | "error";
  usage: ModelUsage;
  providerIdentity?: {
    reportedModelId: string | null;
    reportedSystemFingerprint: string | null;
  };
}

export interface InferenceChunk {
  invocationId: string;
  textDelta?: string;
  toolCallDelta?: Partial<ModelToolCall>;
  usage?: Partial<ModelUsage>;
}

export interface ModelEngine {
  readonly manifest: ModelEngineManifest;
  generate(
    request: InferenceRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InferenceResult>;
  stream?(
    request: InferenceRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InferenceChunk>;
  cancel?(invocationId: string): Promise<void>;
}

export interface HostRunRequest {
  taskPacket: unknown;
  organizationRevision: number;
  workItemId: string;
  runId: string;
  attemptId: string;
  generation: number;
  workspacePath?: string;
}

export type HostRunStatus =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "canceled";

export interface HostRunHandle {
  hostRunId: string;
  hostSessionId?: string;
  status: "starting" | "running" | "waiting_for_approval";
}

export interface AgentHostRunHandle extends HostRunHandle {
  hostSessionId: string;
}

export interface HostResumeRequest extends HostRunRequest {
  hostSessionId: string;
}

/**
 * The signal owns the lifetime of the created host run, not only the start or
 * resume handshake. Aborting it after the handle resolves requests run
 * cancellation. Idempotent callers reuse the signal from the creating call.
 */
export interface AgentHostRunOptions {
  signal?: AbortSignal;
}

export interface AgentHostDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface AgentHostDiscovery {
  available: boolean;
  profileId: string;
  adapter: string;
  providerVersion: string | null;
  protocolVersion: string | null;
  capabilities: CapabilityDescriptor[];
  diagnostics: AgentHostDiagnostic[];
}

export type HostApprovalKind =
  | "command_execution"
  | "file_change"
  | "permission"
  | "user_input"
  | "unknown";

export interface HostApprovalRequest {
  requestId: string;
  kind: HostApprovalKind;
  summary: string;
  actionable: boolean;
  itemId?: string;
}

export interface HostRunError {
  code: string;
  message: string;
  retryable: boolean | null;
}

export type HostRunUsage = ModelUsage;

export interface HostRunResult {
  hostRunId: string;
  hostSessionId: string;
  status: "completed" | "failed" | "canceled";
  outputText: string;
  usage: HostRunUsage;
  error: HostRunError | null;
  cancelReason: HostCancelReason | null;
}

interface HostRunEventBase {
  hostRunId: string;
  hostSessionId: string;
  sequence: number;
  occurredAt: string;
}

export type HostRunEvent =
  | (HostRunEventBase & {
      type: "status";
      status: HostRunStatus;
    })
  | (HostRunEventBase & {
      type: "output_delta";
      delta: string;
    })
  | (HostRunEventBase & {
      type: "approval_required";
      approval: HostApprovalRequest;
    })
  | (HostRunEventBase & {
      type: "warning";
      warning: HostRunError;
    })
  | (HostRunEventBase & {
      type: "terminal";
      result: HostRunResult;
    });

export interface HostCancelReason {
  code:
    | "user_requested"
    | "superseded"
    | "timeout"
    | "shutdown"
    | "safety"
    | "unknown";
  message?: string;
}

export interface AgentHost {
  readonly manifest: AgentHostManifest;
  discover(options?: { signal?: AbortSignal }): Promise<AgentHostDiscovery>;
  start(
    request: HostRunRequest,
    options?: AgentHostRunOptions,
  ): Promise<AgentHostRunHandle>;
  resume(
    request: HostResumeRequest,
    options?: AgentHostRunOptions,
  ): Promise<AgentHostRunHandle>;
  events(
    hostRunId: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<HostRunEvent>;
  result(
    hostRunId: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostRunResult>;
  cancel(hostRunId: string, reason?: HostCancelReason): Promise<void>;
}

export interface ManagedRunner {
  readonly manifest: ManagedRunnerManifest;
  start(
    request: HostRunRequest,
    options: { engine: ModelEngine; signal?: AbortSignal },
  ): Promise<HostRunHandle>;
  cancel(hostRunId: string): Promise<void>;
}

export interface RuntimeRequirement {
  modelCapabilities: string[];
  hostCapabilities: string[];
  allowEmulation: boolean;
  allowExperimental: boolean;
}

export interface RuntimeBindingResolution {
  ok: boolean;
  status: "native" | "degraded" | "unsupported";
  issueCodes: string[];
  capabilitySnapshot: {
    model: CapabilityDescriptor[];
    host: CapabilityDescriptor[];
  };
}
