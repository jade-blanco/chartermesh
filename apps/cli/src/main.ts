#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { FakeModelEngine } from "../../../adapters/model-engines/fake/src/index.ts";
import {
  CommandProcessModelEngine,
  sha256Executable,
  validateCommandProcessConfig,
  type CommandProcessConfig,
} from "../../../adapters/model-engines/command-process/src/index.ts";
import {
  OpenAICompatibleModelEngine,
  validateOpenAICompatibleConfig,
  type OpenAICompatibleConfig,
} from "../../../adapters/model-engines/openai-compatible/src/index.ts";
import {
  CodexAppServerAgentHost,
} from "../../../adapters/agent-hosts/codex/src/index.ts";
import type { AgentHost } from "../../../packages/adapter-sdk/src/index.ts";
import {
  ControlPlane,
  acquireMaintenanceLock,
  createControlPlaneBackup,
  listControlPlaneBackups,
  openControlPlaneDatabase,
  projectApprovalExplanation,
  readControlPlaneBackup,
  validateControlPlaneDatabase,
  type WaitCondition,
} from "../../../packages/control-plane/src/index.ts";
import {
  parseOrgSpec,
  sha256,
} from "../../../packages/orgspec/src/index.ts";
import {
  applyFileTransaction,
  recoverFileTransaction,
  recoverFileTransactions,
} from "../../../packages/compiler/src/index.ts";
import {
  BuiltInManagedRunner,
  DelegationController,
  ToolApprovalRequiredError,
  capabilityCatalog,
  createWorkspaceToolRuntime,
  createWebSearchTools,
  createHostProjectionPlan,
  discoverHost,
  evaluateIntervalSchedule,
  parseRuntimeConfig,
  parseStructuredArtifact,
  portableAgentEntrypoint,
  portableSkillDocuments,
  readProjectPreferences,
  parseProjectPreferences,
  renderProjectPreferences,
  readBoundedRegularText,
  recommendedCapabilities,
  resolveProjectStatePaths,
  validateWebSearchConfig,
  type RuntimeConfig,
  type HostCapabilitySnapshotInput,
  type HostExecutableBinding,
  type HostKind,
  type HostProjectionOperation,
  type ToolExecutionEvidence,
} from "../../../packages/runtime/src/index.ts";
import {
  createProposal,
  type OrganizationProposal,
  type ProposalProfile,
  type TeamDesign,
  type TeamTemplateId,
} from "./proposal.ts";
import { renderTeamCharter } from "./team-charter.ts";
import { validateOrganizationCustomization, renderCustomTeamCharter } from "./project-customization.ts";
import { evaluateModelEngine } from "./evaluate-model.ts";
import { evaluateCollaboration } from "./evaluate-collaboration.ts";
import { runControlPlaneMcpStdio } from "./mcp-server.ts";
import {
  beginApplyOperation,
  completeApplyOperation,
  findApplyOperation,
  inspectApplyOperationFiles,
  listPendingApplyOperations,
  markApplyOperationDatabaseCommitted,
  markApplyOperationFilesCommitted,
  validateApplyOperationPlan,
  type ApplyOperationReceipt,
  type JsonValue,
} from "./apply-operation-journal.ts";
import { collectCodeEvaluationProvenance } from "./code-evaluation/provenance.ts";
import {
  SandboxContainmentError,
  WindowsSandboxCodeBackend,
} from "./code-evaluation/windows-sandbox.ts";
import {
  CodexCliFeedbackProvider,
  CodexExecModelEngine,
  CodexProxyError,
} from "./workflow-evaluation/codex-proxy.ts";
import {
  generateReferenceCodeWorkflowSuite,
  preflightCodeWorkflowSandbox,
} from "./workflow-evaluation/code-adapters.ts";
import { createControlPlaneWorkflowStudyPersistence } from "./workflow-evaluation/control-plane-persistence.ts";
import {
  createWorkflowStudyPlan,
  runBoundWorkflowStudy,
  workflowStudyValueHash,
  type WorkflowStudyTaskBinding,
} from "./workflow-evaluation/runner.ts";
import { generateReferenceArtifactSuite } from "./workflow-evaluation/suite.ts";
import {
  DEFAULT_WORKFLOW_TRAJECTORY_LIMITS,
  WorkflowAbortSettlementError,
} from "./workflow-evaluation/trajectory.ts";
import type {
  WorkflowTrajectoryLimits,
  WorkflowTrajectoryReport,
} from "./workflow-evaluation/types.ts";
import {
  DECISION_REVIEW_BENCHMARK_SUITE_ID,
  DecisionReviewPauseError,
  createDecisionReviewEvaluationPlan,
  runDecisionReviewEvaluation,
  type DecisionReviewExecutionDisclosure,
  type DecisionReviewRunSegment,
} from "./decision-review-evaluation/runner.ts";
import {
  assertDecisionReviewResumePlan,
  createDecisionReviewActiveInvocation,
  createDecisionReviewResumeExecutionSegment,
  createDecisionReviewResumePlan,
  createInitialDecisionReviewCheckpoint,
  decisionReviewCompletedPrefixHash,
  parseDecisionReviewCheckpoint,
  type DecisionReviewAccountContext,
  type DecisionReviewCheckpoint,
  type DecisionReviewResumePlan,
} from "./decision-review-evaluation/resume.ts";

const CLI_API_VERSION = "chartermesh.dev/cli/v1alpha1";
const CHARTERMESH_VERSION = "0.0.10-alpha.1";
const CHARTERMESH_GITHUB_REF =
  `github:jade-blanco/chartermesh#v${CHARTERMESH_VERSION}`;

interface BootstrapFile {
  path: string;
  content: string;
  beforeHash: string | null;
  afterHash: string;
}

interface BootstrapPlan {
  apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1";
  operation: "bootstrap" | "kickoff" | "configure-engine" | "configure-host" | "configure-project";
  target: string;
  engine: string;
  files: BootstrapFile[];
  projectGuard?: { workSnapshotHash: string };
  kickoff?: {
    title: string;
    summary: string;
    briefHash: string;
    ownerRole: string;
    executionTarget: string;
    priority: number;
    decisionQuestion: string;
    acceptanceCriteria: Array<{
      id: string;
      text: string;
      critical: boolean;
      evidenceRequirements: [];
    }>;
  };
  hostBinding?: {
    kind: HostKind;
    executablePath: string;
    executableSha256: string;
    args: string[];
    reportedVersion: string;
    capabilitySnapshotSha256: string;
    projectionPlanHash: string;
    directProtocol: boolean;
  };
  workRetargets?: Array<{
    id: string;
    expectedVersion: number;
    ownerRole: string;
    fromExecutionTarget: string;
    toExecutionTarget: string;
  }>;
  onboarding?: {
    teamTemplate: TeamTemplateId;
    teamSource: TeamDesign["source"];
    entryRole: string;
    roleIds: string[];
    stageIds: string[];
    teamCharterPath: ".chartermesh/TEAM-CHARTER.md";
    handoffMode: "copy_paste";
    allocationMode: "single_entry_work_item_with_manual_role_consultations";
    approvalMode: "exact_hash_human";
    executionBoundary: TeamDesign["executionBoundary"];
    hostProjection?: {
      kind: HostKind;
      executionTarget: string;
      newSessionRequired: true;
    };
  };
  planHash: string;
}

interface RestorePlan {
  apiVersion: "chartermesh.dev/restore-plan/v1alpha1";
  operation: "restore-control-plane";
  target: string;
  backupId: string;
  backupSha256: string;
  currentSha256: string;
  backupSchemaVersion: number;
  backupArtifactCount: number;
  backupArtifactSetSha256: string;
  planHash: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function writeJsonEnvelope(
  command: string,
  data: unknown,
  ok = true,
): void {
  console.log(
    JSON.stringify(
      {
        apiVersion: CLI_API_VERSION,
        command,
        ok,
        ...(ok ? { data } : { error: data }),
      },
      null,
      2,
    ),
  );
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value
      .replace(/^v/u, "")
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return (a.core[index] ?? 0) - (b.core[index] ?? 0);
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function selectLatestPublishedVersion(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  let latest: string | null = null;
  for (const candidate of payload) {
    if (!candidate || typeof candidate !== "object") continue;
    const release = candidate as { draft?: unknown; tag_name?: unknown };
    if (release.draft === true || typeof release.tag_name !== "string") {
      continue;
    }
    const version = release.tag_name.trim().replace(/^v/u, "");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
      continue;
    }
    if (latest === null || compareVersions(version, latest) > 0) {
      latest = version;
    }
  }
  return latest;
}

function targetOf(args: string[]): string {
  return resolve(option(args, "--target") ?? process.cwd());
}

function findInitializedProjectRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, ".chartermesh", "organization.json")) &&
      existsSync(join(current, ".chartermesh", "state.db"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function discoverMcpProjectRoot(): string {
  const candidates = [
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const found = findInitializedProjectRoot(candidate);
    if (found) return found;
  }
  throw new Error(
    "No initialized CharterMesh project was found from the host project directory or current directory.",
  );
}

function statePaths(target: string) {
  return resolveProjectStatePaths(target);
}

function pendingFileTransactionState(target: string): {
  pending: boolean;
  transactionCount: number;
  applyLock: boolean;
  invalidMetadata: boolean;
} {
  const root = statePaths(target).root;
  const transactionRoot = join(root, ".transactions");
  const applyLockPath = join(root, ".apply-lock");
  let transactionCount = 0;
  let invalidMetadata = false;
  if (existsSync(transactionRoot)) {
    const metadata = lstatSync(transactionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      invalidMetadata = true;
    } else {
      transactionCount = readdirSync(transactionRoot).length;
    }
  }
  let applyLock = false;
  if (existsSync(applyLockPath)) {
    const metadata = lstatSync(applyLockPath);
    applyLock = true;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      invalidMetadata = true;
    }
  }
  return {
    pending: transactionCount > 0 || applyLock || invalidMetadata,
    transactionCount,
    applyLock,
    invalidMetadata,
  };
}

function assertNoPendingFileTransactions(target: string): void {
  const state = pendingFileTransactionState(target);
  if (state.pending) {
    throw new Error(
      "A prior file transaction requires explicit inspection and recovery; run chartermesh recover before generating a new plan.",
    );
  }
}

function controlPlaneFor(target: string, expectedRuntime?: RuntimeConfig) {
  const paths = statePaths(target);
  const database = openControlPlaneDatabase(paths.database);
  let budgets:
    | {
        monthlyCostLimitUsd: number;
        maxConcurrentRuns: number;
        maxDailyModelStarts: number;
        unknownCostPolicy?: "block" | "warn" | "estimate";
        maxArtifactBytes?: number;
        maxWorkItemArtifactBytes?: number;
      }
    | undefined;
  const organizationText = existsSync(paths.organization) ? readBoundedRegularText(paths.organization) : null;
  const organizationHash = organizationText === null ? null : createHash("sha256").update(organizationText).digest("hex");
  const expectedRuntimeHash = expectedRuntime ? sha256(expectedRuntime) : undefined;
  if (organizationText !== null) {
    try {
      const organization = JSON.parse(
        organizationText,
      ) as {
        spec?: { budgets?: typeof budgets };
      };
      budgets = organization.spec?.budgets;
    } catch {
      // Doctor reports invalid configuration; commands remain diagnosable.
    }
  }
  return {
    paths,
    database,
    controlPlane: new ControlPlane(database, paths.artifacts, { budgets, beforeMutation: () => {
      const currentHash = existsSync(paths.organization)
        ? createHash("sha256").update(readBoundedRegularText(paths.organization)).digest("hex") : null;
      if (currentHash !== organizationHash || (expectedRuntimeHash && sha256(readRuntime(target)) !== expectedRuntimeHash)) {
        throw new Error("PROJECT_CONFIGURATION_CHANGED: retry the command using the current organization and runtime.");
      }
    } }),
  };
}

function readRuntime(target: string): RuntimeConfig {
  const path = statePaths(target).runtime;
  if (!existsSync(path)) {
    throw new Error(
      "Runtime configuration is missing. Run 'chartermesh bootstrap' first.",
    );
  }
  return parseRuntimeConfig(readBoundedRegularText(path));
}

function readOrganization(target: string) {
  const path = statePaths(target).organization;
  if (!existsSync(path)) {
    throw new Error(
      "Organization configuration is missing. Run 'chartermesh bootstrap' first.",
    );
  }
  return parseOrgSpec(readBoundedRegularText(path));
}

function configuredEngine(
  config: RuntimeConfig,
  target: string,
  engineId?: string,
) {
  const profile = engineId
    ? config.modelEngines.find(({ id }) => id === engineId)
    : config.modelEngines[0];
  if (!profile) throw new Error(`Unknown model engine '${engineId}'.`);
  if (profile.adapter === "fake") return new FakeModelEngine();
  if (profile.adapter === "command-process") {
    const workingDirectory = join(
      statePaths(target).engineWork,
      profile.id.replace(/[^A-Za-z0-9._-]/gu, "_"),
    );
    mkdirSync(workingDirectory, { recursive: true });
    return new CommandProcessModelEngine(profile, workingDirectory);
  }
  const issues = validateOpenAICompatibleConfig(profile);
  if (issues.length > 0) throw new Error(issues.join("\n"));
  return new OpenAICompatibleModelEngine(profile);
}

function profileOf(args: string[]): ProposalProfile {
  const value = option(args, "--profile") ?? "balanced";
  if (!["lean", "balanced", "controlled"].includes(value)) {
    throw new Error("--profile must be lean, balanced, or controlled.");
  }
  return value as ProposalProfile;
}

const teamTemplateIds = [
  "general",
  "software-product",
  "research",
  "content-production",
  "data-analysis",
  "operations",
] as const satisfies readonly TeamTemplateId[];

function teamTemplateOf(args: string[]): TeamTemplateId | undefined {
  const value = option(args, "--team-template");
  if (value === undefined) return undefined;
  if (!(teamTemplateIds as readonly string[]).includes(value)) {
    throw new Error(
      "--team-template must be general, software-product, research, " +
        "content-production, data-analysis, or operations.",
    );
  }
  return value as TeamTemplateId;
}

function pricingFrom(args: string[]) {
  const input = option(args, "--input-price-per-million");
  const output = option(args, "--output-price-per-million");
  if ((input === undefined) !== (output === undefined)) {
    throw new Error(
      "--input-price-per-million and --output-price-per-million must be provided together.",
    );
  }
  if (input === undefined || output === undefined) return undefined;
  const inputValue = Number(input);
  const outputValue = Number(output);
  if (
    !Number.isFinite(inputValue) ||
    inputValue < 0 ||
    !Number.isFinite(outputValue) ||
    outputValue < 0
  ) {
    throw new Error("Model pricing must use finite non-negative numbers.");
  }
  return {
    inputPerMillionTokensUsd: inputValue,
    outputPerMillionTokensUsd: outputValue,
  };
}

function proposalFor(
  args: string[],
  defaultTeamTemplate?: TeamTemplateId,
): OrganizationProposal {
  const explicitTeamTemplate = teamTemplateOf(args);
  const teamTemplate = explicitTeamTemplate ?? defaultTeamTemplate;
  return createProposal(targetOf(args), profileOf(args), {
    webSearch: option(args, "--web-search-searxng") !== undefined,
    ...(teamTemplate
      ? {
          teamTemplate,
          teamTemplateSource: explicitTeamTemplate
            ? "explicit" as const
            : "kickoff_default" as const,
        }
      : {}),
  });
}

function webSearchFrom(
  args: string[],
): RuntimeConfig["webSearch"] | undefined {
  const endpoint = option(args, "--web-search-searxng");
  if (endpoint && has(args, "--disable-web-search")) {
    throw new Error(
      "--web-search-searxng and --disable-web-search cannot be used together.",
    );
  }
  if (!endpoint) return undefined;
  return {
    adapter: "searxng",
    endpoint,
    timeoutMs: Number(option(args, "--web-search-timeout-ms") ?? 20_000),
    maxResults: Number(option(args, "--web-search-max-results") ?? 8),
    maxResponseBytes: Number(
      option(args, "--web-search-max-response-bytes") ?? 1_048_576,
    ),
  };
}

function withWebSearch(
  config: Omit<RuntimeConfig, "webSearch">,
  args: string[],
): RuntimeConfig {
  const webSearch = webSearchFrom(args);
  if (webSearch) {
    const issues = validateWebSearchConfig(webSearch);
    if (issues.length > 0) throw new Error(issues.join("\n"));
  }
  return {
    ...config,
    ...(webSearch ? { webSearch } : {}),
  };
}

function runtimeTemplate(args: string[]): RuntimeConfig {
  const adapter = option(args, "--engine") ?? "fake";
  if (option(args, "--web-search-searxng")) {
    if (adapter === "fake") {
      throw new Error(
        "--web-search-searxng requires a tool-calling model engine; the fake engine never calls tools.",
      );
    }
    if (
      adapter === "openai-compatible" &&
      !has(args, "--tool-calling")
    ) {
      throw new Error(
        "--web-search-searxng with openai-compatible requires --tool-calling.",
      );
    }
  }
  if (adapter === "fake") {
    return withWebSearch({
      apiVersion: "chartermesh.dev/runtime/v1alpha1",
      modelEngines: [{ id: "primary-model", adapter: "fake" }],
      managedRunners: [
        {
          id: "local-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "primary-model",
        },
      ],
    }, args);
  }
  if (adapter === "command-process") {
    const command = option(args, "--command");
    if (!command) {
      throw new Error("command-process requires --command ABSOLUTE_PATH.");
    }
    const config: CommandProcessConfig = {
      id: "primary-model",
      command,
      executableSha256: sha256Executable(command),
      args: options(args, "--command-arg"),
      model: option(args, "--model") ?? "command-process",
      timeoutMs: Number(option(args, "--timeout-ms") ?? 60_000),
      environmentAllowlist: options(args, "--pass-env"),
      ...(pricingFrom(args) ? { pricing: pricingFrom(args) } : {}),
    };
    const issues = validateCommandProcessConfig(config);
    if (issues.length > 0) throw new Error(issues.join("\n"));
    return withWebSearch({
      apiVersion: "chartermesh.dev/runtime/v1alpha1",
      modelEngines: [{ adapter: "command-process", ...config }],
      managedRunners: [
        {
          id: "local-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "primary-model",
        },
      ],
    }, args);
  }
  if (adapter !== "openai-compatible") {
    throw new Error(
      "--engine must be fake, command-process, or openai-compatible.",
    );
  }
  const endpoint = option(args, "--endpoint");
  const model = option(args, "--model");
  if (!endpoint || !model) {
    throw new Error(
      "openai-compatible requires --endpoint and --model. Use --api-key-env for remote credentials.",
    );
  }
  const structuredOutputMode =
    option(args, "--structured-output") ?? "prompt";
  if (!["prompt", "json-schema"].includes(structuredOutputMode)) {
    throw new Error("--structured-output must be prompt or json-schema.");
  }
  const reasoningMode = option(args, "--reasoning") ?? "default";
  if (!["default", "disabled"].includes(reasoningMode)) {
    throw new Error("--reasoning must be default or disabled.");
  }
  return withWebSearch({
    apiVersion: "chartermesh.dev/runtime/v1alpha1",
    modelEngines: [
      {
        id: "primary-model",
        adapter: "openai-compatible",
        endpoint,
        model,
        ...(option(args, "--api-key-env")
          ? { apiKeyEnv: option(args, "--api-key-env") }
          : {}),
        timeoutMs: Number(option(args, "--timeout-ms") ?? 60_000),
        maxResponseBytes: Number(
          option(args, "--max-response-bytes") ?? 8_388_608,
        ),
        structuredOutputMode: structuredOutputMode as
          | "prompt"
          | "json-schema",
        ...(has(args, "--tool-calling") ? { toolCalling: true } : {}),
        reasoningMode: reasoningMode as "default" | "disabled",
        ...(pricingFrom(args) ? { pricing: pricingFrom(args) } : {}),
      },
    ],
    managedRunners: [
      {
        id: "local-runner",
        adapter: "builtin-managed-runner",
        modelEngineRef: "primary-model",
      },
    ],
  }, args);
}

function bootstrapPlan(
  args: string[],
  defaultTeamTemplate?: TeamTemplateId,
): BootstrapPlan {
  const target = targetOf(args);
  assertNoPendingFileTransactions(target);
  const runtime = runtimeTemplate(args);
  const paths = statePaths(target);
  if (existsSync(join(paths.root, "project-customization.json"))) {
    throw new Error("PROJECT_CUSTOMIZED: use configure-project to refresh or change this project; bootstrap would replace its approved custom settings.");
  }
  const preferences = readProjectPreferences(target);
  const proposal = proposalFor(args, defaultTeamTemplate);
  const desired = [
    {
      path: join(paths.root, "preferences.json"),
      content: existsSync(join(paths.root, "preferences.json"))
        ? readBoundedRegularText(join(paths.root, "preferences.json"), { maxBytes: 1024 * 1024 })
        : `${JSON.stringify(preferences, null, 2)}\n`,
    },
    { path: join(paths.root, "PREFERENCES.md"), content: renderProjectPreferences(preferences) },
    {
      path: paths.proposal,
      content: `${JSON.stringify(proposal, null, 2)}\n`,
    },
    {
      path: paths.organization,
      content: `${JSON.stringify(proposal.organization, null, 2)}\n`,
    },
    {
      path: paths.runtime,
      content: `${JSON.stringify(runtime, null, 2)}\n`,
    },
    {
      path: paths.installation,
      content: `${JSON.stringify(
        {
          apiVersion: "chartermesh.dev/installation/v1alpha1",
          charterMeshVersion: CHARTERMESH_VERSION,
          proposalHash: proposal.proposalHash,
          assessmentHash: proposal.assessment.assessmentHash,
          profile: proposal.profile,
          ...(proposal.teamDesign
            ? { teamTemplate: proposal.teamDesign.template }
            : {}),
        },
        null,
        2,
      )}\n`,
    },
    ...(proposal.teamDesign
      ? [{
          path: join(paths.root, "team-design.json"),
          content: `${JSON.stringify(proposal.teamDesign, null, 2)}\n`,
        }]
      : []),
    {
      path: join(paths.root, ".gitignore"),
      content: [
        "state.db",
        "state.db-*",
        "artifacts/",
        "backups/",
        "engine-work/",
        "hosts/",
        "exports/",
        "dashboard.port",
        ".transactions/",
        ".apply-lock/",
        "operations/",
        "",
      ].join("\n"),
    },
    {
      path: join(paths.root, "README.md"),
      content: [
        "# CharterMesh local state",
        "",
        "- `proposal.json`, `organization.json`, and `runtime.json` are reviewable desired configuration.",
        "- `team-design.json` and `TEAM-CHARTER.md` describe approved roles, allocation, handoffs, and human approval rules when kickoff is used.",
        "- `installation.json` pins the CharterMesh version and proposal hashes.",
        "- `state.db` is the local mutable ledger and is ignored by Git.",
        "- `backups/` and `exports/` can contain private operational metadata and are ignored by Git.",
        "- Credentials are read only from the environment variable named in `runtime.json`.",
        "- `AGENT-ENTRYPOINT.md` and `skills/` contain provider-neutral, Apache-2.0 guidance.",
        "- External search is disabled unless `runtime.json` names a reviewed endpoint and OrgSpec allows `web.search`.",
        `- Run \`npx --yes ${CHARTERMESH_GITHUB_REF} doctor --target .\` before live model use.`,
        "",
      ].join("\n"),
    },
    {
      path: join(paths.root, "AGENT-ENTRYPOINT.md"),
      content: portableAgentEntrypoint(),
    },
    ...portableSkillDocuments().map(({ id, content }) => ({
      path: join(paths.root, "skills", id, "SKILL.md"),
      content,
    })),
  ];
  const files = desired.map(({ path, content }) => ({
    path,
    content,
    beforeHash: existsSync(path)
      ? createHash("sha256")
          .update(readFileSync(path))
          .digest("hex")
      : null,
    afterHash: createHash("sha256").update(content).digest("hex"),
  }));
  const body = {
    apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const,
    operation: "bootstrap" as const,
    target,
    engine: runtime.modelEngines[0]?.adapter ?? "unknown",
    files,
  };
  return { ...body, planHash: sha256(body) };
}

function inferredKickoffTitle(brief: string): string {
  const preferredLabels = new Set([
    "name",
    "title",
    "goal",
    "objective",
    "project name",
    "project title",
    "project goal",
    "project objective",
    "이름",
    "제목",
    "목표",
    "목적",
    "프로젝트명",
    "프로젝트 명",
    "프로젝트 제목",
    "프로젝트 목표",
    "프로젝트 목적",
  ]);
  const genericLabels = new Set([
    "type",
    "category",
    "requirements",
    "constraints",
    "acceptance criteria",
    "project type",
    "project category",
    "유형",
    "분류",
    "요구사항",
    "제약사항",
    "승인 기준",
    "프로젝트 유형",
    "프로젝트 분류",
  ]);
  let takeNextAsPreferred = false;
  const preferred: string[] = [];
  const headings: string[] = [];
  const fallback: string[] = [];
  for (const rawLine of brief.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const isHeading = /^#+\s*/u.test(trimmed);
    const clean = trimmed.replace(/^#+\s*/u, "").trim();
    if (!clean) continue;
    const label = clean.replace(/[：:]$/u, "").trim().toLowerCase();
    if (isHeading && preferredLabels.has(label)) {
      takeNextAsPreferred = true;
      continue;
    }
    if (isHeading && genericLabels.has(label)) {
      takeNextAsPreferred = false;
      continue;
    }
    if (takeNextAsPreferred && !isHeading) {
      preferred.push(clean);
      takeNextAsPreferred = false;
    } else if (isHeading) {
      takeNextAsPreferred = false;
      headings.push(clean);
    }
    fallback.push(clean);
  }
  return (preferred[0] ?? headings[0] ?? fallback[0] ??
    "Implement the approved project brief").slice(0, 240);
}

async function kickoffPlan(args: string[]): Promise<BootstrapPlan> {
  const briefFile = option(args, "--brief-file");
  if (!briefFile) {
    throw new Error("kickoff requires --brief-file PATH.");
  }
  const briefPath = resolve(briefFile);
  if (!existsSync(briefPath) || !statSync(briefPath).isFile()) {
    throw new Error(`Project brief does not exist: ${briefPath}`);
  }
  const briefBytes = readFileSync(briefPath);
  if (briefBytes.byteLength > 65_536) {
    throw new Error("Project brief must be 64 KiB or smaller.");
  }
  const rawBrief = briefBytes.toString("utf8");
  if (rawBrief.includes("\0")) {
    throw new Error("Project brief cannot contain NUL bytes.");
  }
  const brief = rawBrief.trim();
  if (!brief) throw new Error("Project brief cannot be empty.");
  let base = bootstrapPlan(args, "general");
  if (option(args, "--host") !== undefined) {
    base = await withInitialHostProjection(base, args);
  }
  const titleFromBrief = inferredKickoffTitle(brief);
  const title = (option(args, "--title") ?? titleFromBrief).trim();
  if (!title || title.length > 240) {
    throw new Error("Kickoff title must contain 1 to 240 characters.");
  }
  const proposalFile = base.files.find(
    ({ path }) => path === statePaths(base.target).proposal,
  );
  const organizationFile = base.files.find(
    ({ path }) => path === statePaths(base.target).organization,
  );
  if (!proposalFile || !organizationFile) {
    throw new Error("Kickoff plan is missing its proposal or organization file.");
  }
  const proposal = JSON.parse(proposalFile.content) as OrganizationProposal;
  const organization = parseOrgSpec(organizationFile.content);
  if (!proposal.teamDesign) {
    throw new Error("Kickoff requires a generated team design.");
  }
  const ownerRole = option(args, "--role") ?? proposal.teamDesign.entryRole;
  const selectedRole = organization.spec.roles.find(({ id }) => id === ownerRole);
  if (!selectedRole) {
    throw new Error(
      `--role '${ownerRole}' is not present in the generated team design.`,
    );
  }
  const executionTarget =
    option(args, "--execution-target") ?? selectedRole.execution.preferred;
  const selectedTarget = organization.spec.executionTargets.find(
    ({ id }) => id === executionTarget,
  );
  if (!selectedTarget?.enabled) {
    throw new Error(
      `--execution-target '${executionTarget}' is not an enabled target in the generated organization.`,
    );
  }
  const priority = Number(option(args, "--priority") ?? 70);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    throw new Error("--priority must be an integer from 0 to 100.");
  }
  const briefHash = createHash("sha256").update(brief).digest("hex");
  const acceptanceTexts = options(args, "--acceptance");
  const criteria = (
    acceptanceTexts.length > 0
      ? acceptanceTexts
      : ["The deliverable satisfies the approved project brief and reports its verification evidence."]
  ).map((text, index) => {
    const clean = text.trim();
    if (!clean || clean.length > 4_000) {
      throw new Error("Each --acceptance value must contain 1 to 4000 characters.");
    }
    return {
      id: `kickoff-${index + 1}`,
      text: clean,
      critical: true,
      evidenceRequirements: [] as [],
    };
  });
  const summaryPrefix =
    `Implement the approved project brief stored at .chartermesh/PROJECT-BRIEF.md ` +
    `(SHA-256 ${briefHash}).\n\n`;
  const summary = `${summaryPrefix}${brief}`.slice(0, 4_000);
  const projectBriefPath = join(base.target, ".chartermesh", "PROJECT-BRIEF.md");
  const teamCharterPath = join(base.target, ".chartermesh", "TEAM-CHARTER.md");
  const rootGuidePath = join(base.target, "CHARTERMESH.md");
  const extraDesired = [
    {
      path: projectBriefPath,
      content: `${brief}\n`,
    },
    {
      path: teamCharterPath,
      content: renderTeamCharter({
        projectTitle: title,
        briefHash,
        profile: proposal.profile,
        teamDesign: proposal.teamDesign,
        approvalRequiredTools: [
          ...new Set(
            organization.spec.roles.flatMap(
              ({ tools }) => tools.approvalRequired ?? [],
            ),
          ),
        ],
      }),
    },
    {
      path: rootGuidePath,
      content: [
        "# CharterMesh project",
        "",
        "The approved project brief is `.chartermesh/PROJECT-BRIEF.md`.",
        "The approved team, work allocation, copy/paste handoffs, and human approval matrix are in `.chartermesh/TEAM-CHARTER.md`.",
        "Mutable work, runs, host bindings, evidence, and decisions live in the local Control Plane database.",
        "Do not replace that ledger with a Markdown task list or a provider-native task list.",
        "",
        "Start every coding-agent session by reading `.chartermesh/AGENT-ENTRYPOINT.md`, then run:",
        "",
        "```text",
        `npx --yes ${CHARTERMESH_GITHUB_REF} doctor --target .`,
        `npx --yes ${CHARTERMESH_GITHUB_REF} list --target . --active-only`,
        "```",
        "",
        "Use the CharterMesh CLI or its local MCP server for state changes. Human approval remains required for exact plans, tools that require approval, and final decisions.",
        "",
      ].join("\n"),
    },
  ];
  const files = [
    ...base.files,
    ...extraDesired.map(({ path, content }) => ({
      path,
      content,
      beforeHash: existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    })),
  ];
  const kickoff = {
    title,
    summary,
    briefHash,
    ownerRole,
    executionTarget,
    priority,
    decisionQuestion:
      option(args, "--decision-question") ??
      "Does the result satisfy the approved project brief?",
    acceptanceCriteria: criteria,
  };
  const projectedHostKind = option(args, "--host") as HostKind | undefined;
  const onboarding: NonNullable<BootstrapPlan["onboarding"]> = {
    teamTemplate: proposal.teamDesign.template,
    teamSource: proposal.teamDesign.source,
    entryRole: proposal.teamDesign.entryRole,
    roleIds: proposal.teamDesign.roles.map(({ id }) => id),
    stageIds: proposal.teamDesign.stages.map(({ id }) => id),
    teamCharterPath: ".chartermesh/TEAM-CHARTER.md",
    handoffMode: "copy_paste",
    allocationMode: "single_entry_work_item_with_manual_role_consultations",
    approvalMode: "exact_hash_human",
    executionBoundary: proposal.teamDesign.executionBoundary,
    ...(projectedHostKind
      ? {
          hostProjection: {
            kind: projectedHostKind,
            executionTarget: `${projectedHostKind}-project`,
            newSessionRequired: true as const,
          },
        }
      : {}),
  };
  const body = {
    apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const,
    operation: "kickoff" as const,
    target: base.target,
    engine: base.engine,
    files,
    kickoff,
    onboarding,
    ...(base.hostBinding ? { hostBinding: base.hostBinding } : {}),
  };
  return { ...body, planHash: sha256(body) };
}

function hostKindOf(args: string[]): HostKind {
  const value = option(args, "--host");
  if (value !== "codex" && value !== "claude") {
    throw new Error("--host must be codex or claude.");
  }
  return value;
}

function declaredHostCapabilitySnapshot(
  hostKind: HostKind,
  directProtocol: boolean,
): HostCapabilitySnapshotInput {
  return {
    contractVersion: "chartermesh.dev/host-capabilities/v1alpha1",
    hostKind,
    capabilities: [
      { name: "agents.project", support: "native", stability: "beta" },
      { name: "instructions.project", support: "native", stability: "stable" },
      { name: "mcp.stdio", support: "native", stability: "stable" },
      {
        name: "sessions.resume",
        support: hostKind === "codex" && directProtocol
          ? "native"
          : "manual_step_required",
        stability: "beta",
      },
    ],
  };
}

function locateHostExecutable(command: string): string | null {
  if (isAbsolute(command)) {
    return existsSync(command) && statSync(command).isFile()
      ? realpathSync(command)
      : null;
  }
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return existsSync(candidate) && statSync(candidate).isFile()
      ? realpathSync(candidate)
      : null;
  }
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? [".exe", ".cmd", ".bat", ".com", ""]
    : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return realpathSync(candidate);
        }
      } catch {
        // Continue through PATH entries that are inaccessible or stale.
      }
    }
  }
  return null;
}

