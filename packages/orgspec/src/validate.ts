import type {
  CapabilityDescriptor,
  PermissionClass,
  RuntimeManifestSet,
} from "../../adapter-sdk/src/types.ts";
import type {
  ExecutionTargetProfile,
  OrganizationSpec,
  RoleSpec,
  ValidationIssue,
  ValidationResult,
  WorkflowStage,
} from "./types.ts";

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const permissionRank: Record<PermissionClass, number> = {
  read_only: 0,
  workspace_write: 1,
  external_side_effect: 2,
};

const emptyManifests: RuntimeManifestSet = {
  modelEngines: [],
  agentHosts: [],
  managedRunners: [],
};

interface ResolvedExecution {
  target: ExecutionTargetProfile;
  permissionCeiling: PermissionClass;
  modelCapabilities: CapabilityDescriptor[];
  hostCapabilities: CapabilityDescriptor[];
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(
  issues: ValidationIssue[],
  code: string,
  path: string,
  message: string,
  severity: "error" | "warning" = "error",
): void {
  issues.push({ code, path, message, severity });
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues];
}

function validateIds(
  issues: ValidationIssue[],
  path: string,
  values: Array<{ id: string }>,
): void {
  for (const [index, value] of values.entries()) {
    if (!idPattern.test(value.id)) {
      add(
        issues,
        "INVALID_ID",
        `${path}/${index}/id`,
        "IDs must be lower kebab-case and safe for generated paths.",
      );
    }
  }

  for (const duplicate of duplicates(values.map(({ id }) => id))) {
    add(
      issues,
      "DUPLICATE_ID",
      path,
      `Duplicate id '${duplicate}' is not allowed.`,
    );
  }
}

function findCycle(stages: WorkflowStage[]): string[] | null {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    stack.push(id);
    const stage = byId.get(id);
    for (const dependency of stage?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const stage of stages) {
    const cycle = visit(stage.id);
    if (cycle) return cycle;
  }
  return null;
}

function requiredHostCapabilities(role: RoleSpec): string[] {
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
  return [...required];
}

function capability(
  capabilities: CapabilityDescriptor[],
  name: string,
): CapabilityDescriptor | undefined {
  return capabilities.find((candidate) => candidate.name === name);
}

function validateCapabilitySet(
  issues: ValidationIssue[],
  names: string[],
  capabilities: CapabilityDescriptor[],
  path: string,
  mismatchCode: string,
  allowEmulation: boolean,
  allowExperimental: boolean,
): void {
  for (const name of names) {
    const available = capability(capabilities, name);
    if (!available || available.support === "unsupported") {
      add(
        issues,
        mismatchCode,
        path,
        `Execution target does not provide '${name}'.`,
      );
      continue;
    }
    if (available.support === "manual_step_required") {
      add(
        issues,
        "CAPABILITY_MANUAL_ONLY",
        path,
        `Capability '${name}' requires a manual step and cannot satisfy an automatic role.`,
      );
    }
    if (available.support === "emulated" && !allowEmulation) {
      add(
        issues,
        "EMULATED_CAPABILITY_REQUIRES_OPT_IN",
        path,
        `Capability '${name}' is emulated and requires explicit opt-in.`,
      );
    }
    if (available.stability === "experimental" && !allowExperimental) {
      add(
        issues,
        "EXPERIMENTAL_CAPABILITY_REQUIRES_OPT_IN",
        path,
        `Capability '${name}' is experimental and requires explicit opt-in.`,
      );
    }
  }
}

