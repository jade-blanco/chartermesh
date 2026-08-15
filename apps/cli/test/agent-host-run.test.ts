import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentHost,
  AgentHostManifest,
  AgentHostRunHandle,
  HostResumeRequest,
  HostRunEvent,
  HostRunRequest,
  HostRunResult,
} from "../../../packages/adapter-sdk/src/index.ts";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";
import { runWork, main } from "../src/main.ts";

const completedOutput = JSON.stringify({
  apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
  summary: "Implemented the bounded request.",
  deliverable: "A reviewable host-produced artifact.",
  checks: [],
  risks: ["Direct provider cost is not reported."],
  nextActions: ["Review the exact artifact hash."],
  confidence: "medium",
});

class FixtureAgentHost implements AgentHost {
  readonly manifest: AgentHostManifest = {
    kind: "agent_host",
    profileId: "codex-host",
    adapter: "fixture-agent-host",
    contractVersion: "v1alpha2",
    permissionCeiling: "read_only",
    engineBinding: "host_managed",
    capabilities: [],
  };
  readonly approval: boolean;
  request: HostRunRequest | undefined;

  constructor(approval = false) {
    this.approval = approval;
  }

  async discover() {
    return {
      available: true,
      profileId: this.manifest.profileId,
      adapter: this.manifest.adapter,
      providerVersion: "fixture",
      protocolVersion: "fixture",
      capabilities: [],
      diagnostics: [],
    };
  }

  async start(request: HostRunRequest): Promise<AgentHostRunHandle> {
    this.request = request;
    return {
      hostRunId: "turn-fixture",
      hostSessionId: "thread-fixture",
      status: "running",
    };
  }

  async resume(request: HostResumeRequest): Promise<AgentHostRunHandle> {
    return this.start(request);
  }

  async *events(): AsyncIterable<HostRunEvent> {
    yield {
      type: "status",
      status: "running",
      hostRunId: "turn-fixture",
      hostSessionId: "thread-fixture",
      sequence: 1,
      occurredAt: "2026-08-14T00:00:00.000Z",
    };
    if (this.approval) {
      yield {
        type: "approval_required",
        approval: {
          requestId: "approval-fixture",
          kind: "file_change",
          summary: "A provider requested a file change.",
        },
        hostRunId: "turn-fixture",
        hostSessionId: "thread-fixture",
        sequence: 2,
        occurredAt: "2026-08-14T00:00:01.000Z",
      };
    }
    yield {
      type: "terminal",
      result: await this.result("turn-fixture"),
      hostRunId: "turn-fixture",
      hostSessionId: "thread-fixture",
      sequence: this.approval ? 3 : 2,
      occurredAt: "2026-08-14T00:00:02.000Z",
    };
  }

  async result(): Promise<HostRunResult> {
    return {
      hostRunId: "turn-fixture",
      hostSessionId: "thread-fixture",
      status: "completed",
      outputText: completedOutput,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cost: null,
        measurementStatus: "unknown",
      },
      error: null,
      cancelReason: null,
    };
  }

  async cancel(): Promise<void> {}
}

class FailingEventAgentHost extends FixtureAgentHost {
  cancelCalls = 0;

