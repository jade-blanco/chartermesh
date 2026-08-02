import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";
import { compareVersions } from "../src/main.ts";

const executable = resolve("bin", "chartermesh.mjs");

test("version comparison does not treat an older release as an update", () => {
  assert.ok(compareVersions("0.0.7-alpha.1", "0.0.6-alpha.1") > 0);
  assert.ok(compareVersions("0.0.7", "0.0.7-alpha.1") > 0);
  assert.equal(compareVersions("v0.0.7-alpha.1", "0.0.7-alpha.1"), 0);
});

function cli(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for test condition.");
}

test("clean target completes the fake-engine bootstrap workflow", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-cli-"));
  const bootstrapArgs = ["bootstrap", "--target", target, "--engine", "fake"];
  const preview = cli(bootstrapArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const hash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(hash, preview.stdout);

  const applied = cli([...bootstrapArgs, "--approve", hash]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Applied CharterMesh bootstrap plan/u);
  assert.equal(
    existsSync(
      join(target, ".chartermesh", "skills", "web-research", "SKILL.md"),
    ),
    true,
  );
  assert.match(
    readFileSync(
      join(target, ".chartermesh", "AGENT-ENTRYPOINT.md"),
      "utf8",
    ),
    /performed, evidenced checks/u,
  );

  const doctor = cli(["doctor", "--target", target]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /Runtime configuration: ready/u);

  const requested = cli([
    "request",
    "Prepare the clean-target artifact",
    "--summary-base64",
    Buffer.from(
      "Prove the provider-neutral CLI path with quotes, regex /^safe$/, and 한국어.",
      "utf8",
    ).toString("base64"),
    "--target",
    target,
  ]);
  assert.equal(requested.status, 0, requested.stderr);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);

  const triaged = cli([
    "triage",
    "--id",
    workId,
    "--role",
    "operator",
    "--target",
    target,
  ]);
  assert.equal(triaged.status, 0, triaged.stderr);

  const paused = cli([
    "system",
    "pause",
    "--reason",
    "Offline E2E pause",
    "--target",
    target,
  ]);
  assert.equal(paused.status, 0, paused.stderr);
  const blockedRun = cli(["run", "--id", workId, "--target", target]);
  assert.equal(blockedRun.status, 1);
  assert.match(blockedRun.stderr, /OPERATIONS_PAUSED/u);
  assert.equal(
    cli(["system", "resume", "--target", target]).status,
    0,
  );

  const run = cli(["run", "--id", workId, "--target", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /submitted for review/u);
  const artifactHash = run.stdout.match(/\(([a-f0-9]{64})\)/u)?.[1];
  assert.ok(artifactHash, run.stdout);
  const packet = cli([
    "decision-packet",
    "--id",
    workId,
    "--target",
    target,
    "--json",
  ]);
  assert.equal(packet.status, 0, packet.stderr);
  const packetHash = JSON.parse(packet.stdout).data.binding.packetHash;

  const decided = cli([
    "decide",
    "--id",
    workId,
    "--decision",
    "approve",
    "--artifact-hash",
    artifactHash,
    "--packet-hash",
    packetHash,
    "--note",
    "Verified by the offline end-to-end test.",
    "--target",
    target,
  ]);
  assert.equal(decided.status, 0, decided.stderr);

  const completed = cli(["complete", "--id", workId, "--target", target]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /completed/u);

  const listed = cli(["list", "--target", target]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /\| done \| completed \|/u);

  const delegatedRequest = cli([
    "request",
    "Prepare a delegated synthetic artifact",
    "--summary",
    "Use four bounded roles and leave one final review artifact.",
    "--target",
    target,
  ]);
  const delegatedWorkId =
    delegatedRequest.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(delegatedWorkId, delegatedRequest.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      delegatedWorkId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );
  const delegatedRun = cli([
    "run",
    "--id",
    delegatedWorkId,
    "--delegated",
    "--target",
    target,
  ]);
  assert.equal(
    delegatedRun.status,
    0,
    delegatedRun.stdout + delegatedRun.stderr,
  );
  const delegatedDatabase = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    const attempts = new ControlPlane(
      delegatedDatabase,
      join(target, ".chartermesh", "artifacts"),
    ).listAttempts();
    assert.deepEqual(
      attempts
        .filter(({ kind }) => kind === "delegated")
        .map(({ roleId, status }) => ({ roleId, status })),
      [
        { roleId: "planner", status: "succeeded" },
        { roleId: "implementer", status: "succeeded" },
        { roleId: "verifier", status: "succeeded" },
        { roleId: "synthesizer", status: "succeeded" },
      ],
    );
  } finally {
    delegatedDatabase.close();
  }

  const evidenceRequest = cli([
    "request",
    "Require a real workspace read",
    "--summary",
    "The fake engine cannot satisfy this required tool evidence.",
    "--require-tool",
    "workspace.read_file",
    "--target",
    target,
  ]);
  const evidenceWorkId =
    evidenceRequest.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(evidenceWorkId, evidenceRequest.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      evidenceWorkId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );
  const evidenceRun = cli([
    "run",
    "--id",
    evidenceWorkId,
    "--target",
    target,
  ]);
  assert.equal(evidenceRun.status, 1);
  assert.match(
    evidenceRun.stderr,
    /REQUIRED_TOOL_EVIDENCE_MISSING: workspace\.read_file/u,
  );
});

