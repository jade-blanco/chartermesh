import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { canonicalJson } from "../../orgspec/src/index.ts";
import { humanApprovalWritingGuidance } from "./portable-skills.ts";

export type HostKind = "codex" | "claude";

export type HostCapabilitySupport =
  | "native"
  | "emulated"
  | "manual_step_required"
  | "unsupported";

export type HostCapabilityStability = "stable" | "beta" | "experimental";

export interface HostCapabilityEntry {
  name: string;
  support: HostCapabilitySupport;
  stability: HostCapabilityStability;
}

export interface HostCapabilitySnapshotInput {
  contractVersion: "chartermesh.dev/host-capabilities/v1alpha1";
  hostKind: HostKind;
  capabilities: readonly HostCapabilityEntry[];
}

export interface BoundHostCapabilitySnapshot
  extends HostCapabilitySnapshotInput {
  executableSha256: string;
  reportedVersion: string;
}

export const HOST_PROJECTION_REQUIRED_CAPABILITIES = [
  "agents.project",
  "instructions.project",
  "mcp.stdio",
] as const;

export interface HostFileProbe {
  locateExecutable(command: string): Promise<string | null>;
  realpath(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface HostProcessProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HostProcessProbe {
  run(input: {
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
    maxOutputBytes: number;
    cwd?: string;
  }): Promise<HostProcessProbeResult>;
}

export interface HostDiscoveryProbes {
  files: HostFileProbe;
  process: HostProcessProbe;
}

export interface HostDiscoveryRequest {
  hostKind: HostKind;
  executablePath?: string;
  expectedExecutableSha256: string;
  expectedVersion?: string;
  expectedCapabilitySnapshotSha256?: string;
  requiredCapabilities?: readonly string[];
  capabilitySnapshot: HostCapabilitySnapshotInput;
  versionArgs?: readonly string[];
  projectRoot?: string;
}

export type HostDiscoveryIssueCode =
  | "invalid_executable_path"
  | "executable_not_found"
  | "executable_not_file"
  | "executable_probe_failed"
  | "invalid_executable_hash"
  | "executable_hash_mismatch"
  | "version_probe_failed"
  | "version_output_too_large"
  | "version_unparseable"
  | "version_mismatch"
  | "invalid_capability_snapshot"
  | "capability_snapshot_hash_mismatch"
  | "required_capability_missing";

export interface HostDiscoveryIssue {
  code: HostDiscoveryIssueCode;
  message: string;
}

export interface HostExecutableBinding {
  hostKind: HostKind;
  executablePath: string;
  executableSha256: string;
  reportedVersion: string;
  capabilitySnapshot: BoundHostCapabilitySnapshot;
  capabilitySnapshotSha256: string;
}

export interface HostDiscoveryResult {
  ok: boolean;
  issues: HostDiscoveryIssue[];
  binding: HostExecutableBinding | null;
}

export type HostRolePermission = "read_only" | "workspace_write";

export interface HostProjectionRole {
  id: string;
  description: string;
  instructions: string;
  permission: HostRolePermission;
}

export interface HostBridgeProjection {
  command: string;
  args?: readonly string[];
  cwd?: string;
}

export interface HostProjectionRequest {
  binding: HostExecutableBinding;
  roles: readonly HostProjectionRole[];
  bridge: HostBridgeProjection;
  maxConcurrentAgents?: number;
  entrypointPath?: string;
}

export type HostProjectionOperation =
  | {
      kind: "write_managed_file";
      path: string;
      content: string;
      contentSha256: string;
    }
  | {
      kind: "merge_toml_fragment";
      path: string;
      content: string;
      contentSha256: string;
      namespace: "chartermesh";
    }
  | {
      kind: "merge_json_fragment";
      path: string;
      content: string;
      contentSha256: string;
      namespace: "chartermesh";
    }
  | {
      kind: "upsert_markdown_section";
      path: string;
      content: string;
      contentSha256: string;
      sectionId: "chartermesh-host-integration";
    };

export interface HostProjectionPlanBody {
  apiVersion: "chartermesh.dev/host-projection-plan/v1alpha1";
  host: {
    kind: HostKind;
    executablePath: string;
    executableSha256: string;
    reportedVersion: string;
    capabilitySnapshotSha256: string;
  };
  operations: HostProjectionOperation[];
}

export interface HostProjectionPlan extends HostProjectionPlanBody {
  planHash: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u;
const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const ROLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_VERSION_OUTPUT_BYTES = 8_192;

function digestBytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /\0/u.test(value)
  ) {
    return `${label} must be a non-empty string of at most ${maximumLength} characters without NUL bytes.`;
  }
  return null;
}

export function validateHostCapabilitySnapshot(
  value: unknown,
  expectedHostKind?: HostKind,
): HostDiscoveryIssue[] {
  const issues: HostDiscoveryIssue[] = [];
  if (
    !isRecord(value) ||
    !exactKeys(value, ["contractVersion", "hostKind", "capabilities"])
  ) {
    return [
      {
        code: "invalid_capability_snapshot",
        message:
          "Capability snapshot must contain only contractVersion, hostKind, and capabilities; authentication material is not accepted.",
      },
    ];
  }
  if (
    value.contractVersion !== "chartermesh.dev/host-capabilities/v1alpha1"
  ) {
    issues.push({
      code: "invalid_capability_snapshot",
      message: "Capability snapshot contractVersion is unsupported.",
    });
  }
  if (!(["codex", "claude"] as const).includes(value.hostKind as HostKind)) {
    issues.push({
      code: "invalid_capability_snapshot",
      message: "Capability snapshot hostKind must be codex or claude.",
    });
  } else if (expectedHostKind && value.hostKind !== expectedHostKind) {
    issues.push({
      code: "invalid_capability_snapshot",
      message: `Capability snapshot belongs to ${String(value.hostKind)}, not ${expectedHostKind}.`,
    });
  }
  if (!Array.isArray(value.capabilities)) {
    issues.push({
      code: "invalid_capability_snapshot",
      message: "Capability snapshot capabilities must be an array.",
    });
    return issues;
  }
  const names = new Set<string>();
  for (const [index, entry] of value.capabilities.entries()) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["name", "support", "stability"])
    ) {
      issues.push({
        code: "invalid_capability_snapshot",
        message: `Capability at index ${index} has an invalid shape.`,
      });
      continue;
    }
    if (
      typeof entry.name !== "string" ||
      !CAPABILITY_NAME_PATTERN.test(entry.name) ||
      entry.name.length > 96
    ) {
      issues.push({
        code: "invalid_capability_snapshot",
        message: `Capability at index ${index} has an invalid name.`,
      });
    } else if (names.has(entry.name)) {
      issues.push({
        code: "invalid_capability_snapshot",
        message: `Capability '${entry.name}' is duplicated.`,
      });
    } else {
      names.add(entry.name);
    }
    if (
      ![
        "native",
        "emulated",
        "manual_step_required",
        "unsupported",
      ].includes(String(entry.support))
    ) {
      issues.push({
        code: "invalid_capability_snapshot",
        message: `Capability '${String(entry.name)}' has invalid support.`,
      });
    }
    if (!(["stable", "beta", "experimental"] as const).includes(
      entry.stability as HostCapabilityStability,
    )) {
      issues.push({
        code: "invalid_capability_snapshot",
        message: `Capability '${String(entry.name)}' has invalid stability.`,
      });
    }
  }
  return issues;
}

