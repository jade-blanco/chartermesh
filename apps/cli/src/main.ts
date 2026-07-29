#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import { sha256 } from "../../../packages/orgspec/src/index.ts";
import { BuiltInManagedRunner } from "../../../packages/runtime/src/index.ts";

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

function targetOf(args: string[]): string {
  return resolve(option(args, "--target") ?? process.cwd());
}

function statePaths(target: string) {
  const root = join(target, ".chartermesh");
  return {
    root,
    database: join(root, "state.db"),
    artifacts: join(root, "artifacts"),
    organization: join(root, "organization.json"),
    runtime: join(root, "runtime.json"),
  };
}

function controlPlaneFor(target: string) {
  const paths = statePaths(target);
  const database = openControlPlaneDatabase(paths.database);
  return {
    paths,
    database,
    controlPlane: new ControlPlane(database, paths.artifacts),
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

function organizationTemplate() {
  return {
    apiVersion: "chartermesh.dev/v1alpha1",
    kind: "Organization",
    metadata: {
      id: "local-team",
      name: "Local CharterMesh Team",
      revision: 1,
    },
    spec: {
      mission: "Safely turn user requests into reviewed artifacts.",
      operatingProfile: "balanced",
      budgets: {
        monthlyCostLimitUsd: 25,
        maxConcurrentRuns: 2,
        maxDailyModelStarts: 20,
      },
      modelEngines: [
        {
          id: "primary-model",
          adapter: "configured-at-runtime",
          transport: "embedded",
          enabled: true,
        },
      ],
      agentHosts: [],
      managedRunners: [
        {
          id: "local-runner",
          adapter: "builtin-managed-runner",
          modelEngineRef: "primary-model",
          executionHost: "local",
          enabled: true,
        },
      ],
      executionTargets: [
        {
          id: "local",
          kind: "managed_runner",
          runnerRef: "local-runner",
          enabled: true,
        },
      ],
      roles: [
        {
          id: "operator",
          name: "Operator",
          class: "worker",
          executionMode: "on_demand_ephemeral",
          capabilities: ["artifact_generation"],
          requiredModelCapabilities: ["model.text.generate"],
          execution: { preferred: "local" },
          concurrency: 1,
          tools: { allow: ["work_read", "artifact_write"] },
        },
      ],
      workflows: [
        {
          id: "reviewed-work",
          name: "Reviewed Work",
          trigger: { type: "manual" },
          stages: [
            {
              id: "produce",
              type: "agent",
              role: "operator",
              acceptanceCriteria: [
                "A human-readable artifact is submitted for review.",
              ],
            },
            {
              id: "review",
              type: "approval",
              dependsOn: ["produce"],
              acceptanceCriteria: [
                "A human approves the immutable artifact hash.",
              ],
            },
          ],
        },
      ],
      schedules: [],
      policies: {
        externalSideEffects: "user_approval",
        destructiveActions: "prohibited",
        providerFailover: "same_or_lower_permissions",
        organizationChanges: "user_approval",
        firstRunMode: "read_only",
      },
    },
  };
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
  const desired = [
    {
      path: paths.organization,
      content: `${JSON.stringify(organizationTemplate(), null, 2)}\n`,
    },
    {
      path: paths.runtime,
      content: `${JSON.stringify(runtime, null, 2)}\n`,
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
        "- `organization.json` and `runtime.json` are reviewable desired configuration.",
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

function printBootstrapPlan(plan: BootstrapPlan): void {
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
    printBootstrapPlan(plan);
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
  for (const file of plan.files) {
    if (file.beforeHash === file.afterHash) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, {
      encoding: "utf8",
      flag: file.beforeHash === null ? "wx" : "w",
    });
  }
  const { database } = controlPlaneFor(plan.target);
  database.close();
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

function doctor(target: string): number {
  const issues: string[] = [];
  const paths = statePaths(target);
  if (!existsSync(paths.organization)) {
    issues.push("organization.json is missing");
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
  console.log(`Node: ${process.version}`);
  console.log(`Target: ${target}`);
  console.log(`Control Plane: ${existsSync(paths.database) ? "ready" : "not initialized"}`);
  if (issues.length === 0) {
    console.log("Runtime configuration: ready");
    return 0;
  }
  console.log("Runtime configuration requires attention:");
  for (const issue of issues) console.log(`- ${issue}`);
  return 1;
}

async function runWork(target: string, id?: string): Promise<void> {
  const runtime = readRuntime(target);
  const { database, controlPlane } = controlPlaneFor(target);
  try {
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
    const claim = controlPlane.claim({
      id: candidate.id,
      actor: "runner:local",
      idempotencyKey: `cli:claim:${candidate.id}:${randomUUID()}`,
    });
    const engine = configuredEngine(runtime);
    const runner = new BuiltInManagedRunner();
    const handle = await runner.start(
      {
        taskPacket: {
          objective: candidate.title,
          context: candidate.summary,
          acceptanceCriteria: [
            "Return a human-readable artifact.",
            "Do not claim external side effects.",
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
    console.log(
      `${submission.workItem.id} submitted for review (${submission.sha256}).`,
    );
  } finally {
    database.close();
  }
}

function printItems(target: string): void {
  const { database, controlPlane } = controlPlaneFor(target);
  try {
    for (const item of controlPlane.list()) {
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
    console.log(`${item.id} created. Next action: ${item.nextAction}`);
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
    console.log(`${item.id} is ready.`);
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
    console.log(`${item.id} is ${item.availability}: ${item.nextAction}`);
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
    console.log(`${item.id} resumed: ${item.nextAction}`);
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
    console.log(`${item.id} -> ${item.status}`);
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
    console.log(`${result.workItem.id} completed.`);
    if (result.resurfaced.length > 0) {
      console.log(`Resurfaced: ${result.resurfaced.join(", ")}`);
    }
  } finally {
    database.close();
  }
}

function help(): void {
  console.log(`CharterMesh CLI

The same safe flow is used by humans, Codex, Claude, and other coding agents:
inspect -> plan -> approve exact hash -> apply -> doctor -> run -> review.

Commands:
  chartermesh bootstrap --target PATH [--engine fake]
  chartermesh bootstrap --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME]
  chartermesh bootstrap ... --approve PLAN_HASH
  chartermesh configure-engine --target PATH --engine fake
  chartermesh configure-engine --target PATH --engine openai-compatible \\
    --endpoint URL --model MODEL [--api-key-env ENV_NAME]
  chartermesh configure-engine ... --approve PLAN_HASH
  chartermesh doctor --target PATH
  chartermesh seed-demo --target PATH
  chartermesh request "work title" --target PATH
  chartermesh triage --id WORK --role ROLE --target PATH
  chartermesh list --target PATH
  chartermesh run --id WORK --target PATH
  chartermesh wait --id WORK --type user_input --reason TEXT --target PATH
  chartermesh resume --id WORK --target PATH
  chartermesh decide --id WORK --decision approve --artifact-hash SHA256 \\
    --note TEXT --target PATH
  chartermesh complete --id WORK --target PATH
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
  if (command === "bootstrap") {
    applyBootstrap(args, bootstrapPlan(args));
    return 0;
  }
  if (command === "configure-engine") {
    applyBootstrap(args, runtimePlan(args));
    return 0;
  }
  if (command === "doctor") return doctor(target);
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
    printItems(target);
    return 0;
  }
  if (command === "run") {
    await runWork(target, option(args, "--id"));
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
  if (command === "decide") {
    decideWork(target, args);
    return 0;
  }
  if (command === "complete") {
    completeWork(target, args);
    return 0;
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
