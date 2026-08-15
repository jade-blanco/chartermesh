import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import {
  createHostProjectionPlan,
  discoverHost,
  validateHostCapabilitySnapshot,
  type HostCapabilitySnapshotInput,
  type HostDiscoveryProbes,
  type HostExecutableBinding,
  type HostKind,
  type HostProjectionRole,
} from "../src/host-integration.ts";

const executableBytes = new TextEncoder().encode("fixture host executable");
const executableSha256 = createHash("sha256")
  .update(executableBytes)
  .digest("hex");

function snapshot(hostKind: HostKind): HostCapabilitySnapshotInput {
  return {
    contractVersion: "chartermesh.dev/host-capabilities/v1alpha1",
    hostKind,
    capabilities: [
      {
        name: "mcp.stdio",
        support: "native",
        stability: "stable",
      },
      {
        name: "instructions.project",
        support: "native",
        stability: "stable",
      },
      {
        name: "agents.project",
        support: "native",
        stability: "beta",
      },
      {
        name: "sessions.resume",
        support: "manual_step_required",
        stability: "beta",
      },
    ],
  };
}

function probes(input: {
  executablePath: string;
  reportedVersion?: string;
  bytes?: Uint8Array;
  calls?: string[];
}): HostDiscoveryProbes {
  const calls = input.calls ?? [];
  return {
    files: {
      async locateExecutable(command) {
        calls.push(`locate:${command}`);
        return input.executablePath;
      },
      async realpath(path) {
        calls.push(`realpath:${path}`);
        return input.executablePath;
      },
      async isFile(path) {
        calls.push(`isFile:${path}`);
        return true;
      },
      async readFile(path) {
        calls.push(`readFile:${path}`);
        return input.bytes ?? executableBytes;
      },
    },
    process: {
      async run(request) {
        calls.push(`run:${request.executable}:${request.args.join(",")}`);
        assert.deepEqual(request.environment, {});
        assert.equal(request.maxOutputBytes, 8_192);
        return {
          exitCode: 0,
          stdout: `fixture-host ${input.reportedVersion ?? "1.2.3"}\n`,
          stderr: "",
        };
      },
    },
  };
}

async function binding(hostKind: HostKind): Promise<HostExecutableBinding> {
  const executablePath = resolve(`fixtures/${hostKind}`);
  const result = await discoverHost(
    {
      hostKind,
      expectedExecutableSha256: executableSha256,
      expectedVersion: "1.2.3",
      requiredCapabilities: [
        "mcp.stdio",
        "instructions.project",
        "agents.project",
      ],
      capabilitySnapshot: snapshot(hostKind),
    },
    probes({ executablePath }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.binding);
  return result.binding;
}

const roles: HostProjectionRole[] = [
  {
    id: "verifier",
    description: "Checks evidence and acceptance criteria.",
    instructions: "Run the smallest relevant offline verification and report gaps.",
    permission: "read_only",
  },
  {
    id: "implementer",
    description: "Implements an approved bounded change.",
    instructions: "Implement the assigned TaskPacket and preserve unrelated files.",
    permission: "workspace_write",
  },
];

test("host discovery hashes only the resolved executable and uses a sterile version probe", async () => {
  const executablePath = resolve("fixtures/codex");
  const calls: string[] = [];
  const result = await discoverHost(
    {
      hostKind: "codex",
      expectedExecutableSha256: executableSha256,
      expectedVersion: "1.2.3",
      requiredCapabilities: ["mcp.stdio"],
      capabilitySnapshot: {
        ...snapshot("codex"),
        capabilities: [...snapshot("codex").capabilities].reverse(),
      },
    },
    probes({ executablePath, calls }),
  );

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.binding);
  assert.equal(result.binding.executablePath, executablePath);
  assert.equal(result.binding.executableSha256, executableSha256);
  assert.equal(result.binding.reportedVersion, "1.2.3");
  assert.deepEqual(
    result.binding.capabilitySnapshot.capabilities.map(({ name }) => name),
    [
      "agents.project",
      "instructions.project",
      "mcp.stdio",
      "sessions.resume",
    ],
  );
  assert.match(result.binding.capabilitySnapshotSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, [
    "locate:codex",
    `realpath:${executablePath}`,
    `isFile:${executablePath}`,
    `readFile:${executablePath}`,
    `run:${executablePath}:--version`,
  ]);
});

