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
    | "complete"
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

export type DecisionKind =
  | "artifact_review"
  | "tool_execution"
  | "user_input";

export type EvidenceSource =
  | "control_plane"
  | "tool_runtime"
  | "host_validator"
  | "model_reported";

export type EvidenceStatus = "verified" | "failed" | "unknown" | "claimed";

export type EvidenceRequirement =
  | { kind: "tool"; toolName: string }
  | { kind: "validator"; validatorId: string };

export interface AcceptanceCriterion {
  id: string;
  text: string;
  critical: boolean;
  evidenceRequirements: EvidenceRequirement[];
}

export interface WorkItemDecisionContract {
  apiVersion: "chartermesh.dev/work-decision-contract/v1alpha1";
  objective: string;
  decisionQuestion: string;
  acceptanceCriteria: AcceptanceCriterion[];
  reviewPolicy: "human_required" | "exception_only";
  source: "user" | "workflow_stage" | "legacy_derived";
  contractHash: string;
}

export interface DecisionPacketEvidence {
  id: string;
  source: EvidenceSource;
  status: EvidenceStatus;
  description: string;
  runId?: string;
  attemptId?: string;
  receiptId?: string;
  provenance?: "control_plane_receipt";
  toolName?: string;
  validatorId?: string;
  inputHash?: string;
  outputHash?: string;
  createdAt: string;
}

export interface ArtifactProducerReport {
  apiVersion: "chartermesh.dev/artifact-producer-report/v1alpha1";
  source: "model_reported" | "runtime_compiled";
  summary: string;
  deliverable: string;
  reportedChecks: string[];
  reportedRisks: string[];
  nextActions: string[];
  confidence: "low" | "medium" | "high" | "unknown";
}

export interface DecisionCriterionResult {
  criterionId: string;
  status: "satisfied" | "failed" | "unverified";
  evidenceRefs: string[];
  explanation: string;
}

export interface DecisionException {
  code:
    | "CONTRACT_INCOMPLETE"
    | "ARTIFACT_UNSTRUCTURED"
    | "EVIDENCE_MISSING"
    | "EVIDENCE_FAILED"
    | "MODEL_REPORTED_ONLY"
    | "LOW_CONFIDENCE"
    | "UNRESOLVED_RISK";
  severity: "info" | "warning" | "blocking";
  owner: "human" | "role" | "system";
  message: string;
  resolution: string;
  evidenceRefs: string[];
}

export type DecisionSubject =
  | {
      kind: "artifact";
      artifactId: string;
      artifactHash: string;
      mediaType: string;
    }
  | {
      kind: "tool_call";
      callHash: string;
      toolName: string;
    }
  | {
      kind: "user_input";
      reference: string;
    };

export interface DecisionPacket {
  apiVersion: "chartermesh.dev/decision-packet/v1alpha2";
  workItemId: string;
  kind: DecisionKind;
  question: string;
  subject: DecisionSubject;
  producerReport: ArtifactProducerReport | null;
  criteria: DecisionCriterionResult[];
  evidence: DecisionPacketEvidence[];
  exceptions: DecisionException[];
  requestedDecision: {
    actor: "human";
    options: Array<
      "approve" | "changes_requested" | "reject" | "provide_input"
    >;
    cta: string;
  };
  binding: {
    contractHash: string;
    subjectHash: string;
    producerReportHash: string | null;
    evidenceSetHash: string;
    workItemVersion: number;
    projectionVersion: "v1alpha2";
    packetHash: string;
  };
}

export interface DecisionReviewView {
  apiVersion: "chartermesh.dev/decision-review-view/v1alpha1";
  workItemId: string;
  kind: DecisionKind;
  question: string;
  subject: DecisionSubject;
  result: ArtifactProducerReport | null;
  criteria: DecisionCriterionResult[];
  evidence: {
    verified: DecisionPacketEvidence[];
    claimed: DecisionPacketEvidence[];
    failed: DecisionPacketEvidence[];
    unknown: DecisionPacketEvidence[];
  };
  exceptions: {
    blocking: DecisionException[];
    warnings: DecisionException[];
    informational: DecisionException[];
  };
  requestedDecision: DecisionPacket["requestedDecision"];
  binding: DecisionPacket["binding"];
}

export interface DashboardProjection {
  summary: {
    actionable: number;
    approvals: number;
    userInput: number;
    failed: number;
    humanDecisions: number;
    agentActions: number;
    waiting: number;
    history: number;
  };
  attention: {
    primaryDecision: UserAction | null;
    queueTruncated: boolean;
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
  producerReport?: ArtifactProducerReport;
  producerReportHash?: string;
  producerReportByteSize?: number;
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
  packetHash: string | null;
  createdAt: string;
}

export interface ToolCallDenial {
  id: string;
  workItemId: string;
  callHash: string;
  toolName: string;
  actor: string;
  note: string;
  packetHash: string;
  createdAt: string;
}

export interface ArtifactReviewDecision {
  id: string;
  workItemId: string;
  artifactHash: string;
  decision: "approve" | "changes_requested" | "reject";
  note: string;
  packetHash: string | null;
  actor: string;
  createdAt: string;
}

export interface UserInputRecord {
  id: string;
  workItemId: string;
  reference: string;
  response: string;
  responseHash: string;
  actor: string;
  createdAt: string;
}

export interface PendingToolCall {
  id: string;
  workItemId: string;
  runId: string;
  attemptId: string;
  callHash: string;
  toolName: string;
  arguments: unknown;
  status: "approval_required" | "executed" | "denied";
  createdAt: string;
  executedAt: string | null;
}

export interface ToolExecutionEvidenceRecord {
  id: string;
  workItemId: string;
  runId: string;
  attemptId: string;
  receiptId: string;
  provenance: "control_plane_receipt";
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

export interface AttemptRecord {
  id: string;
  runId: string;
  parentAttemptId: string | null;
  roleId: string | null;
  kind: "primary" | "delegated";
  attemptNo: number;
  status:
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "canceled";
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
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