test("changes-requested feedback and the exact prior artifact reach the next generation", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-revision-"));
  const bootstrapArgs = ["bootstrap", "--target", target, "--engine", "fake"];
  const preview = cli(bootstrapArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const planHash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(planHash, preview.stdout);
  const applied = cli([...bootstrapArgs, "--approve", planHash]);
  assert.equal(applied.status, 0, applied.stderr);

  const requested = cli([
    "request",
    "Revise the synthetic artifact",
    "--summary",
    "Keep this task deliberately short.",
    "--target",
    target,
  ]);
  assert.equal(requested.status, 0, requested.stderr);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      workId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );

  const firstRun = cli(["run", "--id", workId, "--target", target]);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const firstHash = firstRun.stdout.match(/\(([a-f0-9]{64})\)/u)?.[1];
  assert.ok(firstHash, firstRun.stdout);
  const firstPacketHash = JSON.parse(
    cli([
      "decision-packet",
      "--id",
      workId,
      "--target",
      target,
      "--json",
    ]).stdout,
  ).data.binding.packetHash;
  const reviewNote = "Please make the status explanation understandable to a first-time user.";
  const changes = cli([
    "decide",
    "--id",
    workId,
    "--decision",
    "changes_requested",
    "--artifact-hash",
    firstHash,
    "--packet-hash",
    firstPacketHash,
    "--note",
    reviewNote,
    "--target",
    target,
  ]);
  assert.equal(changes.status, 0, changes.stderr);

  const secondRun = cli(["run", "--id", workId, "--target", target]);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    const artifact = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    ).latestArtifact(workId);
    assert.ok(artifact);
    const envelope = JSON.parse(artifact.content) as { deliverable: string };
    assert.match(envelope.deliverable, new RegExp(firstHash, "u"));
    assert.match(envelope.deliverable, /first-time user/u);
  } finally {
    database.close();
  }
});