function normalizeCapabilitySnapshot(
  value: HostCapabilitySnapshotInput,
): HostCapabilitySnapshotInput {
  return {
    contractVersion: value.contractVersion,
    hostKind: value.hostKind,
    capabilities: [...value.capabilities]
      .map(({ name, stability, support }) => ({ name, stability, support }))
      .sort(({ name: left }, { name: right }) => left.localeCompare(right)),
  };
}

function versionFromOutput(stdout: string, stderr: string): string | null {
  const match = `${stdout.trim()}\n${stderr.trim()}`.match(VERSION_PATTERN);
  return match?.[1] ?? null;
}

function capabilityIsUsable(
  snapshot: HostCapabilitySnapshotInput,
  name: string,
): boolean {
  const entry = snapshot.capabilities.find((candidate) => candidate.name === name);
  return entry?.support === "native" || entry?.support === "emulated";
}

function probeFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "unknown probe error";
}

export async function discoverHost(
  request: HostDiscoveryRequest,
  probes: HostDiscoveryProbes,
): Promise<HostDiscoveryResult> {
  const capabilityIssues = validateHostCapabilitySnapshot(
    request.capabilitySnapshot,
    request.hostKind,
  );
  const issues: HostDiscoveryIssue[] = [...capabilityIssues];
  const expectedHash = typeof request.expectedExecutableSha256 === "string"
    ? request.expectedExecutableSha256.toLowerCase()
    : "";
  if (!SHA256_PATTERN.test(expectedHash)) {
    issues.push({
      code: "invalid_executable_hash",
      message: "expectedExecutableSha256 must be a lowercase SHA-256 digest.",
    });
  }
  if (
    request.expectedCapabilitySnapshotSha256 !== undefined &&
    !SHA256_PATTERN.test(request.expectedCapabilitySnapshotSha256)
  ) {
    issues.push({
      code: "invalid_capability_snapshot",
      message: "expectedCapabilitySnapshotSha256 must be a lowercase SHA-256 digest.",
    });
  }

  let locatedPath: string | null = request.executablePath ?? null;
  if (locatedPath === null) {
    try {
      locatedPath = await probes.files.locateExecutable(request.hostKind);
    } catch (cause) {
      issues.push({
        code: "executable_probe_failed",
        message: `Could not locate ${request.hostKind}: ${probeFailureMessage(cause)}.`,
      });
    }
  }
  if (!locatedPath) {
    issues.push({
      code: "executable_not_found",
      message: `${request.hostKind} executable was not found.`,
    });
    return { ok: false, issues, binding: null };
  }
  if (!isAbsolute(locatedPath)) {
    issues.push({
      code: "invalid_executable_path",
      message: "Host executable path must be absolute.",
    });
    return { ok: false, issues, binding: null };
  }

  let executablePath: string;
  let executableBytes: Uint8Array;
  try {
    executablePath = await probes.files.realpath(locatedPath);
    if (!isAbsolute(executablePath)) {
      throw new Error("realpath probe returned a non-absolute path");
    }
    if (!(await probes.files.isFile(executablePath))) {
      issues.push({
        code: "executable_not_file",
        message: "Resolved host executable is not a regular file.",
      });
      return { ok: false, issues, binding: null };
    }
    executableBytes = await probes.files.readFile(executablePath);
  } catch (cause) {
    issues.push({
      code: "executable_probe_failed",
      message: `Could not inspect host executable: ${probeFailureMessage(cause)}.`,
    });
    return { ok: false, issues, binding: null };
  }

  const executableSha256 = digestBytes(executableBytes);
  if (SHA256_PATTERN.test(expectedHash) && executableSha256 !== expectedHash) {
    issues.push({
      code: "executable_hash_mismatch",
      message: "Host executable does not match the approved SHA-256 digest.",
    });
  }

  let versionResult: HostProcessProbeResult;
  try {
    const processInput: Parameters<HostProcessProbe["run"]>[0] = {
      executable: executablePath,
      args: request.versionArgs ?? ["--version"],
      environment: {},
      maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
    };
    if (request.projectRoot !== undefined) processInput.cwd = request.projectRoot;
    versionResult = await probes.process.run(processInput);
  } catch (cause) {
    issues.push({
      code: "version_probe_failed",
      message: `Host version probe failed: ${probeFailureMessage(cause)}.`,
    });
    return { ok: false, issues, binding: null };
  }
  const outputBytes = Buffer.byteLength(versionResult.stdout, "utf8") +
    Buffer.byteLength(versionResult.stderr, "utf8");
  if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
    issues.push({
      code: "version_output_too_large",
      message: "Host version output exceeded the 8192-byte safety limit.",
    });
  }
  if (versionResult.exitCode !== 0) {
    issues.push({
      code: "version_probe_failed",
      message: `Host version probe exited with code ${versionResult.exitCode}.`,
    });
  }
  const reportedVersion = versionFromOutput(
    versionResult.stdout,
    versionResult.stderr,
  );
  if (!reportedVersion) {
    issues.push({
      code: "version_unparseable",
      message: "Host version output did not contain a semantic version.",
    });
  } else if (
    request.expectedVersion !== undefined &&
    reportedVersion !== request.expectedVersion
  ) {
    issues.push({
      code: "version_mismatch",
      message: `Host reported version ${reportedVersion}, expected ${request.expectedVersion}.`,
    });
  }

  if (!reportedVersion || capabilityIssues.length > 0) {
    return { ok: false, issues, binding: null };
  }
  const normalizedSnapshot = normalizeCapabilitySnapshot(
    request.capabilitySnapshot,
  );
  for (const name of [...new Set(request.requiredCapabilities ?? [])].sort()) {
    if (!capabilityIsUsable(normalizedSnapshot, name)) {
      issues.push({
        code: "required_capability_missing",
        message: `Required host capability '${name}' is not natively or emulatively available.`,
      });
    }
  }

  const capabilitySnapshot: BoundHostCapabilitySnapshot = {
    ...normalizedSnapshot,
    executableSha256,
    reportedVersion,
  };
  const capabilitySnapshotSha256 = digestCanonical(capabilitySnapshot);
  if (
    request.expectedCapabilitySnapshotSha256 !== undefined &&
    capabilitySnapshotSha256 !== request.expectedCapabilitySnapshotSha256
  ) {
    issues.push({
      code: "capability_snapshot_hash_mismatch",
      message: "Host capability snapshot does not match the approved SHA-256 digest.",
    });
  }
  if (issues.length > 0) return { ok: false, issues, binding: null };

  return {
    ok: true,
    issues: [],
    binding: {
      hostKind: request.hostKind,
      executablePath,
      executableSha256,
      reportedVersion,
      capabilitySnapshot,
      capabilitySnapshotSha256,
    },
  };
}