test("host discovery fails closed on executable, version, snapshot, and capability drift", async () => {
  const executablePath = resolve("fixtures/claude");
  const result = await discoverHost(
    {
      hostKind: "claude",
      executablePath,
      expectedExecutableSha256: "0".repeat(64),
      expectedVersion: "9.9.9",
      expectedCapabilitySnapshotSha256: "f".repeat(64),
      requiredCapabilities: ["sessions.resume", "teams.peer-messaging"],
      capabilitySnapshot: snapshot("claude"),
    },
    probes({ executablePath }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.binding, null);
  assert.deepEqual(
    new Set(result.issues.map(({ code }) => code)),
    new Set([
      "executable_hash_mismatch",
      "version_mismatch",
      "required_capability_missing",
      "capability_snapshot_hash_mismatch",
    ]),
  );
});

test("capability snapshots reject unknown fields so credentials cannot enter discovery", () => {
  const unsafe = {
    ...snapshot("codex"),
    authToken: "must-not-be-accepted",
  };
  assert.deepEqual(
    validateHostCapabilitySnapshot(unsafe).map(({ code }) => code),
    ["invalid_capability_snapshot"],
  );
  assert.match(
    validateHostCapabilitySnapshot(unsafe)[0]?.message ?? "",
    /authentication material is not accepted/u,
  );
});

test("Codex projection is deterministic and produces managed project files", async () => {
  const hostBinding = await binding("codex");
  const request = {
    binding: hostBinding,
    roles,
    bridge: {
      command: "chartermesh",
      args: ["host", "mcp", "--stdio"],
    },
    maxConcurrentAgents: 3,
  } as const;
  const first = createHostProjectionPlan(request);
  const reordered = createHostProjectionPlan({
    ...request,
    roles: [...roles].reverse(),
  });

  assert.equal(first.planHash, reordered.planHash);
  assert.deepEqual(first.operations, reordered.operations);
  assert.match(first.planHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    first.operations.map(({ path }) => path),
    [
      ".codex/agents/chartermesh-implementer.toml",
      ".codex/agents/chartermesh-verifier.toml",
      ".codex/config.toml",
      "AGENTS.md",
    ],
  );
  const config = first.operations.find(({ path }) => path === ".codex/config.toml");
  assert.equal(config?.kind, "merge_toml_fragment");
  assert.match(config?.content ?? "", /max_concurrent_threads_per_session = 3/u);
  assert.match(config?.content ?? "", /\[mcp_servers\.chartermesh\]/u);
  assert.match(config?.content ?? "", /cwd = "\."/u);
  assert.match(config?.content ?? "", /required = true/u);
  assert.match(config?.content ?? "", /startup_timeout_sec = 120/u);
  const verifier = first.operations.find(({ path }) =>
    path.endsWith("chartermesh-verifier.toml"),
  );
  assert.match(verifier?.content ?? "", /sandbox_mode = "read-only"/u);
  assert.match(verifier?.content ?? "", /name = "chartermesh-verifier"/u);
  assert.match(verifier?.content ?? "", /Organization role id: verifier/u);
  assert.match(verifier?.content ?? "", /ownerRole is exactly verifier/u);
  assert.match(verifier?.content ?? "", /Never resolve a human approval yourself/u);
  assert.equal(
    first.operations.some(({ content }) => content.includes(hostBinding.executablePath)),
    false,
  );

  const changed = createHostProjectionPlan({
    ...request,
    roles: roles.map((role) =>
      role.id === "implementer"
        ? { ...role, instructions: `${role.instructions} Add evidence.` }
        : role,
    ),
  });
  assert.notEqual(changed.planHash, first.planHash);
});

test("Claude projection uses project agents, MCP merge, and a CLAUDE pointer", async () => {
  const hostBinding = await binding("claude");
  const plan = createHostProjectionPlan({
    binding: hostBinding,
    roles,
    bridge: {
      command: "chartermesh",
      args: ["host", "mcp", "--stdio"],
    },
  });

  assert.deepEqual(
    plan.operations.map(({ path }) => path),
    [
      ".claude/agents/chartermesh-implementer.md",
      ".claude/agents/chartermesh-verifier.md",
      ".mcp.json",
      "CLAUDE.md",
    ],
  );
  const mcp = plan.operations.find(({ path }) => path === ".mcp.json");
  assert.equal(mcp?.kind, "merge_json_fragment");
  assert.deepEqual(JSON.parse(mcp?.content ?? "{}"), {
    mcpServers: {
      chartermesh: {
        args: ["host", "mcp", "--stdio"],
        command: "chartermesh",
        type: "stdio",
      },
    },
  });
  const agent = plan.operations.find(({ path }) =>
    path.endsWith("chartermesh-implementer.md"),
  );
  assert.match(agent?.content ?? "", /^---\nname: "chartermesh-implementer"/u);
  assert.match(agent?.content ?? "", /Organization role id: implementer/u);
  assert.match(agent?.content ?? "", /permissionMode: default/u);
  assert.doesNotMatch(agent?.content ?? "", /disallowedTools:/u);
  const verifier = plan.operations.find(({ path }) =>
    path.endsWith("chartermesh-verifier.md"),
  );
  assert.match(verifier?.content ?? "", /tools:\n  - Read\n  - Glob\n  - Grep\n  - mcp__chartermesh/u);
  assert.match(
    verifier?.content ?? "",
    /disallowedTools:\n  - Bash\n  - PowerShell\n  - Edit\n  - Write\n  - NotebookEdit/u,
  );
  assert.match(verifier?.content ?? "", /permissionMode: default/u);
  const pointer = plan.operations.find(({ path }) => path === "CLAUDE.md");
  assert.equal(pointer?.kind, "upsert_markdown_section");
  assert.match(pointer?.content ?? "", /\.chartermesh\/AGENT-ENTRYPOINT\.md/u);
  assert.match(pointer?.content ?? "", /parent host session has separate permissions/u);
});

test("projection rejects path traversal, duplicate roles, and unusable capabilities", async () => {
  const hostBinding = await binding("codex");
  assert.throws(
    () =>
      createHostProjectionPlan({
        binding: hostBinding,
        roles,
        bridge: { command: "chartermesh" },
        entrypointPath: "../outside.md",
      }),
    /contained project-relative path/u,
  );
  assert.throws(
    () =>
      createHostProjectionPlan({
        binding: hostBinding,
        roles: [roles[0]!, roles[0]!],
        bridge: { command: "chartermesh" },
      }),
    /role ids must be unique/u,
  );

  const unavailableSnapshot: HostCapabilitySnapshotInput = {
    contractVersion: hostBinding.capabilitySnapshot.contractVersion,
    hostKind: hostBinding.capabilitySnapshot.hostKind,
    capabilities: hostBinding.capabilitySnapshot.capabilities.map((entry) =>
      entry.name === "mcp.stdio"
        ? { ...entry, support: "unsupported" as const }
        : entry,
    ),
  };
  const unavailableDiscovery = await discoverHost(
    {
      hostKind: "codex",
      expectedExecutableSha256: executableSha256,
      capabilitySnapshot: unavailableSnapshot,
    },
    probes({ executablePath: hostBinding.executablePath }),
  );
  assert.equal(unavailableDiscovery.ok, true);
  assert.ok(unavailableDiscovery.binding);
  assert.throws(
    () =>
      createHostProjectionPlan({
        binding: unavailableDiscovery.binding!,
        roles,
        bridge: { command: "chartermesh" },
      }),
    /requires capability 'mcp\.stdio'/u,
  );
});