async function inspectHost(
  target: string,
  args: string[],
): Promise<HostExecutableBinding & {
  args: string[];
  protocolVersion?: string;
}> {
  const hostKind = hostKindOf(args);
  const directProtocol =
    hostKind === "codex" &&
    (has(args, "--direct") || options(args, "--activate-role").length > 0);
  const hostArgs = options(args, "--host-arg");
  const executableInput = option(args, "--executable") ?? hostKind;
  const located = locateHostExecutable(executableInput);
  if (!located) {
    throw new Error(
      `${hostKind} executable was not found. Pass --executable ABSOLUTE_PATH.`,
    );
  }
  const windowsCommandWrapper =
    process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(located);
  if (windowsCommandWrapper && hostArgs.length > 0) {
    throw new Error(
      "Windows command wrappers do not accept --host-arg during host discovery.",
    );
  }
  if (windowsCommandWrapper && /[&|<>^%!`\r\n]/u.test(located)) {
    throw new Error(
      "Windows command wrapper path contains unsafe shell metacharacters.",
    );
  }
  const observedSha256 = createHash("sha256")
    .update(readFileSync(located))
    .digest("hex");
  const explicitExpectedSha256 = option(args, "--executable-sha256");
  if (
    explicitExpectedSha256 !== undefined &&
    !/^[a-f0-9]{64}$/u.test(explicitExpectedSha256)
  ) {
    throw new Error("--executable-sha256 must be a lowercase SHA-256 digest.");
  }
  if (
    explicitExpectedSha256 !== undefined &&
    explicitExpectedSha256 !== observedSha256
  ) {
    throw new Error(
      "Host executable bytes do not match --executable-sha256; no host process was started.",
    );
  }
  const expectedSha256 = explicitExpectedSha256 ?? observedSha256;
  let observedVersionOutput = "";
  const result = await discoverHost(
    {
      hostKind,
      executablePath: located,
      expectedExecutableSha256: expectedSha256,
      expectedVersion: option(args, "--expected-version"),
      expectedCapabilitySnapshotSha256: option(
        args,
        "--capability-snapshot-sha256",
      ),
      requiredCapabilities: [
        "agents.project",
        "instructions.project",
        "mcp.stdio",
      ],
      capabilitySnapshot: declaredHostCapabilitySnapshot(hostKind, directProtocol),
      versionArgs: [...hostArgs, "--version"],
      projectRoot: target,
    },
    {
      files: {
        async locateExecutable(command) {
          return locateHostExecutable(command);
        },
        async realpath(path) {
          return realpathSync(path);
        },
        async isFile(path) {
          return statSync(path).isFile();
        },
        async readFile(path) {
          return readFileSync(path);
        },
      },
      process: {
        async run(input) {
          const windowsWrapper =
            process.platform === "win32" &&
            /\.(?:cmd|bat)$/iu.test(input.executable);
          const systemRoot =
            process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
          if (
            windowsWrapper &&
            (input.args.length !== 1 || input.args[0] !== "--version")
          ) {
            throw new Error(
              "Windows command wrappers may be probed only with --version.",
            );
          }
          const spawnOptions = {
            cwd: input.cwd,
            env: windowsWrapper
              ? {
                  SystemRoot: systemRoot,
                  WINDIR: systemRoot,
                  ComSpec:
                    process.env.ComSpec ??
                    join(systemRoot, "System32", "cmd.exe"),
                  PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
                  PATH: [
                    dirname(process.execPath),
                    dirname(input.executable),
                  ].join(";"),
                }
              : input.environment,
            encoding: "utf8" as const,
            timeout: 10_000,
            maxBuffer: input.maxOutputBytes,
            windowsHide: true,
          };
          const probe = windowsWrapper
            ? spawnSync(`"${input.executable}" --version`, {
                ...spawnOptions,
                shell: true,
              })
            : spawnSync(input.executable, [...input.args], {
                ...spawnOptions,
                shell: false,
              });
          if (probe.error) throw probe.error;
          observedVersionOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
          return {
            exitCode: probe.status ?? -1,
            stdout: probe.stdout ?? "",
            stderr: probe.stderr ?? "",
          };
        },
      },
    },
  );
  if (!result.ok || !result.binding) {
    throw new Error(
      result.issues.map(({ code, message }) => `${code}: ${message}`).join("\n"),
    );
  }
  if (
    hostKind === "claude" &&
    !/\bClaude Code\b/iu.test(observedVersionOutput)
  ) {
    throw new Error(
      "Claude executable version output did not identify Anthropic Claude Code.",
    );
  }
  if (hostKind === "codex" && !/\bcodex(?:-cli)?\b/iu.test(observedVersionOutput)) {
    throw new Error(
      "Codex executable version output did not identify OpenAI Codex CLI.",
    );
  }
  if (hostKind === "codex" && directProtocol) {
    const adapter = new CodexAppServerAgentHost({
      id: "codex-protocol-probe",
      command: result.binding.executablePath,
      ...(hostArgs.length > 0 ? { args: hostArgs } : {}),
      executableSha256: result.binding.executableSha256,
      workingDirectory: target,
      allowUnrestrictedRead: true,
      discoveryTimeoutMs: 15_000,
    });
    const discovery = await adapter.discover();
    if (!discovery.available) {
      throw new Error(
        discovery.diagnostics
          .map(({ code, message }) => `${code}: ${message}`)
          .join("\n") || "Codex app-server protocol discovery failed.",
      );
    }
    if (discovery.providerVersion !== result.binding.reportedVersion) {
      throw new Error(
        `Codex app-server reported ${discovery.providerVersion ?? "an unknown version"}, but the executable reported ${result.binding.reportedVersion}.`,
      );
    }
    return {
      ...result.binding,
      args: hostArgs,
      ...(discovery.protocolVersion
        ? { protocolVersion: discovery.protocolVersion }
        : {}),
    };
  }
  return { ...result.binding, args: hostArgs };
}

function splitTomlSections(text: string): Array<{
  name: string;
  header: string;
  body: string[];
}> {
  const sections: Array<{ name: string; header: string; body: string[] }> = [];
  let current: { name: string; header: string; body: string[] } | undefined;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (match) {
      current = { name: match[1]!.trim(), header: line, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

function assertMergeableCodexToml(text: string): void {
  if (/"""|'''/u.test(text)) {
    throw new Error(
      "Codex config contains a multiline string; refusing an ambiguous merge.",
    );
  }
  const seenTables = new Set<string>();
  let table = "";
  for (const [offset, line] of text.replaceAll("\r\n", "\n").split("\n").entries()) {
    const lineNumber = offset + 1;
    if (/^\s*#/u.test(line)) continue;
    if (/^\s*\[\[/u.test(line)) {
      throw new Error(
        `Codex config contains an array table at line ${lineNumber}; refusing an ambiguous merge.`,
      );
    }
    const headerLike = /^\s*\[/u.test(line);
    const header = line.match(
      /^\s*\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/u,
    );
    if (headerLike) {
      if (!header) {
        throw new Error(
          `Codex config contains an unsupported or quoted table at line ${lineNumber}.`,
        );
      }
      table = header[1]!;
      if (seenTables.has(table)) {
        throw new Error(`Codex config has duplicate ${table} tables.`);
      }
      seenTables.add(table);
      if (
        table.startsWith("agents.") ||
        table.startsWith("mcp_servers.chartermesh.")
      ) {
        throw new Error(
          `Codex config defines the managed namespace '${table}' as a nested table.`,
        );
      }
      continue;
    }
    const uncommented = line.replace(/\s+#.*$/u, "").trim();
    if (!uncommented) continue;
    const assignment = uncommented.match(/^([^=]+?)\s*=\s*(.*)$/u);
    if (!assignment) {
      throw new Error(`Codex config has unsupported syntax at line ${lineNumber}.`);
    }
    const key = assignment[1]!.trim();
    const value = assignment[2]!.trim();
    if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
      throw new Error(
        `Codex config contains a dotted or quoted key at line ${lineNumber}; refusing an ambiguous merge.`,
      );
    }
    if (value.startsWith("{")) {
      throw new Error(
        `Codex config contains an inline table at line ${lineNumber}; refusing an ambiguous merge.`,
      );
    }
    if (
      (table === "" && (key === "agents" || key === "mcp_servers")) ||
      (table === "mcp_servers" && key === "chartermesh")
    ) {
      throw new Error(
        `Codex config defines the managed namespace through '${key}' at line ${lineNumber}.`,
      );
    }
  }
}

function mergeCodexToml(existing: string, fragment: string): string {
  if (!existing.trim()) return fragment.endsWith("\n") ? fragment : `${fragment}\n`;
  assertMergeableCodexToml(existing);
  const fragmentSections = splitTomlSections(fragment);
  const agentFragment = fragmentSections.find(({ name }) => name === "agents");
  const mcpFragment = fragmentSections.find(
    ({ name }) => name === "mcp_servers.chartermesh",
  );
  if (!agentFragment || !mcpFragment) {
    throw new Error("Generated Codex projection fragment is incomplete.");
  }
  let lines = existing.replaceAll("\r\n", "\n").split("\n");
  const tableRanges = (name: string) => {
    const starts = lines
      .map((line, index) => ({
        index,
        match: line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u),
      }))
      .filter(({ match }) => match?.[1]?.trim() === name)
      .map(({ index }) => index);
    return starts.map((start) => ({
      start,
      end:
        lines.findIndex(
          (line, index) =>
            index > start && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(line),
        ) < 0
          ? lines.length
          : lines.findIndex(
              (line, index) =>
                index > start && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(line),
            ),
    }));
  };
  const existingMcp = tableRanges("mcp_servers.chartermesh");
  if (existingMcp.length > 1) {
    throw new Error("Codex config has duplicate mcp_servers.chartermesh tables.");
  }
  if (existingMcp[0]) {
    lines.splice(existingMcp[0].start, existingMcp[0].end - existingMcp[0].start);
  }
  const existingAgents = tableRanges("agents");
  if (existingAgents.length > 1) {
    throw new Error("Codex config has duplicate agents tables.");
  }
  const desiredAgentLines = agentFragment.body.filter((line) =>
    /^\s*[A-Za-z0-9_.-]+\s*=/u.test(line)
  );
  if (!existingAgents[0]) {
    while (lines.at(-1) === "") lines.pop();
    lines.push("", agentFragment.header, ...desiredAgentLines);
  } else {
    let range = tableRanges("agents")[0]!;
    for (const desiredLine of desiredAgentLines) {
      const key = desiredLine.match(/^\s*([A-Za-z0-9_.-]+)\s*=/u)![1]!;
      const matching = lines
        .map((line, index) => ({ line, index }))
        .filter(
          ({ line, index }) =>
            index > range.start &&
            index < range.end &&
            line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/u)?.[1] === key,
        );
      if (matching.length > 1) {
        throw new Error(`Codex config has duplicate agents.${key} keys.`);
      }
      if (matching[0]) lines[matching[0].index] = desiredLine;
      else {
        lines.splice(range.end, 0, desiredLine);
        range = { ...range, end: range.end + 1 };
      }
    }
  }
  while (lines.at(-1) === "") lines.pop();
  lines.push("", mcpFragment.header, ...mcpFragment.body.filter((line) => line.length > 0), "");
  return lines.join("\n");
}

function mergeClaudeMcpJson(existing: string, fragment: string): string {
  const current = existing.trim() ? JSON.parse(existing) as unknown : {};
  const desired = JSON.parse(fragment) as {
    mcpServers: { chartermesh: unknown };
  };
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(".mcp.json must contain a JSON object.");
  }
  const record = current as Record<string, unknown>;
  const currentServers = record.mcpServers;
  if (
    currentServers !== undefined &&
    (!currentServers || typeof currentServers !== "object" || Array.isArray(currentServers))
  ) {
    throw new Error(".mcp.json mcpServers must contain a JSON object.");
  }
  return `${JSON.stringify(
    {
      ...record,
      mcpServers: {
        ...((currentServers ?? {}) as Record<string, unknown>),
        chartermesh: desired.mcpServers.chartermesh,
      },
    },
    null,
    2,
  )}\n`;
}

function upsertMarkdownProjection(
  existing: string,
  sectionId: string,
  content: string,
): string {
  const begin = `<!-- chartermesh:${sectionId}:begin -->`;
  const end = `<!-- chartermesh:${sectionId}:end -->`;
  const section = `${begin}\n${content.trim()}\n${end}`;
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) {
    throw new Error(`Markdown integration markers for '${sectionId}' are malformed.`);
  }
  if (start >= 0) {
    const after = finish + end.length;
    return `${existing.slice(0, start)}${section}${existing.slice(after)}`;
  }
  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${section}\n`;
}

const HOST_PROJECTION_MAX_EXISTING_BYTES = 1024 * 1024;

function readProjectionFile(target: string, candidate: string): string {
  const root = resolve(target);
  const path = resolve(candidate);
  const rest = relative(root, path);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new Error("Host projection path escapes the target.");
  }
  const ancestors: string[] = [];
  let cursor = path;
  while (true) {
    ancestors.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of ancestors.reverse()) {
    if (!existsSync(component)) break;
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error(
        `Host projection refuses a linked or reparse-point path: ${component}`,
      );
    }
  }
  if (!existsSync(path)) return "";
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.size > HOST_PROJECTION_MAX_EXISTING_BYTES
  ) {
    throw new Error(
      `Host projection source must be a regular file no larger than ${HOST_PROJECTION_MAX_EXISTING_BYTES} bytes.`,
    );
  }
  let descriptor: number | undefined;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > HOST_PROJECTION_MAX_EXISTING_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("Host projection source changed while opening.");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function projectionContent(target: string, operation: HostProjectionOperation): string {
  const path = resolve(target, operation.path);
  const relativePath = relative(resolve(target), path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Host projection path escapes the target: ${operation.path}`);
  }
  if (createHash("sha256").update(operation.content).digest("hex") !== operation.contentSha256) {
    throw new Error(`Host projection content hash mismatch: ${operation.path}`);
  }
  const existing = readProjectionFile(target, path);
  if (operation.kind === "write_managed_file") return operation.content;
  if (operation.kind === "merge_toml_fragment") {
    return mergeCodexToml(existing, operation.content);
  }
  if (operation.kind === "merge_json_fragment") {
    return mergeClaudeMcpJson(existing, operation.content);
  }
  return upsertMarkdownProjection(existing, operation.sectionId, operation.content);
}

async function withInitialHostProjection(
  base: BootstrapPlan,
  args: string[],
): Promise<BootstrapPlan> {
  if (options(args, "--activate-role").length > 0 || has(args, "--direct")) {
    throw new Error(
      "kickoff --host creates project roles and the MCP bridge in one approved plan; " +
      "--activate-role and --direct are only available to configure-host after initialization.",
    );
  }
  if (option(args, "--executable-sha256") === undefined) {
    const hostKind = hostKindOf(args);
    const executableInput = option(args, "--executable") ?? hostKind;
    const located = locateHostExecutable(executableInput);
    if (!located) {
      throw new Error(
        `${hostKind} executable was not found. Pass --executable ABSOLUTE_PATH.`,
      );
    }
    const observedSha256 = createHash("sha256")
      .update(readFileSync(located))
      .digest("hex");
    throw new Error(
      "kickoff --host will execute the host only after its bytes are explicitly bound. " +
        `Repeat with --executable-sha256 ${observedSha256}; no host process was started.`,
    );
  }
  const binding = await inspectHost(base.target, args);
  if (binding.hostKind === "codex" && !has(args, "--allow-unrestricted-read")) {
    throw new Error(
      "Configuring Codex roles requires --allow-unrestricted-read because its read-only sandbox does not confine reads to the project directory.",
    );
  }
  const paths = statePaths(base.target);
  const organizationFile = base.files.find(
    ({ path }) => path === paths.organization,
  );
  const proposalFile = base.files.find(({ path }) => path === paths.proposal);
  const installationFile = base.files.find(
    ({ path }) => path === paths.installation,
  );
  if (!organizationFile || !proposalFile || !installationFile) {
    throw new Error(
      "Initial host projection requires organization, proposal, and installation files.",
    );
  }
  const organization = parseOrgSpec(organizationFile.content);
  const projectHostId = `${binding.hostKind}-project-host`;
  const projectTargetId = `${binding.hostKind}-project`;
  const roles = organization.spec.roles.map((role) => ({
    id: role.id,
    description: `${role.name}: ${role.class} role for ${organization.metadata.name}.`,
    instructions: [
      `Fulfill the '${role.id}' role using capabilities: ${role.capabilities.join(", ") || "none"}.`,
      `Allowed tools: ${role.tools.allow.join(", ") || "none"}.`,
      role.tools.approvalRequired?.length
        ? `The following tools still require Control Plane approval: ${role.tools.approvalRequired.join(", ")}.`
        : "Do not infer any additional approval authority.",
    ].join("\n"),
    permission:
      role.tools.allow.includes("workspace.write_file") &&
        !role.tools.approvalRequired?.includes("workspace.write_file")
        ? "workspace_write" as const
        : "read_only" as const,
  }));
  const projection = createHostProjectionPlan({
    binding,
    roles,
    bridge: {
      command: option(args, "--bridge-command") ?? "npx",
      args:
        options(args, "--bridge-arg").length > 0
          ? options(args, "--bridge-arg")
          : [
              "--yes",
              CHARTERMESH_GITHUB_REF,
              "mcp",
              "serve",
              "--find-project-root",
              "--actor",
              `host:${binding.hostKind}`,
              ...roles.flatMap(({ id }) => ["--role", id]),
              "--execution-target",
              projectTargetId,
            ],
      cwd: ".",
    },
    maxConcurrentAgents: Number(option(args, "--max-agents") ?? 4),
  });

  organization.spec.agentHosts = [
    ...organization.spec.agentHosts.filter(({ id }) => id !== projectHostId),
    {
      id: projectHostId,
      adapter: `${binding.hostKind}-project-session`,
      executionHost: "local",
      enabled: true,
    },
  ];
  organization.spec.executionTargets = [
    ...organization.spec.executionTargets.filter(
      ({ id }) => id !== projectTargetId,
    ),
    {
      id: projectTargetId,
      kind: "agent_host",
      hostRef: projectHostId,
      enabled: true,
    },
  ];
  for (const role of organization.spec.roles) {
    const candidates = [
      role.execution.preferred,
      ...(role.execution.fallbacks ?? []),
    ];
    role.execution = {
      preferred: projectTargetId,
      fallbacks: [...new Set(candidates)].filter(
        (targetId) =>
          targetId !== projectTargetId &&
          organization.spec.executionTargets.some(
            ({ id, enabled }) => id === targetId && enabled,
          ),
      ),
    };
  }
  const organizationContent = `${JSON.stringify(organization, null, 2)}\n`;
  parseOrgSpec(organizationContent);

  const proposal = JSON.parse(proposalFile.content) as OrganizationProposal;
  const { proposalHash: _proposalHash, ...proposalWithoutHash } = proposal;
  const proposalBody = {
    ...proposalWithoutHash,
    organization,
    rationale: [
      ...proposal.rationale,
      `Projected the approved team into the ${binding.hostKind} project host capability.`,
    ],
  };
  const projectedProposal: OrganizationProposal = {
    ...proposalBody,
    proposalHash: sha256(proposalBody),
  };
  const installation = JSON.parse(installationFile.content) as Record<
    string,
    unknown
  >;
  installation.proposalHash = projectedProposal.proposalHash;

  const desired = new Map(
    base.files.map(({ path, content }) => [path, content] as const),
  );
  desired.set(paths.organization, organizationContent);
  desired.set(
    paths.proposal,
    `${JSON.stringify(projectedProposal, null, 2)}\n`,
  );
  desired.set(
    paths.installation,
    `${JSON.stringify(installation, null, 2)}\n`,
  );
  for (const operation of projection.operations) {
    desired.set(
      resolve(base.target, operation.path),
      projectionContent(base.target, operation),
    );
  }
  desired.set(
    join(paths.root, "hosts", `${binding.hostKind}.json`),
    `${JSON.stringify(
      {
        apiVersion: "chartermesh.dev/host-binding/v1alpha1",
        hostKind: binding.hostKind,
        command: option(args, "--executable") ?? binding.hostKind,
        executableSha256: binding.executableSha256,
        reportedVersion: binding.reportedVersion,
        capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
        capabilitySnapshot: binding.capabilitySnapshot,
        projectionPlanHash: projection.planHash,
        directProtocol: false,
      },
      null,
      2,
    )}\n`,
  );
  const files = [...desired.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({
      path,
      content,
      beforeHash: existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    }));
  const hostBinding = {
    kind: binding.hostKind,
    executablePath: binding.executablePath,
    executableSha256: binding.executableSha256,
    args: binding.args,
    reportedVersion: binding.reportedVersion,
    capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
    projectionPlanHash: projection.planHash,
    directProtocol: false,
  };
  const { planHash: _planHash, ...withoutHash } = base;
  const body = { ...withoutHash, files, hostBinding };
  return { ...body, planHash: sha256(body) };
}

async function configureHostPlan(args: string[]): Promise<BootstrapPlan> {
  const target = targetOf(args);
  assertNoPendingFileTransactions(target);
  const paths = statePaths(target);
  if (!existsSync(paths.organization) || !existsSync(paths.runtime)) {
    throw new Error("CharterMesh is not initialized. Run kickoff or bootstrap first.");
  }
  const binding = await inspectHost(target, args);
  const organization = readOrganization(target);
  const runtime = readRuntime(target);
  const hostId = `${binding.hostKind}-host`;
  const projectHostId = `${binding.hostKind}-project-host`;
  const projectTargetId = `${binding.hostKind}-project`;
  if (binding.hostKind === "codex" && !has(args, "--allow-unrestricted-read")) {
    throw new Error(
      "Configuring Codex roles requires --allow-unrestricted-read because its read-only sandbox does not confine reads to the project directory.",
    );
  }
  const previousRoleTargets = new Map(
    organization.spec.roles.map((role) => [role.id, role.execution.preferred]),
  );
  const roles = organization.spec.roles.map((role) => ({
    id: role.id,
    description: `${role.name}: ${role.class} role for ${organization.metadata.name}.`,
    instructions: [
      `Fulfill the '${role.id}' role using capabilities: ${role.capabilities.join(", ") || "none"}.`,
      `Allowed tools: ${role.tools.allow.join(", ") || "none"}.`,
      role.tools.approvalRequired?.length
        ? `The following tools still require Control Plane approval: ${role.tools.approvalRequired.join(", ")}.`
        : "Do not infer any additional approval authority.",
    ].join("\n"),
    permission:
      role.tools.allow.includes("workspace.write_file") &&
        !role.tools.approvalRequired?.includes("workspace.write_file")
        ? "workspace_write" as const
        : "read_only" as const,
  }));
  const projection = createHostProjectionPlan({
    binding,
    roles,
    bridge: {
      command: option(args, "--bridge-command") ?? "npx",
      args:
        options(args, "--bridge-arg").length > 0
          ? options(args, "--bridge-arg")
          : [
              "--yes",
              `github:jade-blanco/chartermesh#v${CHARTERMESH_VERSION}`,
              "mcp",
              "serve",
              "--find-project-root",
              "--actor",
              `host:${binding.hostKind}`,
              ...roles.flatMap(({ id }) => ["--role", id]),
              "--execution-target",
              projectTargetId,
            ],
      cwd: ".",
    },
    maxConcurrentAgents: Number(option(args, "--max-agents") ?? 4),
  });
  const desired = projection.operations.map((operation) => ({
    path: resolve(target, operation.path),
    content: projectionContent(target, operation),
  }));
  organization.spec.agentHosts = [
    ...organization.spec.agentHosts.filter(({ id }) =>
      ![hostId, projectHostId].includes(id)
    ),
    {
      id: projectHostId,
      adapter: `${binding.hostKind}-project-session`,
      executionHost: "local",
      enabled: true,
    },
  ];
  organization.spec.executionTargets = [
    ...organization.spec.executionTargets.filter(({ id }) =>
      ![hostId, projectTargetId].includes(id)
    ),
    {
      id: projectTargetId,
      kind: "agent_host",
      hostRef: projectHostId,
      enabled: true,
    },
  ];
  if (binding.hostKind === "codex") {
    const activated = options(args, "--activate-role");
    const activatedRoles = new Set(activated);
    if (activated.length > 0) {
      organization.spec.agentHosts.push({
        id: hostId,
        adapter: "codex-app-server",
        executionHost: "local",
        enabled: true,
      });
      organization.spec.executionTargets.push({
        id: hostId,
        kind: "agent_host",
        hostRef: hostId,
        enabled: true,
      });
    }
    for (const roleId of activatedRoles) {
      if (!organization.spec.roles.some(({ id }) => id === roleId)) {
        throw new Error(`Unknown --activate-role '${roleId}'.`);
      }
    }
    for (const role of organization.spec.roles) {
      const direct = activatedRoles.has(role.id);
      const preferred = direct ? hostId : projectTargetId;
      const candidates = [
        ...(direct ? [projectTargetId] : []),
        role.execution.preferred,
        ...(role.execution.fallbacks ?? []),
      ];
      role.execution = {
        preferred,
        fallbacks: [...new Set(candidates)].filter((targetId) =>
          targetId !== preferred &&
          (direct || targetId !== hostId) &&
          organization.spec.executionTargets.some(
            ({ id, enabled }) => id === targetId && enabled,
          )
        ),
      };
    }
    runtime.agentHosts = (runtime.agentHosts ?? []).filter(
      ({ id }) => id !== hostId,
    );
    if (activated.length > 0) {
      runtime.agentHosts.push({
        id: hostId,
        adapter: "codex-app-server",
        command: binding.executablePath,
        executableSha256: binding.executableSha256,
        ...(binding.args.length > 0 ? { args: binding.args } : {}),
        ...(options(args, "--pass-env").length > 0
          ? { environmentAllowlist: options(args, "--pass-env") }
          : {}),
        ...(option(args, "--model") ? { model: option(args, "--model") } : {}),
        ...(option(args, "--reasoning-effort")
          ? {
              reasoningEffort: option(args, "--reasoning-effort") as
                | "low"
                | "medium"
                | "high"
                | "xhigh",
            }
          : {}),
        ...(has(args, "--allow-unrestricted-read")
          ? { allowUnrestrictedRead: true }
          : {}),
        timeoutMs: Number(option(args, "--timeout-ms") ?? 600_000),
      });
    }
    parseRuntimeConfig(`${JSON.stringify(runtime)}\n`);
    desired.push({
      path: paths.runtime,
      content: `${JSON.stringify(runtime, null, 2)}\n`,
    });
  } else {
    if (options(args, "--activate-role").length > 0) {
      throw new Error(
        "Claude role activation requires a future direct AgentHost adapter; project roles and MCP can still be configured now.",
      );
    }
    runtime.agentHosts = (runtime.agentHosts ?? []).filter(
      ({ id }) => id !== hostId,
    );
    parseRuntimeConfig(`${JSON.stringify(runtime)}\n`);
    desired.push({
      path: paths.runtime,
      content: `${JSON.stringify(runtime, null, 2)}\n`,
    });
    for (const role of organization.spec.roles) {
      const candidates = [
        role.execution.preferred,
        ...(role.execution.fallbacks ?? []),
      ];
      role.execution = {
        preferred: projectTargetId,
        fallbacks: [...new Set(candidates)].filter((targetId) =>
          targetId !== projectTargetId &&
          targetId !== hostId &&
          organization.spec.executionTargets.some(
            ({ id, enabled }) => id === targetId && enabled,
          )
        ),
      };
    }
  }
  const targetChanges = new Map(
    organization.spec.roles.flatMap((role) => {
      const fromExecutionTarget = previousRoleTargets.get(role.id);
      return fromExecutionTarget && fromExecutionTarget !== role.execution.preferred
        ? [[
            role.id,
            {
              fromExecutionTarget,
              toExecutionTarget: role.execution.preferred,
            },
          ] as const]
        : [];
    }),
  );
  const workRetargets: NonNullable<BootstrapPlan["workRetargets"]> = [];
  if (targetChanges.size > 0) {
    if (!existsSync(paths.database)) {
      throw new Error(
        "Control Plane database is missing; run doctor before configuring a host.",
      );
    }
    const walPath = `${paths.database}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      throw new Error(
        "Control Plane has uncheckpointed WAL state; stop active writers and run doctor before generating a host plan.",
      );
    }
    const immutableDatabaseUri = `${pathToFileURL(paths.database).href}?mode=ro&immutable=1`;
    const database = new DatabaseSync(immutableDatabaseUri, { readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
      const migrationTable = database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'schema_migrations'
      `).get() as { count: number };
      const schemaVersion = Number(migrationTable.count) === 1
        ? Number(
            (database.prepare(
              "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
            ).get() as { version: number }).version,
          )
        : 0;
      if (schemaVersion !== 15) {
        throw new Error(
          `Control Plane schema v${schemaVersion} cannot be inspected by this no-write plan; run doctor to migrate it to v15 first.`,
        );
      }
      const changedRoles = [...targetChanges.entries()];
      const rows = database.prepare(`
        SELECT id, owner_role, execution_target, status, version
        FROM work_items
        WHERE archived_at IS NULL
          AND status IN ('ready', 'changes_requested')
          AND (${
            changedRoles.map(() =>
              "(owner_role = ? AND execution_target = ?)"
            ).join(" OR ")
          })
        ORDER BY id ASC
        LIMIT 501
      `).all(
        ...changedRoles.flatMap(([ownerRole, change]) => [
          ownerRole,
          change.fromExecutionTarget,
        ]),
      ) as Array<{
        id: string;
        owner_role: string;
        execution_target: string;
        status: string;
        version: number;
      }>;
      for (const item of rows) {
        const change = targetChanges.get(String(item.owner_role));
        if (
          change &&
          String(item.execution_target) === change.fromExecutionTarget
        ) {
          workRetargets.push({
            id: String(item.id),
            expectedVersion: Number(item.version),
            ownerRole: String(item.owner_role),
            fromExecutionTarget: change.fromExecutionTarget,
            toExecutionTarget: change.toExecutionTarget,
          });
          if (workRetargets.length > 500) {
            throw new Error(
              "Host activation would retarget more than 500 unclaimed work items; narrow the work set before activating the role.",
            );
          }
        }
      }
    } finally {
      database.close();
    }
    workRetargets.sort(({ id: left }, { id: right }) =>
      left.localeCompare(right)
    );
  }
  organization.metadata.revision += 1;
  const organizationContent = `${JSON.stringify(organization, null, 2)}\n`;
  parseOrgSpec(organizationContent);
  desired.push({ path: paths.organization, content: organizationContent });
  desired.push({
    path: join(paths.root, "hosts", `${binding.hostKind}.json`),
    content: `${JSON.stringify(
      {
        apiVersion: "chartermesh.dev/host-binding/v1alpha1",
        hostKind: binding.hostKind,
        command: option(args, "--executable") ?? binding.hostKind,
        executableSha256: binding.executableSha256,
        reportedVersion: binding.reportedVersion,
        capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
        capabilitySnapshot: binding.capabilitySnapshot,
        projectionPlanHash: projection.planHash,
        directProtocol: binding.protocolVersion !== undefined,
      },
      null,
      2,
    )}\n`,
  });
  const uniqueDesired = new Map(desired.map((entry) => [entry.path, entry]));
  const files = [...uniqueDesired.values()]
    .sort(({ path: left }, { path: right }) => left.localeCompare(right))
    .map(({ path, content }) => ({
      path,
      content,
      beforeHash: existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    }));
  const hostBinding = {
    kind: binding.hostKind,
    executablePath: binding.executablePath,
    executableSha256: binding.executableSha256,
    args: binding.args,
    reportedVersion: binding.reportedVersion,
    capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
    projectionPlanHash: projection.planHash,
    directProtocol: binding.protocolVersion !== undefined,
  };
  const body = {
    apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const,
    operation: "configure-host" as const,
    target,
    engine: `host:${binding.hostKind}`,
    files,
    hostBinding,
    ...(workRetargets.length > 0 ? { workRetargets } : {}),
  };
  return { ...body, planHash: sha256(body) };
}

