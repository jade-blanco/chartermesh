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
  contractVersion: "v1alpha1";
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
}

export interface HostRunHandle {
  hostRunId: string;
  status: "starting" | "running" | "waiting_for_approval";
}

export interface AgentHost {
  readonly manifest: AgentHostManifest;
  start(
    request: HostRunRequest,
    options?: { signal?: AbortSignal },
  ): Promise<HostRunHandle>;
  cancel(hostRunId: string): Promise<void>;
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