test("capability catalog is agent-readable and external integrations stay disabled", () => {
  const listed = cli(["capabilities", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const catalog = JSON.parse(listed.stdout).data.items;
  assert.ok(
    catalog.some(
      ({ id, defaultEnabled }: { id: string; defaultEnabled: boolean }) =>
        id === "searxng-web-search" && defaultEnabled === false,
    ),
  );
  const skills = cli(["skills", "list", "--json"]);
  assert.equal(skills.status, 0, skills.stdout + skills.stderr);
  assert.equal(JSON.parse(skills.stdout).data.items.length, 5);
});

test("bootstrap can opt into approval-gated loopback SearXNG search", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-search-"));
  const args = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:18080/v1",
    "--model",
    "local-model",
    "--tool-calling",
    "--web-search-searxng",
    "http://127.0.0.1:8888/search",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const hash = JSON.parse(preview.stdout).data.planHash;
  const applied = cli([...args, "--approve", hash]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  const organization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  );
  assert.equal(runtime.webSearch.adapter, "searxng");
  assert.ok(organization.spec.roles[0].tools.allow.includes("web.search"));
  assert.ok(
    organization.spec.roles[0].tools.approvalRequired.includes("web.search"),
  );
});

test("engine reconfiguration is also bound to an exact plan hash", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-reconfigure-"));
  const initial = cli(["bootstrap", "--target", target, "--engine", "fake"]);
  const initialHash = initial.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(initialHash);
  assert.equal(
    cli([
      "bootstrap",
      "--target",
      target,
      "--engine",
      "fake",
      "--approve",
      initialHash,
    ]).status,
    0,
  );

  const configureArgs = [
    "configure-engine",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:11434/v1",
    "--model",
    "local-model",
  ];
  const preview = cli(configureArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const hash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(hash, preview.stdout);
  assert.match(preview.stdout, /verify\/replace/u);

  const applied = cli([...configureArgs, "--approve", hash]);
  assert.equal(applied.status, 0, applied.stderr);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  assert.equal(runtime.modelEngines[0].adapter, "openai-compatible");
  assert.equal(runtime.modelEngines[0].model, "local-model");
});

test("engine reconfiguration adds web search to runtime and selected OrgSpec role atomically", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-search-configure-"));
  const initialArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const initial = JSON.parse(cli(initialArgs).stdout);
  assert.equal(
    cli([...initialArgs, "--approve", initial.data.planHash]).status,
    0,
  );
  const configureArgs = [
    "configure-engine",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:18080/v1",
    "--model",
    "local-model",
    "--tool-calling",
    "--web-search-searxng",
    "http://127.0.0.1:8888/search",
    "--web-search-role",
    "operator",
    "--json",
  ];
  const preview = JSON.parse(cli(configureArgs).stdout);
  assert.equal(preview.data.files.length, 2);
  const applied = cli([
    ...configureArgs,
    "--approve",
    preview.data.planHash,
  ]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  const organization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  );
  assert.equal(runtime.webSearch.endpoint, "http://127.0.0.1:8888/search");
  assert.ok(organization.spec.roles[0].capabilities.includes("web_research"));
  assert.ok(organization.spec.roles[0].tools.allow.includes("web.search"));
  assert.ok(
    organization.spec.roles[0].tools.approvalRequired.includes("web.search"),
  );
  const doctor = cli(["doctor", "--target", target, "--json"]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).data.webSearch, "configured");

  const disableArgs = [
    "configure-engine",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:18080/v1",
    "--model",
    "local-model",
    "--tool-calling",
    "--disable-web-search",
    "--json",
  ];
  const disablePreview = JSON.parse(cli(disableArgs).stdout);
  assert.equal(
    cli([
      ...disableArgs,
      "--approve",
      disablePreview.data.planHash,
    ]).status,
    0,
  );
  const disabledRuntime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  const disabledOrganization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  );
  assert.equal(disabledRuntime.webSearch, undefined);
  assert.equal(
    disabledOrganization.spec.roles[0].tools.allow.includes("web.search"),
    false,
  );
});

test("an arbitrary local executable can serve as the ModelEngine", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-command-cli-"));
  const fixture = resolve(
    "adapters",
    "model-engines",
    "command-process",
    "test",
    "fixtures",
    "engine.mjs",
  );
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "command-process",
    "--command",
    process.execPath,
    "--command-arg",
    fixture,
    "--model",
    "offline-fixture",
  ];
  const preview = cli(bootstrapArgs);
  assert.equal(preview.status, 0, preview.stderr);
  const hash = preview.stdout.match(/Approval token: ([a-f0-9]{64})/u)?.[1];
  assert.ok(hash, preview.stdout);
  assert.equal(cli([...bootstrapArgs, "--approve", hash]).status, 0);

  const requested = cli([
    "request",
    "Exercise a provider-neutral process",
    "--target",
    target,
  ]);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      workId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );
  const run = cli(["run", "--id", workId, "--target", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /submitted for review/u);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  );
  assert.equal(runtime.modelEngines[0].adapter, "command-process");
  assert.equal(runtime.modelEngines[0].command, process.execPath);
  assert.match(
    runtime.modelEngines[0].executableSha256,
    /^[a-f0-9]{64}$/u,
  );
  const artifactHash = run.stdout.match(/\(([a-f0-9]{64})\)/u)?.[1];
  assert.ok(artifactHash, run.stdout);
  const artifact = JSON.parse(
    readFileSync(
      join(target, ".chartermesh", "artifacts", `${artifactHash}.txt`),
      "utf8",
    ),
  );
  assert.ok(
    artifact.checks.includes(
      `cwd:${join(
        target,
        ".chartermesh",
        "engine-work",
        "primary-model",
      )}`,
    ),
  );
});

