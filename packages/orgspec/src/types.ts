export type ExecutionMode =
  | "manual_persistent"
  | "on_demand_ephemeral"
  | "scheduled_ephemeral";

export type OrchestrationStrategy = "single" | "delegated" | "peer_team";

export type WorkspaceIsolation =
  | "required"
  | "preferred"
  | "shared_read_only";

export type CommunicationMode = "parent_only" | "peer_messages";

export interface OrchestrationIntent {
  strategy: OrchestrationStrategy;
  maxWorkers: number;
  workspaceIsolation: WorkspaceIsolation;
  communication: CommunicationMode;
  humanApprovalAuthority: "control_plane_only";
  allowExperimental?: boolean;
  fileOwnership?: string[];
}

export interface ExecutionSelection {
  preferred: string;
  fallbacks?: string[];
  allowEmulation?: boolean;
}

export interface ToolPolicy {
  allow: string[];
  approvalRequired?: string[];
  workspaceRoots?: string[];
  maxIterations?: number;
}

export interface RoleSpec {
  id: string;
  name: string;
  class: "c_level" | "worker" | "reviewer" | "deterministic";
  executionMode: ExecutionMode;
  capabilities: string[];
  requiredModelCapabilities?: string[];
  requiredRuntimeCapabilities?: string[];
  promptRef?: string;
  execution: ExecutionSelection;
  concurrency?: number;
  tools: ToolPolicy;
  orchestration?: OrchestrationIntent;
}

export interface WorkflowStage {
  id: string;
  type?: "agent" | "approval" | "deterministic";
  role?: string;
  dependsOn?: string[];
  outputContract?: string;
  acceptanceCriteria?: string[];
  externalSideEffect?: boolean;
  executionApprovalRequired?: boolean;
}

export interface WorkflowSpec {
  id: string;
  name: string;
  trigger: {
    type: "queue" | "manual" | "schedule";
  };
  stages: WorkflowStage[];
}

export interface ScheduleSpec {
  id: string;
  workflow: string;
  cadence: {
    rrule: string;
    timezone: string;
  };
  activation: "proposed" | "active" | "paused";
  executor?: "controller" | "provider_native";
  executionTarget?: string;
  nativeSurface?: "local" | "hosted" | "chat_continuation";
  noWorkBehavior: "skip_without_model" | "start_and_check";
  overlapPolicy: "forbid" | "allow";
  degradedAcknowledged?: boolean;
  emptyStartAccounting?: boolean;
}

export interface ModelEngineProfile {
  id: string;
  adapter: string;
  transport: "http" | "local_process" | "embedded";
  model?: string;
  enabled: boolean;
}

export interface AgentHostProfile {
  id: string;
  adapter: string;
  executionHost: string;
  enabled: boolean;
}

export interface ManagedRunnerProfile {
  id: string;
  adapter: string;
  modelEngineRef: string;
  executionHost: string;
  enabled: boolean;
}

export type ExecutionTargetProfile =
  | {
      id: string;
      kind: "managed_runner";
      runnerRef: string;
      enabled: boolean;
    }
  | {
      id: string;
      kind: "agent_host";
      hostRef: string;
      enabled: boolean;
    };

export interface OrganizationSpec {
  apiVersion: "chartermesh.dev/v1alpha1";
  kind: "Organization";
  metadata: {
    id: string;
    name: string;
    revision: number;
  };
  spec: {
    mission: string;
    operatingProfile: "lean" | "balanced" | "controlled";
    budgets: {
      monthlyCostLimitUsd: number;
      maxConcurrentRuns: number;
      maxDailyModelStarts: number;
      unknownCostPolicy?: "block" | "warn" | "estimate";
      maxArtifactBytes?: number;
      maxWorkItemArtifactBytes?: number;
    };
    modelEngines: ModelEngineProfile[];
    agentHosts: AgentHostProfile[];
    managedRunners: ManagedRunnerProfile[];
    executionTargets: ExecutionTargetProfile[];
    roles: RoleSpec[];
    workflows: WorkflowSpec[];
    schedules: ScheduleSpec[];
    policies: {
      externalSideEffects: "user_approval" | "prohibited";
      destructiveActions: "user_approval" | "prohibited";
      providerFailover: "same_or_lower_permissions";
      organizationChanges: "user_approval";
      firstRunMode: "read_only";
    };
  };
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