async function hostDoctorCommand(target: string, args: string[]): Promise<number> {
  const binding = await inspectHost(target, args);
  const data = {
    ready: true,
    hostKind: binding.hostKind,
    executablePath: binding.executablePath,
    executableSha256: binding.executableSha256,
    reportedVersion: binding.reportedVersion,
    protocolVersion: binding.protocolVersion ?? null,
    capabilityAssessment: "chartermesh_declared" as const,
    postProjectionVerificationRequired: true,
    capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
    capabilities: binding.capabilitySnapshot.capabilities,
  };
  if (has(args, "--json")) writeJsonEnvelope("host doctor", data);
  else {
    console.log(`${binding.hostKind} host: ready`);
    console.log(`Executable: ${binding.executablePath}`);
    console.log(`SHA-256: ${binding.executableSha256}`);
    console.log(`Version: ${binding.reportedVersion}`);
    console.log(`Declared capabilities: ${binding.capabilitySnapshotSha256}`);
    console.log("Post-projection MCP verification required: yes");
  }
  return 0;
}

function runtimePlan(args: string[]): BootstrapPlan {
  const target = targetOf(args);
  assertNoPendingFileTransactions(target);
  const paths = statePaths(target);
  if (!existsSync(paths.organization)) {
    throw new Error("CharterMesh is not initialized. Run bootstrap first.");
  }
  let runtime = runtimeTemplate(args);
  if (
    !option(args, "--web-search-searxng") &&
    !has(args, "--disable-web-search") &&
    existsSync(paths.runtime)
  ) {
    const current = readRuntime(target);
    if (current.webSearch) {
      runtime = { ...runtime, webSearch: current.webSearch };
    }
  }
  if (runtime.webSearch) {
    const runnerEngineIds = new Set(
      runtime.managedRunners.map(({ modelEngineRef }) => modelEngineRef),
    );
    for (const engine of runtime.modelEngines) {
      if (!runnerEngineIds.has(engine.id)) continue;
      if (
        engine.adapter === "fake" ||
        (engine.adapter === "openai-compatible" && !engine.toolCalling)
      ) {
        throw new Error(
          `Configured web search requires tool calling for engine '${engine.id}'.`,
        );
      }
    }
  }
  const path = paths.runtime;
  const content = `${JSON.stringify(runtime, null, 2)}\n`;
  const desired = [
    {
      path,
      content,
    },
  ];
  if (
    option(args, "--web-search-searxng") ||
    has(args, "--disable-web-search")
  ) {
    const organization = readOrganization(target);
    if (has(args, "--disable-web-search")) {
      for (const role of organization.spec.roles) {
        role.capabilities = role.capabilities.filter(
          (capability) => capability !== "web_research",
        );
        role.tools.allow = role.tools.allow.filter(
          (tool) => tool !== "web.search",
        );
        role.tools.approvalRequired = role.tools.approvalRequired?.filter(
          (tool) => tool !== "web.search",
        );
      }
    } else {
      const selectedRoles = options(args, "--web-search-role");
      const roleIds = selectedRoles.length > 0 ? selectedRoles : ["operator"];
      for (const roleId of roleIds) {
        const role = organization.spec.roles.find(({ id }) => id === roleId);
        if (!role) {
          throw new Error(`Unknown --web-search-role '${roleId}'.`);
        }
        role.capabilities = [
          ...new Set([...role.capabilities, "web_research"]),
        ];
        role.tools.allow = [
          ...new Set([...role.tools.allow, "web.search"]),
        ];
        role.tools.approvalRequired = [
          ...new Set([
            ...(role.tools.approvalRequired ?? []),
            "web.search",
          ]),
        ];
      }
    }
    organization.metadata.revision += 1;
    const organizationContent =
      `${JSON.stringify(organization, null, 2)}\n`;
    parseOrgSpec(organizationContent);
    desired.push({
      path: paths.organization,
      content: organizationContent,
    });
  }
  const files = desired.map(({ path: desiredPath, content: desiredContent }) => ({
    path: desiredPath,
    content: desiredContent,
    beforeHash: existsSync(desiredPath)
      ? createHash("sha256").update(readFileSync(desiredPath)).digest("hex")
      : null,
    afterHash: createHash("sha256").update(desiredContent).digest("hex"),
  }));
  const body = {
    apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const,
    operation: "configure-engine" as const,
    target,
    engine: runtime.modelEngines[0]?.adapter ?? "unknown",
    files,
  };
  return { ...body, planHash: sha256(body) };
}

function projectWorkSnapshot(database: DatabaseSync): unknown[] {
  const running = database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'").get() as { count: number };
  if (Number(running.count) > 0) throw new Error("PROJECT_CONFIGURATION_BUSY: finish or cancel active runs before changing project configuration.");
  const rows = database.prepare(
    "SELECT id, owner_role, execution_target, status, version FROM work_items WHERE status NOT IN ('done', 'canceled') ORDER BY id LIMIT 1001",
  ).all();
  if (rows.length > 1000) throw new Error("PROJECT_CONFIGURATION_WORK_LIMIT: finish outstanding work before changing this project.");
  if (rows.some((row) => row.status === "in_progress")) throw new Error("PROJECT_CONFIGURATION_BUSY: active work must settle first.");
  return rows;
}

function configurationReadDatabase(path: string, approvedRecovery = false): DatabaseSync {
  if (approvedRecovery) return new DatabaseSync(path, { readOnly: true });
  // SQLite readOnly alone may create WAL/SHM files. Preview must not write
  // anything in the target, and immutable mode must not ignore a live WAL.
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
    throw new Error("PROJECT_CONFIGURATION_BUSY: close active writers/idle host and dashboard connections so SQLite checkpoints before a no-write configuration preview.");
  }
  return new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
}

function projectConfiguration(target: string) {
  const paths = resolveProjectStatePaths(target, { requireInitialized: true });
  return {
    organization: readOrganization(target),
    preferences: readProjectPreferences(target),
    customization: existsSync(join(paths.root, "project-customization.json"))
      ? JSON.parse(readBoundedRegularText(join(paths.root, "project-customization.json"), { maxBytes: 32 * 1024 }))
      : null,
  };
}

async function configureProjectPlan(args: string[]): Promise<BootstrapPlan> {
  const target = targetOf(args);
  assertNoPendingFileTransactions(target);
  const paths = resolveProjectStatePaths(target, { requireInitialized: true });
  const current = readOrganization(target);
  const candidatePath = option(args, "--organization-file");
  const organization = candidatePath
    ? validateOrganizationCustomization(current, readBoundedRegularText(resolve(candidatePath), { maxBytes: 2 * 1024 * 1024 }))
    : current;
  const preferencesPath = option(args, "--preferences-file");
  const preferences = preferencesPath
    ? parseProjectPreferences(readBoundedRegularText(resolve(preferencesPath), { maxBytes: 1024 * 1024 }))
    : readProjectPreferences(target);
  for (const id of Object.keys(preferences.roleInstructions)) {
    if (!organization.spec.roles.some((role) => role.id === id)) {
      throw new Error(`PROJECT_PREFERENCES_ROLE_UNKNOWN: '${id}' is not in the proposed organization.`);
    }
  }
  const database = configurationReadDatabase(paths.database);
  let snapshot: unknown[];
  try {
    snapshot = projectWorkSnapshot(database);
    for (const record of snapshot as Array<{ id: string; owner_role: string; execution_target: string; status: string }>) {
      if (record.status === "requested" && record.owner_role === "unassigned" && record.execution_target === "unassigned") continue;
      const role = organization.spec.roles.find(({ id }) => id === record.owner_role);
      if (!role || ![role.execution.preferred, ...(role.execution.fallbacks ?? [])].includes(record.execution_target)) {
        throw new Error(`PROJECT_CONFIGURATION_ORPHAN_WORK: '${record.id}' still needs its current role and execution target. Reassign or settle it first.`);
      }
    }
  } finally { database.close(); }
  const desired = [
    { path: paths.organization, content: candidatePath ? `${JSON.stringify(organization, null, 2)}\n` : readBoundedRegularText(paths.organization) },
    { path: paths.runtime, content: readBoundedRegularText(paths.runtime) },
    { path: join(paths.root, "preferences.json"), content: `${JSON.stringify(preferences, null, 2)}\n` },
    { path: join(paths.root, "PREFERENCES.md"), content: renderProjectPreferences(preferences) },
    { path: join(paths.root, "AGENT-ENTRYPOINT.md"), content: portableAgentEntrypoint() },
    ...portableSkillDocuments().map(({ id, content }) => ({ path: join(paths.root, "skills", id, "SKILL.md"), content })),
    { path: join(paths.root, "project-customization.json"), content: `${JSON.stringify({
      apiVersion: "chartermesh.dev/project-customization/v1alpha1", organizationHash: sha256(organization),
      preferencesHash: sha256(preferences), charterMeshVersion: CHARTERMESH_VERSION,
    }, null, 2)}\n` },
  ];
  if (existsSync(paths.installation)) {
    const installation = JSON.parse(readBoundedRegularText(paths.installation, { maxBytes: 128 * 1024 }));
    if (!installation || Array.isArray(installation) || installation.apiVersion !== "chartermesh.dev/installation/v1alpha1") {
      throw new Error("PROJECT_INSTALLATION_INVALID: repair invalid installation metadata before upgrading.");
    }
    desired.push({ path: paths.installation, content: `${JSON.stringify({ ...installation, charterMeshVersion: CHARTERMESH_VERSION }, null, 2)}\n` });
  }
  // Preserve authored guide text; refresh only this package's pinned command.
  for (const path of [join(target, "CHARTERMESH.md"), join(paths.root, "README.md")]) {
    if (!existsSync(path)) continue;
    const prior = readBoundedRegularText(path);
    const content = prior.replace(/github:jade-blanco\/chartermesh#v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?/gu, CHARTERMESH_GITHUB_REF);
    if (content !== prior) desired.push({ path, content });
  }
  if (candidatePath || existsSync(join(paths.root, "project-customization.json"))) {
    desired.push({ path: join(paths.root, "TEAM-CHARTER.md"), content: renderCustomTeamCharter(organization) });
    desired.push({ path: join(paths.root, "team-design.json"), content: `${JSON.stringify({
      apiVersion: "chartermesh.dev/custom-team-design/v1alpha1", source: "approved_custom_orgspec",
      organizationHash: sha256(organization), roles: organization.spec.roles, workflows: organization.spec.workflows,
      executionBoundary: "manual_handoffs_until_workflow_runtime_binding",
    }, null, 2)}\n` });
  }
  // Native role files must not silently become stale when staffing changes.
  const projectedKinds = [...new Set(organization.spec.agentHosts.filter(({ enabled, adapter }) => enabled && /^(codex|claude)-project-session$/u.test(adapter))
    .map(({ adapter }) => adapter.startsWith("codex") ? "codex" : "claude"))];
  let hostBinding: BootstrapPlan["hostBinding"];
  if ((candidatePath && projectedKinds.length > 0) || has(args, "--host")) {
    if (projectedKinds.length !== 1 || option(args, "--host") !== projectedKinds[0]) {
      throw new Error("PROJECT_HOST_REFRESH_REQUIRED: an organization edit with native roles requires the same --host, --executable-sha256 and host acknowledgement in this plan. Multiple native hosts must be migrated separately; this command does not silently leave stale projections.");
    }
    if (!option(args, "--executable-sha256")) throw new Error("PROJECT_HOST_SHA_REQUIRED: provide the reviewed host executable SHA-256.");
    if (projectedKinds[0] === "codex" && !has(args, "--allow-unrestricted-read")) throw new Error("Codex host refresh requires --allow-unrestricted-read.");
    const binding = await inspectHost(target, args);
    const projection = createHostProjectionPlan({
      binding,
      roles: [...organization.spec.roles.map((role) => ({
        id: role.id, description: `${role.name}: ${role.class} role for ${organization.metadata.name}.`,
        instructions: `Read .chartermesh/organization.json and .chartermesh/PREFERENCES.md. Capabilities: ${role.capabilities.join(", ")}. Allowed tools: ${role.tools.allow.join(", ")}. Approval-required tools: ${role.tools.approvalRequired?.join(", ") ?? "none"}.`,
        permission: "read_only" as const,
      })), ...current.spec.roles.filter((role) => !organization.spec.roles.some(({ id }) => id === role.id)).map((role) => ({
        id: role.id, description: `Retired CharterMesh role: ${role.id}`,
        instructions: "This role was retired by an approved organization change. Do not claim work, call tools, delegate, or act. Ask the user to select a current role from organization.json.",
        permission: "read_only" as const,
      }))],
      bridge: { command: "npx", args: ["--yes", CHARTERMESH_GITHUB_REF, "mcp", "serve", "--find-project-root", "--actor", `host:${binding.hostKind}`,
        ...organization.spec.roles.flatMap(({ id }) => ["--role", id]), "--execution-target", `${binding.hostKind}-project`], cwd: "." },
      maxConcurrentAgents: Math.min(organization.spec.budgets.maxConcurrentRuns, 16),
    });
    desired.push(...projection.operations.map((operation) => ({ path: resolve(target, operation.path), content: projectionContent(target, operation) })));
    const bindingPath = join(paths.root, "hosts", `${binding.hostKind}.json`);
    const priorBinding = existsSync(bindingPath) ? JSON.parse(readBoundedRegularText(bindingPath, { maxBytes: 512 * 1024 })) : {};
    desired.push({ path: bindingPath, content: `${JSON.stringify({
      ...priorBinding, apiVersion: "chartermesh.dev/host-binding/v1alpha1", hostKind: binding.hostKind,
      command: binding.executablePath, executableSha256: binding.executableSha256,
      reportedVersion: binding.reportedVersion, capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
      capabilitySnapshot: binding.capabilitySnapshot, projectionPlanHash: projection.planHash, directProtocol: false,
    }, null, 2)}\n` });
    hostBinding = { kind: binding.hostKind, executablePath: binding.executablePath, executableSha256: binding.executableSha256,
      args: binding.args, reportedVersion: binding.reportedVersion, capabilitySnapshotSha256: binding.capabilitySnapshotSha256,
      projectionPlanHash: projection.planHash, directProtocol: false };
  }
  const files = [...new Map(desired.map((file) => [file.path, file])).values()]
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, content }) => ({ path, content,
      beforeHash: existsSync(path) ? createHash("sha256").update(readBoundedRegularText(path, { maxBytes: 2 * 1024 * 1024, allowEmpty: true })).digest("hex") : null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    }));
  const body = { apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1" as const, operation: "configure-project" as const,
    target, engine: "project-settings", files, projectGuard: { workSnapshotHash: sha256(snapshot) }, ...(hostBinding ? { hostBinding } : {}) };
  return { ...body, planHash: sha256(body) };
}

async function applyProjectConfiguration(args: string[], plan: BootstrapPlan): Promise<void> {
  const approval = option(args, "--approve");
  if (!approval) { printBootstrapPlan(plan, args); return; }
  if (approval !== plan.planHash || !plan.projectGuard) throw new Error("Approval hash does not match the current project plan.");
  validateApplyOperationPlan(plan.target, plan.planHash, plan);
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 16 * 1024 * 1024) throw new Error("PROJECT_CONFIGURATION_PLAN_TOO_LARGE");
  let receipt = findApplyOperation<BootstrapPlan>(plan.target, plan.planHash);
  if (receipt?.stage === "complete") {
    const check = configurationReadDatabase(statePaths(plan.target).database, true);
    let pending: unknown;
    try { pending = check.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_pending'").get(); }
    finally { check.close(); }
    if (!pending) { printAppliedBootstrapResult(plan, args, receipt.result as Record<string, JsonValue>); return; }
  }
  if (plan.hostBinding && (!receipt || inspectApplyOperationFiles(receipt) === "pending")) {
    await inspectHost(plan.target, ["--host", plan.hostBinding.kind, "--executable", plan.hostBinding.executablePath,
      "--executable-sha256", plan.hostBinding.executableSha256, "--expected-version", plan.hostBinding.reportedVersion,
      "--capability-snapshot-sha256", plan.hostBinding.capabilitySnapshotSha256,
      ...plan.hostBinding.args.flatMap((arg) => ["--host-arg", arg])]);
  }
  const paths = statePaths(plan.target);
  const release = acquireMaintenanceLock(paths.root, "configure-project");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(paths.database);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    if (sha256(projectWorkSnapshot(database)) !== plan.projectGuard.workSnapshotHash) {
      throw new Error("PROJECT_CONFIGURATION_WORK_CHANGED: work changed after the preview; generate a new plan.");
    }
    const pending = database.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_pending'").get();
    if (pending && pending.value !== plan.planHash) throw new Error("PROJECT_CONFIGURATION_PENDING: resume the previous exact approved plan first.");
    // Persist the maintenance barrier before file replacement. A crash must
    // not allow new work to invalidate the approved recovery snapshot.
    database.prepare("INSERT INTO metadata(key, value) VALUES ('project_configuration_pending', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(plan.planHash);
    database.prepare("INSERT INTO metadata(key, value) VALUES ('project_configuration_plan', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(plan));
    database.exec("COMMIT; BEGIN IMMEDIATE");
    receipt ??= beginApplyOperation(plan.target, plan.planHash, plan);
    recoverFileTransaction(plan.target, plan.planHash, plan.files);
    const fileState = inspectApplyOperationFiles(receipt);
    if (fileState === "pending" && receipt.stage === "approved") applyFileTransaction(plan.target, plan.planHash, plan.files);
    else if (fileState !== "committed") throw new Error(`Project apply files are '${fileState}'; no new writes were attempted.`);
    if (inspectApplyOperationFiles(receipt) !== "committed") throw new Error("Project configuration files did not commit.");
    if (receipt.stage === "approved") receipt = markApplyOperationFilesCommitted(plan.target, plan.planHash, { fileCount: plan.files.length });
    const result: Record<string, JsonValue> = { applied: true, planHash: plan.planHash,
      files: plan.files.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })),
      nextActions: ["Run doctor; start a new coding-host session to read the current preferences and role charter."],
    };
    if (receipt.stage === "files_committed") receipt = markApplyOperationDatabaseCommitted(plan.target, plan.planHash, result);
    if (receipt.stage === "db_committed") receipt = completeApplyOperation(plan.target, plan.planHash, receipt.result);
    database.prepare("DELETE FROM metadata WHERE key = 'project_configuration_pending' AND value = ?").run(plan.planHash);
    database.prepare("DELETE FROM metadata WHERE key = 'project_configuration_plan'").run();
    database.exec("COMMIT");
    printAppliedBootstrapResult(plan, args, receipt.result as Record<string, JsonValue>);
  } finally {
    if (database) { try { database.exec("ROLLBACK"); } catch {} database.close(); }
    release();
  }
}

function printProposal(args: string[]): void {
  const proposal = proposalFor(args);
  if (has(args, "--json")) {
    writeJsonEnvelope("propose", proposal);
    return;
  }
  console.log(`CharterMesh proposal ${proposal.proposalHash}`);
  console.log(`Profile: ${proposal.profile}`);
  console.log(`Target assessment: ${proposal.assessment.assessmentHash}`);
  console.log(`Files observed: ${proposal.assessment.fileCount}`);
  console.log(
    `Languages: ${proposal.assessment.detectedLanguages.join(", ") || "none detected"}`,
  );
  console.log(
    `Risk signals: ${proposal.assessment.riskSignals.join(", ") || "none detected"}`,
  );
  for (const reason of proposal.rationale) console.log(`- ${reason}`);
  console.log("");
  console.log(
    "Next: run bootstrap with the same --target and --profile to generate the exact no-write plan.",
  );
}

function printApprovalExplanation(sections: Array<[string, string]>): void {
  console.log("Plain-language approval (ELI5)");
  for (const [label, explanation] of sections) {
    console.log(`${label}: ${explanation}`);
  }
  console.log("");
  console.log("Technical details — exact values for this approval");
}

function printBootstrapPlan(plan: BootstrapPlan, args: string[]): void {
  if (has(args, "--json")) {
    writeJsonEnvelope(plan.operation, {
      applied: false,
      approvalRequired: true,
      ...plan,
    });
    return;
  }
  const changes = plan.files.filter((file) => file.beforeHash !== file.afterHash);
  const newFileCount = changes.filter((file) => file.beforeHash === null).length;
  const purposes: Record<BootstrapPlan["operation"], [string, string]> = {
    bootstrap: [
      "Set up CharterMesh's local team settings and work records.",
      "Give this project a place to keep its work, limits, and approval rules.",
    ],
    kickoff: [
      "Set up the team and add the first task from your project brief.",
      "Make it clear who owns the work, what they should produce, and when they must ask you.",
    ],
    "configure-engine": [
      "Change which model the team will use and its connection settings.",
      "Prepare future work to use the selected model and tool settings.",
    ],
    "configure-host": [
      "Add or update CharterMesh's settings in the selected coding app.",
      "Let that app use the approved team roles and report work to CharterMesh.",
    ],
    "configure-project": [
      "Update this project's preferences, team roles, or work rules.",
      "Let the coordinating team adapt its operating guide to your project without changing model connections or granting itself approval authority.",
    ],
  };
  const [what, why] = purposes[plan.operation];
  printApprovalExplanation([
    ["What you are deciding", what],
    ["Why", why],
    ["If you approve", `Create ${newFileCount} files and replace ${changes.length - newFileCount} existing files listed below; ${plan.files.length - changes.length} files already match. Save the approval record and initialize or update local work records.` +
      (plan.kickoff ? " Add one first task; this does not start the work." : "") +
      (plan.workRetargets?.length ? ` Move ${plan.workRetargets.length} waiting tasks to the selected coding app.` : "") +
      (plan.hostBinding ? " Start a new app session afterward to use the settings." : "")],
    ["Cost and data", "Applying this setup does not start model work, install packages, publish, or deploy. Later model use may send task data to the selected provider and use paid service or account limits; that future cost is not known from this plan."],
    ["What is confirmed", "The file list and before/after fingerprints below describe this exact proposed setup. This preview has not applied it. A fingerprint (hash) identifies an exact version; it does not prove that the setup is suitable for your project."],
    ["Risks and unknowns", "Existing settings may be replaced. Future model quality, service charges, and successful task completion are not verified by this plan. Review the listed files and limits before agreeing."],
    ["If you decline or wait", "Do not run the approval command. None of these planned changes will be applied."],
    ["Undo limits", "Interrupted file changes have a recovery record, but this is not a one-click undo of a completed setup. Restoring settings or work records may need a separate reviewed plan; future external actions cannot be undone by restoring these files."],
    ["Your choice", "Approve only if this scope matches what you want. Otherwise ask for changes. Approval covers only the exact hash below, not future actions."],
  ]);
  console.log(`CharterMesh ${plan.operation} plan ${plan.planHash}`);
  console.log(`Target: ${plan.target}`);
  console.log(`${plan.operation === "configure-host" ? "Runtime" : "Model engine"}: ${plan.engine}`);
  if (plan.hostBinding) {
    console.log(
      `Host: ${plan.hostBinding.kind} ${plan.hostBinding.reportedVersion} ` +
        `(${plan.hostBinding.executableSha256})`,
    );
  }
  if (plan.onboarding) {
    console.log(
      `Team: ${plan.onboarding.teamTemplate} (${plan.onboarding.teamSource}) ` +
        `(${plan.onboarding.roleIds.join(" -> ")})`,
    );
    console.log(
      `Allocation: ${plan.onboarding.allocationMode}; handoffs: ` +
        `${plan.onboarding.handoffMode}; approvals: ${plan.onboarding.approvalMode}`,
    );
    console.log(`Team charter: ${plan.onboarding.teamCharterPath}`);
    if (plan.onboarding.hostProjection) {
      console.log(
        `Host projection: ${plan.onboarding.hostProjection.kind} ` +
          `(${plan.onboarding.hostProjection.executionTarget}); a new host session is required after apply.`,
      );
    }
  }
  for (const retarget of plan.workRetargets ?? []) {
    console.log(
      `- retarget ${retarget.id} v${retarget.expectedVersion}: ` +
        `${retarget.fromExecutionTarget} -> ${retarget.toExecutionTarget}`,
    );
  }
  for (const file of plan.files) {
    console.log(
      `- ${file.beforeHash ? "verify/replace" : "create"} ${file.path}`,
    );
    console.log(`  before: ${file.beforeHash ?? "absent"}`);
    console.log(`  after:  ${file.afterHash}`);
  }
  console.log("");
  console.log(`Approval token: ${plan.planHash}`);
  console.log(
    `Repeat the identical ${plan.operation} command and append ` +
      `--approve ${plan.planHash}`,
  );
}