function validateRoleOrchestrationShape(
  issues: ValidationIssue[],
  role: RoleSpec,
  index: number,
): void {
  const path = `/spec/roles/${index}`;
  const orchestration = role.orchestration;
  const approvals = new Set(role.tools.approvalRequired ?? []);
  for (const tool of approvals) {
    if (!role.tools.allow.includes(tool)) {
      add(
        issues,
        "TOOL_APPROVAL_NOT_ALLOWED",
        `${path}/tools/approvalRequired`,
        `Approval-required tool '${tool}' must also appear in allow.`,
      );
    }
  }
  for (const root of role.tools.workspaceRoots ?? ["."]) {
    if (
      root.startsWith("/") ||
      root.startsWith("\\") ||
      /^[a-zA-Z]:/u.test(root) ||
      root.split(/[\\/]/u).includes("..")
    ) {
      add(
        issues,
        "INVALID_TOOL_WORKSPACE_ROOT",
        `${path}/tools/workspaceRoots`,
        `Workspace root '${root}' must be a project-relative path without '..'.`,
      );
    }
  }
  if (
    role.tools.allow.includes("workspace.write_file") &&
    !approvals.has("workspace.write_file")
  ) {
    add(
      issues,
      "WORKSPACE_WRITE_REQUIRES_APPROVAL",
      `${path}/tools/approvalRequired`,
      "workspace.write_file must require exact-call human approval.",
    );
  }
  if (!orchestration) return;

  if (orchestration.maxWorkers < 1) {
    add(
      issues,
      "INVALID_MAX_WORKERS",
      `${path}/orchestration/maxWorkers`,
      "maxWorkers must be at least one.",
    );
  }
  if (orchestration.strategy === "single" && orchestration.maxWorkers !== 1) {
    add(
      issues,
      "SINGLE_WORKER_REQUIRED",
      `${path}/orchestration/maxWorkers`,
      "single orchestration requires exactly one worker.",
    );
  }
  if (
    orchestration.strategy !== "peer_team" &&
    orchestration.communication === "peer_messages"
  ) {
    add(
      issues,
      "PEER_MESSAGES_REQUIRE_TEAM",
      `${path}/orchestration/communication`,
      "Peer messaging is only valid for peer_team orchestration.",
    );
  }

  const writesWorkspace = role.tools.allow.some((tool) =>
    [
      "repo_write",
      "file_write",
      "code_change",
      "workspace.write_file",
    ].includes(tool),
  );
  const isolated =
    orchestration.workspaceIsolation === "required" ||
    (orchestration.fileOwnership?.length ?? 0) >= orchestration.maxWorkers;

  if (writesWorkspace && orchestration.maxWorkers > 1 && !isolated) {
    add(
      issues,
      "PARALLEL_WRITE_REQUIRES_ISOLATION",
      `${path}/orchestration`,
      "Parallel writers require isolated workspaces or one explicit file-ownership entry per worker.",
    );
  }
}

function validateRoleAgainstTarget(
  issues: ValidationIssue[],
  role: RoleSpec,
  roleIndex: number,
  selection: "preferred" | "fallback",
  targetId: string,
  resolved: Map<string, ResolvedExecution>,
): ResolvedExecution | undefined {
  const path = `/spec/roles/${roleIndex}/execution/${selection}`;
  const execution = resolved.get(targetId);
  if (!execution) {
    add(
      issues,
      "UNKNOWN_EXECUTION_TARGET",
      path,
      `Unknown execution target '${targetId}'.`,
    );
    return undefined;
  }
  if (!execution.enabled) {
    add(
      issues,
      "DISABLED_EXECUTION_TARGET",
      path,
      `Execution target '${targetId}' or one of its dependencies is disabled.`,
    );
  }

  const allowExperimental = Boolean(
    role.orchestration?.allowExperimental,
  );
  const allowEmulation = Boolean(role.execution?.allowEmulation);
  validateCapabilitySet(
    issues,
    role.requiredModelCapabilities ?? [],
    execution.modelCapabilities,
    path,
    "MODEL_CAPABILITY_MISMATCH",
    allowEmulation,
    allowExperimental,
  );
  validateCapabilitySet(
    issues,
    requiredHostCapabilities(role),
    execution.hostCapabilities,
    path,
    "HOST_CAPABILITY_MISMATCH",
    allowEmulation,
    allowExperimental,
  );
  return execution;
}

