import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";

const executable = resolve("bin", "chartermesh.mjs");
const fakeCodexSource = [
  'const readline=require("node:readline");',
  'if(process.argv.includes("--version")){console.log("codex-cli 0.145.0");process.exit(0)}',
  'const rl=readline.createInterface({input:process.stdin});',
  'rl.on("line",line=>{const message=JSON.parse(line);',
  'if(message.method==="initialize"&&message.id!==undefined){',
  'process.stdout.write(JSON.stringify({id:message.id,result:{userAgent:"codex-cli/0.145.0"}})+"\\n")}});',
].join("");
const fakeCodexArguments = ["--eval", fakeCodexSource, "chartermesh-fixture"];
const fakeClaudeArguments = [
  "--eval",
  'if(process.argv.includes("--version"))console.log("2.1.223 (Claude Code)")',
  "chartermesh-fixture",
];

function fakeCodexCliArguments(): string[] {
  return fakeCodexArguments.flatMap((argument) => ["--host-arg", argument]);
}

function fakeClaudeCliArguments(): string[] {
  return fakeClaudeArguments.flatMap((argument) => ["--host-arg", argument]);
}

function cli(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

function bootstrap(target: string): void {
  const args = ["bootstrap", "--target", target, "--engine", "fake", "--json"];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const planHash = JSON.parse(preview.stdout).data.planHash as string;
  const applied = cli([...args, "--approve", planHash]);
  assert.equal(applied.status, 0, applied.stderr);
}

function kickoff(target: string): string {
  const inputDirectory = mkdtempSync(join(tmpdir(), "chartermesh-host-brief-"));
  const briefPath = join(inputDirectory, "brief.md");
  writeFileSync(
    briefPath,
    "# Host activation flow\n\nImplement the approved project through the selected role.",
    "utf8",
  );
  const args = [
    "kickoff",
    "--target",
    target,
    "--brief-file",
    briefPath,
    "--engine",
    "fake",
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const planHash = JSON.parse(preview.stdout).data.planHash as string;
  const applied = cli([...args, "--approve", planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  return JSON.parse(applied.stdout).data.workItemId as string;
}

function workExecutionTarget(target: string, id: string): string {
  const database = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    return new ControlPlane(
      database,
      join(target, ".chartermesh", "artifacts"),
    ).get(id).executionTarget;
  } finally {
    database.close();
  }
}

function treeSnapshot(root: string): Array<Record<string, string | number>> {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mtimeMs: stat.mtimeMs });
        visit(path, relativePath);
      } else {
        entries.push({
          path: relativePath,
          type: stat.isSymbolicLink() ? "symlink" : "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  };
  visit(root, "");
  return entries;
}

test("host doctor separates projection checks from the strict direct protocol probe", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-host-doctor-"));
  const projection = cli([
    "host",
    "doctor",
    "--target",
    target,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--json",
  ]);
  assert.equal(projection.status, 0, projection.stderr);
  const projectionData = JSON.parse(projection.stdout).data as {
    ready: boolean;
    executableSha256: string;
    capabilitySnapshotSha256: string;
    protocolVersion: string | null;
    capabilityAssessment: string;
    postProjectionVerificationRequired: boolean;
  };
  assert.equal(projectionData.ready, true);
  assert.match(projectionData.executableSha256, /^[a-f0-9]{64}$/u);
  assert.match(projectionData.capabilitySnapshotSha256, /^[a-f0-9]{64}$/u);
  assert.equal(projectionData.protocolVersion, null);
  assert.equal(projectionData.capabilityAssessment, "chartermesh_declared");
  assert.equal(projectionData.postProjectionVerificationRequired, true);

  const direct = cli([
    "host",
    "doctor",
    "--target",
    target,
    "--host",
    "codex",
    "--direct",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--json",
  ]);
  assert.equal(direct.status, 0, direct.stderr);
  const directData = JSON.parse(direct.stdout).data as {
    protocolVersion: string;
  };
  assert.equal(directData.protocolVersion, "codex-app-server/0.145.0");
});

test("Codex projection requires an explicit unrestricted-read acknowledgement", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-host-read-scope-"));
  bootstrap(target);
  const result = cli([
    "configure-host",
    "--target",
    target,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /requires --allow-unrestricted-read/u,
  );
});

test("approved Codex projection preserves unrelated config and activates selected roles", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-codex-host-"));
  const initialWorkItemId = kickoff(target);
  const codexDirectory = join(target, ".codex");
  mkdirSync(codexDirectory, { recursive: true });
  writeFileSync(
    join(codexDirectory, "config.toml"),
    "[agents]\nmax_depth = 2\nmax_concurrent_threads_per_session = 1\n\n[unrelated]\nkeep = true\n",
    "utf8",
  );
  writeFileSync(join(target, "AGENTS.md"), "# User instructions\n", "utf8");
  const args = [
    "configure-host",
    "--target",
    target,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--activate-role",
    "operator",
    "--allow-unrestricted-read",
    "--model",
    "fixture-model",
    "--json",
  ];
  const beforePreview = treeSnapshot(target);
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(treeSnapshot(target), beforePreview);
  const plan = JSON.parse(preview.stdout).data as {
    applied: boolean;
    planHash: string;
    hostBinding: { executableSha256: string; projectionPlanHash: string };
    workRetargets: Array<{
      id: string;
      fromExecutionTarget: string;
      toExecutionTarget: string;
    }>;
  };
  assert.equal(plan.applied, false);
  assert.match(plan.hostBinding.projectionPlanHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(plan.workRetargets, [{
    id: initialWorkItemId,
    expectedVersion: 2,
    ownerRole: "operator",
    fromExecutionTarget: "local",
    toExecutionTarget: "codex-host",
  }]);
  const second = JSON.parse(cli(args).stdout).data as { planHash: string };
  assert.equal(second.planHash, plan.planHash);

  const applied = cli([...args, "--approve", plan.planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(
    JSON.parse(applied.stdout).data.retargetedWorkItemIds,
    [initialWorkItemId],
  );
  assert.equal(workExecutionTarget(target, initialWorkItemId), "codex-host");
  const codexConfig = readFileSync(join(codexDirectory, "config.toml"), "utf8");
  assert.match(codexConfig, /max_depth = 2/u);
  assert.match(codexConfig, /max_concurrent_threads_per_session = 4/u);
  assert.match(codexConfig, /\[unrelated\]\nkeep = true/u);
  assert.match(codexConfig, /\[mcp_servers\.chartermesh\]/u);
  assert.match(codexConfig, /cwd = "\."/u);
  assert.equal((codexConfig.match(/^\[agents\]$/gmu) ?? []).length, 1);
  const instructions = readFileSync(join(target, "AGENTS.md"), "utf8");
  assert.match(instructions, /# User instructions/u);
  assert.match(instructions, /chartermesh-host-integration:begin/u);
  const runtime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  ) as {
    agentHosts: Array<{
      id: string;
      executableSha256: string;
      allowUnrestrictedRead?: boolean;
      args?: string[];
    }>;
  };
  assert.equal(runtime.agentHosts[0]?.id, "codex-host");
  assert.equal(runtime.agentHosts[0]?.executableSha256, plan.hostBinding.executableSha256);
  assert.equal(runtime.agentHosts[0]?.allowUnrestrictedRead, true);
  assert.deepEqual(runtime.agentHosts[0]?.args, fakeCodexArguments);
  const organization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  ) as { spec: { roles: Array<{ id: string; execution: { preferred: string } }> } };
  assert.equal(
    organization.spec.roles.find(({ id }) => id === "operator")?.execution.preferred,
    "codex-host",
  );
  const healthy = cli(["doctor", "--target", target, "--json"]);
  assert.equal(healthy.status, 0, healthy.stderr);

  runtime.agentHosts[0]!.executableSha256 = "0".repeat(64);
  writeFileSync(
    join(target, ".chartermesh", "runtime.json"),
    `${JSON.stringify(runtime, null, 2)}\n`,
    "utf8",
  );
  const changed = cli(["doctor", "--target", target, "--json"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /AgentHost executable digest changed/u);

  const projectionOnlyArgs = [
    "configure-host",
    "--target",
    target,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--allow-unrestricted-read",
    "--json",
  ];
  const projectionPreview = cli(projectionOnlyArgs);
  assert.equal(projectionPreview.status, 0, projectionPreview.stderr);
  const projectionHash = JSON.parse(projectionPreview.stdout).data
    .planHash as string;
  const projectionApplied = cli([
    ...projectionOnlyArgs,
    "--approve",
    projectionHash,
  ]);
  assert.equal(projectionApplied.status, 0, projectionApplied.stderr);
  assert.equal(workExecutionTarget(target, initialWorkItemId), "codex-project");
  const projectionRuntime = JSON.parse(
    readFileSync(join(target, ".chartermesh", "runtime.json"), "utf8"),
  ) as { agentHosts?: unknown[] };
  assert.deepEqual(projectionRuntime.agentHosts, []);
  const projectionOrganization = JSON.parse(
    readFileSync(join(target, ".chartermesh", "organization.json"), "utf8"),
  ) as {
    spec: {
      executionTargets: Array<{ id: string }>;
      roles: Array<{ id: string; execution: { preferred: string } }>;
    };
  };
  assert.equal(
    projectionOrganization.spec.executionTargets.some(
      ({ id }) => id === "codex-host",
    ),
    false,
  );
  assert.equal(
    projectionOrganization.spec.roles.find(({ id }) => id === "operator")
      ?.execution.preferred,
    "codex-project",
  );
  const projectionHealthy = cli(["doctor", "--target", target, "--json"]);
  assert.equal(projectionHealthy.status, 0, projectionHealthy.stderr);
});

test("Codex projection fails closed on ambiguous or oversized existing TOML", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-codex-toml-"));
  bootstrap(target);
  const codexDirectory = join(target, ".codex");
  mkdirSync(codexDirectory, { recursive: true });
  const configPath = join(codexDirectory, "config.toml");
  const args = [
    "configure-host",
    "--target",
    target,
    "--host",
    "codex",
    "--executable",
    process.execPath,
    ...fakeCodexCliArguments(),
    "--allow-unrestricted-read",
    "--json",
  ];
  const unsupported = [
    '[mcp_servers.chartermesh]\ncommand = "old"\n\n[[plugins]]\nname = "x"\n',
    '["mcp_servers"."chartermesh"]\ncommand = "old"\n',
    'mcp_servers.chartermesh = { command = "old" }\n',
    '[description]\ntext = """ambiguous\nmultiline"""\n',
    'mcp_servers = { chartermesh = { command = "old" } }\n',
    '[mcp_servers.chartermesh.extra]\nvalue = true\n',
  ];
  for (const content of unsupported) {
    writeFileSync(configPath, content, "utf8");
    const before = readFileSync(configPath, "utf8");
    const rejected = cli(args);
    assert.equal(rejected.status, 1, `${content}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Codex config/u);
    assert.equal(readFileSync(configPath, "utf8"), before);
  }

  writeFileSync(configPath, "x".repeat(1024 * 1024 + 1), "utf8");
  const oversized = cli(args);
  assert.equal(oversized.status, 1, oversized.stderr);
  assert.match(
    `${oversized.stdout}\n${oversized.stderr}`,
    /no larger than 1048576 bytes/u,
  );
});

test("CLI state access refuses a linked CharterMesh directory", (context) => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-linked-state-"));
  const outside = mkdtempSync(join(tmpdir(), "chartermesh-linked-state-data-"));
  bootstrap(target);
  const state = join(target, ".chartermesh");
  const moved = join(outside, "state");
  renameSync(state, moved);
  try {
    symlinkSync(moved, state, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      context.skip("The platform does not permit creating a test link.");
      return;
    }
    throw error;
  }
  const result = cli(["doctor", "--target", target, "--json"]);
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /(?:linked or reparse-point (?:state path|component)|symbolic link, junction, or reparse-point component)/u,
  );
});

test("approved Claude projection merges MCP JSON but does not claim direct run activation", () => {
  const target = mkdtempSync(join(tmpdir(), "chartermesh-claude-host-"));
  bootstrap(target);
  writeFileSync(
    join(target, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { existing: { command: "existing" } } }, null, 2)}\n`,
    "utf8",
  );
  const args = [
    "configure-host",
    "--target",
    target,
    "--host",
    "claude",
    "--executable",
    process.execPath,
    ...fakeClaudeCliArguments(),
    "--json",
  ];
  const preview = cli(args);
  assert.equal(preview.status, 0, preview.stderr);
  const planHash = JSON.parse(preview.stdout).data.planHash as string;
  const applied = cli([...args, "--approve", planHash]);
  assert.equal(applied.status, 0, applied.stderr);
  const mcp = JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(mcp.mcpServers.existing);
  assert.ok(mcp.mcpServers.chartermesh);
  assert.match(
    readFileSync(
      join(target, ".claude", "agents", "chartermesh-operator.md"),
      "utf8",
    ),
    /disallowedTools:\n  - Bash\n  - PowerShell\n  - Edit\n  - Write/u,
  );
  const healthy = cli(["doctor", "--target", target, "--json"]);
  assert.equal(healthy.status, 0, healthy.stderr);
  const rejectedActivation = cli([
    ...args.filter((argument) => argument !== "--json"),
    "--activate-role",
    "operator",
  ]);
  assert.equal(rejectedActivation.status, 1);
  assert.match(rejectedActivation.stderr, /future direct AgentHost adapter/u);
});