function onboardingNextActions(plan: BootstrapPlan): JsonValue[] {
  if (plan.operation === "configure-project") return [
    "Run doctor to check the updated project settings.",
    "Start a new coding-host session to read the approved preferences and role charter. No model work was started.",
  ];
  const actions: JsonValue[] = [
    {
      id: "doctor",
      instruction: "Verify the approved installation and local Control Plane.",
      command: {
        executable: "npx",
        arguments: [
          "--yes",
          CHARTERMESH_GITHUB_REF,
          "doctor",
          "--target",
          plan.target,
        ],
      },
    },
  ];
  if (!plan.onboarding) return actions;
  actions.push({
    id: "review-team-charter",
    instruction:
      "Review .chartermesh/TEAM-CHARTER.md for roles, copy/paste handoffs, and human approval rules.",
  });
  if (plan.onboarding.hostProjection) {
    actions.push({
      id: "start-new-host-session",
      instruction:
        `Start a new ${plan.onboarding.hostProjection.kind} session in the project so the projected roles and CharterMesh MCP bridge are loaded.`,
    });
  } else {
    actions.push({
      id: "optional-host-projection",
      instruction:
        "To load native Codex or Claude project roles, generate and approve a configure-host plan, or repeat kickoff on a clean project with --host.",
    });
  }
  actions.push({
    id: "inspect-initial-work",
    instruction: "Inspect the initial approved WorkItem before execution.",
    command: {
      executable: "npx",
      arguments: [
        "--yes",
        CHARTERMESH_GITHUB_REF,
        "list",
        "--target",
        plan.target,
        "--active-only",
      ],
    },
  });
  return actions;
}

function approvedOperationPlan(
  args: string[],
  operation: BootstrapPlan["operation"],
): BootstrapPlan | null {
  const approved = option(args, "--approve");
  if (!approved) return null;
  const receipt = findApplyOperation<BootstrapPlan>(targetOf(args), approved);
  if (!receipt) {
    if (operation !== "configure-project") return null;
    const path = resolveProjectStatePaths(targetOf(args)).database;
    if (!existsSync(path)) return null;
    const database = configurationReadDatabase(path, true);
    try {
      const pending = database.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_pending'").get();
      if (!pending) return null;
      if (pending.value !== approved) throw new Error("PROJECT_CONFIGURATION_PENDING: resume the previous exact approved plan.");
      const size = database.prepare("SELECT length(CAST(value AS BLOB)) AS bytes FROM metadata WHERE key = 'project_configuration_plan'").get();
      if (!size || Number(size.bytes) > 16 * 1024 * 1024) throw new Error("PROJECT_CONFIGURATION_PENDING_PLAN_INVALID");
      const stored = database.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_plan'").get();
      const plan = JSON.parse(String(stored!.value)) as BootstrapPlan;
      validateApplyOperationPlan(targetOf(args), approved, plan);
      if (plan.operation !== operation || !plan.projectGuard) throw new Error("PROJECT_CONFIGURATION_PENDING_PLAN_INVALID");
      return plan;
    } finally { database.close(); }
  }
  if (receipt.plan.operation !== operation) {
    throw new Error(
      `Approved operation ${approved} belongs to '${receipt.plan.operation}', not '${operation}'.`,
    );
  }
  return receipt.plan;
}

function assertNoUnfinishedApplyOperation(target: string): void {
  const path = statePaths(target).database;
  if (existsSync(path)) {
    const database = configurationReadDatabase(path);
    try {
      const pendingConfiguration = database.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_pending'").get();
      if (pendingConfiguration) throw new Error(`PROJECT_CONFIGURATION_PENDING: resume configure-project --approve ${pendingConfiguration.value} before generating another configuration plan.`);
    } finally { database.close(); }
  }
  const pending = listPendingApplyOperations<BootstrapPlan>(target);
  if (pending.length === 0) return;
  throw new Error(
    `An approved '${pending[0]!.plan.operation}' operation is unfinished at ` +
      `stage '${pending[0]!.stage}'. Resume the identical command with ` +
      `--approve ${pending[0]!.planHash} before generating another plan.`,
  );
}

function printAppliedBootstrapResult(
  plan: BootstrapPlan,
  args: string[],
  result: Record<string, JsonValue>,
): void {
  if (has(args, "--json")) {
    writeJsonEnvelope(plan.operation, result);
    return;
  }
  console.log(`Applied CharterMesh ${plan.operation} plan ${plan.planHash}.`);
  if (typeof result.workItemId === "string") {
    console.log(`Created and triaged initial work item ${result.workItemId}.`);
  }
  const retargeted = Array.isArray(result.retargetedWorkItemIds)
    ? result.retargetedWorkItemIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (retargeted.length > 0) {
    console.log(
      `Retargeted ${retargeted.length} unclaimed work item(s): ` +
        retargeted.join(", "),
    );
  }
  for (const [index, action] of onboardingNextActions(plan).entries()) {
    if (
      typeof action === "object" &&
      action !== null &&
      !Array.isArray(action)
    ) {
      const instruction = action.instruction;
      const command = action.command;
      if (typeof instruction === "string") {
        console.log(`${index === 0 ? "Next" : "Then"}: ${instruction}`);
      }
      if (
        typeof command === "object" &&
        command !== null &&
        !Array.isArray(command) &&
        typeof command.executable === "string" &&
        Array.isArray(command.arguments) &&
        command.arguments.every((value) => typeof value === "string")
      ) {
        console.log(
          `  Command argv (not shell text): ${JSON.stringify([
            command.executable,
            ...command.arguments,
          ])}`,
        );
      }
    }
  }
}

async function applyBootstrap(args: string[], plan: BootstrapPlan): Promise<void> {
  const approved = option(args, "--approve");
  if (!approved) {
    printBootstrapPlan(plan, args);
    return;
  }
  if (approved !== plan.planHash) {
    throw new Error("Approval hash does not match the current bootstrap plan.");
  }
  let receipt = findApplyOperation<BootstrapPlan>(plan.target, plan.planHash);
  if (receipt?.stage === "complete") {
    printAppliedBootstrapResult(
      plan,
      args,
      receipt.result as Record<string, JsonValue>,
    );
    return;
  }
  const initialFileState = receipt
    ? inspectApplyOperationFiles(receipt)
    : "pending";
  if (plan.hostBinding && initialFileState === "pending") {
    const rebound = await inspectHost(plan.target, [
      "--host",
      plan.hostBinding.kind,
      "--executable",
      plan.hostBinding.executablePath,
      "--executable-sha256",
      plan.hostBinding.executableSha256,
      "--expected-version",
      plan.hostBinding.reportedVersion,
      "--capability-snapshot-sha256",
      plan.hostBinding.capabilitySnapshotSha256,
      ...plan.hostBinding.args.flatMap((value) => ["--host-arg", value]),
      ...(plan.hostBinding.directProtocol ? ["--direct"] : []),
    ]);
    if (
      rebound.executableSha256 !== plan.hostBinding.executableSha256 ||
      rebound.reportedVersion !== plan.hostBinding.reportedVersion ||
      rebound.capabilitySnapshotSha256 !==
        plan.hostBinding.capabilitySnapshotSha256
    ) {
      throw new Error(
        "Host executable, reported version, or capabilities changed after planning; generate and approve a new host-bound plan.",
      );
    }
  }
  receipt ??= beginApplyOperation<BootstrapPlan>(
    plan.target,
    plan.planHash,
    plan,
  );
  recoverFileTransaction(plan.target, plan.planHash, plan.files);
  let fileState = inspectApplyOperationFiles(receipt);
  if (fileState === "mixed" || fileState === "changed") {
    throw new Error(
      `Approved apply operation files are in '${fileState}' state; no additional write was attempted. Inspect the operation receipt and target files.`,
    );
  }
  if (fileState === "pending") {
    if (receipt.stage !== "approved") {
      throw new Error(
        `Apply receipt stage '${receipt.stage}' cannot have pending files.`,
      );
    }
    applyFileTransaction(
      plan.target,
      plan.planHash,
      plan.files,
    );
    fileState = inspectApplyOperationFiles(receipt);
    if (fileState !== "committed") {
      throw new Error("Approved files did not reach their committed hashes.");
    }
  }
  if (receipt.stage === "approved") {
    receipt = markApplyOperationFilesCommitted<BootstrapPlan>(
      plan.target,
      plan.planHash,
      { fileCount: plan.files.length },
    );
  }
  let kickoffWorkItemId: string | undefined;
  let retargetedWorkItemIds: string[] = [];
  if (receipt.stage === "files_committed") {
    const { database, controlPlane } = controlPlaneFor(plan.target);
    try {
      if (plan.kickoff) {
        const item = controlPlane.intake({
          title: plan.kickoff.title,
          summary: plan.kickoff.summary,
          ownerRole: plan.kickoff.ownerRole,
          executionTarget: plan.kickoff.executionTarget,
          priority: plan.kickoff.priority,
          decisionQuestion: plan.kickoff.decisionQuestion,
          acceptanceCriteria: plan.kickoff.acceptanceCriteria,
          actor: "human:local",
          idempotencyKey: `kickoff:${plan.planHash}:intake`,
        });
        const triaged = controlPlane.triage({
          id: item.id,
          ownerRole: plan.kickoff.ownerRole,
          executionTarget: plan.kickoff.executionTarget,
          actor: "human:local",
          idempotencyKey: `kickoff:${plan.planHash}:triage`,
        });
        kickoffWorkItemId = triaged.id;
      }
      if (plan.workRetargets?.length) {
        retargetedWorkItemIds = controlPlane.retargetUnclaimedWork({
          items: plan.workRetargets,
          actor: "human:local",
          idempotencyKey: `configure-host:${plan.planHash}:retarget`,
        }).map(({ id }) => id);
      }
    } finally {
      database.close();
    }
    const result: Record<string, JsonValue> = {
      applied: true,
      planHash: plan.planHash,
      files: plan.files.map(({ path, beforeHash, afterHash }) => ({
        path,
        beforeHash,
        afterHash,
      })),
      ...(kickoffWorkItemId ? { workItemId: kickoffWorkItemId } : {}),
      ...(retargetedWorkItemIds.length > 0
        ? { retargetedWorkItemIds }
        : {}),
      ...(plan.onboarding
        ? {
            onboarding: {
              teamTemplate: plan.onboarding.teamTemplate,
              teamSource: plan.onboarding.teamSource,
              entryRole: plan.onboarding.entryRole,
              roleIds: plan.onboarding.roleIds,
              stageIds: plan.onboarding.stageIds,
              teamCharterPath: plan.onboarding.teamCharterPath,
              handoffMode: plan.onboarding.handoffMode,
              allocationMode: plan.onboarding.allocationMode,
              approvalMode: plan.onboarding.approvalMode,
              executionBoundary: plan.onboarding.executionBoundary,
              ...(plan.onboarding.hostProjection
                ? {
                    hostProjection: {
                      kind: plan.onboarding.hostProjection.kind,
                      executionTarget:
                        plan.onboarding.hostProjection.executionTarget,
                      newSessionRequired: true,
                    },
                  }
                : {}),
            },
            nextActions: onboardingNextActions(plan),
          }
        : {}),
    };
    receipt = markApplyOperationDatabaseCommitted<BootstrapPlan>(
      plan.target,
      plan.planHash,
      result,
    );
  }
  if (receipt.stage === "db_committed") {
    receipt = completeApplyOperation<BootstrapPlan>(
      plan.target,
      plan.planHash,
      receipt.result,
    );
  }
  if (receipt.stage !== "complete") {
    throw new Error(
      `Apply operation stopped at unexpected stage '${receipt.stage}'.`,
    );
  }
  printAppliedBootstrapResult(
    plan,
    args,
    receipt.result as Record<string, JsonValue>,
  );
}

function seedDemo(target: string): void {
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    if (controlPlane.list().length > 0) {
      console.log("Demo seed skipped: the Control Plane already has work.");
      return;
    }
    const first = controlPlane.intake({
      title: "Prepare the first reviewed artifact",
      summary:
        "Use the configured model engine to produce a concise synthetic onboarding note.",
      actor: "human:local",
      idempotencyKey: "demo:intake:first",
    });
    const second = controlPlane.intake({
      title: "Verify the onboarding result",
      summary:
        "Verify the first artifact after it has been reviewed and completed.",
      actor: "human:local",
      idempotencyKey: "demo:intake:second",
    });
    controlPlane.triage({
      id: first.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:local",
      idempotencyKey: "demo:triage:first",
    });
    controlPlane.triage({
      id: second.id,
      ownerRole: "operator",
      executionTarget: "local",
      actor: "human:local",
      idempotencyKey: "demo:triage:second",
    });
    controlPlane.addDependency({
      id: second.id,
      predecessorId: first.id,
      actor: "human:local",
      idempotencyKey: "demo:dependency",
    });
    console.log(`Seeded demo work: ${first.id}, ${second.id}`);
  } finally {
    database.close();
  }
}

function doctor(target: string, args: string[]): number {
  const issues: string[] = [];
  const recovery = pendingFileTransactionState(target);
  if (recovery.pending) {
    issues.push(
      "An incomplete or invalid file transaction requires explicit 'chartermesh recover' inspection; doctor did not mutate it",
    );
  }
  let pendingApplyOperations: Array<{ planHash: string; operation: string; stage: string }> = [];
  try {
    pendingApplyOperations = listPendingApplyOperations<BootstrapPlan>(target)
      .map(({ planHash, plan, stage }) => ({
        planHash,
        operation: plan.operation,
        stage,
      }));
    if (pendingApplyOperations.length > 0) {
      const pending = pendingApplyOperations[0]!;
      issues.push(
        `Approved '${pending.operation}' operation ${pending.planHash} remains at stage '${pending.stage}'; resume its identical --approve command`,
      );
    }
  } catch (error) {
    issues.push(
      `Apply operation receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const paths = statePaths(target);
  let organization: ReturnType<typeof readOrganization> | undefined;
  let webSearchConfiguration: "disabled" | "configured" = "disabled";
  try { readProjectPreferences(target); }
  catch (error) { issues.push(`preferences.json: ${error instanceof Error ? error.message : String(error)}`); }
  if (existsSync(paths.database)) {
    let check: DatabaseSync | undefined;
    try {
      check = configurationReadDatabase(paths.database);
      const pending = check.prepare("SELECT value FROM metadata WHERE key = 'project_configuration_pending'").get();
      if (pending) issues.push(`PROJECT_CONFIGURATION_PENDING: resume configure-project --approve ${pending.value} with the identical options; work changes remain blocked.`);
    } catch (error) { issues.push(`Configuration maintenance state: ${error instanceof Error ? error.message : String(error)}`); }
    finally { check?.close(); }
  }
  if (existsSync(paths.installation)) {
    try {
      const installed = JSON.parse(
        readBoundedRegularText(paths.installation, { maxBytes: 128 * 1024 }),
      ) as { charterMeshVersion?: string };
      if (installed.charterMeshVersion !== CHARTERMESH_VERSION) {
        issues.push(
          `installation.json pins ${installed.charterMeshVersion ?? "an unknown version"} but this CLI is ${CHARTERMESH_VERSION}`,
        );
      }
    } catch {
      issues.push("installation.json is invalid");
    }
  }
  if (!existsSync(paths.organization)) {
    issues.push("organization.json is missing");
  } else {
    try {
      organization = parseOrgSpec(
        readBoundedRegularText(paths.organization, { maxBytes: 2 * 1024 * 1024 }),
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? `organization.json: ${error.message}`
          : "organization.json is invalid",
      );
    }
  }
  if (!existsSync(paths.runtime)) {
    issues.push("runtime.json is missing");
  } else {
    try {
      const runtime = readRuntime(target);
      if (runtime.webSearch) {
        webSearchConfiguration = "configured";
        const searchAllowed = organization?.spec.roles.some(({ tools }) =>
          tools.allow.includes("web.search"),
        );
        if (!searchAllowed) {
          issues.push(
            "runtime.json configures web search but no OrgSpec role allows web.search",
          );
        }
        const runnerEngineIds = new Set(
          runtime.managedRunners.map(({ modelEngineRef }) => modelEngineRef),
        );
        for (const engine of runtime.modelEngines) {
          if (!runnerEngineIds.has(engine.id)) continue;
          if (
            engine.adapter === "fake" ||
            (engine.adapter === "openai-compatible" && !engine.toolCalling)
          ) {
            issues.push(
              `Engine '${engine.id}' cannot use configured web.search because tool calling is disabled`,
            );
          }
        }
      } else if (
        organization?.spec.roles.some(({ tools }) =>
          tools.allow.includes("web.search"),
        )
      ) {
        issues.push(
          "OrgSpec allows web.search but runtime.json has no webSearch endpoint",
        );
      }
      for (const engine of runtime.modelEngines) {
        if (engine.adapter === "openai-compatible") {
          issues.push(...validateOpenAICompatibleConfig(engine));
        }
        if (engine.adapter === "command-process") {
          issues.push(...validateCommandProcessConfig(engine));
          try {
            if (
              sha256Executable(engine.command) !==
              engine.executableSha256
            ) {
              issues.push(
                `Command-process executable digest changed for '${engine.id}'.`,
              );
            }
          } catch {
            issues.push(
              `Command-process executable is unavailable for '${engine.id}'.`,
            );
          }
        }
        const policy =
          organization?.spec.budgets.unknownCostPolicy ?? "warn";
        if (
          engine.adapter !== "fake" &&
          !("pricing" in engine && engine.pricing) &&
          ["block", "estimate"].includes(policy)
        ) {
          issues.push(
            policy === "block"
              ? `Engine '${engine.id}' has unknown cost but OrgSpec blocks unknown-cost runs`
              : `Engine '${engine.id}' needs pricing for the OrgSpec estimate policy`,
          );
        }
      }
      const runtimeAgentHosts = new Map(
        (runtime.agentHosts ?? []).map((host) => [host.id, host]),
      );
      const organizationAgentHosts = new Map(
        (organization?.spec.agentHosts ?? []).map((host) => [host.id, host]),
      );
      const interactiveProjectHostIds = new Set(
        (organization?.spec.agentHosts ?? [])
          .filter(({ adapter, enabled }) =>
            enabled && adapter.endsWith("-project-session")
          )
          .map(({ id }) => id),
      );
      for (const host of runtime.agentHosts ?? []) {
        const declared = organizationAgentHosts.get(host.id);
        if (!declared) {
          issues.push(
            `Runtime agent host '${host.id}' is not declared in OrgSpec`,
          );
        } else if (
          declared.adapter !== host.adapter ||
          declared.executionHost !== "local" ||
          !declared.enabled
        ) {
          issues.push(
            `Runtime agent host '${host.id}' does not match an enabled local OrgSpec host`,
          );
        }
        try {
          if (sha256Executable(host.command) !== host.executableSha256) {
            issues.push(
              `AgentHost executable digest changed for '${host.id}'.`,
            );
          }
        } catch {
          issues.push(
            `AgentHost executable is unavailable for '${host.id}'.`,
          );
        }
        if (host.allowUnrestrictedRead !== true) {
          issues.push(
            `AgentHost '${host.id}' cannot start until unrestricted local reads are explicitly acknowledged`,
          );
        }
        const policy =
          organization?.spec.budgets.unknownCostPolicy ?? "warn";
        if (["block", "estimate"].includes(policy)) {
          issues.push(
            policy === "block"
              ? `AgentHost '${host.id}' has provider-managed cost but OrgSpec blocks unknown-cost runs`
              : `AgentHost '${host.id}' cannot satisfy the OrgSpec estimate policy without host pricing evidence`,
          );
        }
      }
      for (const executionTarget of organization?.spec.executionTargets ?? []) {
        if (executionTarget.kind !== "agent_host" || !executionTarget.enabled) {
          continue;
        }
        if (
          !runtimeAgentHosts.has(executionTarget.hostRef) &&
          !interactiveProjectHostIds.has(executionTarget.hostRef)
        ) {
          issues.push(
            `Execution target '${executionTarget.id}' references AgentHost '${executionTarget.hostRef}' without a runtime binding`,
          );
        }
      }
    } catch (error) {
      issues.push(
        error instanceof Error
          ? `runtime.json: ${error.message}`
          : "runtime.json is invalid",
      );
    }
  }
  const result = {
    version: CHARTERMESH_VERSION,
    node: process.version,
    target,
    controlPlane: existsSync(paths.database) ? "ready" : "not_initialized",
    webSearch: webSearchConfiguration,
    runtimeConfiguration: issues.length === 0 ? "ready" : "attention_required",
    issues,
    recovery: {
      automatic: false,
      ...recovery,
    },
    applyOperations: { pending: pendingApplyOperations },
  };
  if (has(args, "--json")) {
    writeJsonEnvelope("doctor", result, issues.length === 0);
    return issues.length === 0 ? 0 : 1;
  }
  console.log(`Node: ${result.node}`);
  console.log(`Target: ${result.target}`);
  console.log(`Control Plane: ${result.controlPlane === "ready" ? "ready" : "not initialized"}`);
  if (issues.length === 0) {
    console.log("Runtime configuration: ready");
    return 0;
  }
  console.log("Runtime configuration requires attention:");
  for (const issue of issues) console.log(`- ${issue}`);
  return 1;
}

async function version(args: string[]): Promise<number> {
  const target = targetOf(args);
  let installationVersion: string | null = null;
  const installation = statePaths(target).installation;
  if (existsSync(installation)) {
    try {
      installationVersion = String(
        (
          JSON.parse(
            readBoundedRegularText(installation, { maxBytes: 128 * 1024 }),
          ) as {
            charterMeshVersion?: string;
          }
        ).charterMeshVersion ?? "",
      ) || null;
    } catch {
      // Doctor reports malformed installation metadata.
    }
  }
  let latestVersion: string | null = null;
  let updateCheck: "not_requested" | "current" | "update_available" | "failed" =
    "not_requested";
  if (has(args, "--check")) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Version check timed out.")),
      3_000,
    );
    try {
      const response = await fetch(
        "https://api.github.com/repos/jade-blanco/chartermesh/releases?per_page=100",
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": `chartermesh/${CHARTERMESH_VERSION}`,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      latestVersion = selectLatestPublishedVersion(await response.json());
      if (latestVersion === null) {
        throw new Error("GitHub returned no published semantic-version release.");
      }
      updateCheck =
        latestVersion &&
        compareVersions(latestVersion, CHARTERMESH_VERSION) > 0
          ? "update_available"
          : "current";
    } catch {
      updateCheck = "failed";
    } finally {
      clearTimeout(timeout);
    }
  }
  const data = {
    currentVersion: CHARTERMESH_VERSION,
    installationVersion,
    installationMatches:
      installationVersion === null ||
      installationVersion === CHARTERMESH_VERSION,
    updateCheck,
    latestVersion,
  };
  if (has(args, "--json")) writeJsonEnvelope("version", data);
  else {
    console.log(`CharterMesh ${CHARTERMESH_VERSION}`);
    if (installationVersion) {
      console.log(
        `Target installation: ${installationVersion}` +
          (data.installationMatches ? " (matches)" : " (mismatch)"),
      );
    }
    if (has(args, "--check")) {
      console.log(
        updateCheck === "failed"
          ? "Latest release check failed."
          : `Latest release: ${latestVersion ?? CHARTERMESH_VERSION} (${updateCheck.replace("_", " ")})`,
      );
    }
  }
  return data.installationMatches ? 0 : 1;
}

function recover(target: string, args: string[]): void {
  const results = recoverFileTransactions(target);
  if (has(args, "--json")) {
    writeJsonEnvelope("recover", { recovered: results });
    return;
  }
  if (results.length === 0) {
    console.log("No incomplete file transaction was found.");
    return;
  }
  for (const result of results) {
    console.log(
      `${result.transactionId}: ${result.action.replace("_", " ")}`,
    );
  }
}

function exportAudit(target: string, args: string[]): void {
  if (args[1] !== "export") {
    throw new Error("audit requires the 'export' subcommand.");
  }
  const paths = statePaths(target);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const requested = option(args, "--output");
  const output = requested
    ? resolve(target, requested)
    : join(paths.exports, `audit-${timestamp}.jsonl`);
  const normalizedTarget = target.toLowerCase();
  const normalizedOutput = output.toLowerCase();
  if (
    normalizedOutput !== normalizedTarget &&
    !normalizedOutput.startsWith(`${normalizedTarget}${sep}`)
  ) {
    throw new Error("Audit output must stay inside the target project.");
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const organization = readOrganization(target);
    const recordCount = controlPlane.auditRecordCount();
    const header = {
      apiVersion: "chartermesh.dev/audit-export/v1alpha1",
      recordType: "export",
      charterMeshVersion: CHARTERMESH_VERSION,
      exportedAt: new Date().toISOString(),
      organizationId: organization.metadata.id,
      organizationRevision: organization.metadata.revision,
      recordCount,
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    let afterId = 0;
    for (;;) {
      const page = controlPlane.auditRecordsPage({
        afterId,
        limit: 500,
      });
      if (page.length === 0) break;
      appendFileSync(
        output,
        `${page.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      afterId = page.at(-1)!.id;
    }
    const result = { output, recordCount };
    if (has(args, "--json")) writeJsonEnvelope("audit export", result);
    else console.log(`Exported ${recordCount} audit records to ${output}.`);
  } finally {
    database.close();
  }
}

function backupCommand(target: string, args: string[]): void {
  const subcommand = args[1];
  const paths = statePaths(target);
  if (subcommand === "list") {
    const backups = listControlPlaneBackups(paths.backups);
    if (has(args, "--json")) writeJsonEnvelope("backup list", backups);
    else if (backups.length === 0) console.log("No Control Plane backups.");
    else {
      for (const backup of backups) {
        console.log(
          `${backup.id} ${backup.reason} schema=${backup.schemaVersion} ` +
            `workItems=${backup.workItemCount} ` +
            `artifacts=${backup.artifacts?.length ?? 0} ` +
            `sha256=${backup.sha256}`,
        );
      }
    }
    return;
  }
  if (subcommand !== "create") {
    throw new Error("backup requires the 'create' or 'list' subcommand.");
  }
  const database = openControlPlaneDatabase(paths.database);
  try {
    const backup = createControlPlaneBackup(
      database,
      paths.backups,
      "manual",
    );
    if (has(args, "--json")) writeJsonEnvelope("backup create", backup);
    else {
      console.log(
        `Created Control Plane backup ${backup.id} (${backup.sha256}).`,
      );
    }
  } finally {
    database.close();
  }
}

function restorePlan(target: string, args: string[]): RestorePlan {
  assertNoPendingFileTransactions(target);
  const id = option(args, "--backup");
  if (!id) throw new Error("restore requires --backup BACKUP_ID.");
  const paths = statePaths(target);
  if (!existsSync(paths.database)) {
    throw new Error("Control Plane database is missing.");
  }
  const backup = readControlPlaneBackup(paths.backups, id);
  const body = {
    apiVersion: "chartermesh.dev/restore-plan/v1alpha1" as const,
    operation: "restore-control-plane" as const,
    target,
    backupId: backup.manifest.id,
    backupSha256: backup.manifest.sha256,
    currentSha256: createHash("sha256")
      .update(readFileSync(paths.database))
      .digest("hex"),
    backupSchemaVersion: backup.manifest.schemaVersion,
    backupArtifactCount: backup.artifacts.length,
    backupArtifactSetSha256:
      backup.manifest.artifactSetSha256 ??
      sha256(backup.manifest.artifacts ?? []),
  };
  return { ...body, planHash: sha256(body) };
}

function restoreControlPlane(target: string, args: string[]): void {
  const plan = restorePlan(target, args);
  const approval = option(args, "--approve");
  if (!approval) {
    if (has(args, "--json")) writeJsonEnvelope("restore", plan);
    else {
      printApprovalExplanation([
        ["What you are deciding", "Replace CharterMesh's current work records with an earlier saved copy."],
        ["Why", "Use this only if the selected backup is the version you want to return to."],
        ["If you approve", `Restore the selected backup and ${plan.backupArtifactCount} saved outputs. Work records created or changed after that backup will no longer be the active records.`],
        ["Cost and data", "This is a local restore. It does not call a model or send the backup to a provider; local storage and time are required."],
        ["What is confirmed", "The fingerprints below identify the selected backup, its saved outputs, and the current database. No restore has happened in this preview."],
        ["Risks and unknowns", "A valid backup is not proof that it contains the work you want. Check its date and contents. Stop running workers and dashboards before restoring."],
        ["If you decline or wait", "Keep the current work records; do not run the approval command."],
        ["Undo limits", "A safety backup of the current records is made before replacement. Returning to it requires another exact-hash restore approval. Restoring records cannot undo files changed elsewhere, sent data, payments, or other external actions."],
      ]);
      console.log(JSON.stringify(plan, null, 2));
      console.log("");
      console.log(
        `Review the exact plan, then repeat with --approve ${plan.planHash}`,
      );
    }
    return;
  }
  if (approval !== plan.planHash) {
    throw new Error(
      `Restore approval hash does not match the current plan (${plan.planHash}).`,
    );
  }
  const paths = statePaths(target);
  const releaseMaintenance = acquireMaintenanceLock(paths.root, "restore");
  try {
    const selected = readControlPlaneBackup(paths.backups, plan.backupId);
    if (
      selected.artifacts.length !== plan.backupArtifactCount ||
      (selected.manifest.artifactSetSha256 ??
        sha256(selected.manifest.artifacts ?? [])) !==
        plan.backupArtifactSetSha256
    ) {
      throw new Error("Backup artifact set changed after approval.");
    }
    const approvedCurrentHash = createHash("sha256")
      .update(readFileSync(paths.database))
      .digest("hex");
    if (approvedCurrentHash !== plan.currentSha256) {
      throw new Error(
        "Control Plane changed after the restore plan was approved.",
      );
    }
    const database = openControlPlaneDatabase(paths.database, {
      allowMaintenance: true,
    });
    let safetyBackup;
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.exec("BEGIN EXCLUSIVE");
      database.exec("COMMIT");
      safetyBackup = createControlPlaneBackup(
        database,
        paths.backups,
        "pre_restore",
      );
    } finally {
      database.close();
    }
    for (const sidecar of [`${paths.database}-wal`, `${paths.database}-shm`]) {
      if (!existsSync(sidecar)) continue;
      if (statSync(sidecar).size > 0) {
        throw new Error(
          "Control Plane sidecar is still active. Stop dashboards and retry.",
        );
      }
      rmSync(sidecar, { force: true });
    }
    mkdirSync(paths.artifacts, { recursive: true });
    const replacementBeforeHash = createHash("sha256")
      .update(readFileSync(paths.database))
      .digest("hex");
    applyFileTransaction(target, `restore-${plan.planHash.slice(0, 20)}`, [
      {
        path: paths.database,
        content: selected.bytes,
        beforeHash: replacementBeforeHash,
        afterHash: plan.backupSha256,
      },
      ...selected.artifacts.map((artifact) => {
        const path = join(paths.artifacts, artifact.manifest.storageName);
        return {
          path,
          content: artifact.bytes,
          beforeHash: existsSync(path)
            ? createHash("sha256")
                .update(readFileSync(path))
                .digest("hex")
            : null,
          afterHash: artifact.manifest.sha256,
        };
      }),
    ]);
    validateControlPlaneDatabase(paths.database);
    for (const artifact of selected.artifacts) {
      const restored = readFileSync(
        join(paths.artifacts, artifact.manifest.storageName),
      );
      if (
        restored.byteLength !== artifact.manifest.byteSize ||
        createHash("sha256").update(restored).digest("hex") !==
          artifact.manifest.sha256
      ) {
        throw new Error("CONTROL_PLANE_RESTORE_ARTIFACT_MISMATCH");
      }
    }
    const result = {
      restoredBackup: plan.backupId,
      restoredSha256: plan.backupSha256,
      restoredArtifactCount: selected.artifacts.length,
      safetyBackup: safetyBackup.id,
    };
    if (has(args, "--json")) writeJsonEnvelope("restore", result);
    else {
      console.log(
        `Restored ${plan.backupId} with ${selected.artifacts.length} ` +
          `artifact(s). Pre-restore safety backup: ${safetyBackup.id}.`,
      );
    }
  } finally {
    releaseMaintenance();
  }
}

