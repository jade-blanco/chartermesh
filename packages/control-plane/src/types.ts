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
}
