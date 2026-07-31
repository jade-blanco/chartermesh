#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  ControlPlane,
  acquireMaintenanceLock,
  createControlPlaneBackup,
  listControlPlaneBackups,
  openControlPlaneDatabase,
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
  recoverFileTransactions,
} from "../../../packages/compiler/src/index.ts";
import {
  BuiltInManagedRunner,
  DelegationController,
  ToolApprovalRequiredError,
  capabilityCatalog,
  createWorkspaceToolRuntime,
  createWebSearchTools,
  evaluateIntervalSchedule,
  parseRuntimeConfig,
  portableAgentEntrypoint,
  portableSkillDocuments,
  recommendedCapabilities,
  validateWebSearchConfig,
  type RuntimeConfig,
  type ToolExecutionEvidence,
} from "../../../packages/runtime/src/index.ts";
import {
  createProposal,
  type OrganizationProposal,
  type ProposalProfile,
} from "./proposal.ts";
import { evaluateModelEngine } from "./evaluate-model.ts";
import { evaluateCollaboration } from "./evaluate-collaboration.ts";

const CLI_API_VERSION = "chartermesh.dev/cli/v1alpha1";
const CHARTERMESH_VERSION = "0.0.7-alpha.1";

interface BootstrapFile {
  path: string;
  content: string;
  beforeHash: string | null;
  afterHash: string;
}