export type RunWorkResult =
  | {
      status: "submitted_for_review";
      workItemId: string;
      artifactId: string;
      sha256: string;
      generation: number;
    }
  | {
      status: "approval_required";
      workItemId: string;
      callHash: string;
      toolName: string;
      generation: number;
    };

export interface SchedulerTickSummary {
  evaluatedAt: string;
  activeSchedules: number;
  started: number;
  succeeded: number;
  failed: number;
  skippedNoWork: number;
  skippedOverlap: number;
  notDue: number;
  inactive: number;
  results: Array<{
    scheduleId: string;
    status:
      | "inactive"
      | "not_due"
      | "skipped_no_work"
      | "skipped_overlap"
      | "succeeded"
      | "failed"
      | "unsupported";
    workItemId?: string;
    tickId?: string;
    errorCode?: string;
  }>;
}

export async function runWork(
  target: string,
  id?: string,
  options: {
    quiet?: boolean;
    json?: boolean;
    delegated?: boolean;
    agentHostFactory?: () => AgentHost;
  } = {},
): Promise<RunWorkResult> {
  const runtime = readRuntime(target);
  const { database, controlPlane } = controlPlaneFor(target, runtime);
  let heartbeat: NodeJS.Timeout | undefined;
  let cancellationPoll: NodeJS.Timeout | undefined;
  let invocationId: string | undefined;
  let activeAttemptId: string | undefined;
  let activeAgentHostRunId: string | undefined;
  let activeAgentHost: AgentHost | undefined;
  let agentHostBindingCreated = false;
  const runController = new AbortController();
  let removeSignalHandlers = () => {};
  let claim:
    | {
        runId: string;
        attemptId: string;
        leaseId: string;
        generation: number;
      }
    | undefined;
  try {
    controlPlane.recoverExpiredLeases();
    const organization = readOrganization(target);
    const candidate =
      (id ? controlPlane.get(id) : undefined) ??
      controlPlane
        .list()
        .find(
          ({ status, availability }) =>
            ["ready", "changes_requested"].includes(status) &&
            availability === "ready",
        );
    if (!candidate) throw new Error("No claimable work is available.");
    const executionTarget = organization.spec.executionTargets.find(
      ({ id: targetId }) => targetId === candidate.executionTarget,
    );
    if (!executionTarget || !executionTarget.enabled) {
      throw new Error(
        `Execution target '${candidate.executionTarget}' is unavailable.`,
      );
    }
    const agentHostProfile =
      executionTarget.kind === "agent_host"
        ? runtime.agentHosts?.find(
            ({ id: hostId }) => hostId === executionTarget.hostRef,
          )
        : undefined;
    if (executionTarget.kind === "agent_host" && !agentHostProfile) {
      const declaredHost = organization.spec.agentHosts.find(
        ({ id: hostId }) => hostId === executionTarget.hostRef,
      );
      if (declaredHost?.adapter.endsWith("-project-session")) {
        throw new Error(
          `Execution target '${executionTarget.id}' is interactive-only; claim it through the configured CharterMesh MCP bridge from the coding host.`,
        );
      }
      throw new Error(
        `AgentHost '${executionTarget.hostRef}' is not configured in runtime.json.`,
      );
    }
    const engine = agentHostProfile
      ? undefined
      : configuredEngine(runtime, target);
    const configuredProfile = engine
      ? runtime.modelEngines.find(
          ({ id: engineId }) => engineId === engine.manifest.profileId,
        )
      : undefined;
    const costVisibility = agentHostProfile
      ? "unknown"
      : configuredProfile?.adapter === "fake"
        ? "measured"
        : "pricing" in (configuredProfile ?? {}) && configuredProfile?.pricing
          ? "estimated"
          : "unknown";
    const unknownCostPolicy =
      organization.spec.budgets.unknownCostPolicy ?? "warn";
    if (
      costVisibility === "unknown" &&
      ["block", "estimate"].includes(unknownCostPolicy)
    ) {
      throw new Error(
        unknownCostPolicy === "block"
          ? "COST_POLICY_BLOCKS_UNKNOWN_ENGINE"
          : "COST_POLICY_REQUIRES_PRICING",
      );
    }
    if (options.delegated) {
      if (!executionTarget || executionTarget.kind !== "managed_runner") {
        throw new Error("DELEGATION_TARGET_UNSUPPORTED");
      }
    }
    claim = controlPlane.claim({
      id: candidate.id,
      actor: "runner:local",
      idempotencyKey: `cli:claim:${candidate.id}:${randomUUID()}`,
    });
    activeAttemptId = claim.attemptId;
    const requestSignalCancellation = (signal: string) => {
      try {
        controlPlane.requestRunCancellation({
          id: candidate.id,
          actor: "human:cli-signal",
          idempotencyKey:
            `cli:cancel:${claim!.runId}:${signal.toLowerCase()}`,
        });
      } catch {
        // A concurrent cancellation or terminal transition is already visible.
      }
      runController.abort(new Error("RUN_CANCELED"));
    };
    const onSigint = () => requestSignalCancellation("SIGINT");
    const onSigterm = () => requestSignalCancellation("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    removeSignalHandlers = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    heartbeat = setInterval(() => {
      try {
        if (!claim) return;
        controlPlane.heartbeat({
          id: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          actor: "runner:local",
          idempotencyKey: `cli:heartbeat:${claim.leaseId}:${Date.now()}`,
        });
      } catch {
        // The foreground result path will fence stale or recovered workers.
      }
    }, 60_000);
    heartbeat.unref();
    cancellationPoll = setInterval(() => {
      try {
        if (
          claim &&
          controlPlane.isRunCancellationRequested(claim.runId)
        ) {
          runController.abort(new Error("RUN_CANCELED"));
        }
      } catch {
        // Lease recovery or terminal fencing decides the durable result.
      }
    }, 500);
    cancellationPoll.unref();
    try {
      const role = organization.spec.roles.find(
        ({ id: roleId }) => roleId === candidate.ownerRole,
      );
      if (!role) {
        throw new Error(
          `OrgSpec does not define the assigned role '${candidate.ownerRole}'.`,
        );
      }
      const evidenceReceiptAttempts = new Map<string, string>();
      const toolRuntime = createWorkspaceToolRuntime({
        workspaceRoot: target,
        workItemId: candidate.id,
        policy: role.tools,
        additionalTools: createWebSearchTools(runtime.webSearch),
        isApproved: (callHash, toolName) =>
          Boolean(
            claim &&
              controlPlane.isPendingToolExecutionReserved({
                id: candidate.id,
                runId: claim.runId,
                attemptId: claim.attemptId,
                leaseId: claim.leaseId,
                generation: claim.generation,
                callHash,
                toolName,
                actor: "runner:local",
              }),
          ),
        prepareEvidence: (intent) => {
          const evidenceAttemptId = activeAttemptId ?? claim!.attemptId;
          const receipt = controlPlane.prepareToolEvidence({
            id: candidate.id,
            runId: claim!.runId,
            attemptId: claim!.attemptId,
            evidenceAttemptId,
            leaseId: claim!.leaseId,
            generation: claim!.generation,
            callHash: intent.callHash,
            toolName: intent.toolName,
            inputHash: intent.inputHash,
            actor: "runner:local",
          });
          evidenceReceiptAttempts.set(receipt.id, evidenceAttemptId);
          return receipt;
        },
        onEvidence: (evidence, receipt) => {
          if (!receipt) {
            throw new Error("TOOL_EVIDENCE_RECEIPT_MISSING");
          }
          const evidenceAttemptId = evidenceReceiptAttempts.get(receipt.id);
          if (!evidenceAttemptId) {
            throw new Error("TOOL_EVIDENCE_RECEIPT_LINEAGE_MISSING");
          }
          controlPlane.recordToolEvidence({
            receipt,
            evidenceId: evidence.id,
            id: candidate.id,
            runId: claim!.runId,
            attemptId: claim!.attemptId,
            evidenceAttemptId,
            leaseId: claim!.leaseId,
            generation: claim!.generation,
            callHash: evidence.callHash,
            toolName: evidence.toolName,
            status: evidence.status,
            inputHash: evidence.inputHash,
            outputHash: evidence.outputHash,
            paths: evidence.paths,
            durationMs: evidence.durationMs,
            createdAt: evidence.createdAt,
            actor: "runner:local",
          });
          evidenceReceiptAttempts.delete(receipt.id);
        },
      });
      const replayedEvidence: ToolExecutionEvidence[] = [];
      const approvedPending =
        controlPlane.approvedPendingToolCall(candidate.id);
      if (approvedPending) {
        const pendingFence = {
          id: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          actor: "runner:local",
        };
        const evidenceEffectHash = (
          evidence: Pick<
            ToolExecutionEvidence,
            "status" | "toolName" | "outputHash" | "paths"
          >,
        ) =>
          evidence.outputHash ??
          createHash("sha256")
            .update(
              JSON.stringify({
                status: evidence.status,
                toolName: evidence.toolName,
                paths: evidence.paths,
              }),
            )
            .digest("hex");
        const asRuntimeEvidence = (
          evidence: ReturnType<typeof controlPlane.listToolEvidence>[number],
        ): ToolExecutionEvidence => ({
          id: evidence.id,
          callHash: evidence.callHash,
          toolName: evidence.toolName,
          status: evidence.status,
          inputHash: evidence.inputHash,
          outputHash: evidence.outputHash,
          paths: evidence.paths,
          durationMs: evidence.durationMs,
          createdAt: evidence.createdAt,
        });
        const durableEvidence = (evidenceId: string | null) =>
          evidenceId
            ? controlPlane.listToolEvidence(candidate.id).find(
                ({ id: durableId }) => durableId === evidenceId,
              ) ?? null
            : null;
        const executionClaim = controlPlane.reservePendingToolExecution({
          ...pendingFence,
          callHash: approvedPending.callHash,
          idempotencyKey:
            `cli:pending-tool-reserve:${claim.runId}:${approvedPending.callHash}`,
        });
        if (
          process.env.NODE_ENV === "test" &&
          process.env.CHARTERMESH_TEST_CRASH_AFTER_PENDING_RESERVATION === "1" &&
          executionClaim.disposition === "reserved"
        ) {
          process.exit(87);
        }
        if (executionClaim.disposition === "executed") {
          const evidence = durableEvidence(executionClaim.pending.evidenceId);
          if (!evidence || evidence.status !== "succeeded") {
            throw new Error("TOOL_EXECUTION_STATE_INVALID: executed call lacks durable succeeded evidence.");
          }
          replayedEvidence.push(asRuntimeEvidence(evidence));
        } else if (executionClaim.disposition === "recovery_required") {
          const previous = executionClaim.pending.reservation;
          if (!previous) throw new Error("PENDING_TOOL_EXECUTION_STATE_INVALID");
          const evidence = controlPlane.listToolEvidence(candidate.id).find(
            (entry) =>
              entry.runId === previous.runId &&
              entry.attemptId === previous.attemptId &&
              entry.callHash === approvedPending.callHash &&
              entry.toolName === approvedPending.toolName &&
              entry.status === "succeeded",
          );
          if (evidence) {
            controlPlane.recoverCommittedPendingToolExecution({
              ...pendingFence,
              callHash: approvedPending.callHash,
              previousReservationId: previous.id,
              evidenceId: evidence.id,
              effectHash: evidenceEffectHash(asRuntimeEvidence(evidence)),
              idempotencyKey:
                `cli:pending-tool-recover:${claim.runId}:${previous.id}`,
            });
            replayedEvidence.push(asRuntimeEvidence(evidence));
          } else {
            controlPlane.markPendingToolOutcomeUnknown({
              ...pendingFence,
              callHash: approvedPending.callHash,
              previousReservationId: previous.id,
              message:
                "The previous executor ended without durable succeeded evidence; the approved tool call will not be replayed.",
              idempotencyKey:
                `cli:pending-tool-unknown:${claim.runId}:${previous.id}`,
            });
            throw new Error(
              "TOOL_OUTCOME_UNKNOWN: an approved tool call may have started and will not be replayed automatically.",
            );
          }
        } else {
          const reservation = executionClaim.pending.reservation;
          if (!reservation) throw new Error("PENDING_TOOL_EXECUTION_STATE_INVALID");
          let replay;
          try {
            replay = await toolRuntime.executeApprovedCall(
              {
                id: approvedPending.id,
                name: approvedPending.toolName,
                arguments: approvedPending.arguments,
              },
              { signal: runController.signal },
            );
          } catch (error) {
            const executionMessage =
              error instanceof Error ? error.message : String(error);
            controlPlane.markPendingToolOutcomeUnknown({
              ...pendingFence,
              callHash: approvedPending.callHash,
              previousReservationId: reservation.id,
              message:
                "Approved tool execution did not produce durable succeeded evidence and will not be replayed automatically.",
              idempotencyKey:
                `cli:pending-tool-execute-unknown:${claim.runId}:${reservation.id}`,
            });
            throw new Error(
              `TOOL_OUTCOME_UNKNOWN: approved tool execution was not durably proven (${executionMessage.slice(0, 500)}).`,
            );
          }
          if (replay.evidence.status !== "succeeded") {
            controlPlane.markPendingToolOutcomeUnknown({
              ...pendingFence,
              callHash: approvedPending.callHash,
              previousReservationId: reservation.id,
              message:
                "Approved tool execution returned without succeeded evidence and will not be replayed automatically.",
              idempotencyKey:
                `cli:pending-tool-evidence-unknown:${claim.runId}:${reservation.id}`,
            });
            throw new Error("TOOL_OUTCOME_UNKNOWN: approved tool execution was not proven successful.");
          }
          controlPlane.settlePendingToolExecution({
            ...pendingFence,
            callHash: approvedPending.callHash,
            reservationId: reservation.id,
            evidenceId: replay.evidence.id,
            effectHash: evidenceEffectHash(replay.evidence),
            idempotencyKey:
              `cli:pending-tool-settle:${claim.runId}:${reservation.id}`,
          });
          replayedEvidence.push(replay.evidence);
        }
      }
      const modelId =
        engine && "config" in engine && engine.config?.model
          ? String(engine.config.model)
          : "deterministic-fixture";
      const requiredTools = controlPlane.requiredTools(candidate.id);
      const decisionContract = controlPlane.decisionContract(candidate.id);
      const revisionContext = (() => {
        if (candidate.status !== "changes_requested") return "";
        const decision = controlPlane.latestArtifactDecision(candidate.id);
        const previousArtifact = controlPlane.latestArtifact(candidate.id);
        if (
          !decision ||
          decision.decision !== "changes_requested" ||
          !previousArtifact ||
          decision.artifactHash !== previousArtifact.sha256
        ) {
          throw new Error("REVISION_CONTEXT_NOT_HASH_BOUND");
        }
        const context = [
          "A reviewer requested changes to the previous immutable artifact.",
          `Previous artifact SHA-256: ${previousArtifact.sha256}`,
          "Exact review feedback:",
          decision.note,
          "Revise the prior artifact in response to this feedback. Do not claim the feedback itself is execution evidence.",
          "Previous artifact:",
          previousArtifact.content,
        ].join("\n\n");
        if (Buffer.byteLength(context, "utf8") > 131_072) {
          throw new Error("REVISION_CONTEXT_SIZE_LIMIT_EXCEEDED");
        }
        return context;
      })();
      const latestUserInput = controlPlane.latestUserInput(candidate.id);
      const userInputContext = latestUserInput
        ? [
            "A human supplied the input that previously blocked this work.",
            `Input reference: ${latestUserInput.reference}`,
            `Input SHA-256: ${latestUserInput.responseHash}`,
            "Exact human response:",
            latestUserInput.response,
            "Use this response only for the current work objective. Do not treat it as execution evidence.",
          ].join("\n\n")
        : "";
      const skillGuidance = portableSkillDocuments()
        .filter(
          ({ id: skillId }) =>
            skillId === "small-model-evidence" ||
            (requiredTools.length > 0 &&
              skillId === "tool-grounded-implementation") ||
            (role.capabilities.includes("web_research") &&
              skillId === "web-research"),
        )
        .map(({ content }) => content)
        .join("\n\n");
      const hostRequest = {
        taskPacket: {
          objective: candidate.title,
          context: [
            candidate.summary,
            revisionContext,
            userInputContext,
            skillGuidance
              ? `Assigned portable skill guidance:\n${skillGuidance}`
              : "",
            requiredTools.length > 0
              ? [
                  "Required execution evidence:",
                  ...requiredTools.map(
                    (toolName) =>
                      `- A successful ${toolName} result is required before final submission.`,
                  ),
                  "Do not return a completion artifact until every required tool succeeds.",
                ].join("\n")
              : "",
            replayedEvidence.length > 0
              ? "An exact human-approved pending tool call was replayed successfully in this run. Inspect the resulting workspace state before final submission."
              : "",
            agentHostProfile ? renderProjectPreferences(readProjectPreferences(target), role.id) : "",
          ].filter(Boolean).join("\n\n"),
          acceptanceCriteria: [
            ...decisionContract.acceptanceCriteria.map(
              ({ text }) => text,
            ),
            "Return a structured artifact suitable for exact-hash review.",
            "Do not claim external side effects.",
            "State checks, risks, next actions, and confidence explicitly.",
          ],
        },
        organizationRevision: organization.metadata.revision,
        workItemId: candidate.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        generation: claim.generation,
      };
      let result;
      if (agentHostProfile) {
        if (agentHostProfile.adapter !== "codex-app-server") {
          throw new Error(
            `AGENT_HOST_ADAPTER_UNSUPPORTED: ${agentHostProfile.adapter}`,
          );
        }
        const host = options.agentHostFactory?.() ??
          new CodexAppServerAgentHost({
            id: agentHostProfile.id,
            command: agentHostProfile.command,
            ...(agentHostProfile.args
              ? { args: agentHostProfile.args }
              : {}),
            executableSha256: agentHostProfile.executableSha256,
            workingDirectory: target,
            ...(agentHostProfile.model ? { model: agentHostProfile.model } : {}),
            ...(agentHostProfile.reasoningEffort
              ? { reasoningEffort: agentHostProfile.reasoningEffort }
              : {}),
            allowUnrestrictedRead:
              agentHostProfile.allowUnrestrictedRead === true,
            ...(agentHostProfile.environmentAllowlist
              ? { environmentAllowlist: agentHostProfile.environmentAllowlist }
              : {}),
            timeoutMs: agentHostProfile.timeoutMs ?? 600_000,
            approvalPolicy: "never",
            sandbox:
              role.tools.allow.includes("workspace.write_file") &&
              !role.tools.approvalRequired?.includes("workspace.write_file")
                ? "workspace_write"
              : "read_only",
          });
        activeAgentHost = host;
        const hostModelId = agentHostProfile.model ?? "host-managed";
        invocationId = controlPlane.startInvocation({
          attemptId: claim.attemptId,
          engineId: agentHostProfile.id,
          modelId: hostModelId,
        }).id;
        const handle = await host.start(
          {
            ...hostRequest,
            workspacePath: target,
            taskPacket: {
              ...hostRequest.taskPacket,
              executionProtocol: [
                "Act as the assigned CharterMesh role inside the approved workspace.",
                "Return exactly one JSON object and no Markdown fences.",
                "The JSON object must use apiVersion chartermesh.dev/structured-artifact/v1alpha1 and contain summary, deliverable, checks, risks, nextActions, and confidence.",
                "Checks may name only verification actually performed in this run; proposals belong in nextActions.",
                "Never claim that a host permission prompt is CharterMesh human approval.",
              ],
            },
          },
          { signal: runController.signal },
        );
        activeAgentHostRunId = handle.hostRunId;
        controlPlane.bindAgentHostRun({
          workItemId: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          hostId: agentHostProfile.id,
          hostSessionId: handle.hostSessionId,
          hostRunId: handle.hostRunId,
          actor: "runner:local",
          idempotencyKey: `agent-host:bind:${claim.runId}`,
        });
        agentHostBindingCreated = true;
        let approvalRequested = false;
        let terminalSequence: number | undefined;
        for await (const event of host.events(handle.hostRunId, {
          signal: runController.signal,
        })) {
          if (event.type === "approval_required") {
            approvalRequested = true;
            controlPlane.checkpointAgentHostRun({
              workItemId: candidate.id,
              runId: claim.runId,
              attemptId: claim.attemptId,
              leaseId: claim.leaseId,
              generation: claim.generation,
              status: "waiting",
              lastEventCursor: String(event.sequence),
              errorCode: "AGENT_HOST_APPROVAL_UNRESOLVED",
              actor: "runner:local",
              idempotencyKey:
                `agent-host:event:${claim.runId}:${event.sequence}`,
            });
          } else if (event.type === "terminal") {
            terminalSequence = event.sequence;
          }
        }
        const hostResult = await host.result(handle.hostRunId, {
          signal: runController.signal,
        });
        if (approvalRequested) {
          throw new Error(
            "AGENT_HOST_APPROVAL_UNRESOLVED: the provider request was denied fail-closed; no human approval was inferred.",
          );
        }
        if (hostResult.status !== "completed") {
          throw new Error(
            hostResult.status === "canceled"
              ? "RUN_CANCELED"
              : `AGENT_HOST_FAILED: ${hostResult.error?.code ?? "unknown"}`,
          );
        }
        const artifact = parseStructuredArtifact(hostResult.outputText);
        if (!artifact) {
          throw new Error(
            "STRUCTURED_ARTIFACT_INVALID: AgentHost output did not satisfy the artifact contract.",
          );
        }
        controlPlane.checkpointAgentHostRun({
          workItemId: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          status: "succeeded",
          ...(terminalSequence !== undefined
            ? { lastEventCursor: String(terminalSequence) }
            : {}),
          actor: "runner:local",
          idempotencyKey: `agent-host:terminal:${claim.runId}:succeeded`,
        });
        result = {
          hostRunId: hostResult.hostRunId,
          inference: {
            invocationId,
            text: `${JSON.stringify(artifact, null, 2)}\n`,
            toolCalls: [],
            finishReason: "stop" as const,
            usage: hostResult.usage,
            providerIdentity: {
              reportedModelId: agentHostProfile.model ?? null,
              reportedSystemFingerprint: null,
            },
          },
          toolEvidence: [],
          artifactSubmission: {
            content: `${JSON.stringify(artifact, null, 2)}\n`,
            mediaType: "text/plain",
            producerReport: {
              apiVersion:
                "chartermesh.dev/artifact-producer-report/v1alpha1" as const,
              source: "model_reported" as const,
              summary: artifact.summary,
              deliverable: artifact.deliverable,
              reportedChecks: artifact.checks,
              reportedRisks: artifact.risks,
              nextActions: artifact.nextActions,
              confidence: artifact.confidence,
            },
          },
        };
      } else if (options.delegated) {
        if (!engine) throw new Error("DELEGATION_ENGINE_UNAVAILABLE");
        const stageInvocations = new Map<string, string>();
        const controller = new DelegationController();
        result = await controller.run(hostRequest, {
          engine,
          projectPreferences: readProjectPreferences(target),
          toolRuntime,
          signal: runController.signal,
          lifecycle: {
            startStage({ role: delegatedRole, engineId }) {
              const child = controlPlane.startChildAttempt({
                parentAttemptId: claim!.attemptId,
                roleId: delegatedRole,
                actor: "runner:local",
                maxChildren: 4,
              });
              activeAttemptId = child.id;
              try {
                const invocation = controlPlane.startInvocation({
                  attemptId: child.id,
                  engineId,
                  modelId,
                });
                stageInvocations.set(child.id, invocation.id);
                return { attemptId: child.id };
              } catch (error) {
                controlPlane.finishChildAttempt({
                  id: child.id,
                  status: "failed",
                  actor: "runner:local",
                  errorCode: "MODEL_START_REJECTED",
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : "Model start was rejected.",
                });
                throw error;
              }
            },
            finishStage({
              attemptId,
              status,
              inference,
              error,
            }) {
              const stageInvocationId = stageInvocations.get(attemptId);
              if (stageInvocationId) {
                controlPlane.finishInvocation({
                  id: stageInvocationId,
                  status,
                  inputTokens: inference?.usage.inputTokens ?? null,
                  outputTokens: inference?.usage.outputTokens ?? null,
                  cost: inference?.usage.cost ?? null,
                  measurementStatus:
                    inference?.usage.measurementStatus ?? "unknown",
                });
              }
              controlPlane.finishChildAttempt({
                id: attemptId,
                status,
                actor: "runner:local",
                ...(status === "succeeded"
                  ? {}
                  : {
                      errorCode:
                        status === "canceled"
                          ? "RUN_CANCELED"
                          : "DELEGATED_STAGE_FAILED",
                      errorMessage:
                        error instanceof Error
                          ? error.message
                          : "Delegated stage failed.",
                    }),
              });
              activeAttemptId = claim!.attemptId;
            },
          },
        });
      } else {
        if (!engine) throw new Error("MANAGED_ENGINE_UNAVAILABLE");
        const runner = new BuiltInManagedRunner({ projectPreferences: readProjectPreferences(target), roleId: role.id });
        invocationId = controlPlane.startInvocation({
          attemptId: claim.attemptId,
          engineId: engine.manifest.profileId,
          modelId,
        }).id;
        const handle = await runner.start(hostRequest, {
          engine,
          toolRuntime,
          signal: runController.signal,
        });
        result = await runner.result(handle.hostRunId);
      }
      const successfulTools = new Set(
        [...replayedEvidence, ...result.toolEvidence]
          .filter(({ status }) => status === "succeeded")
          .map(({ toolName }) => toolName),
      );
      const missingRequiredTools = requiredTools.filter(
        (toolName) => !successfulTools.has(toolName),
      );
      if (missingRequiredTools.length > 0) {
        throw new Error(
          `REQUIRED_TOOL_EVIDENCE_MISSING: ${missingRequiredTools.join(", ")}`,
        );
      }
      if (invocationId) {
        controlPlane.finishInvocation({
          id: invocationId,
          status: "succeeded",
          inputTokens: result.inference.usage.inputTokens,
          outputTokens: result.inference.usage.outputTokens,
          cost: result.inference.usage.cost,
          measurementStatus: result.inference.usage.measurementStatus,
        });
      }
      const submission = controlPlane.submitArtifact({
        id: candidate.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        content: result.artifactSubmission.content,
        mediaType: result.artifactSubmission.mediaType,
        producerReport: result.artifactSubmission.producerReport,
        generation: claim.generation,
        actor: "runner:local",
        idempotencyKey: `cli:submit:${candidate.id}:${claim.generation}`,
      });
      const runResult = {
        status: "submitted_for_review" as const,
        workItemId: submission.workItem.id,
        artifactId: submission.artifactId,
        sha256: submission.sha256,
        generation: claim.generation,
      };
      if (options.json) {
        writeJsonEnvelope("run", runResult);
      } else if (!options.quiet) {
        console.log(
          `${submission.workItem.id} submitted for review (${submission.sha256}).`,
        );
      }
      return runResult;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (activeAgentHost && activeAgentHostRunId) {
        try {
          await activeAgentHost.cancel(activeAgentHostRunId, {
            code: "safety",
            message:
              "CharterMesh could not continue or durably checkpoint the active host run.",
          });
        } catch {
          // Durable Control Plane failure settlement remains authoritative. A
          // failed best-effort host cancellation is visible through that path.
        }
      }
      if (error instanceof ToolApprovalRequiredError && claim) {
        controlPlane.recordPendingToolCall({
          id: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          callHash: error.callHash,
          toolName: error.toolName,
          arguments: error.call.arguments,
          ...(error.summary ? { summary: error.summary } : {}),
          createdAt: new Date().toISOString(),
          actor: "runner:local",
          idempotencyKey: `cli:pending:${candidate.id}:${error.callHash}`,
        });
        const pendingResult = {
          status: "approval_required" as const,
          workItemId: candidate.id,
          callHash: error.callHash,
          toolName: error.toolName,
          generation: claim.generation,
        };
        if (options.json) {
          writeJsonEnvelope("run", pendingResult);
        } else if (!options.quiet) {
          console.log(
            `${candidate.id} is waiting for exact human tool approval (${error.callHash}).`,
          );
        }
        return pendingResult;
      }
      const errorCode = rawMessage.startsWith("STRUCTURED_ARTIFACT_INVALID")
        ? "STRUCTURED_ARTIFACT_INVALID"
        : rawMessage.startsWith("TOOL_APPROVAL_REQUIRED")
          ? "TOOL_APPROVAL_REQUIRED"
          : rawMessage.startsWith("REQUIRED_TOOL_EVIDENCE_MISSING")
            ? "REQUIRED_TOOL_EVIDENCE_MISSING"
          : rawMessage.startsWith("AGENT_HOST_APPROVAL_UNRESOLVED")
            ? "AGENT_HOST_APPROVAL_UNRESOLVED"
          : rawMessage.startsWith("AGENT_HOST_FAILED")
            ? "AGENT_HOST_FAILED"
          : rawMessage.startsWith("TOOL_OUTCOME_UNKNOWN")
            ? "TOOL_OUTCOME_UNKNOWN"
          : rawMessage.startsWith("TOOL_ITERATION_LIMIT")
            ? "TOOL_ITERATION_LIMIT"
            : rawMessage.startsWith("RUN_CANCELED") ||
                rawMessage.toLowerCase().includes("abort") ||
                rawMessage.toLowerCase().includes("canceled")
              ? "RUN_CANCELED"
              : "MODEL_INVOCATION_FAILED";
      if (agentHostBindingCreated && activeAgentHostRunId) {
        const binding = controlPlane.agentHostRunBinding(claim.runId);
        if (
          binding &&
          !["succeeded", "failed", "canceled"].includes(binding.status)
        ) {
          controlPlane.checkpointAgentHostRun({
            workItemId: candidate.id,
            runId: claim.runId,
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
            generation: claim.generation,
            status: errorCode === "RUN_CANCELED" ? "canceled" : "failed",
            errorCode,
            actor: "runner:local",
            idempotencyKey:
              `agent-host:terminal:${claim.runId}:${errorCode.toLowerCase()}`,
          });
        }
      }
      if (invocationId) {
        controlPlane.finishInvocation({
          id: invocationId,
          status:
            errorCode === "RUN_CANCELED" ? "canceled" : "failed",
          inputTokens: null,
          outputTokens: null,
          cost: null,
          measurementStatus: "unknown",
        });
      }
      const alreadySettled = ["failed", "canceled"].includes(
        controlPlane.get(candidate.id).status,
      );
      if (errorCode === "RUN_CANCELED" && !alreadySettled) {
        controlPlane.cancelRun({
          id: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          actor: "runner:local",
          idempotencyKey:
            `cli:canceled:${candidate.id}:${claim.generation}`,
        });
      } else if (!alreadySettled) {
        controlPlane.failRun({
          id: candidate.id,
          runId: claim.runId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          attemptId: claim.attemptId,
          errorCode,
          errorMessage:
            errorCode === "STRUCTURED_ARTIFACT_INVALID"
              ? "The model did not return a valid structured artifact."
              : errorCode === "TOOL_APPROVAL_REQUIRED"
                ? rawMessage
                : errorCode === "REQUIRED_TOOL_EVIDENCE_MISSING"
                  ? rawMessage
                : errorCode === "AGENT_HOST_APPROVAL_UNRESOLVED" ||
                    errorCode === "AGENT_HOST_FAILED"
                  ? rawMessage
                : errorCode === "TOOL_OUTCOME_UNKNOWN"
                  ? "A tool returned, but its evidence could not be committed. Inspect the workspace before retrying."
                : errorCode === "TOOL_ITERATION_LIMIT"
                  ? "The model exceeded the OrgSpec tool iteration limit."
                  : "The configured model invocation failed.",
          actor: "runner:local",
          idempotencyKey:
            `cli:fail:${candidate.id}:${claim.generation}`,
        });
      }
      throw error;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancellationPoll) clearInterval(cancellationPoll);
    removeSignalHandlers();
    database.close();
  }
}