function assertValidBinding(binding: HostExecutableBinding): void {
  if (
    !isAbsolute(binding.executablePath) ||
    !SHA256_PATTERN.test(binding.executableSha256) ||
    !SHA256_PATTERN.test(binding.capabilitySnapshotSha256) ||
    binding.capabilitySnapshot.hostKind !== binding.hostKind ||
    binding.capabilitySnapshot.executableSha256 !== binding.executableSha256 ||
    binding.capabilitySnapshot.reportedVersion !== binding.reportedVersion ||
    digestCanonical(binding.capabilitySnapshot) !==
      binding.capabilitySnapshotSha256 ||
    validateHostCapabilitySnapshot(
      {
        contractVersion: binding.capabilitySnapshot.contractVersion,
        hostKind: binding.capabilitySnapshot.hostKind,
        capabilities: binding.capabilitySnapshot.capabilities,
      },
      binding.hostKind,
    ).length > 0
  ) {
    throw new Error("Host executable binding is invalid or has been modified.");
  }
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`${label} must be a contained project-relative path.`);
  }
  return normalized;
}

function normalizeRoles(roles: readonly HostProjectionRole[]): HostProjectionRole[] {
  if (roles.length === 0 || roles.length > 32) {
    throw new Error("Host projection requires between 1 and 32 roles.");
  }
  const normalized = roles.map((role) => {
    if (!ROLE_ID_PATTERN.test(role.id) || role.id.length > 64) {
      throw new Error(
        `Role id '${role.id}' must be a lowercase, hyphen-separated identifier.`,
      );
    }
    const descriptionIssue = validateText(
      role.description,
      `Role '${role.id}' description`,
      240,
    );
    if (descriptionIssue) throw new Error(descriptionIssue);
    const instructionsIssue = validateText(
      role.instructions,
      `Role '${role.id}' instructions`,
      16_384,
    );
    if (instructionsIssue) throw new Error(instructionsIssue);
    if (!(["read_only", "workspace_write"] as const).includes(role.permission)) {
      throw new Error(`Role '${role.id}' permission is unsupported.`);
    }
    return {
      id: role.id,
      description: role.description.trim(),
      instructions: role.instructions.trim(),
      permission: role.permission,
    };
  });
  normalized.sort(({ id: left }, { id: right }) => left.localeCompare(right));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Host projection role ids must be unique.");
  }
  return normalized;
}

