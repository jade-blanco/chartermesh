export type WorkStatus =
  | "requested"
  | "ready"
  | "in_progress"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "done"
  | "failed"
  | "canceled";

export type Availability =
  | "ready"
  | "dependency_waiting"
  | "user_input_waiting"
  | "approval_waiting"
  | "not_before"
  | "manual_resume"
  | "on_hold"
  | "completed";

export type WaitType =
  | "predecessor"
  | "not_before"
  | "user_input"
  | "manual_resume"
  | "approval";

export interface WaitCondition {
  type: WaitType;
  reason: string;
  createdBy: string;
  reference?: string;
  resumeAt?: string;
}

export interface WorkItem {
  id: string;
  rootId: string;
  parentId: string | null;
  title: string;
  summary: string;
  ownerRole: string;
  executionTarget: string;
  status: WorkStatus;
  availability: Availability;
  priority: number;
  version: number;
  wait: WaitCondition | null;
  nextAction: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserAction {
  id: string;
  workItemId: string;
  category:
    | "human_review"
    | "user_input"
    | "triage"
    | "resume"
    | "start"
    | "retry"
    | "waiting";
  reason: string;
  actor: "human" | "role";
  cta: string;
  actionable: boolean;
  blockedBy: string[];
  priority: number;
  expiresAt?: string;
}

export interface DashboardProjection {
  summary: {
    actionable: number;
    approvals: number;
    userInput: number;
    failed: number;
  };
  workItems: WorkItem[];
  userActions: UserAction[];
  recentEvents: Array<{
    id: number;
    type: string;
    workItemId: string | null;
    actor: string;
    createdAt: string;
  }>;
  page: {
    nextCursor: string | null;
  };
}

export interface RuntimeHealth {
  id: string;
  kind: "model_engine" | "managed_runner" | "agent_host";
  status: "ready" | "configuration_required" | "unavailable";
  detail: string;
}

export interface ArtifactEvidence {
  id: string;
  workItemId: string;
  runId: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  content: string;
  createdAt: string;
}

export interface RuntimeBudgets {
  monthlyCostLimitUsd: number;
  maxConcurrentRuns: number;
  maxDailyModelStarts: number;
  unknownCostPolicy?: "block" | "warn" | "estimate";
  maxArtifactBytes?: number;
  maxWorkItemArtifactBytes?: number;
}

export interface OperationalState {
  paused: boolean;
  pausedAt: string | null;
  reason: string | null;
  actor: string | null;
}

export interface ToolCallApproval {
  id: string;
  workItemId: string;
  callHash: string;
  toolName: string;
  actor: string;
  note: string;
  createdAt: string;
}

export interface ToolExecutionEvidenceRecord {
  id: string;
  workItemId: string;
  runId: string;
  attemptId: string;
  callHash: string;
  toolName: string;
  status: "succeeded" | "approval_required" | "denied" | "failed";
  inputHash: string;
  outputHash: string | null;
  paths: string[];
  durationMs: number;
  createdAt: string;
}

export interface AuditRecord {
  id: number;
  type: string;
  workItemId: string | null;
  actor: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface WorkItemPage {
  items: WorkItem[];
  nextCursor: string | null;
}

export interface ModelInvocationRecord {
  id: string;
  attemptId: string;
  engineId: string;
  modelId: string;
  status: "running" | "succeeded" | "failed" | "canceled" | "abandoned";
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  measurementStatus: "measured" | "estimated" | "unknown";
  startedAt: string;
  finishedAt: string | null;
}

export interface OutboxDelivery {
  id: number;
  eventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attemptCount: number;
}

export interface OutboxRecord extends OutboxDelivery {
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  dispatchedAt: string | null;
  deadLetteredAt: string | null;
  claimedAt: string | null;
  claimOwner: string | null;
}

export interface ScheduleTickRecord {
  id: string;
  scheduleId: string;
  tickKey: string;
  status:
    | "started"
    | "succeeded"
    | "failed"
    | "skipped_no_work"
    | "skipped_overlap";
  workItemId: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}