  async *events(): AsyncIterable<HostRunEvent> {
    throw new Error("FIXTURE_EVENT_STREAM_FAILED");
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

async function hostFixture(suffix: string) {
  const target = mkdtempSync(join(tmpdir(), `chartermesh-host-run-${suffix}-`));
  let output = "";
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output += `${values.join(" ")}\n`;
  };
  try {
    await main(["bootstrap", "--target", target, "--engine", "fake", "--json"]);
  } finally {
    console.log = originalLog;
  }
  const planHash = (JSON.parse(output) as { data: { planHash: string } }).data.planHash;
  console.log = () => {};
  try {
    await main([
      "bootstrap",
      "--target",
      target,
      "--engine",
      "fake",
      "--json",
      "--approve",
      planHash,
    ]);
  } finally {
    console.log = originalLog;
  }
  const organizationPath = join(target, ".chartermesh", "organization.json");
  const organization = JSON.parse(readFileSync(organizationPath, "utf8"));
  organization.metadata.revision += 1;
  organization.spec.agentHosts.push({
    id: "codex-host",
    adapter: "codex-app-server",
    executionHost: "local",
    enabled: true,
  });
  organization.spec.executionTargets.push({
    id: "codex-host",
    kind: "agent_host",
    hostRef: "codex-host",
    enabled: true,
  });
  const operator = organization.spec.roles.find(
    ({ id }: { id: string }) => id === "operator",
  );
  if (!operator) throw new Error("Fixture operator role is missing.");
  operator.execution = { preferred: "codex-host", fallbacks: ["local"] };
  writeFileSync(organizationPath, `${JSON.stringify(organization, null, 2)}\n`);
  const runtimePath = join(target, ".chartermesh", "runtime.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  runtime.modelEngines = [
    {
      id: "unused-invalid-managed-engine",
      adapter: "openai-compatible",
      endpoint: "http://public.example/v1",
      model: "must-not-be-instantiated-for-agent-host-routing",
    },
  ];
  runtime.managedRunners[0].modelEngineRef = "unused-invalid-managed-engine";
  runtime.agentHosts = [
    {
      id: "codex-host",
      adapter: "codex-app-server",
      command: process.execPath,
      executableSha256: createHash("sha256")
        .update(readFileSync(process.execPath))
        .digest("hex"),
    },
  ];
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  const controlPlane = new ControlPlane(database, join(target, ".chartermesh", "artifacts"));
  const item = controlPlane.intake({
    title: "Create an AgentHost artifact",
    summary: "Use a durable external host binding and return structured output.",
    actor: "human:test",
    idempotencyKey: `host-run:${suffix}:intake`,
  });
  database.close();
  console.log = () => {};
  try {
    await main([
      "triage",
      "--id",
      item.id,
      "--role",
      "operator",
      "--target",
      target,
      "--json",
    ]);
  } finally {
    console.log = originalLog;
  }
  const routedDatabase = openControlPlaneDatabase(
    join(target, ".chartermesh", "state.db"),
  );
  try {
    assert.equal(
      new ControlPlane(
        routedDatabase,
        join(target, ".chartermesh", "artifacts"),
      ).get(item.id).executionTarget,
      "codex-host",
    );
  } finally {
    routedDatabase.close();
  }
  return { target, item };
}

test("run routes an agent_host target and persists provider ids before review", async () => {
  const { target, item } = await hostFixture("success");
  const host = new FixtureAgentHost();
  const result = await runWork(target, item.id, {
    quiet: true,
    agentHostFactory: () => host,
  });
  assert.equal(result.status, "submitted_for_review");
  assert.equal(host.request?.organizationRevision, 2);
  assert.equal(host.request?.workspacePath, target);
  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const controlPlane = new ControlPlane(database, join(target, ".chartermesh", "artifacts"));
    const current = controlPlane.get(item.id);
    assert.equal(current.status, "review_pending");
    const attempts = controlPlane.listAttempts();
    const binding = controlPlane.agentHostRunBinding(attempts[0]!.runId);
    assert.equal(binding?.hostSessionId, "thread-fixture");
    assert.equal(binding?.hostRunId, "turn-fixture");
    assert.equal(binding?.status, "succeeded");
    assert.equal(controlPlane.listInvocations()[0]?.status, "succeeded");
  } finally {
    database.close();
  }
});

test("an active provider turn is canceled when host event processing fails", async () => {
  const { target, item } = await hostFixture("event-failure");
  const host = new FailingEventAgentHost();
  await assert.rejects(
    () =>
      runWork(target, item.id, {
        quiet: true,
        agentHostFactory: () => host,
      }),
    /FIXTURE_EVENT_STREAM_FAILED/u,
  );
  assert.equal(host.cancelCalls, 1);
  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const controlPlane = new ControlPlane(database, join(target, ".chartermesh", "artifacts"));
    assert.equal(controlPlane.get(item.id).status, "failed");
  } finally {
    database.close();
  }
});

test("provider approval requests fail closed and never become human approval", async () => {
  const { target, item } = await hostFixture("approval");
  await assert.rejects(
    () =>
      runWork(target, item.id, {
        quiet: true,
        agentHostFactory: () => new FixtureAgentHost(true),
      }),
    /AGENT_HOST_APPROVAL_UNRESOLVED/u,
  );
  const database = openControlPlaneDatabase(join(target, ".chartermesh", "state.db"));
  try {
    const controlPlane = new ControlPlane(database, join(target, ".chartermesh", "artifacts"));
    assert.equal(controlPlane.get(item.id).status, "failed");
    const binding = controlPlane.agentHostRunBinding(
      controlPlane.listAttempts()[0]!.runId,
    );
    assert.equal(binding?.status, "failed");
    assert.equal(binding?.errorCode, "AGENT_HOST_APPROVAL_UNRESOLVED");
    assert.equal(controlPlane.latestArtifact(item.id), null);
  } finally {
    database.close();
  }
});