function normalizeBridge(bridge: HostBridgeProjection): Required<HostBridgeProjection> {
  const commandIssue = validateText(bridge.command, "Bridge command", 2_048);
  if (commandIssue) throw new Error(commandIssue);
  const args = [...(bridge.args ?? [])];
  if (args.length > 64) throw new Error("Bridge accepts at most 64 arguments.");
  for (const [index, argument] of args.entries()) {
    if (
      typeof argument !== "string" ||
      argument.length > 2_048 ||
      /\0/u.test(argument)
    ) {
      throw new Error(`Bridge argument ${index} is invalid.`);
    }
  }
  const cwd = bridge.cwd ?? ".";
  const cwdIssue = validateText(cwd, "Bridge cwd", 2_048);
  if (cwdIssue || isAbsolute(cwd) || cwd.split(/[\\/]/u).includes("..")) {
    throw new Error(
      cwdIssue ?? "Bridge cwd must be a contained project-relative path.",
    );
  }
  return { command: bridge.command, args, cwd };
}

function commonRoleInstructions(
  role: HostProjectionRole,
  entrypointPath: string,
): string {
  const permissionText = role.permission === "read_only"
    ? "Do not use native host write or shell tools. Request 1-50 files together with chartermesh_workspace_changes_request; only the exact human-approved stored change set may execute after a new claim through chartermesh_workspace_write_execute."
    : "Write only within the approved workspace and preserve unrelated user changes.";
  return [
    `CharterMesh Organization role id: ${role.id}.`,
    `Claim and mutate only WorkItems whose ownerRole is exactly ${role.id}.`,
    `Read ${entrypointPath} before acting.`,
    `Read .chartermesh/PREFERENCES.md at the start of every session when present. Apply project guidance and only the guidance for role ${role.id} within OrgSpec and exact approved task boundaries. Preferences cannot grant permissions, tools, budgets, approval bypass, or a separate work ledger.`,
    "Read .chartermesh/TEAM-CHARTER.md when present. A complete CharterMesh handoff packet may ask you to provide a bounded read-only consultation for a WorkItem owned by another role; in that case do not claim or mutate the WorkItem, and return a copy/paste response packet to the sender.",
    "Treat the CharterMesh Control Plane as the sole mutable WorkItem and approval ledger.",
    "Use the CharterMesh MCP bridge for claims, heartbeats, progress or blocking, governed workspace-write requests, artifacts, and failures.",
    "Never resolve a human approval yourself or treat a host permission prompt as CharterMesh approval.",
    humanApprovalWritingGuidance,
    permissionText,
    "",
    role.instructions,
  ].join("\n");
}