test("an approval-gated tool call waits without failing and resumes on a new run", () => {
  const target = mkdtempSync(
    join(tmpdir(), "chartermesh-command-approval-cli-"),
  );
  const fixture = resolve(
    "adapters",
    "model-engines",
    "command-process",
    "test",
    "fixtures",
    "approval-engine.mjs",
  );
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "command-process",
    "--command",
    process.execPath,
    "--command-arg",
    fixture,
    "--model",
    "approval-fixture",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(
    cli([
      ...bootstrapArgs,
      "--approve",
      preview.data.planHash,
    ]).status,
    0,
  );

  const requested = JSON.parse(
    cli([
      "request",
      "Exercise a durable tool approval wait",
      "--target",
      target,
      "--json",
    ]).stdout,
  );
  const workId = requested.data.id;
  assert.equal(
    cli([
      "triage",
      "--id",
      workId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );

  const firstRun = cli([
    "run",
    "--id",
    workId,
    "--target",
    target,
    "--json",
  ]);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const pending = JSON.parse(firstRun.stdout).data;
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.toolName, "workspace.write_file");
  assert.match(pending.callHash, /^[a-f0-9]{64}$/u);

  let database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  let controlPlane = new ControlPlane(
    database,
    join(target, ".chartermesh", "artifacts"),
  );
  assert.deepEqual(
    {
      status: controlPlane.get(workId).status,
      availability: controlPlane.get(workId).availability,
      failures: controlPlane.dashboard().summary.failed,
      approvals: controlPlane.dashboard().summary.approvals,
    },
    {
      status: "in_progress",
      availability: "approval_waiting",
      failures: 0,
      approvals: 1,
    },
  );
  database.close();

  const toolPacketHash = JSON.parse(
    cli([
      "decision-packet",
      "--id",
      workId,
      "--target",
      target,
      "--json",
    ]).stdout,
  ).data.binding.packetHash;

  const approved = cli([
    "approve-tool",
    "--id",
    workId,
    "--call-hash",
    pending.callHash,
    "--tool",
    pending.toolName,
    "--packet-hash",
    toolPacketHash,
    "--target",
    target,
  ]);
  assert.equal(approved.status, 0, approved.stderr);

  database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  controlPlane = new ControlPlane(
    database,
    join(target, ".chartermesh", "artifacts"),
  );
  assert.deepEqual(
    {
      status: controlPlane.get(workId).status,
      availability: controlPlane.get(workId).availability,
    },
    { status: "ready", availability: "ready" },
  );
  database.close();

  const resumed = cli([
    "run",
    "--id",
    workId,
    "--target",
    target,
    "--json",
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(
    JSON.parse(resumed.stdout).data.status,
    "submitted_for_review",
  );
  assert.equal(
    readFileSync(join(target, "approval-fixture.txt"), "utf8"),
    "approved\n",
  );
});

test("proposal and workflow commands expose versioned JSON for coding agents", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-json-"));
  writeFileSync(join(target, "package.json"), '{"scripts":{"test":"node --test"}}');
  writeFileSync(join(target, "service.ts"), "export const service = true;\n");
  writeFileSync(join(target, "service.test.ts"), "export {};\n");

  const proposed = cli([
    "propose",
    "--target",
    target,
    "--profile",
    "controlled",
    "--json",
  ]);
  assert.equal(proposed.status, 0, proposed.stderr);
  const proposal = JSON.parse(proposed.stdout);
  assert.equal(proposal.apiVersion, "chartermesh.dev/cli/v1alpha1");
  assert.equal(proposal.data.profile, "controlled");
  assert.ok(proposal.data.assessment.detectedLanguages.includes("TypeScript"));
  assert.equal(proposal.data.assessment.hasTests, true);

  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(preview.data.approvalRequired, true);
  const applied = cli([
    ...bootstrapArgs,
    "--approve",
    preview.data.planHash,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).data.applied, true);

  const requested = cli([
    "request",
    "JSON contract",
    "--summary",
    "Exercise the machine-readable command contract.",
    "--target",
    target,
    "--json",
  ]);
  const requestEnvelope = JSON.parse(requested.stdout);
  assert.equal(requestEnvelope.command, "request");
  assert.match(requestEnvelope.data.id, /^work-\d{6}$/u);

  const listed = JSON.parse(
    cli(["list", "--target", target, "--json"]).stdout,
  );
  assert.equal(listed.data.items.length, 1);

  const evaluated = cli([
    "evaluate-model",
    "--target",
    target,
    "--live",
    "--json",
  ]);
  assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);
  const evaluationEnvelope = JSON.parse(evaluated.stdout);
  assert.equal(evaluationEnvelope.command, "evaluate-model");
  assert.equal(evaluationEnvelope.data.passedCases, 3);
});

test("doctor automatically recovers an interrupted engine replacement", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-crash-recovery-"));
  const initialArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
  ];
  const initial = cli(initialArgs);
  const initialHash = initial.stdout.match(
    /Approval token: ([a-f0-9]{64})/u,
  )?.[1];
  assert.ok(initialHash);
  assert.equal(
    cli([...initialArgs, "--approve", initialHash]).status,
    0,
  );

  const configure = [
    "configure-engine",
    "--target",
    target,
    "--engine",
    "openai-compatible",
    "--endpoint",
    "http://127.0.0.1:11434/v1",
    "--model",
    "crash-fixture",
  ];
  const preview = cli(configure);
  const hash = preview.stdout.match(
    /Approval token: ([a-f0-9]{64})/u,
  )?.[1];
  assert.ok(hash);
  const crashed = cli(
    [...configure, "--approve", hash],
    {
      NODE_ENV: "test",
      CHARTERMESH_TEST_CRASH_AFTER_RENAMES: "1",
    },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(
    JSON.parse(
      readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
    ).modelEngines[0].adapter,
    "openai-compatible",
  );

  const doctor = cli(["doctor", "--target", target, "--json"]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const result = JSON.parse(doctor.stdout);
  assert.equal(result.data.recovery[0].action, "rolled_back");
  assert.equal(
    JSON.parse(
      readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
    ).modelEngines[0].adapter,
    "fake",
  );
});

test("Control Plane restore requires the exact preview hash and keeps a safety backup", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-restore-"));
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(
    cli([...bootstrapArgs, "--approve", preview.data.planHash]).status,
    0,
  );
  const before = cli(["request", "Before backup", "--target", target]);
  assert.equal(before.status, 0, before.stderr);
  const beforeId = before.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(beforeId, before.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      beforeId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );
  const beforeRun = cli(["run", "--id", beforeId, "--target", target]);
  assert.equal(beforeRun.status, 0, beforeRun.stderr);
  const beforeArtifactHash =
    beforeRun.stdout.match(/\(([a-f0-9]{64})\)/u)?.[1];
  assert.ok(beforeArtifactHash, beforeRun.stdout);
  const backup = cli(["backup", "create", "--target", target, "--json"]);
  assert.equal(backup.status, 0, backup.stderr);
  const backupId = JSON.parse(backup.stdout).data.id;
  assert.match(backupId, /^backup-/u);
  assert.equal(
    cli(["request", "After backup", "--target", target]).status,
    0,
  );

  const restoreArgs = [
    "restore",
    "--backup",
    backupId,
    "--target",
    target,
    "--json",
  ];
  const restorePreview = cli(restoreArgs);
  assert.equal(restorePreview.status, 0, restorePreview.stderr);
  const plan = JSON.parse(restorePreview.stdout).data;
  assert.match(plan.planHash, /^[a-f0-9]{64}$/u);
  const restored = cli([
    ...restoreArgs,
    "--approve",
    plan.planHash,
  ]);
  assert.equal(restored.status, 0, restored.stderr);
  const restoredData = JSON.parse(restored.stdout).data;
  assert.match(restoredData.safetyBackup, /^backup-/u);
  assert.equal(restoredData.restoredArtifactCount, 1);
  assert.equal(
    readFileSync(
      join(
        target,
        ".chartermesh",
        "artifacts",
        `${beforeArtifactHash}.txt`,
      ),
      "utf8",
    ).length > 0,
    true,
  );

  const listed = JSON.parse(
    cli(["list", "--target", target, "--json"]).stdout,
  );
  assert.deepEqual(
    listed.data.items.map((item: { title: string }) => item.title),
    ["Before backup"],
  );
});