export async function runSchedulerTick(
  target: string,
  evaluatedAt = new Date(),
): Promise<SchedulerTickSummary> {
  const organization = readOrganization(target);
  const summary: SchedulerTickSummary = {
    evaluatedAt: evaluatedAt.toISOString(),
    activeSchedules: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    skippedNoWork: 0,
    skippedOverlap: 0,
    notDue: 0,
    inactive: 0,
    results: [],
  };
  for (const schedule of organization.spec.schedules) {
    if (
      schedule.activation !== "active" ||
      (schedule.executor ?? "controller") !== "controller"
    ) {
      summary.inactive += 1;
      summary.results.push({
        scheduleId: schedule.id,
        status: "inactive",
      });
      continue;
    }
    summary.activeSchedules += 1;
    let database;
    let controlPlane;
    try {
      ({ database, controlPlane } = controlPlaneFor(target));
      controlPlane.recoverExpiredLeases("system:scheduler");
      let active = controlPlane.activeScheduleTick(schedule.id);
      if (active?.workItemId) {
        const activeWork = controlPlane.get(active.workItemId);
        if (
          ["review_pending", "approved", "done"].includes(activeWork.status)
        ) {
          controlPlane.finishScheduleTick({
            id: active.id,
            status: "succeeded",
          });
          active = null;
        } else if (activeWork.status !== "in_progress") {
          controlPlane.finishScheduleTick({
            id: active.id,
            status: "failed",
            errorCode: "SCHEDULE_TICK_ABANDONED",
          });
          active = null;
        }
      }
      const latest = controlPlane.latestScheduleTick(schedule.id);
      let evaluation;
      try {
        evaluation = evaluateIntervalSchedule({
          rrule: schedule.cadence.rrule,
          timezone: schedule.cadence.timezone,
          now: evaluatedAt,
          lastStartedAt: latest?.startedAt,
        });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "unsupported",
          errorCode:
            error instanceof Error
              ? error.message
              : "SCHEDULE_CONFIGURATION_INVALID",
        });
        continue;
      }
      if (!evaluation.due) {
        summary.notDue += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "not_due",
        });
        continue;
      }
      if (
        schedule.overlapPolicy === "forbid" &&
        active
      ) {
        const tick = controlPlane.beginScheduleTick({
          scheduleId: schedule.id,
          tickKey: evaluation.tickKey,
          workItemId: null,
          status: "skipped_overlap",
          startedAt: evaluatedAt.toISOString(),
        });
        summary.skippedOverlap += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "skipped_overlap",
          tickId: tick.id,
        });
        continue;
      }
      const candidate = controlPlane.nextClaimableWork();
      if (!candidate) {
        const tick = controlPlane.beginScheduleTick({
          scheduleId: schedule.id,
          tickKey: evaluation.tickKey,
          workItemId: null,
          status: "skipped_no_work",
          startedAt: evaluatedAt.toISOString(),
        });
        summary.skippedNoWork += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "skipped_no_work",
          tickId: tick.id,
        });
        continue;
      }
      const tick = controlPlane.beginScheduleTick({
        scheduleId: schedule.id,
        tickKey: evaluation.tickKey,
        workItemId: candidate.id,
        startedAt: evaluatedAt.toISOString(),
      });
      summary.started += 1;
      database.close();
      database = undefined;
      try {
        await runWork(target, candidate.id, { quiet: true });
        const completion = controlPlaneFor(target);
        try {
          completion.controlPlane.finishScheduleTick({
            id: tick.id,
            status: "succeeded",
          });
        } finally {
          completion.database.close();
        }
        summary.succeeded += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "succeeded",
          workItemId: candidate.id,
          tickId: tick.id,
        });
      } catch {
        const completion = controlPlaneFor(target);
        try {
          completion.controlPlane.finishScheduleTick({
            id: tick.id,
            status: "failed",
            errorCode: "SCHEDULE_RUN_FAILED",
          });
        } finally {
          completion.database.close();
        }
        summary.failed += 1;
        summary.results.push({
          scheduleId: schedule.id,
          status: "failed",
          workItemId: candidate.id,
          tickId: tick.id,
          errorCode: "SCHEDULE_RUN_FAILED",
        });
      }
    } finally {
      database?.close();
    }
  }
  return summary;
}

async function schedulerCommand(
  target: string,
  args: string[],
): Promise<void> {
  const subcommand = args[1] ?? "tick";
  if (subcommand === "list") {
    const { database, controlPlane } = controlPlaneFor(target);
    try {
      const items = controlPlane.listScheduleTicks(
        option(args, "--schedule"),
      );
      if (has(args, "--json")) {
        writeJsonEnvelope("scheduler list", { items });
      } else {
        for (const item of items) {
          console.log(
            `${item.scheduleId} | ${item.tickKey} | ${item.status}` +
              (item.workItemId ? ` | ${item.workItemId}` : ""),
          );
        }
      }
      return;
    } finally {
      database.close();
    }
  }
  const requestedNow = option(args, "--now");
  const tick = async () => {
    const at = requestedNow ? new Date(requestedNow) : new Date();
    if (!Number.isFinite(at.getTime())) {
      throw new Error("--now must be an ISO-8601 timestamp.");
    }
    const result = await runSchedulerTick(target, at);
    if (has(args, "--json")) {
      writeJsonEnvelope(`scheduler ${subcommand}`, result);
    } else {
      console.log(
        `Scheduler: ${result.succeeded} succeeded, ` +
          `${result.skippedNoWork} no-work skip, ` +
          `${result.failed} failed.`,
      );
    }
  };
  if (subcommand === "tick") {
    await tick();
    return;
  }
  if (subcommand !== "watch") {
    throw new Error("scheduler requires tick, watch, or list.");
  }
  if (requestedNow) {
    throw new Error("scheduler watch does not accept --now.");
  }
  const pollMs = Number(option(args, "--poll-ms") ?? 30_000);
  if (
    !Number.isInteger(pollMs) ||
    pollMs < 1_000 ||
    pollMs > 3_600_000
  ) {
    throw new Error("--poll-ms must be between 1000 and 3600000.");
  }
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function printItems(target: string, args: string[]): void {
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const paged =
      option(args, "--limit") !== undefined ||
      option(args, "--cursor") !== undefined ||
      has(args, "--active-only");
    const page = paged
      ? controlPlane.listPage({
          cursor: option(args, "--cursor"),
          limit: Number(option(args, "--limit") ?? 100),
          includeCompleted: !has(args, "--active-only"),
          includeArchived: has(args, "--include-archived"),
        })
      : {
          items: controlPlane.list({
            includeArchived: has(args, "--include-archived"),
          }),
          nextCursor: null,
        };
    if (has(args, "--json")) {
      writeJsonEnvelope("list", page);
      return;
    }
    for (const item of page.items) {
      console.log(
        `${item.id} | ${item.status} | ${item.availability} | ${item.ownerRole} | ${item.title}`,
      );
    }
    if (page.nextCursor) {
      console.log(`Next cursor: ${page.nextCursor}`);
    }
  } finally {
    database.close();
  }
}

function requestWork(target: string, args: string[]): void {
  const title = option(args, "--title") ?? args.filter((arg) => !arg.startsWith("--"))[1];
  const encodedSummary = option(args, "--summary-base64");
  let decodedSummary: string | undefined;
  if (encodedSummary !== undefined) {
    if (
      encodedSummary.length === 0 ||
      encodedSummary.length > 87_384 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(encodedSummary) ||
      encodedSummary.length % 4 !== 0
    ) {
      throw new Error(
        "--summary-base64 must be canonical base64 for at most 65536 UTF-8 bytes.",
      );
    }
    const bytes = Buffer.from(encodedSummary, "base64");
    if (
      bytes.byteLength > 65_536 ||
      bytes.toString("base64") !== encodedSummary
    ) {
      throw new Error(
        "--summary-base64 must be canonical base64 for at most 65536 UTF-8 bytes.",
      );
    }
    decodedSummary = bytes.toString("utf8");
    if (
      Buffer.from(decodedSummary, "utf8").compare(bytes) !== 0 ||
      decodedSummary.trim().length === 0
    ) {
      throw new Error("--summary-base64 must decode to non-empty UTF-8 text.");
    }
  }
  if (option(args, "--summary") !== undefined && decodedSummary !== undefined) {
    throw new Error("Use only one of --summary or --summary-base64.");
  }
  const summary = option(args, "--summary") ?? decodedSummary ?? title;
  if (!title || !summary) {
    throw new Error(
      "request requires a title and optionally --summary or --summary-base64.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const acceptanceCriteria = options(args, "--acceptance").map(
      (text, index) => ({
        id: `user-${index + 1}`,
        text,
        critical: true,
        evidenceRequirements: [],
      }),
    );
    const item = controlPlane.intake({
      title,
      summary,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
      requiredTools: options(args, "--require-tool"),
      decisionQuestion: option(args, "--decision-question"),
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    });
    if (has(args, "--json")) writeJsonEnvelope("request", item);
    else console.log(`${item.id} created. Next action: ${item.nextAction}`);
  } finally {
    database.close();
  }
}

function triageWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("triage requires --id.");
  const organization = readOrganization(target);
  const ownerRole = option(args, "--role") ?? "operator";
  const role = organization.spec.roles.find(({ id }) => id === ownerRole);
  if (!role) throw new Error(`Unknown OrgSpec role '${ownerRole}'.`);
  const executionTarget = option(args, "--execution-target") ??
    role.execution.preferred;
  const selectedTarget = organization.spec.executionTargets.find(
    ({ id }) => id === executionTarget,
  );
  if (!selectedTarget?.enabled) {
    throw new Error(
      `Execution target '${executionTarget}' is not an enabled OrgSpec target.`,
    );
  }
  const roleTargets = new Set([
    role.execution.preferred,
    ...(role.execution.fallbacks ?? []),
  ]);
  if (!roleTargets.has(executionTarget)) {
    throw new Error(
      `Execution target '${executionTarget}' is not configured for role '${ownerRole}'.`,
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.triage({
      id,
      ownerRole,
      executionTarget,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("triage", item);
    else console.log(`${item.id} is ready.`);
  } finally {
    database.close();
  }
}

function waitWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  const type = option(args, "--type") as WaitCondition["type"] | undefined;
  const reason = option(args, "--reason");
  if (!id || !type || !reason) {
    throw new Error("wait requires --id, --type, and --reason.");
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.wait({
      id,
      condition: {
        type,
        reason,
        ...(option(args, "--reference")
          ? { reference: option(args, "--reference") }
          : {}),
        ...(option(args, "--resume-at")
          ? { resumeAt: option(args, "--resume-at") }
          : {}),
      },
      actor: "role:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("wait", item);
    else console.log(`${item.id} is ${item.availability}: ${item.nextAction}`);
  } finally {
    database.close();
  }
}

function resumeWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("resume requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.resume({
      id,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("resume", item);
    else console.log(`${item.id} resumed: ${item.nextAction}`);
  } finally {
    database.close();
  }
}

function provideUserInput(target: string, args: string[]): void {
  const id = option(args, "--id");
  const packetHash = option(args, "--packet-hash");
  const response = option(args, "--response");
  if (!id || !packetHash || !response) {
    throw new Error(
      "provide-input requires --id, --packet-hash, and --response.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const result = controlPlane.provideUserInput({
      id,
      packetHash,
      response,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("provide-input", result);
    else console.log(`${result.workItem.id} received the requested input.`);
  } finally {
    database.close();
  }
}

function retryWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("retry requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.retry({
      id,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
      acknowledgeUnknownToolOutcome: has(
        args,
        "--acknowledge-tool-outcome",
      ),
    });
    if (has(args, "--json")) writeJsonEnvelope("retry", item);
    else console.log(`${item.id} is ready to retry.`);
  } finally {
    database.close();
  }
}

function cancelWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("cancel requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const result = controlPlane.requestRunCancellation({
      id,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("cancel", result);
    else console.log(`Cancellation requested for ${result.workItemId}.`);
  } finally {
    database.close();
  }
}

function archiveWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("archive requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.archive({
      id,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("archive", item);
    else console.log(`${item.id} archived.`);
  } finally {
    database.close();
  }
}

function outboxCommand(target: string, args: string[]): void {
  const subcommand = args[1] ?? "list";
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    if (subcommand === "list") {
      const items = controlPlane.listOutbox({
        deadLettersOnly: has(args, "--dead-letters"),
        limit: Number(option(args, "--limit") ?? 100),
      });
      if (has(args, "--json")) {
        writeJsonEnvelope("outbox list", { items });
      } else {
        for (const item of items) {
          console.log(
            `${item.id} | ${item.eventType} | attempts=${item.attemptCount} | ` +
              `${item.deadLetteredAt ? "dead-letter" : item.dispatchedAt ? "dispatched" : "pending"}`,
          );
        }
      }
      return;
    }
    if (subcommand === "retry") {
      const id = Number(option(args, "--id"));
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("outbox retry requires a positive --id.");
      }
      const item = controlPlane.retryDeadLetter({
        id,
        actor: "human:cli",
        idempotencyKey:
          option(args, "--idempotency-key") ?? randomUUID(),
      });
      if (has(args, "--json")) writeJsonEnvelope("outbox retry", item);
      else console.log(`Outbox delivery ${item.id} is pending again.`);
      return;
    }
    throw new Error("outbox requires list or retry.");
  } finally {
    database.close();
  }
}

function decideWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  const decision = option(args, "--decision") as
    | "approve"
    | "changes_requested"
    | "reject"
    | undefined;
  if (!id || !decision) {
    throw new Error("decide requires --id and --decision.");
  }
  const artifactHash = option(args, "--artifact-hash");
  if (!artifactHash) {
    throw new Error(
      "decide requires --artifact-hash from the submitted artifact.",
    );
  }
  const packetHash = option(args, "--packet-hash");
  if (!packetHash) {
    throw new Error(
      "decide requires --packet-hash from the current decision-packet command.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.decide({
      id,
      decision,
      artifactHash,
      packetHash,
      note: option(args, "--note") ?? "Reviewed from the local CLI.",
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("decide", item);
    else console.log(`${item.id} -> ${item.status}`);
  } finally {
    database.close();
  }
}

function completeWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("complete requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const result = controlPlane.complete({
      id,
      actor: "role:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) {
      writeJsonEnvelope("complete", result);
    } else {
      console.log(`${result.workItem.id} completed.`);
    }
    if (!has(args, "--json") && result.resurfaced.length > 0) {
      console.log(`Resurfaced: ${result.resurfaced.join(", ")}`);
    }
  } finally {
    database.close();
  }
}

function approveTool(target: string, args: string[]): void {
  const id = option(args, "--id");
  const callHash = option(args, "--call-hash");
  const toolName = option(args, "--tool");
  const packetHash = option(args, "--packet-hash");
  if (!id || !callHash || !toolName || !packetHash) {
    throw new Error(
      "approve-tool requires --id, --call-hash, --tool, and --packet-hash.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const approval = controlPlane.approveToolCall({
      id,
      callHash,
      toolName,
      packetHash,
      actor: "human:cli",
      note:
        option(args, "--note") ??
        "Approved exact tool call from the local CLI.",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("approve-tool", approval);
    else {
      console.log(
        `Approved ${approval.toolName} call ${approval.callHash} for ${approval.workItemId}.`,
      );
    }
  } finally {
    database.close();
  }
}

function denyTool(target: string, args: string[]): void {
  const id = option(args, "--id");
  const callHash = option(args, "--call-hash");
  const toolName = option(args, "--tool");
  const packetHash = option(args, "--packet-hash");
  if (!id || !callHash || !toolName || !packetHash) {
    throw new Error(
      "deny-tool requires --id, --call-hash, --tool, and --packet-hash.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const denial = controlPlane.denyToolCall({
      id,
      callHash,
      toolName,
      packetHash,
      actor: "human:cli",
      note:
        option(args, "--note") ??
        "Denied exact tool call from the local CLI.",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
    });
    if (has(args, "--json")) writeJsonEnvelope("deny-tool", denial);
    else {
      console.log(
        `Denied ${denial.toolName} call ${denial.callHash}; ${denial.workItemId} was canceled.`,
      );
    }
  } finally {
    database.close();
  }
}

function printDecisionPacket(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("decision-packet requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const packet = controlPlane.decisionPacket(id);
    if (!packet) throw new Error("No current human decision packet exists.");
    if (has(args, "--json")) writeJsonEnvelope("decision-packet", packet);
    else {
      const preferences = readProjectPreferences(target);
      const explanation = projectApprovalExplanation(packet, preferences.language === "ko" ? "ko" : "en", preferences.approvalDetail);
      console.log(explanation.heading);
      for (const section of explanation.sections) {
        console.log(`${section.label}: ${section.text}`);
      }
      console.log("");
      console.log("Technical details — exact decision packet");
      console.log(JSON.stringify(packet, null, 2));
    }
  } finally {
    database.close();
  }
}

function systemCommand(target: string, args: string[]): void {
  const subcommand = args[1] ?? "status";
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    let state;
    if (subcommand === "status") {
      state = controlPlane.operationalState();
    } else if (subcommand === "pause") {
      const reason = option(args, "--reason");
      if (!reason) throw new Error("system pause requires --reason TEXT.");
      state = controlPlane.pauseOperations({
        reason,
        actor: "human:cli",
        idempotencyKey:
          option(args, "--idempotency-key") ?? randomUUID(),
      });
    } else if (subcommand === "resume") {
      state = controlPlane.resumeOperations({
        actor: "human:cli",
        idempotencyKey:
          option(args, "--idempotency-key") ?? randomUUID(),
      });
    } else {
      throw new Error("system requires status, pause, or resume.");
    }
    if (has(args, "--json")) writeJsonEnvelope(`system ${subcommand}`, state);
    else if (state.paused) {
      console.log(`New runs are paused: ${state.reason}`);
    } else {
      console.log("New runs are enabled.");
    }
  } finally {
    database.close();
  }
}

function printToolEvidence(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("tool-evidence requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const evidence = controlPlane.listToolEvidence(id);
    const pending = controlPlane.listPendingToolCalls(id);
    if (has(args, "--json")) {
      writeJsonEnvelope("tool-evidence", {
        items: evidence,
        pendingToolCalls: pending,
      });
      return;
    }
    for (const item of evidence) {
      console.log(
        `${item.id} | ${item.status} | ${item.toolName} | ${item.callHash}`,
      );
    }
    for (const item of pending) {
      console.log(
        `${item.id} | ${item.status} | ${item.toolName} | ${item.callHash} | ${JSON.stringify(item.arguments)}`,
      );
    }
  } finally {
    database.close();
  }
}

async function evaluateModel(target: string, args: string[]): Promise<number> {
  if (!has(args, "--live")) {
    throw new Error(
      "evaluate-model starts real model inference. Repeat with --live to opt in.",
    );
  }
  const runtime = readRuntime(target);
  const engine = configuredEngine(
    runtime,
    target,
    option(args, "--engine-id"),
  );
  const report = await evaluateModelEngine(engine);
  if (has(args, "--json")) writeJsonEnvelope("evaluate-model", report);
  else {
    console.log(
      `Model evaluation ${report.evaluationId}: ${report.passedCases}/${report.totalCases} passed.`,
    );
    for (const item of report.cases) {
      console.log(
        `- ${item.id}: ${item.passed ? "PASS" : "FAIL"} (${item.latencyMs} ms)` +
          (item.errorCode ? ` ${item.errorCode}` : "") +
          (item.missingTokens.length
            ? `; missing: ${item.missingTokens.join(", ")}`
            : ""),
      );
    }
  }
  return report.passed ? 0 : 2;
}

async function evaluateCollaborationCommand(
  target: string,
  args: string[],
): Promise<number> {
  if (!has(args, "--live")) {
    throw new Error(
      "evaluate-collaboration starts real model inference. Repeat with --live to opt in.",
    );
  }
  const repetitions = Number(option(args, "--repetitions") ?? 1);
  const runtime = readRuntime(target);
  const engine = configuredEngine(
    runtime,
    target,
    option(args, "--engine-id"),
  );
  const reviewerEngineId = option(args, "--reviewer-engine-id");
  const reviewerEngine = reviewerEngineId
    ? configuredEngine(runtime, target, reviewerEngineId)
    : undefined;
  const fixtureIds = options(args, "--fixture");
  const report = await evaluateCollaboration(engine, {
    repetitions,
    ...(fixtureIds.length > 0 ? { fixtureIds } : {}),
    ...(reviewerEngine
      ? {
          delegatedEngineForRole: (role) =>
            role === "verifier" || role === "synthesizer"
              ? reviewerEngine
              : engine,
        }
      : {}),
  });
  if (has(args, "--json")) {
    writeJsonEnvelope("evaluate-collaboration", report);
  } else {
    console.log(
      `Collaboration evaluation ${report.evaluationId}: single ${report.aggregate.singleMeanScore.toFixed(3)}, delegated ${report.aggregate.delegatedMeanScore.toFixed(3)}, delta ${report.aggregate.meanScoreDelta.toFixed(3)}.`,
    );
    for (const trial of report.trials) {
      console.log(
        `- ${trial.fixtureId} #${trial.repetition}: single ${trial.single.score.toFixed(3)}, delegated ${trial.delegated.score.toFixed(3)} (${trial.scoreDelta >= 0 ? "+" : ""}${trial.scoreDelta.toFixed(3)})`,
      );
    }
  }
  return report.trials.every(
    ({ single, delegated }) => single.passed && delegated.passed,
  )
    ? 0
    : 2;
}

