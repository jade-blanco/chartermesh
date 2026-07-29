#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeModelEngine } from "../../../adapters/model-engines/fake/src/index.ts";
import {
  OpenAICompatibleModelEngine,
  validateOpenAICompatibleConfig,
  type OpenAICompatibleConfig,
} from "../../../adapters/model-engines/openai-compatible/src/index.ts";
import {
  ControlPlane,
  openControlPlaneDatabase,
  type WaitCondition,
} from "../../../packages/control-plane/src/index.ts";
import {
  parseOrgSpec,
  sha256,
} from "../../../packages/orgspec/src/index.ts";
import { BuiltInManagedRunner } from "../../../packages/runtime/src/index.ts";
import {
  createProposal,
  type OrganizationProposal,
  type ProposalProfile,
} from "./proposal.ts";
import { evaluateModelEngine } from "./evaluate-model.ts";

const CLI_API_VERSION = "chartermesh.dev/cli/v1alpha1";
const CHARTERMESH_VERSION = "0.0.2-alpha.1";

interface RuntimeConfig {
  apiVersion: "chartermesh.dev/runtime/v1alpha1";
  modelEngines: Array<
    | { id: string; adapter: "fake" }
    | ({
        adapter: "openai-compatible";
      } & OpenAICompatibleConfig)
  >;
  managedRunners: Array<{
    id: string;
    adapter: "builtin-managed-runner";
    modelEngineRef: string;
  }>;
}

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
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
}

function configuredEngine(config: RuntimeConfig, engineId?: string) {
  const profile = engineId
    ? config.modelEngines.find(({ id }) => id === engineId)
    : config.modelEngines[0];
  if (!profile) throw new Error(`Unknown model engine '${engineId}'.`);
  if (profile.adapter === "fake") return new FakeModelEngine();
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

function proposalFor(args: string[]): OrganizationProposal {
  return createProposal(targetOf(args), profileOf(args));
}

function runtimeTemplate(args: string[]): RuntimeConfig {
  const adapter = option(args, "--engine") ?? "fake";
  if (adapter === "fake") {
    return {
      apiVersion: "chartermesh.dev/runtime/v1alpha1",
      modelEngines: [{ id: "primary-model", adapter: "fake" }],
      managedRunners: [
        {
          id: "local-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "primary-model",
        },
      ],
    };
  }
  if (adapter !== "openai-compatible") {
    throw new Error("--engine must be fake or openai-compatible.");
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
  return {
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
        structuredOutputMode: structuredOutputMode as
          | "prompt"
          | "json-schema",
        ...(has(args, "--tool-calling") ? { toolCalling: true } : {}),
        reasoningMode: reasoningMode as "default" | "disabled",
      },
    ],
    managedRunners: [
      {
        id: "local-runner",
        adapter: "builtin-managed-runner",
        modelEngineRef: "primary-model",
      },
    ],
  };
}