interface BootstrapPlan {
  apiVersion: "chartermesh.dev/bootstrap-plan/v1alpha1";
  operation: "bootstrap" | "configure-engine";
  target: string;
  engine: string;
  files: BootstrapFile[];
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

function targetOf(args: string[]): string {
  return resolve(option(args, "--target") ?? process.cwd());
}

function statePaths(target: string) {
  const root = join(target, ".chartermesh");
  return {
    root,
    database: join(root, "state.db"),
    artifacts: join(root, "artifacts"),
    installation: join(root, "installation.json"),
    organization: join(root, "organization.json"),
    proposal: join(root, "proposal.json"),
    runtime: join(root, "runtime.json"),
    exports: join(root, "exports"),
    backups: join(root, "backups"),
    engineWork: join(root, "engine-work"),
  };
}

function controlPlaneFor(target: string) {
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
  if (existsSync(paths.organization)) {
    try {
      const organization = JSON.parse(
        readFileSync(paths.organization, "utf8"),
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
    controlPlane: new ControlPlane(database, paths.artifacts, { budgets }),
  };
}

function readRuntime(target: string): RuntimeConfig {
  const path = statePaths(target).runtime;
  if (!existsSync(path)) {
    throw new Error(
      "Runtime configuration is missing. Run 'chartermesh bootstrap' first.",
    );
  }
  return parseRuntimeConfig(readFileSync(path, "utf8"));
}

function readOrganization(target: string) {
  const path = statePaths(target).organization;
  if (!existsSync(path)) {
    throw new Error(
      "Organization configuration is missing. Run 'chartermesh bootstrap' first.",
    );
  }
  return parseOrgSpec(readFileSync(path, "utf8"));
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

function proposalFor(args: string[]): OrganizationProposal {
  return createProposal(targetOf(args), profileOf(args), {
    webSearch: option(args, "--web-search-searxng") !== undefined,
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

function bootstrapPlan(args: string[]): BootstrapPlan {
  const target = targetOf(args);
  recoverFileTransactions(target);
  const runtime = runtimeTemplate(args);
  const paths = statePaths(target);
  const proposal = proposalFor(args);
  const desired = [
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
        },
        null,
        2,
      )}\n`,
    },
    {
      path: join(paths.root, ".gitignore"),
      content: [
        "state.db",
        "state.db-*",
        "artifacts/",
        "backups/",
        "engine-work/",
        "exports/",
        "dashboard.port",
        ".transactions/",
        ".apply-lock/",
        "",
      ].join("\n"),
    },
    {
      path: join(paths.root, "README.md"),
      content: [
        "# CharterMesh local state",
        "",
        "- `proposal.json`, `organization.json`, and `runtime.json` are reviewable desired configuration.",
        "- `installation.json` pins the CharterMesh version and proposal hashes.",
        "- `state.db` is the local mutable ledger and is ignored by Git.",
        "- `backups/` and `exports/` can contain private operational metadata and are ignored by Git.",
        "- Credentials are read only from the environment variable named in `runtime.json`.",
        "- `AGENT-ENTRYPOINT.md` and `skills/` contain provider-neutral, Apache-2.0 guidance.",
        "- External search is disabled unless `runtime.json` names a reviewed endpoint and OrgSpec allows `web.search`.",
        "- Run `chartermesh doctor --target .` before live model use.",
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

function runtimePlan(args: string[]): BootstrapPlan {
  const target = targetOf(args);
  recoverFileTransactions(target);
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

function printBootstrapPlan(plan: BootstrapPlan, args: string[]): void {
  if (has(args, "--json")) {
    writeJsonEnvelope(plan.operation, {
      applied: false,
      approvalRequired: true,
      ...plan,
    });
    return;
  }
  console.log(`CharterMesh ${plan.operation} plan ${plan.planHash}`);
  console.log(`Target: ${plan.target}`);
  console.log(`Model engine: ${plan.engine}`);
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
    "Repeat the identical bootstrap command and append " +
      `--approve ${plan.planHash}`,
  );
}

function applyBootstrap(args: string[], plan: BootstrapPlan): void {
  const approved = option(args, "--approve");
  if (!approved) {
    printBootstrapPlan(plan, args);
    return;
  }
  if (approved !== plan.planHash) {
    throw new Error("Approval hash does not match the current bootstrap plan.");
  }
  applyFileTransaction(
    plan.target,
    plan.planHash,
    plan.files,
  );
  const { database } = controlPlaneFor(plan.target);
  database.close();
  if (has(args, "--json")) {
    writeJsonEnvelope(plan.operation, {
      applied: true,
      planHash: plan.planHash,
      files: plan.files.map(({ path, beforeHash, afterHash }) => ({
        path,
        beforeHash,
        afterHash,
      })),
    });
    return;
  }
  console.log(`Applied CharterMesh ${plan.operation} plan ${plan.planHash}.`);
  console.log(`Next: chartermesh doctor --target "${plan.target}"`);
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
  const recovered = recoverFileTransactions(target);
  const issues: string[] = [];
  const paths = statePaths(target);
  let organization: ReturnType<typeof readOrganization> | undefined;
  let webSearchConfiguration: "disabled" | "configured" = "disabled";
  if (existsSync(paths.installation)) {
    try {
      const installed = JSON.parse(
        readFileSync(paths.installation, "utf8"),
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
      organization = parseOrgSpec(readFileSync(paths.organization, "utf8"));
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
    recovery: recovered,
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
          JSON.parse(readFileSync(installation, "utf8")) as {
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
        "https://api.github.com/repos/jade-blanco/chartermesh/releases/latest",
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": `chartermesh/${CHARTERMESH_VERSION}`,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      const payload = (await response.json()) as { tag_name?: string };
      latestVersion = payload.tag_name?.replace(/^v/u, "") ?? null;
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
  recoverFileTransactions(target);
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
  options: { quiet?: boolean; json?: boolean; delegated?: boolean } = {},
): Promise<RunWorkResult> {
  const runtime = readRuntime(target);
  const { database, controlPlane } = controlPlaneFor(target);
  let heartbeat: NodeJS.Timeout | undefined;
  let cancellationPoll: NodeJS.Timeout | undefined;
  let invocationId: string | undefined;
  let activeAttemptId: string | undefined;
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
    const engine = configuredEngine(runtime, target);
    const configuredProfile = runtime.modelEngines.find(
      ({ id: engineId }) => engineId === engine.manifest.profileId,
    );
    const costVisibility =
      configuredProfile?.adapter === "fake"
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
    if (options.delegated) {
      const executionTarget = organization.spec.executionTargets.find(
        ({ id: targetId }) => targetId === candidate.executionTarget,
      );
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
      const toolRuntime = createWorkspaceToolRuntime({
        workspaceRoot: target,
        workItemId: candidate.id,
        policy: role.tools,
        additionalTools: createWebSearchTools(runtime.webSearch),
        isApproved: (callHash, toolName) =>
          controlPlane.isToolCallApproved(
            candidate.id,
            callHash,
            toolName,
          ),
        onEvidence: (evidence) => {
          controlPlane.recordToolEvidence({
            evidenceId: evidence.id,
            id: candidate.id,
            runId: claim!.runId,
            attemptId: activeAttemptId ?? claim!.attemptId,
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
        },
      });
      const replayedEvidence: ToolExecutionEvidence[] = [];
      const approvedPending =
        controlPlane.approvedPendingToolCall(candidate.id);
      if (approvedPending) {
        const replay = await toolRuntime.executeApprovedCall(
          {
            id: approvedPending.id,
            name: approvedPending.toolName,
            arguments: approvedPending.arguments,
          },
          { signal: runController.signal },
        );
        replayedEvidence.push(replay.evidence);
        controlPlane.markPendingToolCallExecuted({
          id: candidate.id,
          callHash: approvedPending.callHash,
          actor: "runner:local",
          idempotencyKey:
            `cli:pending-tool-executed:${candidate.id}:${approvedPending.callHash}`,
        });
      }
      const modelId =
        "config" in engine && engine.config?.model
          ? String(engine.config.model)
          : "deterministic-fixture";
      const requiredTools = controlPlane.requiredTools(candidate.id);
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
          ].filter(Boolean).join("\n\n"),
          acceptanceCriteria: [
            "Return a structured artifact suitable for exact-hash review.",
            "Do not claim external side effects.",
            "State checks, risks, next actions, and confidence explicitly.",
          ],
        },
        organizationRevision: 1,
        workItemId: candidate.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        generation: claim.generation,
      };
      let result;
      if (options.delegated) {
        const stageInvocations = new Map<string, string>();
        const controller = new DelegationController();
        result = await controller.run(hostRequest, {
          engine,
          toolRuntime,
          signal: runController.signal,
          lifecycle: {
            startStage({ role: delegatedRole }) {
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
                  engineId: engine.manifest.profileId,
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
        const runner = new BuiltInManagedRunner();
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
        content: result.inference.text,
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
      if (error instanceof ToolApprovalRequiredError && claim) {
        controlPlane.recordPendingToolCall({
          id: candidate.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          callHash: error.callHash,
          toolName: error.toolName,
          arguments: error.call.arguments,
          createdAt: new Date().toISOString(),
          actor: "runner:local",
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
          : rawMessage.startsWith("TOOL_ITERATION_LIMIT")
            ? "TOOL_ITERATION_LIMIT"
            : rawMessage.startsWith("RUN_CANCELED") ||
                rawMessage.toLowerCase().includes("abort") ||
                rawMessage.toLowerCase().includes("canceled")
              ? "RUN_CANCELED"
              : "MODEL_INVOCATION_FAILED";
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
      if (errorCode === "RUN_CANCELED") {
        controlPlane.cancelRun({
          id: candidate.id,
          generation: claim.generation,
          actor: "runner:local",
          idempotencyKey:
            `cli:canceled:${candidate.id}:${claim.generation}`,
        });
      } else {
        controlPlane.failRun({
          id: candidate.id,
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
    const item = controlPlane.intake({
      title,
      summary,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
      requiredTools: options(args, "--require-tool"),
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
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.triage({
      id,
      ownerRole: option(args, "--role") ?? "operator",
      executionTarget: option(args, "--execution-target") ?? "local",
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

function retryWork(target: string, args: string[]): void {
  const id = option(args, "--id");
  if (!id) throw new Error("retry requires --id.");
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.retry({
      id,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
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
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.decide({
      id,
      decision,
      artifactHash,
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
  if (!id || !callHash || !toolName) {
    throw new Error(
      "approve-tool requires --id, --call-hash, and --tool.",
    );
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const approval = controlPlane.approveToolCall({
      id,
      callHash,
      toolName,
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
  const report = await evaluateCollaboration(engine, { repetitions });
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
  chartermesh propose --target PATH [--profile lean|balanced|controlled] [--json]
  chartermesh bootstrap --target PATH [--profile balanced] [--engine fake] [--json]
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
    [--summary TEXT | --summary-base64 BASE64] [--require-tool TOOL] [--json]
  chartermesh triage --id WORK --role ROLE --target PATH [--json]
  chartermesh list --target PATH [--json] [--limit N --cursor CURSOR]
    [--active-only] [--include-archived]
  chartermesh run --id WORK --target PATH [--delegated] [--json]
  chartermesh cancel --id WORK --target PATH [--json]
  chartermesh archive --id WORK --target PATH [--json]
  chartermesh wait --id WORK --type user_input --reason TEXT --target PATH
  chartermesh resume --id WORK --target PATH
  chartermesh retry --id WORK --target PATH
  chartermesh approve-tool --id WORK --call-hash SHA256 --tool TOOL \\
    --note TEXT --target PATH
  chartermesh tool-evidence --id WORK --target PATH [--json]
  chartermesh decide --id WORK --decision approve --artifact-hash SHA256 \\
    --note TEXT --target PATH
  chartermesh complete --id WORK --target PATH
  chartermesh outbox list --target PATH [--dead-letters] [--limit N] [--json]
  chartermesh outbox retry --id DELIVERY --target PATH [--json]
  chartermesh scheduler tick --target PATH [--now ISO_TIME] [--json]
  chartermesh scheduler list --target PATH [--schedule ID] [--json]
  chartermesh scheduler watch --target PATH [--poll-ms 30000] [--json]
  chartermesh evaluate-model --target PATH --live [--engine-id ID] [--json]
  chartermesh evaluate-collaboration --target PATH --live
    [--engine-id ID] [--repetitions 1] [--json]
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
environment-variable name and are never written to CharterMesh files.`);
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
    applyBootstrap(args, bootstrapPlan(args));
    return 0;
  }
  if (command === "configure-engine") {
    applyBootstrap(args, runtimePlan(args));
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
  if (command === "retry") {
    retryWork(target, args);
    return 0;
  }
  if (command === "approve-tool") {
    approveTool(target, args);
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