test("doctor reports a schema-invalid runtime before a model run", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-runtime-schema-"));
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(
    cli([...bootstrapArgs, "--approve", preview.data.planHash]).status,
    0,
  );
  const runtimePath = join(target, ".chartermesh", "runtime.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  runtime.unexpected = true;
  writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));

  const doctor = cli(["doctor", "--target", target, "--json"]);
  assert.equal(doctor.status, 1, doctor.stdout + doctor.stderr);
  const envelope = JSON.parse(doctor.stdout);
  assert.equal(envelope.ok, false);
  assert.match(
    envelope.error.issues.join("\n"),
    /runtime\.json:.*additionalProperties/u,
  );

  const run = cli(["run", "--target", target, "--json"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    JSON.parse(run.stdout).error.message,
    /Runtime configuration does not satisfy/u,
  );
});

test("local scheduler is disabled by default and skips empty queues without a model", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-scheduler-"));
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(
    cli([...bootstrapArgs, "--approve", preview.data.planHash]).status,
    0,
  );

  const disabled = cli([
    "scheduler",
    "tick",
    "--target",
    target,
    "--now",
    "2026-07-30T00:00:00.000Z",
    "--json",
  ]);
  assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).data.activeSchedules, 0);

  const organizationPath = join(
    target,
    ".chartermesh",
    "organization.json",
  );
  const organization = JSON.parse(
    readFileSync(organizationPath, "utf8"),
  );
  organization.spec.schedules = [
    {
      id: "local-minute",
      workflow: "reviewed-work",
      cadence: {
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        timezone: "UTC",
      },
      activation: "active",
      executor: "controller",
      noWorkBehavior: "skip_without_model",
      overlapPolicy: "forbid",
    },
  ];
  writeFileSync(
    organizationPath,
    JSON.stringify(organization, null, 2),
  );

  const empty = cli([
    "scheduler",
    "tick",
    "--target",
    target,
    "--now",
    "2026-07-30T00:01:00.000Z",
    "--json",
  ]);
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.equal(JSON.parse(empty.stdout).data.skippedNoWork, 1);
  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    assert.equal(
      new ControlPlane(
        database,
        join(target, ".chartermesh", "artifacts"),
      ).listInvocations().length,
      0,
    );
  } finally {
    database.close();
  }

  const requested = cli([
    "request",
    "Scheduled local work",
    "--target",
    target,
  ]);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      workId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );
  const executed = cli([
    "scheduler",
    "tick",
    "--target",
    target,
    "--now",
    "2026-07-30T00:02:00.000Z",
    "--json",
  ]);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.equal(
    JSON.parse(executed.stdout).data.succeeded,
    1,
    executed.stdout + executed.stderr,
  );
  const listed = JSON.parse(
    cli(["list", "--target", target, "--json"]).stdout,
  );
  assert.equal(listed.data.items[0].status, "review_pending");
});

