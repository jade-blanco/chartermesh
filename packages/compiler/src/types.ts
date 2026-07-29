import type { OrganizationSpec } from "../../orgspec/src/types.ts";

export type Risk = "R0" | "R1" | "R2" | "R3";

export interface InstallOperation {
  id: string;
  action: "create" | "replace" | "deactivate" | "user_action";
  target: string;
  requirements: string[];
  resolution: "native" | "degraded" | "manual_step_required";
  beforeHash: string | null;
  afterHash: string | null;
  risk: Risk;
  approvalRequired: boolean;
  applyMode: "managed" | "manual";
  rollback: "delete_if_owned" | "restore_if_unchanged" | "manual";
}

export interface InstallPlanBody {
  apiVersion: "chartermesh.dev/plan/v1alpha1";
  organizationId: string;
  fromRevision: number | null;
  toRevision: number;
  specHash: string;
  capabilitySnapshotHash: string;
  operations: InstallOperation[];
}

export interface InstallPlan extends InstallPlanBody {
  planHash: string;
}

export interface PlanApproval {
  id: string;
  subject: "install_plan";
  status: "approved" | "rejected" | "expired" | "superseded";
  specHash: string;
  planHash: string;
  approvedBy: string;
  expiresAt?: string;
}

export interface AppliedManifest {
  organizationId: string;
  revision: number;
  specHash: string;
  capabilitySnapshotHash: string;
  planHash: string;
  approvalId: string;
  operations: InstallOperation[];
}

export interface PlanWriter {
  apply(operation: InstallOperation): Promise<void>;
}

export interface SpecChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface RollbackPlanBody {
  apiVersion: "chartermesh.dev/rollback/v1alpha1";
  organizationId: string;
  fromRevision: number;
  toRevision: number;
  sourcePlanHash: string;
  operations: InstallOperation[];
}

export interface RollbackPlan extends RollbackPlanBody {
  rollbackPlanHash: string;
}

export interface PlanInput {
  next: OrganizationSpec;
  current?: OrganizationSpec;
}