function boundedIntegerOption(
  args: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = option(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function workflowTrajectoryLimits(args: string[]): WorkflowTrajectoryLimits {
  const maximumTotalTokens = option(args, "--max-total-tokens");
  const wallClockMinutes = boundedIntegerOption(
    args,
    "--max-wall-clock-minutes",
    DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.maxWallClockMs / 60_000,
    1,
    1_440,
  );
  const limits: WorkflowTrajectoryLimits = {
    boundedCheckpoint: boundedIntegerOption(
      args,
      "--checkpoint-feedback-rounds",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.boundedCheckpoint,
      1,
      100,
    ),
    maxFeedbackRounds: boundedIntegerOption(
      args,
      "--max-feedback-rounds",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.maxFeedbackRounds,
      1,
      1_000,
    ),
    maxWallClockMs: wallClockMinutes * 60_000,
    maxModelCalls: boundedIntegerOption(
      args,
      "--max-model-calls",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.maxModelCalls,
      1,
      100_000,
    ),
    maxTotalTokens:
      maximumTotalTokens === undefined
        ? null
        : boundedIntegerOption(
            args,
            "--max-total-tokens",
            1,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
    identicalArtifactLimit: boundedIntegerOption(
      args,
      "--identical-artifact-limit",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.identicalArtifactLimit,
      2,
      100,
    ),
    maxConsecutiveContractInvalidSubmissions: boundedIntegerOption(
      args,
      "--max-consecutive-contract-invalid-submissions",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS
        .maxConsecutiveContractInvalidSubmissions,
      1,
      100,
    ),
    maxParallelAgents: boundedIntegerOption(
      args,
      "--max-parallel-agents",
      DEFAULT_WORKFLOW_TRAJECTORY_LIMITS.maxParallelAgents,
      1,
      32,
    ),
  };
  if (limits.maxFeedbackRounds < limits.boundedCheckpoint) {
    throw new Error(
      "--max-feedback-rounds must be at least --checkpoint-feedback-rounds.",
    );
  }
  return limits;
}

function writeWorkflowStudyCheckpoint(
  output: string,
  value: unknown,
): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, output);
    let directoryDescriptor: number | undefined;
    try {
      directoryDescriptor = openSync(dirname(output), constants.O_RDONLY);
      fsyncSync(directoryDescriptor);
    } catch {
      // Directory fsync is not available on every supported Windows filesystem.
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function workflowStudyProcessIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireWorkflowStudyLock(input: {
  path: string;
  planHash: string;
  recoverStale: boolean;
  staleError?: string;
  authorizeStaleRecovery?: (owner: {
    planHash?: unknown;
    pid?: unknown;
  }) => void;
}): { release(): void; recoveredStale: boolean } {
  mkdirSync(dirname(input.path), { recursive: true });
  const nonce = randomUUID();
  const value = `${JSON.stringify({
    apiVersion: "chartermesh.dev/collaboration-study-lock/v1alpha1",
    planHash: input.planHash,
    pid: process.pid,
    nonce,
    createdAt: new Date().toISOString(),
  })}\n`;
  let recoveredStale = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(input.path, value, { encoding: "utf8", flag: "wx" });
      return {
        recoveredStale,
        release() {
          try {
            const current = JSON.parse(
              readFileSync(input.path, "utf8"),
            ) as { nonce?: unknown };
            if (current.nonce === nonce) rmSync(input.path, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { planHash?: unknown; pid?: unknown };
      try {
        owner = JSON.parse(readFileSync(input.path, "utf8")) as {
          planHash?: unknown;
          pid?: unknown;
        };
      } catch {
        throw new Error(
          "WORKFLOW_STUDY_LOCK_INVALID: the existing lock cannot be safely recovered.",
        );
      }
      if (
        typeof owner.pid === "number" &&
        workflowStudyProcessIsRunning(owner.pid)
      ) {
        throw new Error(
          `WORKFLOW_STUDY_ALREADY_RUNNING: process ${owner.pid} owns this plan.`,
        );
      }
      if (!input.recoverStale) {
        throw new Error(
          input.staleError ??
            "WORKFLOW_STUDY_STALE_LOCK: repeat with --restart-checkpoint only after confirming the earlier process stopped.",
        );
      }
      if (input.authorizeStaleRecovery) {
        input.authorizeStaleRecovery(owner);
      } else if (owner.planHash !== input.planHash) {
        throw new Error("WORKFLOW_STUDY_STALE_LOCK_PLAN_MISMATCH");
      }
      renameSync(
        input.path,
        `${input.path}.abandoned-${randomUUID()}`,
      );
      recoveredStale = true;
    }
  }
  throw new Error("WORKFLOW_STUDY_LOCK_ACQUISITION_FAILED");
}

const DECISION_REVIEW_MAX_STATE_BYTES = 16 * 1024 * 1024;

function decisionReviewPathIsInside(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return (
    rest === "" ||
    (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`))
  );
}

function assertDecisionReviewPathComponents(
  target: string,
  candidate: string,
): void {
  const lexicalTarget = resolve(target);
  const lexicalCandidate = resolve(candidate);
  if (!decisionReviewPathIsInside(lexicalTarget, lexicalCandidate)) {
    throw new Error("DECISION_REVIEW_STATE_PATH_ESCAPE");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(lexicalTarget);
  } catch {
    throw new Error("DECISION_REVIEW_TARGET_INVALID");
  }
  const rest = relative(lexicalTarget, lexicalCandidate);
  let cursor = lexicalTarget;
  for (const component of rest === "" ? [] : rest.split(sep)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) {
      throw new Error("DECISION_REVIEW_STATE_REPARSE_POINT_REJECTED");
    }
    const canonical = realpathSync(cursor);
    if (!decisionReviewPathIsInside(canonicalTarget, canonical)) {
      throw new Error("DECISION_REVIEW_STATE_PATH_ESCAPE");
    }
  }
}

function ensureDecisionReviewDirectory(
  target: string,
  directory: string,
): void {
  assertDecisionReviewPathComponents(target, directory);
  mkdirSync(directory, { recursive: true });
  assertDecisionReviewPathComponents(target, directory);
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("DECISION_REVIEW_STATE_DIRECTORY_INVALID");
  }
}

function decisionReviewEvaluationPaths(target: string, benchmarkId: string) {
  const directory = join(
    statePaths(target).root,
    "evaluations",
    benchmarkId,
  );
  return {
    directory,
    approvals: join(directory, "used-approvals"),
    plan: join(directory, "plan.json"),
    checkpoint: join(directory, "checkpoint.json"),
    lock: join(directory, "lock.json"),
    output: join(statePaths(target).exports, `${benchmarkId}.json`),
  };
}

function readBoundedRegularJson(
  target: string,
  path: string,
  code: string,
): unknown {
  assertDecisionReviewPathComponents(target, path);
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error(`${code}: state file is unavailable`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 2 ||
    before.size > DECISION_REVIEW_MAX_STATE_BYTES
  ) {
    throw new Error(`${code}: state file is not a bounded regular file`);
  }
  let descriptor: number | undefined;
  let contents: string;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size < 2 ||
      opened.size > DECISION_REVIEW_MAX_STATE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`${code}: state file changed while opening`);
    }
    contents = readFileSync(descriptor, "utf8");
  } catch {
    throw new Error(`${code}: state file cannot be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${code}: state file is not valid JSON`);
  }
}

function writeExclusiveJson(
  target: string,
  path: string,
  value: unknown,
): void {
  assertDecisionReviewPathComponents(target, path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function persistDecisionReviewCheckpoint(
  target: string,
  path: string,
  checkpoint: DecisionReviewCheckpoint,
): DecisionReviewCheckpoint {
  assertDecisionReviewPathComponents(target, path);
  const parsed = parseDecisionReviewCheckpoint(checkpoint);
  writeWorkflowStudyCheckpoint(path, parsed);
  assertDecisionReviewPathComponents(target, path);
  return parsed;
}

function decisionReviewExecutionDisclosure(
  checkpoint: DecisionReviewCheckpoint,
): DecisionReviewExecutionDisclosure {
  return {
    segments: structuredClone(checkpoint.segments),
    processAttemptsBeforeRun: checkpoint.processAttempts,
    nonScoringPauses: structuredClone(checkpoint.nonScoringPauses),
  };
}

function decisionReviewFailureCode(error: unknown): string {
  if (error instanceof CodexProxyError) return error.code;
  if (error instanceof DecisionReviewPauseError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]{2,80})/u)?.[1] ??
    "DECISION_REVIEW_EXECUTION_FAILED";
}

function startDecisionReviewResume(
  checkpoint: DecisionReviewCheckpoint,
  resumePlan: DecisionReviewResumePlan,
): DecisionReviewCheckpoint {
  assertDecisionReviewResumePlan(resumePlan, checkpoint);
  const next = structuredClone(checkpoint);
  next.status = "running";
  next.resumeGeneration = resumePlan.resumeGeneration;
  next.segments.push(createDecisionReviewResumeExecutionSegment(resumePlan));
  next.activeInvocation = null;
  next.pause = null;
  next.failure = null;
  return parseDecisionReviewCheckpoint(next);
}

function assertRestartableWorkflowCheckpoint(
  output: string,
  planHash: string,
): void {
  const info = statSync(output);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) {
    throw new Error("WORKFLOW_STUDY_CHECKPOINT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    throw new Error("WORKFLOW_STUDY_CHECKPOINT_INVALID");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !["running", "failed"].includes(
      String((value as { status?: unknown }).status),
    ) ||
    (value as { plan?: { planHash?: unknown } }).plan?.planHash !== planHash
  ) {
    throw new Error("WORKFLOW_STUDY_CHECKPOINT_NOT_RESTARTABLE");
  }
}

async function evaluateWorkflowCommand(
  target: string,
  args: string[],
): Promise<number> {
  const artifactBindings: WorkflowStudyTaskBinding[] =
    generateReferenceArtifactSuite().map((task) => ({
      kind: "artifact",
      task,
    }));
  const codeBindings: WorkflowStudyTaskBinding[] =
    generateReferenceCodeWorkflowSuite().map((task) => ({
      kind: "code",
      task,
    }));
  const allTasks = [...artifactBindings, ...codeBindings];
  const requestedFixtures = options(args, "--fixture");
  const artifactOnly = has(args, "--artifacts-only");
  const codeOnly = has(args, "--code-only");
  const selectors = [
    has(args, "--full"),
    artifactOnly,
    codeOnly,
    requestedFixtures.length > 0,
  ].filter(Boolean).length;
  if (selectors > 1) {
    throw new Error(
      "Use only one of --full, --artifacts-only, --code-only, or --fixture.",
    );
  }
  const requestedSet = new Set(requestedFixtures);
  if (requestedSet.size !== requestedFixtures.length) {
    throw new Error("Each --fixture may be supplied only once.");
  }
  for (const id of requestedSet) {
    if (
      !allTasks.some((binding) =>
        binding.kind === "artifact"
          ? binding.task.id === id
          : binding.task.task.id === id,
      )
    ) {
      throw new Error(`Unknown workflow-evaluation fixture '${id}'.`);
    }
  }
  const tasks =
    requestedSet.size > 0
      ? allTasks.filter((binding) =>
          requestedSet.has(
            binding.kind === "artifact"
              ? binding.task.id
              : binding.task.task.id,
          ),
        )
      : artifactOnly
        ? artifactBindings
        : codeOnly
          ? codeBindings
          : allTasks;
  const limits = workflowTrajectoryLimits(args);
  const hybridCLevelCanary = has(args, "--hybrid-c-level-canary");
  const seed = boundedIntegerOption(
    args,
    "--seed",
    20260731,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const engineId = option(args, "--engine-id");
  const codexExecutable = option(args, "--codex-executable");
  const codexSha256 = option(args, "--codex-sha256")?.toLowerCase();
  const codexModel = option(args, "--codex-model");
  const codexTimeoutMs = boundedIntegerOption(
    args,
    "--codex-timeout-ms",
    120_000,
    1_000,
    900_000,
  );
  const codexMaxOutputBytes = boundedIntegerOption(
    args,
    "--codex-max-output-bytes",
    1_048_576,
    1,
    16_777_216,
  );
  let runtime: RuntimeConfig | undefined;
  let engineProfile: RuntimeConfig["modelEngines"][number] | undefined;
  if (engineId) {
    runtime = readRuntime(target);
    engineProfile = runtime.modelEngines.find(({ id }) => id === engineId);
    if (!engineProfile) throw new Error(`Unknown model engine '${engineId}'.`);
  }
  const configuredModelId = engineProfile
    ? engineProfile.adapter === "fake"
      ? "fake-model-engine"
      : engineProfile.model ?? null
    : null;
  const manifestProfileId = engineProfile
    ? engineProfile.adapter === "fake"
      ? "fake-model-engine"
      : engineProfile.id
    : null;
  const runtimeProfileHash = engineProfile
    ? createHash("sha256")
        .update(JSON.stringify(engineProfile))
        .digest("hex")
    : null;
  const hasCodeTasks = tasks.some(({ kind }) => kind === "code");
  const codeRuntimeExecutable = resolve(
    option(args, "--code-runtime-executable") ?? process.execPath,
  );
  const requestedCodeSandboxLauncher = option(args, "--wsb-executable")
    ? resolve(option(args, "--wsb-executable")!)
    : "wsb.exe";
  let codeSandboxLauncherExecutable = requestedCodeSandboxLauncher;
  let codeSandboxLauncherAttestation:
    | "file_sha256"
    | "command_name_only"
    | null = null;
  let codeSandboxLauncherCommitment: string | null = null;
  let codeSandboxLauncherSha256: string | null = null;
  if (hasCodeTasks) {
    const defaultWsbPath = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "wsb.exe")
      : null;
    const launcherFile = option(args, "--wsb-executable")
      ? requestedCodeSandboxLauncher
      : defaultWsbPath && existsSync(defaultWsbPath)
        ? defaultWsbPath
        : null;
    if (
      option(args, "--wsb-executable") &&
      !existsSync(requestedCodeSandboxLauncher)
    ) {
      throw new Error("--wsb-executable must name an existing file.");
    }
    codeSandboxLauncherExecutable = launcherFile ?? "wsb.exe";
    codeSandboxLauncherAttestation = launcherFile
      ? "file_sha256"
      : "command_name_only";
    codeSandboxLauncherSha256 = launcherFile
      ? createHash("sha256").update(readFileSync(launcherFile)).digest("hex")
      : null;
    codeSandboxLauncherCommitment = workflowStudyValueHash({
      attestation: codeSandboxLauncherAttestation,
      value: codeSandboxLauncherSha256 ?? "wsb.exe",
    });
  }
  let codeProvenance:
    | Awaited<ReturnType<typeof collectCodeEvaluationProvenance>>
    | undefined;
  let codeProvenanceHash: string | null = null;
  if (hasCodeTasks) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const roots = [
      resolve(moduleDirectory, "../../.."),
      resolve(moduleDirectory, "../../../.."),
    ];
    const packageRoot = roots.find(
      (candidate) =>
        existsSync(join(candidate, "package.json")) &&
        existsSync(join(candidate, "scripts", "windows-sandbox")),
    );
    if (!packageRoot) {
      throw new Error(
        "CODE_WORKFLOW_BUNDLE_NOT_FOUND: package.json and scripts/windows-sandbox are required.",
      );
    }
    codeProvenance = await collectCodeEvaluationProvenance({
      packageJson: join(packageRoot, "package.json"),
      repositoryDirectory: packageRoot,
      runtimeExecutable: codeRuntimeExecutable,
      guestBundleDirectory: join(
        packageRoot,
        "scripts",
        "windows-sandbox",
      ),
    });
    codeProvenanceHash = workflowStudyValueHash(codeProvenance);
  }
  const plan = createWorkflowStudyPlan({
    taskBindings: tasks,
    limits,
    seed,
    conditionSet: hybridCLevelCanary
      ? "hybrid_c_level_canary_v1"
      : "standard_v1",
    bindings: {
      candidateEngineId: manifestProfileId,
      candidateRuntimeProfileHash: runtimeProfileHash,
      candidateConfiguredModelId: configuredModelId,
      codexExecutableSha256: codexSha256 ?? null,
      codexModelId: codexModel ?? null,
      codexTimeoutMs:
        codexExecutable && codexSha256 && codexModel
          ? codexTimeoutMs
          : null,
      codexMaxOutputBytes:
        codexExecutable && codexSha256 && codexModel
          ? codexMaxOutputBytes
          : null,
      codexEngineProfileId: hybridCLevelCanary
        ? "codex-cli-c-level"
        : null,
      codeSandboxId: hasCodeTasks
        ? "windows-sandbox-protected-client"
        : null,
      codeSandboxProvenanceHash: codeProvenanceHash,
      codeSandboxLauncherCommitment,
      codeSandboxLauncherAttestation,
    },
  });

  if (!has(args, "--live")) {
    if (has(args, "--json")) {
      writeJsonEnvelope("evaluate-workflow plan", plan);
    } else {
      printApprovalExplanation([
        ["What you are deciding", `Run ${plan.plannedTrajectories} test runs to compare ways of organizing model work.`],
        ["Why", "Measure how these model setups perform on the selected test tasks before relying on them."],
        ["If you approve", "The live command will call the configured models and save local test results. Code tasks also run generated code in the configured sandbox."],
        ["Cost and data", "Live calls can consume paid service or account limits and send test inputs to the selected providers. The total money cost is unknown; review the exact run and feedback limits below."],
        ["What is confirmed", "This preview lists the test tasks, model bindings, and limits. No model was called by this preview."],
        ["Risks and unknowns", "Tests can fail or stop early. Passing these tasks does not prove that the setup is safe or reliable for all real work."],
        ["If you decline or wait", "Do not add --live and the approval hash. The test will not start."],
        ["Undo limits", "Stopping future calls does not refund completed calls or retract data already sent to a provider. Saved results do not undo code execution effects."],
      ]);
      console.log(
        `Workflow study plan ${plan.studyId}: ${plan.tasks.length} tasks × ${plan.conditions.length} conditions = ${plan.plannedTrajectories} trajectories.`,
      );
      console.log(
        `Checkpoint: ${plan.boundedCheckpointFeedbackRounds} feedback directives; convergence cap: ${plan.maximumFeedbackRoundsPerTrajectory}.`,
      );
      console.log(
        "No model was called. Bind --engine-id, --codex-executable, --codex-sha256, and --codex-model; then approve the exact plan hash with --approve before adding --live.",
      );
      console.log(`Approval token: ${plan.planHash}`);
      for (const task of plan.tasks) {
        console.log(`- ${task.id} | ${task.family} | ${task.difficulty}`);
      }
    }
    return 0;
  }

  if (selectors === 0) {
    throw new Error(
      "A live workflow study requires --fixture, --full, --artifacts-only, or --code-only.",
    );
  }
  if (
    (has(args, "--full") || artifactOnly || codeOnly) &&
    !has(args, "--acknowledge-large-run")
  ) {
    throw new Error(
      "The full study can make many local/provider calls. Repeat with --acknowledge-large-run.",
    );
  }
  if (!engineId || !codexExecutable || !codexSha256 || !codexModel) {
    throw new Error(
      "Live workflow evaluation requires --engine-id ID, --codex-executable ABSOLUTE_PATH, --codex-sha256 SHA256, and --codex-model MODEL.",
    );
  }
  if (!plan.liveReady) {
    throw new Error(
      "The selected runtime profile must record an explicit model id before live evaluation.",
    );
  }
  if (option(args, "--approve") !== plan.planHash) {
    throw new Error(
      `Live workflow evaluation requires --approve ${plan.planHash}.`,
    );
  }
  const engine = configuredEngine(
    runtime!,
    target,
    engineId,
  );
  const codex = new CodexCliFeedbackProvider({
    executablePath: codexExecutable,
    executableSha256: codexSha256,
    model: codexModel,
    timeoutMs: codexTimeoutMs,
    maxOutputBytes: codexMaxOutputBytes,
  });
  const cLevelEngine = hybridCLevelCanary
    ? new CodexExecModelEngine({
        profileId: "codex-cli-c-level",
        executablePath: codexExecutable,
        executableSha256: codexSha256,
        model: codexModel,
        timeoutMs: codexTimeoutMs,
        maxOutputBytes: codexMaxOutputBytes,
      })
    : undefined;
  const codeSandbox = codeProvenance
    ? {
        backend: new WindowsSandboxCodeBackend({
          provenance: codeProvenance,
          runtimeExecutable: codeRuntimeExecutable,
          wsbExecutable: codeSandboxLauncherExecutable,
          ...(codeSandboxLauncherSha256
            ? { wsbExecutableSha256: codeSandboxLauncherSha256 }
            : {}),
        }),
        provenanceHash: codeProvenanceHash!,
        launcherCommitment: codeSandboxLauncherCommitment!,
        launcherAttestation: codeSandboxLauncherAttestation!,
      }
    : undefined;
  const output = join(
    statePaths(target).exports,
    `${plan.studyId}.json`,
  );
  const restartRequested = has(args, "--restart-checkpoint");
  const evaluationBase = join(statePaths(target).root, "evaluations");
  const lock = acquireWorkflowStudyLock({
    path: join(evaluationBase, `${plan.studyId}.lock`),
    planHash: plan.planHash,
    recoverStale: restartRequested,
  });
  let retainStudyLock = false;
  const studyAbort = new AbortController();
  const cancelStudy = (source: "SIGINT" | "SIGTERM"): void => {
    if (!studyAbort.signal.aborted) {
      studyAbort.abort(new Error(`WORKFLOW_STUDY_CANCELED_${source}`));
    }
  };
  const onStudySigint = (): void => cancelStudy("SIGINT");
  const onStudySigterm = (): void => cancelStudy("SIGTERM");
  process.once("SIGINT", onStudySigint);
  process.once("SIGTERM", onStudySigterm);
  try {
    if (existsSync(output)) {
      if (!restartRequested) {
        throw new Error(`Workflow study output already exists: ${output}`);
      }
      assertRestartableWorkflowCheckpoint(output, plan.planHash);
    }
    if (codeSandbox) {
      await preflightCodeWorkflowSandbox(
        codeSandbox.backend,
        studyAbort.signal,
      );
    }
    const restarting =
      restartRequested && (existsSync(output) || lock.recoveredStale);
    if (existsSync(output)) {
      renameSync(output, `${output}.abandoned-${randomUUID()}`);
    }
    const evaluationRoot = join(
      evaluationBase,
      restarting
        ? `${plan.studyId}-restart-${randomUUID()}`
        : plan.studyId,
    );
    const evaluationDatabasePath = join(evaluationRoot, "state.db");
    const evaluationArtifactPath = join(evaluationRoot, "artifacts");
    const completedTrials: WorkflowTrajectoryReport[] = [];
    writeWorkflowStudyCheckpoint(output, {
      apiVersion: "chartermesh.dev/collaboration-study-checkpoint/v1alpha1",
      status: "running",
      updatedAt: new Date().toISOString(),
      plan,
      completedTrials,
      evaluationControlPlane: evaluationDatabasePath,
    });
    let report;
    try {
      const evaluationDatabase = openControlPlaneDatabase(
        evaluationDatabasePath,
      );
      const evaluationControlPlane = new ControlPlane(
        evaluationDatabase,
        evaluationArtifactPath,
      );
      try {
        report = await runBoundWorkflowStudy({
          plan,
          taskBindings: tasks,
          limits,
          engine,
          codex,
          ...(cLevelEngine ? { cLevelEngine } : {}),
          ...(codeSandbox ? { codeSandbox } : {}),
          signal: studyAbort.signal,
          persistence: createControlPlaneWorkflowStudyPersistence({
            controlPlane: evaluationControlPlane,
            configuredModelId: configuredModelId!,
            maxChildrenPerTrial: Math.min(1_000, limits.maxModelCalls),
            ...(plan.bindings.codexFeedbackEngineProfileId
              ? {
                  codexFeedbackAccounting: {
                    engineProfileId:
                      plan.bindings.codexFeedbackEngineProfileId,
                    modelId: codexModel,
                  },
                }
              : {}),
          }),
          onTrial(trial) {
            completedTrials.push(trial);
            writeWorkflowStudyCheckpoint(output, {
              apiVersion:
                "chartermesh.dev/collaboration-study-checkpoint/v1alpha1",
              status: "running",
              updatedAt: new Date().toISOString(),
              plan,
              completedTrials,
              evaluationControlPlane: evaluationDatabasePath,
            });
          },
        });
      } finally {
        evaluationDatabase.close();
      }
    } catch (error) {
      retainStudyLock = error instanceof WorkflowAbortSettlementError;
      writeWorkflowStudyCheckpoint(output, {
        apiVersion: "chartermesh.dev/collaboration-study-checkpoint/v1alpha1",
        status: "failed",
        updatedAt: new Date().toISOString(),
        plan,
        completedTrials,
        evaluationControlPlane: evaluationDatabasePath,
        failure: {
          name: error instanceof Error ? error.name : "UnknownError",
          messageHash: createHash("sha256")
            .update(error instanceof Error ? error.message : String(error))
            .digest("hex"),
        },
      });
      throw error;
    }
    writeWorkflowStudyCheckpoint(output, report);
    if (has(args, "--json")) {
      writeJsonEnvelope("evaluate-workflow", {
        output,
        evaluationControlPlane: evaluationDatabasePath,
        report,
      });
    } else {
      const passed = report.trials.filter(
        ({ outcome }) => outcome.status === "passed",
      ).length;
      console.log(
        `Workflow study ${report.studyId}: ${passed}/${report.trials.length} trajectories reached the sealed pass gate.`,
      );
      console.log(`Report: ${output}`);
      console.log(`Evaluation Control Plane: ${evaluationDatabasePath}`);
      for (const item of report.aggregate) {
        console.log(
          `- ${item.conditionId}: checkpoint ${item.passedByCheckpoint}/${item.trials}, final ${item.finalPassed}/${item.trials}, calls ${item.totalModelCalls}`,
        );
      }
    }
    return report.trials.every(({ outcome }) => outcome.status === "passed")
      ? 0
      : 2;
  } catch (error) {
    if (
      error instanceof WorkflowAbortSettlementError ||
      error instanceof SandboxContainmentError
    ) {
      retainStudyLock = true;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onStudySigint);
    process.removeListener("SIGTERM", onStudySigterm);
    if (!retainStudyLock) lock.release();
  }
}

async function evaluateDecisionReviewCommand(
  target: string,
  args: string[],
): Promise<number> {
  const requestedSuite =
    option(args, "--suite") ?? DECISION_REVIEW_BENCHMARK_SUITE_ID;
  if (requestedSuite !== DECISION_REVIEW_BENCHMARK_SUITE_ID) {
    throw new Error(`Unknown decision-review suite '${requestedSuite}'.`);
  }
  const resumeRequested = has(args, "--resume");
  const accountContextOption = option(args, "--account-context");
  if (resumeRequested && !accountContextOption) {
    throw new Error(
      "Decision-review resume requires --account-context same, changed, or unknown.",
    );
  }
  if (!resumeRequested && accountContextOption) {
    throw new Error("--account-context is valid only together with --resume.");
  }
  if (
    accountContextOption &&
    !["same", "changed", "unknown"].includes(accountContextOption)
  ) {
    throw new Error(
      "--account-context must be exactly same, changed, or unknown.",
    );
  }
  const accountContext = accountContextOption as
    | DecisionReviewAccountContext
    | undefined;
  const codexExecutable = option(args, "--codex-executable");
  const codexSha256 = option(args, "--codex-sha256")?.toLowerCase() ?? null;
  const codexModel = option(args, "--codex-model") ?? null;
  const codexTimeoutMs = boundedIntegerOption(
    args,
    "--codex-timeout-ms",
    120_000,
    1_000,
    900_000,
  );
  const codexMaxOutputBytes = boundedIntegerOption(
    args,
    "--codex-max-output-bytes",
    1_048_576,
    1,
    16_777_216,
  );
  const anyReviewerBinding = Boolean(
    codexExecutable || codexSha256 || codexModel,
  );
  const completeReviewerBinding = Boolean(
    codexExecutable && codexSha256 && codexModel,
  );
  if (anyReviewerBinding && !completeReviewerBinding) {
    throw new Error(
      "Bind --codex-executable, --codex-sha256, and --codex-model together.",
    );
  }
  if (resumeRequested && !completeReviewerBinding) {
    throw new Error(
      "Decision-review resume requires the exact original Codex executable, SHA-256, and model binding.",
    );
  }
  const plan = createDecisionReviewEvaluationPlan({
    reviewer: completeReviewerBinding
      ? {
          executableSha256: codexSha256,
          modelId: codexModel,
          timeoutMs: codexTimeoutMs,
          maxOutputBytes: codexMaxOutputBytes,
          engineProfileId: "codex-cli-decision-review",
        }
      : {
          executableSha256: null,
          modelId: null,
          timeoutMs: null,
          maxOutputBytes: null,
          engineProfileId: null,
        },
  });
  const paths = decisionReviewEvaluationPaths(target, plan.benchmarkId);
  let resumePlan: DecisionReviewResumePlan | undefined;
  let dryResumeCheckpoint: DecisionReviewCheckpoint | undefined;
  if (resumeRequested) {
    assertDecisionReviewPathComponents(target, paths.directory);
    assertDecisionReviewPathComponents(target, dirname(paths.output));
    if (existsSync(paths.output)) {
      throw new Error("DECISION_REVIEW_ALREADY_COMPLETED");
    }
    dryResumeCheckpoint = parseDecisionReviewCheckpoint(
      readBoundedRegularJson(
        target,
        paths.checkpoint,
        "DECISION_REVIEW_CHECKPOINT_INVALID",
      ),
    );
    const storedPlan = readBoundedRegularJson(
      target,
      paths.plan,
      "DECISION_REVIEW_PLAN_INVALID",
    );
    if (
      dryResumeCheckpoint.plan.planHash !== plan.planHash ||
      JSON.stringify(storedPlan) !== JSON.stringify(dryResumeCheckpoint.plan)
    ) {
      throw new Error(
        "DECISION_REVIEW_RESUME_BASE_PLAN_MISMATCH: source, model, executable hash, or limits changed",
      );
    }
    resumePlan = createDecisionReviewResumePlan(
      dryResumeCheckpoint,
      accountContext!,
    );
  }

  if (!has(args, "--live")) {
    if (has(args, "--json")) {
      writeJsonEnvelope(
        resumeRequested
          ? "evaluate-decision-review resume-plan"
          : "evaluate-decision-review plan",
        resumePlan ?? plan,
      );
    } else {
      printApprovalExplanation([
        ["What you are deciding", resumePlan
          ? `Continue the paused comparison with ${resumePlan.remainingCount} model calls left; completed scored calls will not be repeated.`
          : `Make ${plan.plannedCalls} model calls to compare two ways of presenting approval information.`],
        ["Why", "Check whether a model spots important facts and risks in the approval information."],
        ["If you approve", "The live command will call the selected Codex model and save local progress and results. It does not approve any real project work."],
        ["Cost and data", "Calls can consume paid service or account limits and send synthetic test inputs to the provider. Total money cost is unknown; each response is limited to 1,024 output tokens (pieces of text)."],
        ["What is confirmed", "This preview has not called a model. Exact test and model settings are bound to the hash below."],
        ["Risks and unknowns", "This tests a model, not people: results do not prove that humans understand the approval information or that the presentation caused an improvement." +
          (resumePlan ? " The account context is what the operator declared; account identity has not been independently verified." : "")],
        ["If you decline or wait", "Do not add --live and the approval hash. No new test calls will start."],
        ["Undo limits", "Stopping future calls cannot refund completed calls or retract test data already sent. A paused run needs its own newly approved resume hash."],
      ]);
      if (resumePlan) {
        console.log(
          `Decision-review resume plan ${resumePlan.benchmarkId}: ${resumePlan.completedCount}/20 scored calls sealed; sequence ${resumePlan.nextSequence} is next.`,
        );
        console.log(
          `Account context: ${resumePlan.accountContext} (operator-declared, not identity-attested). No model was called.`,
        );
        console.log(`Resume approval token: ${resumePlan.resumePlanHash}`);
      } else {
        console.log(
          `Decision-review plan ${plan.benchmarkId}: 10 fixed cases x 2 presentations = ${plan.plannedCalls} stateless calls.`,
        );
        console.log(
          "No model was called. This is a Codex proxy product regression, not human or causal evidence.",
        );
        console.log(`Approval token: ${plan.planHash}`);
      }
    }
    return 0;
  }
  if (!completeReviewerBinding || !codexExecutable || !plan.liveReady) {
    throw new Error(
      "Live decision review requires --codex-executable ABSOLUTE_PATH, --codex-sha256 SHA256, and --codex-model MODEL.",
    );
  }
  const approvalHash = resumePlan?.resumePlanHash ?? plan.planHash;
  if (option(args, "--approve") !== approvalHash) {
    throw new Error(
      `Live decision review requires --approve ${approvalHash}.`,
    );
  }
  if (!resumeRequested) {
    assertDecisionReviewPathComponents(target, paths.directory);
    assertDecisionReviewPathComponents(target, dirname(paths.output));
    if (existsSync(paths.output) || existsSync(paths.directory)) {
      throw new Error(
        "DECISION_REVIEW_STATE_ALREADY_EXISTS: refusing to overwrite an earlier execution",
      );
    }
  }
  ensureDecisionReviewDirectory(target, paths.directory);
  ensureDecisionReviewDirectory(target, dirname(paths.output));
  const lock = acquireWorkflowStudyLock({
    path: paths.lock,
    planHash: approvalHash,
    recoverStale: resumeRequested,
    staleError:
      "DECISION_REVIEW_STALE_LOCK: automatic resume is forbidden because child settlement cannot be proven from a stale lock.",
    ...(resumePlan
      ? {
          authorizeStaleRecovery(owner: {
            planHash?: unknown;
            pid?: unknown;
          }): void {
            const current = parseDecisionReviewCheckpoint(
              readBoundedRegularJson(
                target,
                paths.checkpoint,
                "DECISION_REVIEW_CHECKPOINT_INVALID",
              ),
            );
            const storedPlan = readBoundedRegularJson(
              target,
              paths.plan,
              "DECISION_REVIEW_PLAN_INVALID",
            );
            const expectedLockHashes = new Set([
              current.segments.at(-1)?.authorizationHash,
              resumePlan.resumePlanHash,
            ]);
            if (
              current.status !== "paused" ||
              current.activeInvocation !== null ||
              current.plan.planHash !== plan.planHash ||
              JSON.stringify(storedPlan) !== JSON.stringify(current.plan) ||
              typeof owner.planHash !== "string" ||
              !expectedLockHashes.has(owner.planHash)
            ) {
              throw new Error(
                "DECISION_REVIEW_STALE_LOCK_NOT_SAFE_TO_RECOVER",
              );
            }
            assertDecisionReviewResumePlan(resumePlan, current);
          },
        }
      : {}),
  });
  const abortController = new AbortController();
  const cancel = (source: "SIGINT" | "SIGTERM"): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error(`DECISION_REVIEW_CANCELED_${source}`));
    }
  };
  const onSigint = (): void => cancel("SIGINT");
  const onSigterm = (): void => cancel("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let retainDecisionReviewLock = false;
  let checkpoint: DecisionReviewCheckpoint;
  try {
    if (existsSync(paths.output)) {
      throw new Error("DECISION_REVIEW_ALREADY_COMPLETED");
    }
    if (resumePlan) {
      const current = parseDecisionReviewCheckpoint(
        readBoundedRegularJson(
          target,
          paths.checkpoint,
          "DECISION_REVIEW_CHECKPOINT_INVALID",
        ),
      );
      const storedPlan = readBoundedRegularJson(
        target,
        paths.plan,
        "DECISION_REVIEW_PLAN_INVALID",
      );
      if (
        current.plan.planHash !== plan.planHash ||
        JSON.stringify(storedPlan) !== JSON.stringify(current.plan)
      ) {
        throw new Error("DECISION_REVIEW_RESUME_BASE_PLAN_MISMATCH");
      }
      assertDecisionReviewResumePlan(resumePlan, current);
      ensureDecisionReviewDirectory(target, paths.approvals);
      const receiptPath = join(
        paths.approvals,
        `${resumePlan.resumePlanHash}.json`,
      );
      const receipt = {
        apiVersion:
          "chartermesh.dev/decision-review-used-approval/v1alpha1",
        benchmarkId: plan.benchmarkId,
        basePlanHash: plan.planHash,
        resumePlanHash: resumePlan.resumePlanHash,
        sourceCheckpointHash: resumePlan.sourceCheckpointHash,
        resumeGeneration: resumePlan.resumeGeneration,
      };
      if (existsSync(receiptPath)) {
        const existingReceipt = readBoundedRegularJson(
          target,
          receiptPath,
          "DECISION_REVIEW_USED_APPROVAL_INVALID",
        );
        if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
          throw new Error("DECISION_REVIEW_USED_APPROVAL_CONFLICT");
        }
      } else {
        writeExclusiveJson(target, receiptPath, receipt);
      }
      checkpoint = persistDecisionReviewCheckpoint(
        target,
        paths.checkpoint,
        startDecisionReviewResume(current, resumePlan),
      );
    } else {
      writeExclusiveJson(target, paths.plan, plan);
      checkpoint = persistDecisionReviewCheckpoint(
        target,
        paths.checkpoint,
        createInitialDecisionReviewCheckpoint(plan, plan.planHash),
      );
    }

    let report;
    try {
      const engine = new CodexExecModelEngine({
        profileId: "codex-cli-decision-review",
        executablePath: codexExecutable,
        executableSha256: codexSha256!,
        model: codexModel!,
        timeoutMs: codexTimeoutMs,
        maxOutputBytes: codexMaxOutputBytes,
      });
      await engine.preflightExecutableAttestation();
      const segment = checkpoint.segments.at(-1)!;
      const runSegment: DecisionReviewRunSegment = {
        index: segment.index,
        segmentIdHash: segment.segmentIdHash,
      };
      report = await runDecisionReviewEvaluation({
        plan,
        engine,
        signal: abortController.signal,
        priorTrials: checkpoint.completedTrials,
        segment: runSegment,
        execution: decisionReviewExecutionDisclosure(checkpoint),
        onInvocationStart(record) {
          const expected = createDecisionReviewActiveInvocation(checkpoint);
          if (JSON.stringify(record) !== JSON.stringify(expected)) {
            throw new Error("DECISION_REVIEW_INVOCATION_BINDING_MISMATCH");
          }
          const next = structuredClone(checkpoint);
          next.activeInvocation = structuredClone(record);
          next.processAttempts += 1;
          checkpoint = persistDecisionReviewCheckpoint(
            target,
            paths.checkpoint,
            next,
          );
        },
        onInvocationPause(pause) {
          const expectedSequence =
            checkpoint.plan.schedule[checkpoint.completedTrials.length]
              ?.sequence ?? checkpoint.plan.plannedCalls + 1;
          if (
            pause.sequence !== expectedSequence ||
            pause.segmentIndex !== checkpoint.segments.at(-1)?.index ||
            (pause.reasonCode === "operator_requested"
              ? checkpoint.activeInvocation !== null
              : checkpoint.activeInvocation?.sequence !== pause.sequence)
          ) {
            throw new Error("DECISION_REVIEW_PAUSE_BINDING_MISMATCH");
          }
          const next = structuredClone(checkpoint);
          next.status = "paused";
          next.activeInvocation = null;
          next.pause = {
            reasonCode: pause.reasonCode,
            sequence: pause.sequence,
          };
          next.failure = null;
          next.nonScoringPauses.push(structuredClone(pause));
          checkpoint = persistDecisionReviewCheckpoint(
            target,
            paths.checkpoint,
            next,
          );
        },
        onTrial(trial) {
          if (
            checkpoint.activeInvocation?.sequence !== trial.sequence ||
            checkpoint.activeInvocation.segmentIndex !== trial.segmentIndex ||
            checkpoint.activeInvocation.segmentIdHash !== trial.segmentIdHash
          ) {
            throw new Error("DECISION_REVIEW_TRIAL_BINDING_MISMATCH");
          }
          const next = structuredClone(checkpoint);
          next.completedTrials.push(structuredClone(trial));
          next.completedPrefixHash = decisionReviewCompletedPrefixHash(
            next.plan,
            next.completedTrials,
          );
          next.segments.at(-1)!.completedThroughSequence = trial.sequence;
          next.activeInvocation = null;
          checkpoint = persistDecisionReviewCheckpoint(
            target,
            paths.checkpoint,
            next,
          );
        },
      });
    } catch (error) {
      if (
        error instanceof CodexProxyError &&
        error.code === "CODEX_PROXY_TERMINATION_UNSETTLED"
      ) {
        retainDecisionReviewLock = true;
      }
      if (error instanceof DecisionReviewPauseError) {
        if (
          checkpoint.status !== "paused" ||
          checkpoint.pause?.reasonCode !== error.reasonCode ||
          checkpoint.pause.sequence !== error.sequence ||
          checkpoint.activeInvocation !== null
        ) {
          throw new Error("DECISION_REVIEW_PAUSE_NOT_DURABLE");
        }
        if (has(args, "--json")) {
          writeJsonEnvelope("evaluate-decision-review paused", {
            benchmarkId: plan.benchmarkId,
            status: "paused",
            completedTrials: checkpoint.completedTrials.length,
            nextSequence: error.sequence,
            processAttempts: checkpoint.processAttempts,
            reasonCode: error.reasonCode,
            resumeRequiresNewApproval: true,
          });
        } else {
          console.log(
            `Decision-review benchmark ${plan.benchmarkId} paused safely after ${checkpoint.completedTrials.length}/20 scored calls.`,
          );
          console.log(
            `Next sequence: ${error.sequence}; reason: ${error.reasonCode}. Generate a new --resume plan before continuing.`,
          );
        }
        return 3;
      }
      const next = structuredClone(checkpoint);
      next.status = "failed";
      next.pause = null;
      next.failure = {
        reasonCode: decisionReviewFailureCode(error),
        sequence:
          next.plan.schedule[next.completedTrials.length]?.sequence ??
          next.plan.plannedCalls + 1,
      };
      checkpoint = persistDecisionReviewCheckpoint(
        target,
        paths.checkpoint,
        next,
      );
      throw error;
    }
    if (
      checkpoint.completedTrials.length !== plan.plannedCalls ||
      checkpoint.activeInvocation !== null ||
      report.execution.processAttempts !== checkpoint.processAttempts ||
      JSON.stringify(report.trials) !==
        JSON.stringify(checkpoint.completedTrials)
    ) {
      throw new Error("DECISION_REVIEW_FINALIZATION_MISMATCH");
    }
    writeWorkflowStudyCheckpoint(paths.output, report);
    rmSync(paths.checkpoint, { force: true });
    if (has(args, "--json")) {
      writeJsonEnvelope("evaluate-decision-review", {
        qualityGatePassed: report.gates.packetStrictPass,
        benefitGatePassed: report.gates.demonstratedPilotBenefit,
        exitCodeMeaning: "packet_quality_gate_only",
        report,
      });
    } else {
      const raw = report.aggregate.find(
        ({ presentation }) => presentation === "raw",
      )!;
      const packet = report.aggregate.find(
        ({ presentation }) => presentation === "decision_review",
      )!;
      console.log(
        `Decision-review benchmark ${report.benchmarkId} completed (${report.trials.length}/20 calls accounted).`,
      );
      console.log(
        `- raw: ${raw.exactDecisions}/10 decisions, ${raw.requiredFindings}/20 findings`,
      );
      console.log(
        `- packet: ${packet.exactDecisions}/10 decisions, ${packet.requiredFindings}/20 findings`,
      );
      console.log(
        `Packet quality gate: ${report.gates.packetStrictPass ? "pass" : "fail"}`,
      );
      console.log(
        `Demonstrated fixed-suite pilot benefit: ${report.gates.demonstratedPilotBenefit ? "yes" : "no"}`,
      );
      console.log(`Report: ${paths.output}`);
    }
    return report.gates.packetStrictPass ? 0 : 2;
  } catch (error) {
    if (
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_TERMINATION_UNSETTLED"
    ) {
      retainDecisionReviewLock = true;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!retainDecisionReviewLock) lock.release();
  }
}

function capabilitiesCommand(args: string[]): void {
  const subcommand = args[1] ?? "list";
  if (!["list", "recommend"].includes(subcommand)) {
    throw new Error("capabilities requires list or recommend.");
  }
  const kind = option(args, "--kind");
  const source =
    subcommand === "recommend"
      ? recommendedCapabilities()
      : capabilityCatalog;
  const items = source.filter((entry) => !kind || entry.kind === kind);
  if (has(args, "--json")) {
    writeJsonEnvelope(`capabilities ${subcommand}`, { items });
    return;
  }
  for (const item of items) {
    console.log(
      `${item.id} | ${item.kind} | ${item.disposition} | ` +
        `${item.defaultEnabled ? "enabled" : "disabled"}`,
    );
    console.log(`  ${item.rationale}`);
    console.log(`  source: ${item.source} (${item.license})`);
  }
}

function skillsCommand(args: string[]): void {
  const subcommand = args[1] ?? "list";
  const documents = portableSkillDocuments();
  if (subcommand === "list") {
    const items = documents.map(({ id, relativePath }) => ({
      id,
      relativePath,
      bundled: true,
      license: "Apache-2.0",
    }));
    if (has(args, "--json")) writeJsonEnvelope("skills list", { items });
    else {
      for (const item of items) {
        console.log(`${item.id} | ${item.relativePath} | Apache-2.0`);
      }
    }
    return;
  }
  if (subcommand !== "show") {
    throw new Error("skills requires list or show.");
  }
  const id = option(args, "--id");
  const document = documents.find((item) => item.id === id);
  if (!document) throw new Error(`Unknown bundled skill '${id ?? ""}'.`);
  if (has(args, "--json")) writeJsonEnvelope("skills show", document);
  else console.log(document.content);
}

function help(): void {
  console.log(`CharterMesh CLI

The same safe flow is used by humans, Codex, Claude, and other coding agents:
inspect -> plan -> approve exact hash -> apply -> doctor -> run -> review.

Commands:
  chartermesh version [--target PATH] [--check] [--json]
  chartermesh propose --target PATH [--profile lean|balanced|controlled] \
    [--team-template general|software-product|research|content-production|data-analysis|operations] [--json]
  chartermesh bootstrap --target PATH [--profile lean|balanced|controlled] [--engine fake] \
    [--team-template TEMPLATE] [--json]
  chartermesh kickoff --target PATH --brief-file PATH [--title TEXT] \
    [--team-template TEMPLATE] [--profile lean|balanced|controlled] \
    [--acceptance TEXT] [--role operator] \
    [--execution-target TARGET] [--priority 70] [--engine fake] [--json]
  chartermesh kickoff ... --host codex|claude \
    --executable-sha256 SHA256 [--executable ABSOLUTE_PATH] [--host-arg ARG] \
    [--max-agents 4] [--bridge-command COMMAND --bridge-arg ARG] \
    [--allow-unrestricted-read]
  chartermesh kickoff ... --approve PLAN_HASH
  chartermesh bootstrap --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME] \\
    [--structured-output prompt|json-schema] [--tool-calling] \\
    [--reasoning default|disabled] \\
    [--max-response-bytes 8388608] \\
    [--input-price-per-million USD --output-price-per-million USD]
  chartermesh bootstrap --target PATH --engine command-process \\
    --command ABSOLUTE_EXECUTABLE [--command-arg ARG] [--model LABEL] \\
    [--pass-env ENV_NAME] [--timeout-ms 60000] \\
    [--input-price-per-million USD --output-price-per-million USD]
  chartermesh bootstrap ... --approve PLAN_HASH
  chartermesh configure-engine --target PATH --engine fake
  chartermesh configure-engine --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME]
  chartermesh configure-engine --target PATH --engine command-process \\
    --command ABSOLUTE_EXECUTABLE [--command-arg ARG] [--pass-env ENV_NAME]
  chartermesh configure-engine ... --approve PLAN_HASH
  chartermesh project-config --target PATH [--json]
  chartermesh configure-project --target PATH [--preferences-file PATH] [--organization-file PATH] [--json]
    [--host codex|claude --executable-sha256 SHA256] [--executable ABSOLUTE_PATH]
    [--host-arg ARG] [--allow-unrestricted-read]
  chartermesh configure-project ... --approve PLAN_HASH
  chartermesh host doctor --host codex|claude [--target PATH] [--direct]
    [--executable ABSOLUTE_PATH]
    [--host-arg ARG]
    [--executable-sha256 SHA256] [--expected-version VERSION]
    [--capability-snapshot-sha256 SHA256] [--json]
  chartermesh configure-host --target PATH --host codex|claude \
    [--executable ABSOLUTE_PATH] [--host-arg ARG] [--max-agents 4]
    [--executable-sha256 SHA256] [--expected-version VERSION]
    [--capability-snapshot-sha256 SHA256] [--json]
    [--allow-unrestricted-read] [--activate-role ROLE] [--model MODEL]
    [--reasoning-effort medium] [--pass-env ENV_NAME] [--timeout-ms 600000]
    [--bridge-command COMMAND --bridge-arg ARG]
  chartermesh configure-host ... --approve PLAN_HASH
  chartermesh mcp serve (--target PATH | --find-project-root)
    [--actor host:codex] [--role ROLE] [--execution-target TARGET]
  chartermesh doctor --target PATH [--json]
  chartermesh recover --target PATH [--json]
  chartermesh audit export --target PATH [--output RELATIVE_PATH] [--json]
  chartermesh backup create --target PATH [--json]
  chartermesh backup list --target PATH [--json]
  chartermesh restore --backup BACKUP_ID --target PATH
  chartermesh restore ... --approve PLAN_HASH
  chartermesh system status --target PATH [--json]
  chartermesh system pause --reason TEXT --target PATH
  chartermesh system resume --target PATH
  chartermesh seed-demo --target PATH
  chartermesh request "work title" --target PATH
    [--summary TEXT | --summary-base64 BASE64] [--decision-question TEXT]
    [--acceptance TEXT] [--require-tool TOOL] [--json]
  chartermesh triage --id WORK --role ROLE --target PATH [--json]
  chartermesh list --target PATH [--json] [--limit N --cursor CURSOR]
    [--active-only] [--include-archived]
  chartermesh run --id WORK --target PATH [--delegated] [--json]
  chartermesh cancel --id WORK --target PATH [--json]
  chartermesh archive --id WORK --target PATH [--json]
  chartermesh wait --id WORK --type user_input --reason TEXT --target PATH
  chartermesh provide-input --id WORK --packet-hash SHA256 --response TEXT --target PATH
  chartermesh resume --id WORK --target PATH
  chartermesh retry --id WORK --target PATH [--acknowledge-tool-outcome]
  chartermesh decision-packet --id WORK --target PATH [--json]
  chartermesh approve-tool --id WORK --call-hash SHA256 --tool TOOL \\
    --packet-hash SHA256 --note TEXT --target PATH
  chartermesh deny-tool --id WORK --call-hash SHA256 --tool TOOL \\
    --packet-hash SHA256 --note TEXT --target PATH
  chartermesh tool-evidence --id WORK --target PATH [--json]
  chartermesh decide --id WORK --decision approve --artifact-hash SHA256 \\
    --packet-hash SHA256 --note TEXT --target PATH
  chartermesh complete --id WORK --target PATH
  chartermesh outbox list --target PATH [--dead-letters] [--limit N] [--json]
  chartermesh outbox retry --id DELIVERY --target PATH [--json]
  chartermesh scheduler tick --target PATH [--now ISO_TIME] [--json]
  chartermesh scheduler list --target PATH [--schedule ID] [--json]
  chartermesh scheduler watch --target PATH [--poll-ms 30000] [--json]
  chartermesh evaluate-model --target PATH --live [--engine-id ID] [--json]
  chartermesh evaluate-collaboration --target PATH --live [--engine-id ID] [--reviewer-engine-id ID] [--fixture ID]
    [--engine-id ID] [--repetitions 1] [--json]
  chartermesh evaluate-workflow --target PATH
    [--fixture ID | --full | --artifacts-only | --code-only]
    [--hybrid-c-level-canary]
    [--checkpoint-feedback-rounds 10] [--max-feedback-rounds 50]
    [--max-model-calls 512] [--max-total-tokens N]
    [--max-consecutive-contract-invalid-submissions 3]
    [--max-wall-clock-minutes 480] [--max-parallel-agents 1] [--json]
    [--code-runtime-executable ABSOLUTE_PATH] [--wsb-executable ABSOLUTE_PATH]
  chartermesh evaluate-workflow ... --live --engine-id ID \
    --codex-executable ABSOLUTE_PATH --codex-sha256 SHA256 --codex-model MODEL \
    --approve PLAN_HASH
    [--codex-timeout-ms 120000]
    [--codex-max-output-bytes 1048576]
    [--acknowledge-large-run]
    [--restart-checkpoint]
  chartermesh evaluate-decision-review --target PATH \
    [--suite decision-review-fixed-10-v1] \
    [--codex-executable ABSOLUTE_PATH --codex-sha256 SHA256 \
     --codex-model MODEL] [--json]
  chartermesh evaluate-decision-review ... --live --approve PLAN_HASH \
    [--codex-timeout-ms 120000] [--codex-max-output-bytes 1048576]
  chartermesh evaluate-decision-review ... --resume \
    --account-context same|changed|unknown [--json]
  chartermesh evaluate-decision-review ... --resume \
    --account-context same|changed|unknown --live --approve RESUME_PLAN_HASH
  chartermesh capabilities list|recommend [--kind KIND] [--json]
  chartermesh skills list [--json]
  chartermesh skills show --id SKILL [--json]
  chartermesh dashboard --target PATH [--port 4173]

Bootstrap and configure-engine accept an optional reviewed search endpoint:
  --web-search-searxng URL [--web-search-role operator]
  [--web-search-max-results 8]
Use --disable-web-search in a configure-engine plan to remove it.
Search remains disabled without this option, is OrgSpec allowlisted, and each
exact external query requires Control Plane approval.

Live model calls are opt-in. Credentials are read from the configured
environment-variable name and are never written to CharterMesh files.

kickoff --host reports the observed executable digest and exits before a host
process starts when --executable-sha256 is omitted. Repeat with that digest to
generate the one approval plan.`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0] ?? "help";
  if (command === "help" || has(args, "--help") || has(args, "-h")) {
    help();
    return 0;
  }
  const target = targetOf(args);
  if (command === "propose") {
    printProposal(args);
    return 0;
  }
  if (command === "version") return version(args);
  if (command === "capabilities") {
    capabilitiesCommand(args);
    return 0;
  }
  if (command === "skills") {
    skillsCommand(args);
    return 0;
  }
  if (command === "bootstrap") {
    const resumed = approvedOperationPlan(args, "bootstrap");
    if (!resumed) assertNoUnfinishedApplyOperation(target);
    await applyBootstrap(args, resumed ?? bootstrapPlan(args));
    return 0;
  }
  if (command === "kickoff") {
    const resumed = approvedOperationPlan(args, "kickoff");
    if (!resumed) assertNoUnfinishedApplyOperation(target);
    await applyBootstrap(args, resumed ?? await kickoffPlan(args));
    return 0;
  }
  if (command === "configure-engine") {
    const resumed = approvedOperationPlan(args, "configure-engine");
    if (!resumed) assertNoUnfinishedApplyOperation(target);
    await applyBootstrap(args, resumed ?? runtimePlan(args));
    return 0;
  }
  if (command === "project-config") {
    const config = projectConfiguration(target);
    if (has(args, "--json")) writeJsonEnvelope(command, config);
    else console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  if (command === "configure-project") {
    const resumed = approvedOperationPlan(args, "configure-project");
    if (!resumed) assertNoUnfinishedApplyOperation(target);
    await applyProjectConfiguration(args, resumed ?? await configureProjectPlan(args));
    return 0;
  }
  if (command === "host") {
    if ((args[1] ?? "doctor") !== "doctor") {
      throw new Error("host requires doctor.");
    }
    return hostDoctorCommand(target, args);
  }
  if (command === "configure-host") {
    const resumed = approvedOperationPlan(args, "configure-host");
    if (!resumed) assertNoUnfinishedApplyOperation(target);
    await applyBootstrap(args, resumed ?? await configureHostPlan(args));
    return 0;
  }
  if (command === "mcp") {
    if (args[1] !== "serve") throw new Error("mcp requires serve.");
    const mcpTarget = has(args, "--find-project-root")
      ? discoverMcpProjectRoot()
      : target;
    await runControlPlaneMcpStdio({
      target: mcpTarget,
      ...(option(args, "--actor") ? { actor: option(args, "--actor") } : {}),
      allowedRoles: options(args, "--role"),
      allowedExecutionTargets: options(args, "--execution-target"),
    });
    return 0;
  }
  if (command === "doctor") return doctor(target, args);
  if (command === "recover") {
    recover(target, args);
    return 0;
  }
  if (command === "audit") {
    exportAudit(target, args);
    return 0;
  }
  if (command === "backup") {
    backupCommand(target, args);
    return 0;
  }
  if (command === "restore") {
    restoreControlPlane(target, args);
    return 0;
  }
  if (command === "system") {
    systemCommand(target, args);
    return 0;
  }
  if (command === "seed-demo") {
    seedDemo(target);
    return 0;
  }
  if (command === "request") {
    requestWork(target, args);
    return 0;
  }
  if (command === "triage") {
    triageWork(target, args);
    return 0;
  }
  if (command === "list") {
    printItems(target, args);
    return 0;
  }
  if (command === "run") {
    await runWork(target, option(args, "--id"), {
      json: has(args, "--json"),
      delegated: has(args, "--delegated"),
    });
    return 0;
  }
  if (command === "cancel") {
    cancelWork(target, args);
    return 0;
  }
  if (command === "archive") {
    archiveWork(target, args);
    return 0;
  }
  if (command === "wait") {
    waitWork(target, args);
    return 0;
  }
  if (command === "resume") {
    resumeWork(target, args);
    return 0;
  }
  if (command === "provide-input") {
    provideUserInput(target, args);
    return 0;
  }
  if (command === "retry") {
    retryWork(target, args);
    return 0;
  }
  if (command === "approve-tool") {
    approveTool(target, args);
    return 0;
  }
  if (command === "deny-tool") {
    denyTool(target, args);
    return 0;
  }
  if (command === "decision-packet") {
    printDecisionPacket(target, args);
    return 0;
  }
  if (command === "tool-evidence") {
    printToolEvidence(target, args);
    return 0;
  }
  if (command === "decide") {
    decideWork(target, args);
    return 0;
  }
  if (command === "complete") {
    completeWork(target, args);
    return 0;
  }
  if (command === "outbox") {
    outboxCommand(target, args);
    return 0;
  }
  if (command === "scheduler") {
    await schedulerCommand(target, args);
    return 0;
  }
  if (command === "evaluate-model") {
    return evaluateModel(target, args);
  }
  if (command === "evaluate-collaboration") {
    return evaluateCollaborationCommand(target, args);
  }
  if (command === "evaluate-workflow") {
    return evaluateWorkflowCommand(target, args);
  }
  if (command === "evaluate-decision-review") {
    return evaluateDecisionReviewCommand(target, args);
  }
  if (command === "dashboard") {
    const { startDashboard } = await import("../../dashboard/src/server.ts");
    await startDashboard({
      target,
      port: Number(option(args, "--port") ?? 4173),
      open: has(args, "--open"),
    });
    return 0;
  }
  throw new Error(`Unknown command '${command}'. Run 'chartermesh help'.`);
}

const isEntryPoint =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  const invocationArgs = process.argv.slice(2);
  main(invocationArgs).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (has(invocationArgs, "--json")) {
        writeJsonEnvelope(invocationArgs[0] ?? "unknown", { message }, false);
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    },
  );
}