test("a separate CLI cancellation durably ends a running invocation", async () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-cancel-"));
  const fixture = resolve(
    "adapters",
    "model-engines",
    "command-process",
    "test",
    "fixtures",
    "slow-engine.mjs",
  );
  const bootstrapArgs = [
    "bootstrap",
    "--target",
    target,
    "--engine",
    "command-process",
    "--command",
    process.execPath,
    "--command-arg",
    fixture,
    "--timeout-ms",
    "60000",
    "--json",
  ];
  const preview = JSON.parse(cli(bootstrapArgs).stdout);
  assert.equal(
    cli([...bootstrapArgs, "--approve", preview.data.planHash]).status,
    0,
  );
  const requested = cli([
    "request",
    "Cancelable local invocation",
    "--target",
    target,
  ]);
  const workId = requested.stdout.match(/(work-\d{6}) created/u)?.[1];
  assert.ok(workId, requested.stdout);
  assert.equal(
    cli([
      "triage",
      "--id",
      workId,
      "--role",
      "operator",
      "--target",
      target,
    ]).status,
    0,
  );

  const runner = spawn(
    process.execPath,
    [
      executable,
      "run",
      "--id",
      workId,
      "--target",
      target,
      "--json",
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  runner.stdout.setEncoding("utf8");
  runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  runner.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolveClose) => {
    runner.once("close", resolveClose);
  });

  await waitUntil(() => {
    const listed = cli(["list", "--target", target, "--json"]);
    if (listed.status !== 0) return false;
    return JSON.parse(listed.stdout).data.items[0]?.status === "in_progress";
  });
  const canceled = cli([
    "cancel",
    "--id",
    workId,
    "--target",
    target,
    "--json",
  ]);
  assert.equal(canceled.status, 0, canceled.stdout + canceled.stderr);
  assert.equal(JSON.parse(canceled.stdout).data.workItemId, workId);
  const exitCode = await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("Canceled run did not exit."));
      }, 10_000).unref(),
    ),
  ]);
  assert.equal(exitCode, 1, stdout + stderr);
  assert.match(JSON.parse(stdout).error.message, /CANCELED/u);

  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    const controlPlane = new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    );
    assert.equal(controlPlane.get(workId).status, "canceled");
    assert.equal(controlPlane.listInvocations()[0]?.status, "canceled");
  } finally {
    database.close();
  }
});