function bootstrapPlan(args: string[]): BootstrapPlan {
  const target = targetOf(args);
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
        "dashboard.port",
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
        "- Credentials are read only from the environment variable named in `runtime.json`.",
        "- Run `chartermesh doctor --target .` before live model use.",
        "",
      ].join("\n"),
    },
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
  if (!existsSync(statePaths(target).organization)) {
    throw new Error("CharterMesh is not initialized. Run bootstrap first.");
  }
  const runtime = runtimeTemplate(args);
  const path = statePaths(target).runtime;
  const content = `${JSON.stringify(runtime, null, 2)}\n`;
  const files = [
    {
      path,
      content,
      beforeHash: existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    },
  ];
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
  for (const file of plan.files) {
    if (file.beforeHash === null && existsSync(file.path)) {
      throw new Error(`Target changed after planning: '${file.path}' now exists.`);
    }
    if (file.beforeHash !== null) {
      if (!existsSync(file.path)) {
        throw new Error(`Target changed after planning: '${file.path}' was removed.`);
      }
      const current = createHash("sha256").update(readFileSync(file.path)).digest("hex");
      if (current !== file.beforeHash) {
        throw new Error(`Target changed after planning: '${file.path}'.`);
      }
    }
  }
  const changed = plan.files.filter(
    ({ beforeHash, afterHash }) => beforeHash !== afterHash,
  );
  const stageDirectory = join(
    statePaths(plan.target).root,
    `.apply-${plan.planHash.slice(0, 16)}`,
  );
  const staged = changed.map((file, index) => ({
    file,
    nextPath: join(stageDirectory, `${index}.next`),
    backupPath: join(stageDirectory, `${index}.before`),
  }));
  const applied: typeof staged = [];
  mkdirSync(stageDirectory, { recursive: true });
  try {
    for (const entry of staged) {
      writeFileSync(entry.nextPath, entry.file.content, {
        encoding: "utf8",
        flag: "wx",
      });
      const stagedHash = createHash("sha256")
        .update(readFileSync(entry.nextPath))
        .digest("hex");
      if (stagedHash !== entry.file.afterHash) {
        throw new Error(`Staged content hash mismatch for '${entry.file.path}'.`);
      }
    }
    writeFileSync(
      join(stageDirectory, "journal.json"),
      `${JSON.stringify(
        {
          apiVersion: "chartermesh.dev/apply-journal/v1alpha1",
          planHash: plan.planHash,
          files: staged.map(({ file, nextPath, backupPath }) => ({
            target: file.path,
            nextPath,
            backupPath: file.beforeHash === null ? null : backupPath,
          })),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    for (const entry of staged) {
      mkdirSync(dirname(entry.file.path), { recursive: true });
      if (entry.file.beforeHash !== null) {
        renameSync(entry.file.path, entry.backupPath);
      }
      try {
        renameSync(entry.nextPath, entry.file.path);
      } catch (error) {
        if (
          entry.file.beforeHash !== null &&
          existsSync(entry.backupPath) &&
          !existsSync(entry.file.path)
        ) {
          renameSync(entry.backupPath, entry.file.path);
        }
        throw error;
      }
      applied.push(entry);
    }
    const { database } = controlPlaneFor(plan.target);
    database.close();
  } catch (error) {
    for (const entry of [...applied].reverse()) {
      if (existsSync(entry.file.path)) {
        rmSync(entry.file.path, { force: true });
      }
      if (entry.file.beforeHash !== null && existsSync(entry.backupPath)) {
        renameSync(entry.backupPath, entry.file.path);
      }
    }
    throw error;
  } finally {
    rmSync(stageDirectory, { recursive: true, force: true });
  }
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
  const issues: string[] = [];
  const paths = statePaths(target);
  if (!existsSync(paths.organization)) {
    issues.push("organization.json is missing");
  } else {
    try {
      parseOrgSpec(readFileSync(paths.organization, "utf8"));
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
    const runtime = readRuntime(target);
    for (const engine of runtime.modelEngines) {
      if (engine.adapter === "openai-compatible") {
        issues.push(...validateOpenAICompatibleConfig(engine));
      }
    }
  }
  const result = {
    version: CHARTERMESH_VERSION,
    node: process.version,
    target,
    controlPlane: existsSync(paths.database) ? "ready" : "not_initialized",
    runtimeConfiguration: issues.length === 0 ? "ready" : "attention_required",
    issues,
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

export interface RunWorkResult {
  workItemId: string;
  artifactId: string;
  sha256: string;
  generation: number;
}

export async function runWork(
  target: string,
  id?: string,
  options: { quiet?: boolean; json?: boolean } = {},
): Promise<RunWorkResult> {
  const runtime = readRuntime(target);
  const { database, controlPlane } = controlPlaneFor(target);
  let heartbeat: NodeJS.Timeout | undefined;
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
    claim = controlPlane.claim({
      id: candidate.id,
      actor: "runner:local",
      idempotencyKey: `cli:claim:${candidate.id}:${randomUUID()}`,
    });
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
    try {
      const engine = configuredEngine(runtime);
      const runner = new BuiltInManagedRunner();
      const handle = await runner.start(
        {
          taskPacket: {
            objective: candidate.title,
            context: candidate.summary,
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
        },
        { engine },
      );
      const result = await runner.result(handle.hostRunId);
      controlPlane.recordInvocation({
        attemptId: claim.attemptId,
        engineId: engine.manifest.profileId,
        modelId:
          "config" in engine && engine.config?.model
            ? String(engine.config.model)
            : "deterministic-fixture",
        status: "succeeded",
        inputTokens: result.inference.usage.inputTokens,
        outputTokens: result.inference.usage.outputTokens,
        cost: result.inference.usage.cost,
        measurementStatus: result.inference.usage.measurementStatus,
      });
      const submission = controlPlane.submitArtifact({
        id: candidate.id,
        content: result.inference.text,
        generation: claim.generation,
        actor: "runner:local",
        idempotencyKey: `cli:submit:${candidate.id}:${claim.generation}`,
      });
      const runResult = {
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
      const configured = runtime.modelEngines[0];
      controlPlane.recordInvocation({
        attemptId: claim.attemptId,
        engineId: configured?.id ?? "unknown-engine",
        modelId:
          configured && "model" in configured
            ? configured.model
            : "deterministic-fixture",
        status: "failed",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        measurementStatus: "unknown",
      });
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorCode = rawMessage.startsWith("STRUCTURED_ARTIFACT_INVALID")
        ? "STRUCTURED_ARTIFACT_INVALID"
        : rawMessage.toLowerCase().includes("abort")
          ? "RUN_CANCELED"
          : "MODEL_INVOCATION_FAILED";
      controlPlane.failRun({
        id: candidate.id,
        generation: claim.generation,
        attemptId: claim.attemptId,
        errorCode,
        errorMessage:
          errorCode === "STRUCTURED_ARTIFACT_INVALID"
            ? "The model did not return a valid structured artifact."
            : errorCode === "RUN_CANCELED"
              ? "The model invocation was canceled."
              : "The configured model invocation failed.",
        actor: "runner:local",
        idempotencyKey: `cli:fail:${candidate.id}:${claim.generation}`,
      });
      throw error;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    database.close();
  }
}

function printItems(target: string, args: string[]): void {
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const items = controlPlane.list();
    if (has(args, "--json")) {
      writeJsonEnvelope("list", { items });
      return;
    }
    for (const item of items) {
      console.log(
        `${item.id} | ${item.status} | ${item.availability} | ${item.ownerRole} | ${item.title}`,
      );
    }
  } finally {
    database.close();
  }
}

function requestWork(target: string, args: string[]): void {
  const title = option(args, "--title") ?? args.filter((arg) => !arg.startsWith("--"))[1];
  const summary = option(args, "--summary") ?? title;
  if (!title || !summary) {
    throw new Error("request requires a title or --title and --summary.");
  }
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    const item = controlPlane.intake({
      title,
      summary,
      actor: "human:cli",
      idempotencyKey: option(args, "--idempotency-key") ?? randomUUID(),
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

async function evaluateModel(target: string, args: string[]): Promise<number> {
  if (!has(args, "--live")) {
    throw new Error(
      "evaluate-model starts real model inference. Repeat with --live to opt in.",
    );
  }
  const runtime = readRuntime(target);
  const engine = configuredEngine(runtime, option(args, "--engine-id"));
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

function help(): void {
  console.log(`CharterMesh CLI

The same safe flow is used by humans, Codex, Claude, and other coding agents:
inspect -> plan -> approve exact hash -> apply -> doctor -> run -> review.

Commands:
  chartermesh propose --target PATH [--profile lean|balanced|controlled] [--json]
  chartermesh bootstrap --target PATH [--profile balanced] [--engine fake] [--json]
  chartermesh bootstrap --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME] \\
    [--structured-output prompt|json-schema] [--tool-calling] \\
    [--reasoning default|disabled]
  chartermesh bootstrap ... --approve PLAN_HASH
  chartermesh configure-engine --target PATH --engine fake
  chartermesh configure-engine --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME]
  chartermesh configure-engine ... --approve PLAN_HASH
  chartermesh doctor --target PATH [--json]
  chartermesh seed-demo --target PATH
  chartermesh request "work title" --target PATH [--json]
  chartermesh triage --id WORK --role ROLE --target PATH [--json]
  chartermesh list --target PATH [--json]
  chartermesh run --id WORK --target PATH [--json]
  chartermesh wait --id WORK --type user_input --reason TEXT --target PATH
  chartermesh resume --id WORK --target PATH
  chartermesh retry --id WORK --target PATH
  chartermesh decide --id WORK --decision approve --artifact-hash SHA256 \\
    --note TEXT --target PATH
  chartermesh complete --id WORK --target PATH
  chartermesh evaluate-model --target PATH --live [--engine-id ID] [--json]
  chartermesh dashboard --target PATH [--port 4173]

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
  if (command === "bootstrap") {
    applyBootstrap(args, bootstrapPlan(args));
    return 0;
  }
  if (command === "configure-engine") {
    applyBootstrap(args, runtimePlan(args));
    return 0;
  }
  if (command === "doctor") return doctor(target, args);
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
    await runWork(target, option(args, "--id"), { json: has(args, "--json") });
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
  if (command === "decide") {
    decideWork(target, args);
    return 0;
  }
  if (command === "complete") {
    completeWork(target, args);
    return 0;
  }
  if (command === "evaluate-model") {
    return evaluateModel(target, args);
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