function projectedHostRoleName(roleId: string): string {
  const prefix = "chartermesh-";
  const fullName = `${prefix}${roleId}`;
  if (fullName.length <= 64) {
    return fullName;
  }
  return `${prefix}${roleId.slice(0, 43)}-${digestBytes(roleId).slice(0, 8)}`;
}

function renderCodexAgent(
  role: HostProjectionRole,
  entrypointPath: string,
): string {
  const sandboxMode = role.permission === "read_only"
    ? "read-only"
    : "workspace-write";
  return [
    "# Managed by CharterMesh. Regenerate through an approved host projection plan.",
    `name = ${JSON.stringify(projectedHostRoleName(role.id))}`,
    `description = ${JSON.stringify(role.description)}`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    `developer_instructions = ${JSON.stringify(commonRoleInstructions(role, entrypointPath))}`,
    "",
  ].join("\n");
}

function renderClaudeAgent(
  role: HostProjectionRole,
  entrypointPath: string,
): string {
  const permissionFrontmatter = role.permission === "read_only"
    ? [
        "tools:",
        "  - Read",
        "  - Glob",
        "  - Grep",
        "  - mcp__chartermesh",
        "disallowedTools:",
        "  - Bash",
        "  - PowerShell",
        "  - Edit",
        "  - Write",
        "  - NotebookEdit",
        "permissionMode: default",
      ]
    : ["permissionMode: default"];
  return [
    "---",
    `name: ${JSON.stringify(projectedHostRoleName(role.id))}`,
    `description: ${JSON.stringify(role.description)}`,
    ...permissionFrontmatter,
    "---",
    "",
    "<!-- Managed by CharterMesh. Regenerate through an approved host projection plan. -->",
    commonRoleInstructions(role, entrypointPath),
    "",
  ].join("\n");
}

function renderCodexConfig(
  bridge: Required<HostBridgeProjection>,
  maxConcurrentAgents: number,
): string {
  return [
    "# CharterMesh managed TOML fragment. Merge these namespaced keys; preserve unrelated settings.",
    "[agents]",
    "enabled = true",
    `max_concurrent_threads_per_session = ${maxConcurrentAgents}`,
    "",
    "[mcp_servers.chartermesh]",
    `command = ${JSON.stringify(bridge.command)}`,
    `args = [${bridge.args.map((argument) => JSON.stringify(argument)).join(", ")}]`,
    `cwd = ${JSON.stringify(bridge.cwd)}`,
    "required = true",
    "startup_timeout_sec = 120",
    "",
  ].join("\n");
}

