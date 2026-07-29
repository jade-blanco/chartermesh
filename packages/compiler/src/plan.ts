import { sha256, validateOrgSpec } from "../../orgspec/src/index.ts";
import type {
  CapabilityDescriptor,
  RuntimeManifestSet,
} from "../../adapter-sdk/src/types.ts";
import type {
  OrganizationSpec,
  RoleSpec,
} from "../../orgspec/src/types.ts";
import type {
  AppliedManifest,
  InstallOperation,
  InstallPlan,
  InstallPlanBody,
  PlanApproval,
  PlanInput,
  PlanWriter,
  RollbackPlan,
  RollbackPlanBody,
} from "./types.ts";

export class InvalidOrgSpecError extends Error {
  readonly code = "INVALID_ORGSPEC";
  readonly issueCodes: string[];

  constructor(issueCodes: string[]) {
    super(`OrgSpec validation failed: ${issueCodes.join(", ")}`);
    this.name = "InvalidOrgSpecError";
    this.issueCodes = issueCodes;
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

function roleTarget(organizationId: string, roleId: string): string {
  return `.chartermesh/generated/${organizationId}/roles/${roleId}.json`;
}

function orderedManifestSnapshot(
  manifests: RuntimeManifestSet,
): RuntimeManifestSet {
  const byProfile = <T extends { profileId: string; capabilities: CapabilityDescriptor[] }>(
    values: T[],
  ): T[] =>
    [...values]
      .sort((left, right) => left.profileId.localeCompare(right.profileId))
      .map((value) => ({
        ...value,
        capabilities: [...value.capabilities].sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
      }));

  return {
    modelEngines: byProfile(manifests.modelEngines),
    agentHosts: byProfile(manifests.agentHosts).map((manifest) => ({
      ...manifest,
      modelCapabilities: manifest.modelCapabilities
        ? [...manifest.modelCapabilities].sort((left, right) =>
            left.name.localeCompare(right.name)
          )
        : undefined,
    })),
    managedRunners: byProfile(manifests.managedRunners),
  };
}

function hostRequirements(role: RoleSpec): string[] {
  const required = new Set(role.requiredRuntimeCapabilities ?? []);
  if (role.orchestration?.strategy === "delegated") {
    required.add("host.delegate.subagent");
  }
  if (role.orchestration?.strategy === "peer_team") {
    required.add("host.delegate.peer_team");
  }
  if (
    role.orchestration &&
    role.orchestration.maxWorkers > 1 &&
    role.orchestration.workspaceIsolation === "required"
  ) {
    required.add("host.workspace.isolated");
  }
  return [...required].sort();
}

function capabilityResolution(
  required: string[],
  available: CapabilityDescriptor[],
): InstallOperation["resolution"] {
  let degraded = false;
  for (const name of required) {
    const capability = available.find((candidate) => candidate.name === name);
    if (
      !capability ||
      capability.support === "unsupported" ||
      capability.support === "manual_step_required"
    ) {
      return "manual_step_required";
    }
    if (
      capability.support === "emulated" ||
      capability.stability !== "stable"
    ) {
      degraded = true;
    }
  }
  return degraded ? "degraded" : "native";
}

function roleResolution(
  next: OrganizationSpec,
  role: RoleSpec,
  manifests: RuntimeManifestSet,
): InstallOperation["resolution"] {
  const target = next.spec.executionTargets.find(
    ({ id }) => id === role.execution.preferred,
  );
  let modelCapabilities: CapabilityDescriptor[] = [];
  let hostCapabilities: CapabilityDescriptor[] = [];

  if (target?.kind === "managed_runner") {
    const runner = next.spec.managedRunners.find(
      ({ id }) => id === target.runnerRef,
    );
    hostCapabilities =
      manifests.managedRunners.find(({ profileId }) => profileId === runner?.id)
        ?.capabilities ?? [];
    modelCapabilities =
      manifests.modelEngines.find(
        ({ profileId }) => profileId === runner?.modelEngineRef,
      )?.capabilities ?? [];
  } else if (target?.kind === "agent_host") {
    const host = manifests.agentHosts.find(
      ({ profileId }) => profileId === target.hostRef,
    );
    hostCapabilities = host?.capabilities ?? [];
    modelCapabilities = host?.modelCapabilities ?? [];
  }

  const model = capabilityResolution(
    role.requiredModelCapabilities ?? [],
    modelCapabilities,
  );
  const host = capabilityResolution(hostRequirements(role), hostCapabilities);
  if (model === "manual_step_required" || host === "manual_step_required") {
    return "manual_step_required";
  }
  return model === "degraded" || host === "degraded" ? "degraded" : "native";
}

function planOperations(
  next: OrganizationSpec,
  manifests: RuntimeManifestSet,
  current?: OrganizationSpec,
): InstallOperation[] {
  const operations: InstallOperation[] = [
    {
      id: "organization-revision",
      action: current ? "replace" : "create",
      target: `.chartermesh/generated/${next.metadata.id}/organization.json`,
      requirements: [],
      resolution: "native",
      beforeHash: current ? sha256(current) : null,
      afterHash: sha256(next),
      risk: "R1",
      approvalRequired: true,
      applyMode: "managed",
      rollback: current ? "restore_if_unchanged" : "delete_if_owned",
    },
  ];

  const currentRoles = new Map(
    (current?.spec.roles ?? []).map((role) => [role.id, role]),
  );
  for (const role of next.spec.roles) {
    const before = currentRoles.get(role.id);
    operations.push({
      id: `role-${role.id}`,
      action: before ? "replace" : "create",
      target: roleTarget(next.metadata.id, role.id),
      requirements: [
        ...(role.requiredModelCapabilities ?? []),
        ...hostRequirements(role),
      ].sort(),
      resolution: roleResolution(next, role, manifests),
      beforeHash: before ? sha256(before) : null,
      afterHash: sha256(role),
      risk: "R1",
      approvalRequired: true,
      applyMode: "managed",
      rollback: before ? "restore_if_unchanged" : "delete_if_owned",
    });
  }

  for (const schedule of next.spec.schedules) {
    const native = (schedule.executor ?? "controller") === "provider_native";
    const activating = schedule.activation === "active";
    operations.push({
      id: `schedule-${schedule.id}`,
      action: native ? "user_action" : activating ? "create" : "user_action",
      target: `schedule:${schedule.id}`,
      requirements: native && schedule.nativeSurface
        ? [`schedule.native.${schedule.nativeSurface}`]
        : [],
      resolution: native || !activating ? "manual_step_required" : "native",
      beforeHash: null,
      afterHash: sha256(schedule),
      risk: "R2",
      approvalRequired: true,
      applyMode: native || !activating ? "manual" : "managed",
      rollback: native ? "manual" : "delete_if_owned",
    });
  }

  return operations;
}

export function createInstallPlan(
  input: PlanInput,
  manifests: RuntimeManifestSet = {
    modelEngines: [],
    agentHosts: [],
    managedRunners: [],
  },
): InstallPlan {
  const validation = validateOrgSpec(input.next, manifests);
  if (!validation.ok) {
    throw new InvalidOrgSpecError(
      validation.issues
        .filter(({ severity }) => severity === "error")
        .map(({ code }) => code),
    );
  }
  if (
    input.current &&
    input.next.metadata.revision <= input.current.metadata.revision
  ) {
    throw new InvalidOrgSpecError(["REVISION_MUST_INCREASE"]);
  }

  const body: InstallPlanBody = {
    apiVersion: "chartermesh.dev/plan/v1alpha1",
    organizationId: input.next.metadata.id,
    fromRevision: input.current?.metadata.revision ?? null,
    toRevision: input.next.metadata.revision,
    specHash: sha256(input.next),
    capabilitySnapshotHash: sha256(orderedManifestSnapshot(manifests)),
    operations: planOperations(input.next, manifests, input.current),
  };

  return { ...body, planHash: sha256(body) };
}

function assertApproval(plan: InstallPlan, approval?: PlanApproval): PlanApproval {
  if (!approval) {
    throw new ApprovalRequiredError("An exact plan approval is required.");
  }
  if (approval.status !== "approved") {
    throw new ApprovalRequiredError(
      `Approval '${approval.id}' is ${approval.status}.`,
    );
  }
  if (
    approval.subject !== "install_plan" ||
    approval.planHash !== plan.planHash ||
    approval.specHash !== plan.specHash
  ) {
    throw new ApprovalRequiredError(
      "Approval hashes do not match the current spec and plan.",
    );
  }
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
    throw new ApprovalRequiredError(`Approval '${approval.id}' has expired.`);
  }
  return approval;
}

export async function applyInstallPlan(
  plan: InstallPlan,
  writer: PlanWriter,
  approval?: PlanApproval,
): Promise<AppliedManifest> {
  const exactApproval = assertApproval(plan, approval);

  for (const operation of plan.operations) {
    if (operation.applyMode === "managed") {
      await writer.apply(operation);
    }
  }

  return {
    organizationId: plan.organizationId,
    revision: plan.toRevision,
    specHash: plan.specHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    planHash: plan.planHash,
    approvalId: exactApproval.id,
    operations: plan.operations,
  };
}

export function createRollbackPlan(
  manifest: AppliedManifest,
  targetRevision: number,
): RollbackPlan {
  if (
    !Number.isInteger(targetRevision) ||
    targetRevision < 1 ||
    targetRevision >= manifest.revision
  ) {
    throw new Error("Rollback target must be a positive earlier revision.");
  }

  const operations = manifest.operations
    .filter(({ applyMode }) => applyMode === "managed")
    .map(
      (operation): InstallOperation => ({
        ...operation,
        id: `rollback-${operation.id}`,
        action:
          operation.rollback === "delete_if_owned" ? "deactivate" : "replace",
        beforeHash: operation.afterHash,
        afterHash: operation.beforeHash,
        approvalRequired: true,
      }),
    );

  const body: RollbackPlanBody = {
    apiVersion: "chartermesh.dev/rollback/v1alpha1",
    organizationId: manifest.organizationId,
    fromRevision: manifest.revision,
    toRevision: targetRevision,
    sourcePlanHash: manifest.planHash,
    operations,
  };

  return { ...body, rollbackPlanHash: sha256(body) };
}
