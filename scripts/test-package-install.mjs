import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "chartermesh-package-"));
const packageDirectory = join(directory, "package");
const consumer = join(directory, "consumer");
const target = join(directory, "clean-project");
const claudeTarget = join(directory, "claude-project");
mkdirSync(packageDirectory);
mkdirSync(consumer);
mkdirSync(target);
mkdirSync(claudeTarget);

const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const npm = existsSync(npmCli) ? process.execPath : "npm";
const npmPrefix = existsSync(npmCli) ? [npmCli] : [];
const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      CHARTERMESH_NO_UPDATE_CHECK: "1",
      npm_config_cache: join(directory, "npm-cache"),
      npm_config_update_notifier: "false",
    },
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(" ")}\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result.stdout;
};

const openMcpSession = (args, options = {}) => {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: target,
    env: {
      ...process.env,
      CHARTERMESH_NO_UPDATE_CHECK: "1",
      npm_config_cache: join(directory, "npm-cache"),
      npm_config_update_notifier: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  const pending = new Map();

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  const consumeLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      rejectPending(
        new Error(
          `MCP server emitted invalid JSON: ${line}\n${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      child.kill();
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    entry.resolve(message);
  };
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let exitSettled = false;
  const settleExit = (result) => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit(result);
  };
  child.once("error", (error) => {
    rejectPending(error);
    settleExit({ code: null, error });
  });
  child.once("close", (code, signal) => {
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
    if (pending.size > 0) {
      rejectPending(
        new Error(
          `MCP server exited before replying (code=${code}, signal=${signal}).\n${stderr}`,
        ),
      );
    }
    settleExit({ code, signal });
  });

  return {
    request(message) {
      assert.notEqual(message.id, undefined);
      assert.equal(pending.has(String(message.id)), false);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(message.id));
          reject(new Error(`Timed out waiting for MCP response ${message.id}.\n${stderr}`));
          child.kill();
        }, 15_000);
        pending.set(String(message.id), { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!error) return;
          const entry = pending.get(String(message.id));
          if (!entry) return;
          pending.delete(String(message.id));
          clearTimeout(entry.timer);
          reject(error);
        });
      });
    },
    async close() {
      child.stdin.end();
      const result = await exited;
      assert.equal(
        result.code,
        0,
        `MCP server failed (code=${result.code}, signal=${result.signal ?? "none"}).\n${result.error?.message ?? ""}\n${stderr}`,
      );
    },
  };
};

const mcpToolData = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.ok(response.result && typeof response.result === "object");
  const envelope = response.result.structuredContent;
  assert.ok(envelope && typeof envelope === "object");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope.data;
};

const packed = JSON.parse(
  run(npm, [
    ...npmPrefix,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
  ]),
);
assert.equal(packed.length, 1);
const archive = join(packageDirectory, packed[0].filename);
assert.equal(existsSync(archive), true);
run(npm, [
  ...npmPrefix,
  "install",
  "--no-audit",
  "--no-fund",
  "--prefix",
  consumer,
  archive,
]);

const installed = join(
  consumer,
  "node_modules",
  "chartermesh",
);
const executable = join(installed, "bin", "chartermesh.mjs");
assert.equal(existsSync(executable), true);
for (const packagedContract of [
  "CHANGELOG.md",
  "SECURITY.md",
  join("docs", "USER-GUIDE.ko.md"),
  join("docs", "DECISION-REVIEW-PROXY-BENCHMARK.md"),
  join("schemas", "decision-packet-v1alpha2.schema.json"),
  join("schemas", "artifact-producer-report-v1alpha1.schema.json"),
  join("schemas", "project-preferences-v1alpha1.schema.json"),
  join("docs", "PROJECT-CUSTOMIZATION.md"),
]) {
  assert.equal(
    existsSync(join(installed, packagedContract)),
    true,
    `packed contract is missing: ${packagedContract}`,
  );
}
assert.equal(
  existsSync(
    join(installed, "scripts", "run-execution-evaluation.mjs"),
  ),
  true,
);
for (const binary of [
  "chartermesh",
  "chartermesh-evaluate-code-generate",
  "chartermesh-evaluate-code-run",
]) {
  assert.equal(
    existsSync(
      join(
        consumer,
        "node_modules",
        ".bin",
        process.platform === "win32" ? `${binary}.cmd` : binary,
      ),
    ),
    true,
  );
}
const codeGenerationScript = join(
  installed,
  "scripts",
  "run-code-generation-stage.mjs",
);
const codeEvaluationScript = join(
  installed,
  "scripts",
  "run-code-sandbox-evaluation.mjs",
);
assert.equal(existsSync(codeGenerationScript), true);
assert.equal(existsSync(codeEvaluationScript), true);
for (const guestScript of [
  "candidate-executor.mjs",
  "candidate-worker.mjs",
  "guest-canary.mjs",
  "guest-runner.mjs",
  "canary-candidate.mjs",
]) {
  assert.equal(
    existsSync(
      join(installed, "scripts", "windows-sandbox", guestScript),
    ),
    true,
  );
}
assert.equal(
  existsSync(
    join(installed, "dist", "skills", "web-research", "SKILL.md"),
  ),
  true,
);
const version = JSON.parse(
  run(process.execPath, [executable, "version", "--json"], {
    cwd: target,
  }),
);
assert.equal(version.data.currentVersion, "0.0.10-alpha.1");

for (const script of [codeGenerationScript, codeEvaluationScript]) {
  const result = spawnSync(
    process.execPath,
    [script, "--unsupported-package-smoke", "1"],
    {
      cwd: target,
      encoding: "utf8",
      env: {
        ...process.env,
        CHARTERMESH_NO_UPDATE_CHECK: "1",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    /Unknown argument '--unsupported-package-smoke'/u,
  );
}

const proposal = JSON.parse(
  run(
    process.execPath,
    [executable, "propose", "--target", target, "--json"],
  ),
);
assert.equal(proposal.data.organization.kind, "Organization");
const brief = join(directory, "project-brief.md");
writeFileSync(
  brief,
  "# Package friend-flow smoke\n\nCreate a reviewed offline fixture through projected coding-host roles.\n",
  "utf8",
);
const preview = JSON.parse(
  run(
    process.execPath,
    [
      executable,
      "kickoff",
      "--target",
      target,
      "--brief-file",
      brief,
      "--profile",
      "controlled",
      "--engine",
      "fake",
      "--json",
    ],
  ),
);
assert.equal(preview.data.approvalRequired, true);
assert.equal(existsSync(join(target, ".chartermesh")), false);
run(process.execPath, [
  executable,
  "kickoff",
  "--target",
  target,
  "--brief-file",
  brief,
  "--profile",
  "controlled",
  "--engine",
  "fake",
  "--json",
  "--approve",
  preview.data.planHash,
]);
const generatedGuide = readFileSync(join(target, "CHARTERMESH.md"), "utf8");
assert.match(
  generatedGuide,
  /npx --yes github:jade-blanco\/chartermesh#v0\.0\.10-alpha\.1 doctor --target \./u,
);
assert.doesNotMatch(generatedGuide, /^chartermesh doctor --target/mu);
const doctor = JSON.parse(
  run(process.execPath, [
    executable,
    "doctor",
    "--target",
    target,
    "--json",
  ]),
);
assert.equal(doctor.ok, true);
const preferenceFile = join(directory, "project-preferences.json");
const preferences = {
  apiVersion: "chartermesh.dev/project-preferences/v1alpha1", language: "ko",
  approvalDetail: "concise", tone: "formal", projectInstructions: "Use a short project summary.",
  roleInstructions: { operator: "Explain the deliverable to a non-specialist." },
};
writeFileSync(preferenceFile, JSON.stringify(preferences));
const customizeArgs = ["configure-project", "--target", target, "--preferences-file", preferenceFile, "--json"];
const customPreview = JSON.parse(run(process.execPath, [executable, ...customizeArgs])).data;
assert.equal(customPreview.approvalRequired, true);
run(process.execPath, [executable, ...customizeArgs, "--approve", customPreview.planHash]);
assert.deepEqual(JSON.parse(run(process.execPath, [executable, "project-config", "--target", target, "--json"])).data.preferences, preferences);
const fakeCodexSource = [
  'if(process.argv.includes("--version")){',
  'console.log("codex-cli 0.145.0");process.exit(0)}',
].join("");
const hostArguments = [
  "--host",
  "codex",
  "--target",
  target,
  "--executable",
  process.execPath,
  "--host-arg",
  "--eval",
  "--host-arg",
  fakeCodexSource,
  "--host-arg",
  "chartermesh-package-fixture",
  "--allow-unrestricted-read",
  "--json",
];
const hostDoctor = JSON.parse(
  run(process.execPath, [executable, "host", "doctor", ...hostArguments]),
);
assert.equal(hostDoctor.data.ready, true);
assert.equal(hostDoctor.data.protocolVersion, null);
const hostPreview = JSON.parse(
  run(process.execPath, [executable, "configure-host", ...hostArguments]),
);
assert.equal(hostPreview.data.approvalRequired, true);
run(process.execPath, [
  executable,
  "configure-host",
  ...hostArguments,
  "--approve",
  hostPreview.data.planHash,
]);
assert.equal(
  existsSync(join(target, ".codex", "agents", "chartermesh-operator.toml")),
  true,
);
assert.equal(
  existsSync(join(target, ".codex", "agents", "chartermesh-verifier.toml")),
  true,
);
assert.match(
  readFileSync(join(target, ".codex", "config.toml"), "utf8"),
  /mcp_servers\.chartermesh/u,
);
const customOrganization = JSON.parse(run(process.execPath,
  [executable, "project-config", "--target", target, "--json"])).data.organization;
customOrganization.metadata.revision++;
customOrganization.spec.roles.push({
  ...customOrganization.spec.roles.find(({ id }) => id === "operator"),
  id: "editor", name: "Project Editor", capabilities: ["editing"],
});
const organizationFile = join(directory, "custom-organization.json");
writeFileSync(organizationFile, JSON.stringify(customOrganization));
const customHostArgs = ["configure-project", ...hostArguments,
  "--organization-file", organizationFile,
  "--executable-sha256", hostPreview.data.hostBinding.executableSha256];
const customHostPlan = JSON.parse(run(process.execPath, [executable, ...customHostArgs])).data;
assert.equal(existsSync(join(target, ".codex", "agents", "chartermesh-editor.toml")), false);
run(process.execPath, [executable, ...customHostArgs, "--approve", customHostPlan.planHash]);
assert.equal(existsSync(join(target, ".codex", "agents", "chartermesh-editor.toml")), true);
assert.deepEqual(JSON.parse(run(process.execPath, [executable, "project-config", "--target", target, "--json"])).data.preferences, preferences);
const nested = join(target, "src", "nested");
mkdirSync(nested, { recursive: true });
const mcpOutput = run(
  process.execPath,
  [
    executable,
    "mcp",
    "serve",
    "--find-project-root",
    "--actor",
    "host:package-smoke",
    "--role",
    "operator",
    "--role",
    "verifier",
    "--execution-target",
    "codex-project",
  ],
  {
    cwd: nested,
    input: [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "chartermesh_work_next", arguments: {} },
      }),
      "",
    ].join("\n"),
  },
);
const mcpMessages = mcpOutput
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line));
assert.match(mcpMessages[0].result.sessionActor, /^runner:host-package-smoke-/u);
assert.equal(mcpMessages[1].result.structuredContent.ok, true);
assert.equal(
  mcpMessages[1].result.structuredContent.data.workItem.executionTarget,
  "codex-project",
);

const governedRequest = JSON.parse(
  run(process.execPath, [
    executable,
    "request",
    "--target",
    target,
    "--title",
    "Apply one reviewed package-smoke change set",
    "--summary",
    "Request two exact UTF-8 files, wait for human approval, and execute only the stored bytes after a new claim.",
    "--require-tool",
    "workspace.write_file",
    "--idempotency-key",
    "package-smoke:governed:intake",
    "--json",
  ]),
).data;
const governedReady = JSON.parse(
  run(process.execPath, [
    executable,
    "triage",
    "--target",
    target,
    "--id",
    governedRequest.id,
    "--role",
    "operator",
    "--execution-target",
    "codex-project",
    "--idempotency-key",
    "package-smoke:governed:triage",
    "--json",
  ]),
).data;
assert.equal(governedReady.status, "ready");
assert.equal(governedReady.executionTarget, "codex-project");

const governedPaths = [
  {
    path: "generated/package-smoke.txt",
    content: "human-approved package smoke\n",
    beforeSha256: null,
  },
  {
    path: "generated/package-smoke.json",
    content: '{"approved":true}\n',
    beforeSha256: null,
  },
];
const governedOutputPaths = governedPaths.map(({ path }) => join(target, path));
for (const path of governedOutputPaths) assert.equal(existsSync(path), false);

const mcpServeArguments = [
  "mcp",
  "serve",
  "--find-project-root",
  "--actor",
  "host:package-governed",
  "--role",
  "operator",
  "--role",
  "verifier",
  "--execution-target",
  "codex-project",
];
let firstClaim;
let requestedChangeSet;
const firstGovernedSession = openMcpSession(mcpServeArguments, { cwd: nested });
try {
  const initialized = await firstGovernedSession.request({
    jsonrpc: "2.0",
    id: 100,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {} },
  });
  assert.match(initialized.result.sessionActor, /^runner:host-package-governed-/u);
  firstClaim = mcpToolData(
    await firstGovernedSession.request({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "chartermesh_work_claim",
        arguments: {
          id: governedReady.id,
          expectedVersion: governedReady.version,
          idempotencyKey: "package-smoke:governed:claim:1",
        },
      },
    }),
  );
  requestedChangeSet = mcpToolData(
    await firstGovernedSession.request({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "chartermesh_workspace_changes_request",
        arguments: {
          id: governedReady.id,
          runId: firstClaim.runId,
          attemptId: firstClaim.attemptId,
          leaseId: firstClaim.leaseId,
          generation: firstClaim.generation,
          changes: governedPaths,
          idempotencyKey: "package-smoke:governed:request",
        },
      },
    }),
  );
} finally {
  await firstGovernedSession.close();
}
assert.match(requestedChangeSet.pending.callHash, /^[a-f0-9]{64}$/u);
assert.equal(requestedChangeSet.pending.status, "approval_required");
assert.equal(requestedChangeSet.pending.summary.changeCount, governedPaths.length);
for (const path of governedOutputPaths) assert.equal(existsSync(path), false);

const approvedToolCall = JSON.parse(
  run(process.execPath, [
    executable,
    "approve-tool",
    "--target",
    target,
    "--id",
    governedReady.id,
    "--call-hash",
    requestedChangeSet.pending.callHash,
    "--tool",
    "workspace.write_file",
    "--packet-hash",
    requestedChangeSet.decisionPacketHash,
    "--note",
    "Approved the exact packed-install fixture bytes.",
    "--idempotency-key",
    "package-smoke:governed:approve",
    "--json",
  ]),
).data;
assert.equal(approvedToolCall.workItemId, governedReady.id);
assert.equal(approvedToolCall.callHash, requestedChangeSet.pending.callHash);
const approvedPage = JSON.parse(
  run(process.execPath, [executable, "list", "--target", target, "--json"]),
).data;
const approvedWorkItem = approvedPage.items.find(
  ({ id }) => id === governedReady.id,
);
assert.ok(approvedWorkItem);
assert.equal(approvedWorkItem.status, "ready");

let executedChangeSet;
const secondGovernedSession = openMcpSession(mcpServeArguments, { cwd: nested });
try {
  await secondGovernedSession.request({
    jsonrpc: "2.0",
    id: 200,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {} },
  });
  const secondClaim = mcpToolData(
    await secondGovernedSession.request({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "chartermesh_work_claim",
        arguments: {
          id: governedReady.id,
          expectedVersion: approvedWorkItem.version,
          idempotencyKey: "package-smoke:governed:claim:2",
        },
      },
    }),
  );
  assert.ok(secondClaim.generation > firstClaim.generation);
  executedChangeSet = mcpToolData(
    await secondGovernedSession.request({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: {
        name: "chartermesh_workspace_write_execute",
        arguments: {
          id: governedReady.id,
          runId: secondClaim.runId,
          attemptId: secondClaim.attemptId,
          leaseId: secondClaim.leaseId,
          generation: secondClaim.generation,
          callHash: requestedChangeSet.pending.callHash,
          idempotencyKey: "package-smoke:governed:execute",
        },
      },
    }),
  );
} finally {
  await secondGovernedSession.close();
}
assert.equal(executedChangeSet.pendingStatus, "executed");
for (const [index, outputPath] of governedOutputPaths.entries()) {
  assert.equal(readFileSync(outputPath, "utf8"), governedPaths[index].content);
}
const governedEvidence = JSON.parse(
  run(process.execPath, [
    executable,
    "tool-evidence",
    "--target",
    target,
    "--id",
    governedReady.id,
    "--json",
  ]),
).data;
assert.equal(governedEvidence.items.length, 1);
assert.equal(governedEvidence.items[0].status, "succeeded");
assert.equal(
  governedEvidence.items[0].callHash,
  requestedChangeSet.pending.callHash,
);
assert.deepEqual(
  governedEvidence.items[0].paths,
  governedPaths.map(({ path }) => path).sort(),
);
assert.equal(governedEvidence.pendingToolCalls[0].status, "executed");

const claudeBootstrapArguments = [
  "bootstrap",
  "--target",
  claudeTarget,
  "--profile",
  "controlled",
  "--engine",
  "fake",
  "--json",
];
const claudeBootstrapPreview = JSON.parse(
  run(process.execPath, [executable, ...claudeBootstrapArguments]),
);
assert.equal(claudeBootstrapPreview.data.approvalRequired, true);
run(process.execPath, [
  executable,
  ...claudeBootstrapArguments,
  "--approve",
  claudeBootstrapPreview.data.planHash,
]);
const fakeClaudeSource =
  'if(process.argv.includes("--version"))console.log("2.1.223 (Claude Code)")';
const claudeHostArguments = [
  "--host",
  "claude",
  "--target",
  claudeTarget,
  "--executable",
  process.execPath,
  "--host-arg",
  "--eval",
  "--host-arg",
  fakeClaudeSource,
  "--host-arg",
  "chartermesh-package-fixture",
  "--json",
];
const claudeHostDoctor = JSON.parse(
  run(process.execPath, [executable, "host", "doctor", ...claudeHostArguments]),
);
assert.equal(claudeHostDoctor.data.ready, true);
assert.equal(claudeHostDoctor.data.protocolVersion, null);
const claudeHostPreview = JSON.parse(
  run(process.execPath, [executable, "configure-host", ...claudeHostArguments]),
);
assert.equal(claudeHostPreview.data.approvalRequired, true);
run(process.execPath, [
  executable,
  "configure-host",
  ...claudeHostArguments,
  "--approve",
  claudeHostPreview.data.planHash,
]);
assert.equal(
  existsSync(join(claudeTarget, ".claude", "agents", "chartermesh-operator.md")),
  true,
);
assert.equal(
  existsSync(join(claudeTarget, ".claude", "agents", "chartermesh-verifier.md")),
  true,
);
const claudeMcp = JSON.parse(
  readFileSync(join(claudeTarget, ".mcp.json"), "utf8"),
);
assert.equal(claudeMcp.mcpServers.chartermesh.type, "stdio");
assert.equal(claudeMcp.mcpServers.chartermesh.command, "npx");
assert.deepEqual(
  claudeMcp.mcpServers.chartermesh.args.slice(0, 2),
  ["--yes", "github:jade-blanco/chartermesh#v0.0.10-alpha.1"],
);
assert.match(
  readFileSync(join(claudeTarget, "CLAUDE.md"), "utf8"),
  /chartermesh-host-integration:begin/u,
);
const claudeDoctor = JSON.parse(
  run(process.execPath, [
    executable,
    "doctor",
    "--target",
    claudeTarget,
    "--json",
  ]),
);
assert.equal(claudeDoctor.ok, true);

assert.equal(
  existsSync(
    join(
      target,
      ".chartermesh",
      "skills",
      "small-model-evidence",
      "SKILL.md",
    ),
  ),
  true,
);
assert.equal(
  JSON.parse(
    readFileSync(
      join(target, ".chartermesh", "installation.json"),
      "utf8",
    ),
  ).charterMeshVersion,
  "0.0.10-alpha.1",
);
console.log(`Package install check passed: ${packed[0].filename}`);