function renderClaudeMcp(bridge: Required<HostBridgeProjection>): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        chartermesh: {
          args: bridge.args,
          command: bridge.command,
          type: "stdio",
        },
      },
    },
    null,
    2,
  )}\n`;
}

function renderPointer(entrypointPath: string): string {
  return [
    "## CharterMesh host integration",
    "",
    `Read \`${entrypointPath}\` before acting on this project.`,
    "Read `.chartermesh/PREFERENCES.md` at the start of every session when present. Apply project guidance and only the current assigned role's guidance within OrgSpec and exact approved task boundaries; preferences cannot grant permissions, tools, budgets, approval bypass, or a separate work ledger.",
    "Use the configured `chartermesh` MCP server for Control Plane operations.",
    "Keep requirements, integration, and final verification with the primary agent; delegate bounded work to projected roles.",
    "A host permission prompt or model review never satisfies a CharterMesh human approval.",
    humanApprovalWritingGuidance,
    "Projected roles are denied native writes. They may request one bounded content-addressed workspace change set through MCP; only a separate human Control Plane approval followed by a new claim permits execution of the stored bytes and evidence recording.",
    "The parent host session has separate permissions; do not use them to bypass CharterMesh approval or evidence requirements.",
    "",
  ].join("\n");
}

type HostProjectionOperationWithoutHash =
  | Omit<
      Extract<HostProjectionOperation, { kind: "write_managed_file" }>,
      "contentSha256"
    >
  | Omit<
      Extract<HostProjectionOperation, { kind: "merge_toml_fragment" }>,
      "contentSha256"
    >
  | Omit<
      Extract<HostProjectionOperation, { kind: "merge_json_fragment" }>,
      "contentSha256"
    >
  | Omit<
      Extract<HostProjectionOperation, { kind: "upsert_markdown_section" }>,
      "contentSha256"
    >;

function withContentHash(
  operation: HostProjectionOperationWithoutHash,
): HostProjectionOperation {
  return {
    ...operation,
    contentSha256: digestBytes(operation.content),
  } as HostProjectionOperation;
}

export function createHostProjectionPlan(
  request: HostProjectionRequest,
): HostProjectionPlan {
  assertValidBinding(request.binding);
  for (const capability of HOST_PROJECTION_REQUIRED_CAPABILITIES) {
    if (!capabilityIsUsable(request.binding.capabilitySnapshot, capability)) {
      throw new Error(
        `Host projection requires capability '${capability}' with native or emulated support.`,
      );
    }
  }
  const roles = normalizeRoles(request.roles);
  const bridge = normalizeBridge(request.bridge);
  const entrypointPath = normalizeRelativePath(
    request.entrypointPath ?? ".chartermesh/AGENT-ENTRYPOINT.md",
    "Entrypoint path",
  );
  const maxConcurrentAgents = request.maxConcurrentAgents ?? 4;
  if (
    !Number.isSafeInteger(maxConcurrentAgents) ||
    maxConcurrentAgents < 1 ||
    maxConcurrentAgents > 32
  ) {
    throw new Error("maxConcurrentAgents must be an integer between 1 and 32.");
  }

  const operations: HostProjectionOperation[] = [];
  if (request.binding.hostKind === "codex") {
    operations.push(
      withContentHash({
        kind: "merge_toml_fragment",
        path: ".codex/config.toml",
        namespace: "chartermesh",
        content: renderCodexConfig(bridge, maxConcurrentAgents),
      }),
      withContentHash({
        kind: "upsert_markdown_section",
        path: "AGENTS.md",
        sectionId: "chartermesh-host-integration",
        content: renderPointer(entrypointPath),
      }),
    );
    for (const role of roles) {
      operations.push(
        withContentHash({
          kind: "write_managed_file",
          path: `.codex/agents/chartermesh-${role.id}.toml`,
          content: renderCodexAgent(role, entrypointPath),
        }),
      );
    }
  } else {
    operations.push(
      withContentHash({
        kind: "merge_json_fragment",
        path: ".mcp.json",
        namespace: "chartermesh",
        content: renderClaudeMcp(bridge),
      }),
      withContentHash({
        kind: "upsert_markdown_section",
        path: "CLAUDE.md",
        sectionId: "chartermesh-host-integration",
        content: renderPointer(entrypointPath),
      }),
    );
    for (const role of roles) {
      operations.push(
        withContentHash({
          kind: "write_managed_file",
          path: `.claude/agents/chartermesh-${role.id}.md`,
          content: renderClaudeAgent(role, entrypointPath),
        }),
      );
    }
  }
  operations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
  );
  const body: HostProjectionPlanBody = {
    apiVersion: "chartermesh.dev/host-projection-plan/v1alpha1",
    host: {
      kind: request.binding.hostKind,
      executablePath: request.binding.executablePath,
      executableSha256: request.binding.executableSha256,
      reportedVersion: request.binding.reportedVersion,
      capabilitySnapshotSha256: request.binding.capabilitySnapshotSha256,
    },
    operations,
  };
  return { ...body, planHash: digestCanonical(body) };
}