export function validateOrgSpec(
  candidate: unknown,
  runtimeManifests: RuntimeManifestSet = emptyManifests,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isRecord(candidate)) {
    add(issues, "INVALID_ROOT", "/", "OrgSpec must be an object.");
    return { ok: false, issues };
  }

  const spec = candidate as unknown as OrganizationSpec;
  if (spec.apiVersion !== "chartermesh.dev/v1alpha1") {
    add(
      issues,
      "UNSUPPORTED_API_VERSION",
      "/apiVersion",
      "Expected chartermesh.dev/v1alpha1.",
    );
  }
  if (spec.kind !== "Organization") {
    add(issues, "INVALID_KIND", "/kind", "Expected Organization.");
  }
  if (!isRecord(spec.metadata) || !isRecord(spec.spec)) {
    add(
      issues,
      "MISSING_REQUIRED_OBJECT",
      "/",
      "metadata and spec are required objects.",
    );
    return { ok: false, issues };
  }
  if (!idPattern.test(spec.metadata.id ?? "")) {
    add(
      issues,
      "INVALID_ID",
      "/metadata/id",
      "Organization id must be lower kebab-case.",
    );
  }
  if (!Number.isInteger(spec.metadata.revision) || spec.metadata.revision < 1) {
    add(
      issues,
      "INVALID_REVISION",
      "/metadata/revision",
      "Revision must be a positive integer.",
    );
  }

  const modelEngines = Array.isArray(spec.spec.modelEngines)
    ? spec.spec.modelEngines
    : [];
  const agentHosts = Array.isArray(spec.spec.agentHosts)
    ? spec.spec.agentHosts
    : [];
  const managedRunners = Array.isArray(spec.spec.managedRunners)
    ? spec.spec.managedRunners
    : [];
  const executionTargets = Array.isArray(spec.spec.executionTargets)
    ? spec.spec.executionTargets
    : [];
  const roles = Array.isArray(spec.spec.roles) ? spec.spec.roles : [];
  const workflows = Array.isArray(spec.spec.workflows)
    ? spec.spec.workflows
    : [];
  const schedules = Array.isArray(spec.spec.schedules)
    ? spec.spec.schedules
    : [];
  const budgets: OrganizationSpec["spec"]["budgets"] = isRecord(
    spec.spec.budgets,
  )
    ? (spec.spec.budgets as unknown as OrganizationSpec["spec"]["budgets"])
    : {
        monthlyCostLimitUsd: Number.NaN,
        maxConcurrentRuns: Number.NaN,
        maxDailyModelStarts: Number.NaN,
      };

  if (executionTargets.length === 0) {
    add(
      issues,
      "EXECUTION_TARGET_REQUIRED",
      "/spec/executionTargets",
      "At least one execution target is required.",
    );
  }
  if (roles.length === 0) {
    add(
      issues,
      "ROLE_REQUIRED",
      "/spec/roles",
      "At least one role is required.",
    );
  }

  validateIds(issues, "/spec/modelEngines", modelEngines);
  validateIds(issues, "/spec/agentHosts", agentHosts);
  validateIds(issues, "/spec/managedRunners", managedRunners);
  validateIds(issues, "/spec/executionTargets", executionTargets);
  validateIds(issues, "/spec/roles", roles);
  validateIds(issues, "/spec/workflows", workflows);
  validateIds(issues, "/spec/schedules", schedules);

  const engineProfiles = new Map(
    modelEngines.map((profile) => [profile.id, profile]),
  );
  const hostProfiles = new Map(agentHosts.map((profile) => [profile.id, profile]));
  const runnerProfiles = new Map(
    managedRunners.map((profile) => [profile.id, profile]),
  );
  const engineManifests = new Map(
    runtimeManifests.modelEngines.map((manifest) => [manifest.profileId, manifest]),
  );
  const hostManifests = new Map(
    runtimeManifests.agentHosts.map((manifest) => [manifest.profileId, manifest]),
  );
  const runnerManifests = new Map(
    runtimeManifests.managedRunners.map((manifest) => [
      manifest.profileId,
      manifest,
    ]),
  );
  const resolved = new Map<string, ResolvedExecution>();

  for (const [index, runner] of managedRunners.entries()) {
    if (!engineProfiles.has(runner.modelEngineRef)) {
      add(
        issues,
        "UNKNOWN_MODEL_ENGINE",
        `/spec/managedRunners/${index}/modelEngineRef`,
        `Unknown model engine '${runner.modelEngineRef}'.`,
      );
    }
    const manifest = runnerManifests.get(runner.id);
    if (!manifest) {
      add(
        issues,
        "RUNTIME_MANIFEST_MISSING",
        `/spec/managedRunners/${index}`,
        `No managed-runner manifest was discovered for '${runner.id}'.`,
      );
    } else if (manifest.adapter !== runner.adapter) {
      add(
        issues,
        "RUNTIME_ADAPTER_MISMATCH",
        `/spec/managedRunners/${index}/adapter`,
        "Managed-runner profile and manifest adapters differ.",
      );
    }
  }

  for (const [index, engine] of modelEngines.entries()) {
    const manifest = engineManifests.get(engine.id);
    if (!manifest) {
      add(
        issues,
        "RUNTIME_MANIFEST_MISSING",
        `/spec/modelEngines/${index}`,
        `No model-engine manifest was discovered for '${engine.id}'.`,
      );
    } else if (manifest.adapter !== engine.adapter) {
      add(
        issues,
        "RUNTIME_ADAPTER_MISMATCH",
        `/spec/modelEngines/${index}/adapter`,
        "Model-engine profile and manifest adapters differ.",
      );
    }
  }

  for (const [index, host] of agentHosts.entries()) {
    const manifest = hostManifests.get(host.id);
    if (!manifest) {
      add(
        issues,
        "RUNTIME_MANIFEST_MISSING",
        `/spec/agentHosts/${index}`,
        `No agent-host manifest was discovered for '${host.id}'.`,
      );
    } else if (manifest.adapter !== host.adapter) {
      add(
        issues,
        "RUNTIME_ADAPTER_MISMATCH",
        `/spec/agentHosts/${index}/adapter`,
        "Agent-host profile and manifest adapters differ.",
      );
    }
  }

  for (const [index, target] of executionTargets.entries()) {
    const path = `/spec/executionTargets/${index}`;
    if (target.kind === "managed_runner") {
      const runner = runnerProfiles.get(target.runnerRef);
      if (!runner) {
        add(
          issues,
          "UNKNOWN_MANAGED_RUNNER",
          `${path}/runnerRef`,
          `Unknown managed runner '${target.runnerRef}'.`,
        );
        continue;
      }
      const engine = engineProfiles.get(runner.modelEngineRef);
      const runnerManifest = runnerManifests.get(runner.id);
      const engineManifest = engineManifests.get(runner.modelEngineRef);
      if (runnerManifest) {
        resolved.set(target.id, {
          target,
          permissionCeiling: runnerManifest.permissionCeiling,
          modelCapabilities: engineManifest?.capabilities ?? [],
          hostCapabilities: runnerManifest.capabilities,
          enabled: target.enabled && runner.enabled && Boolean(engine?.enabled),
        });
      }
    } else {
      const host = hostProfiles.get(target.hostRef);
      if (!host) {
        add(
          issues,
          "UNKNOWN_AGENT_HOST",
          `${path}/hostRef`,
          `Unknown agent host '${target.hostRef}'.`,
        );
        continue;
      }
      const hostManifest = hostManifests.get(host.id);
      if (hostManifest) {
        resolved.set(target.id, {
          target,
          permissionCeiling: hostManifest.permissionCeiling,
          modelCapabilities: hostManifest.modelCapabilities ?? [],
          hostCapabilities: hostManifest.capabilities,
          enabled: target.enabled && host.enabled,
        });
      }
    }
  }

  const roleIds = new Set(roles.map(({ id }) => id));
  const workflowIds = new Set(workflows.map(({ id }) => id));

  for (const [index, role] of roles.entries()) {
    const preferred = validateRoleAgainstTarget(
      issues,
      role,
      index,
      "preferred",
      role.execution?.preferred,
      resolved,
    );

    for (const fallbackId of role.execution?.fallbacks ?? []) {
      const fallback = validateRoleAgainstTarget(
        issues,
        role,
        index,
        "fallback",
        fallbackId,
        resolved,
      );
      if (
        preferred &&
        fallback &&
        permissionRank[fallback.permissionCeiling] >
          permissionRank[preferred.permissionCeiling]
      ) {
        add(
          issues,
          "FALLBACK_PERMISSION_ESCALATION",
          `/spec/roles/${index}/execution/fallbacks`,
          `Fallback '${fallbackId}' has a broader permission ceiling than the preferred target.`,
        );
      }
    }

    if (
      !Number.isInteger(role.concurrency ?? 1) ||
      (role.concurrency ?? 1) < 1
    ) {
      add(
        issues,
        "INVALID_CONCURRENCY",
        `/spec/roles/${index}/concurrency`,
        "Role concurrency must be a positive integer.",
      );
    }
    if (
      typeof budgets.maxConcurrentRuns === "number" &&
      (role.concurrency ?? 1) > budgets.maxConcurrentRuns
    ) {
      add(
        issues,
        "ROLE_EXCEEDS_GLOBAL_CONCURRENCY",
        `/spec/roles/${index}/concurrency`,
        "Role concurrency cannot exceed the global run limit.",
      );
    }
    validateRoleOrchestrationShape(issues, role, index);
  }

  for (const [workflowIndex, workflow] of workflows.entries()) {
    const stages = Array.isArray(workflow.stages) ? workflow.stages : [];
    validateIds(
      issues,
      `/spec/workflows/${workflowIndex}/stages`,
      stages,
    );
    const stageIds = new Set(stages.map(({ id }) => id));

    for (const [stageIndex, stage] of stages.entries()) {
      const stagePath = `/spec/workflows/${workflowIndex}/stages/${stageIndex}`;
      const type = stage.type ?? "agent";
      if (type === "agent" && (!stage.role || !roleIds.has(stage.role))) {
        add(
          issues,
          "STAGE_ROLE_REQUIRED",
          `${stagePath}/role`,
          "Agent stages require a known responsible role.",
        );
      }
      for (const dependency of stage.dependsOn ?? []) {
        if (!stageIds.has(dependency)) {
          add(
            issues,
            "UNKNOWN_STAGE_DEPENDENCY",
            `${stagePath}/dependsOn`,
            `Unknown stage dependency '${dependency}'.`,
          );
        }
      }
      if (
        type === "agent" &&
        !stage.outputContract &&
        (stage.acceptanceCriteria?.length ?? 0) === 0
      ) {
        add(
          issues,
          "STAGE_OUTPUT_CONTRACT_REQUIRED",
          stagePath,
          "Agent stages require an output contract or acceptance criteria.",
        );
      }
      if (stage.externalSideEffect && !stage.executionApprovalRequired) {
        add(
          issues,
          "SIDE_EFFECT_APPROVAL_REQUIRED",
          stagePath,
          "External side effects require a distinct execution approval.",
        );
      }
    }

    const cycle = findCycle(stages);
    if (cycle) {
      add(
        issues,
        "WORKFLOW_CYCLE",
        `/spec/workflows/${workflowIndex}/stages`,
        `Workflow dependency cycle: ${cycle.join(" -> ")}.`,
      );
    }
  }

  for (const [index, schedule] of schedules.entries()) {
    const path = `/spec/schedules/${index}`;
    if (!workflowIds.has(schedule.workflow)) {
      add(
        issues,
        "UNKNOWN_WORKFLOW",
        `${path}/workflow`,
        `Unknown workflow '${schedule.workflow}'.`,
      );
    }

    const executor = schedule.executor ?? "controller";
    if (
      executor === "controller" &&
      schedule.noWorkBehavior !== "skip_without_model"
    ) {
      add(
        issues,
        "CONTROLLER_MUST_SKIP_WITHOUT_MODEL",
        `${path}/noWorkBehavior`,
        "Controller schedules must skip without starting a model.",
      );
    }

    if (executor === "provider_native") {
      const target = schedule.executionTarget
        ? resolved.get(schedule.executionTarget)
        : undefined;
      if (!target) {
        add(
          issues,
          "NATIVE_SCHEDULE_TARGET_REQUIRED",
          `${path}/executionTarget`,
          "Native schedules require a known execution target.",
        );
      }
      if (!schedule.nativeSurface) {
        add(
          issues,
          "NATIVE_SCHEDULE_SURFACE_REQUIRED",
          `${path}/nativeSurface`,
          "Native schedules must distinguish local, hosted, or chat continuation.",
        );
      } else if (
        target &&
        !capability(
          target.hostCapabilities,
          `schedule.native.${schedule.nativeSurface}`,
        )
      ) {
        add(
          issues,
          "NATIVE_SCHEDULE_CAPABILITY_MISMATCH",
          `${path}/executionTarget`,
          "The selected target does not support this native schedule surface.",
        );
      }
      if (!schedule.degradedAcknowledged || !schedule.emptyStartAccounting) {
        add(
          issues,
          "NATIVE_SCHEDULE_DEGRADED_GUARD_REQUIRED",
          path,
          "Native schedules require degraded acknowledgement and empty-start accounting.",
        );
      }
    }
  }

  if (
    typeof budgets.monthlyCostLimitUsd !== "number" ||
    budgets.monthlyCostLimitUsd < 0 ||
    !Number.isInteger(budgets.maxConcurrentRuns) ||
    budgets.maxConcurrentRuns < 1 ||
    !Number.isInteger(budgets.maxDailyModelStarts) ||
    budgets.maxDailyModelStarts < 1
  ) {
    add(
      issues,
      "INVALID_BUDGET",
      "/spec/budgets",
      "Budget values must be non-negative and run/start limits must be positive integers.",
    );
  }
  if (
    budgets.unknownCostPolicy !== undefined &&
    !["block", "warn", "estimate"].includes(budgets.unknownCostPolicy)
  ) {
    add(
      issues,
      "INVALID_UNKNOWN_COST_POLICY",
      "/spec/budgets/unknownCostPolicy",
      "unknownCostPolicy must be block, warn, or estimate.",
    );
  }
  if (
    (budgets.maxArtifactBytes !== undefined &&
      (!Number.isInteger(budgets.maxArtifactBytes) ||
        budgets.maxArtifactBytes < 1)) ||
    (budgets.maxWorkItemArtifactBytes !== undefined &&
      (!Number.isInteger(budgets.maxWorkItemArtifactBytes) ||
        budgets.maxWorkItemArtifactBytes < 1)) ||
    (budgets.maxArtifactBytes !== undefined &&
      budgets.maxWorkItemArtifactBytes !== undefined &&
      budgets.maxWorkItemArtifactBytes < budgets.maxArtifactBytes)
  ) {
    add(
      issues,
      "INVALID_ARTIFACT_BUDGET",
      "/spec/budgets",
      "Artifact limits must be positive integers and the work-item limit must not be smaller than the per-artifact limit.",
    );
  }

  return {
    ok: issues.every(({ severity }) => severity !== "error"),
    issues,
  };
}
