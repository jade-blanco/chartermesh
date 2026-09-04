import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  ControlPlane,
  acquireMaintenanceLock,
  openControlPlaneDatabase,
} from "../../../packages/control-plane/src/index.ts";
import { applyFileTransaction } from "../../../packages/compiler/src/index.ts";
import {
  CONTROL_PLANE_MCP_TOOLS,
  createControlPlaneMcpHandler,
  openControlPlaneMcpBridge,
  type ControlPlaneMcpHandler,
  type JsonRpcResponse,
} from "../src/mcp-server.ts";

function fixture(
  options: { target?: string; workspaceRoot?: string } = {},
) {
  const target = options.target ??
    mkdtempSync(join(tmpdir(), "chartermesh-mcp-"));
  const stateDirectory = join(target, ".chartermesh");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(
    join(stateDirectory, "organization.json"),
    readFileSync(
      join(
        import.meta.dirname,
        "../../../examples/balanced-software-team/organization.json",
      ),
    ),
  );
  writeFileSync(join(stateDirectory, "runtime.json"), "{}\n");
  const database = openControlPlaneDatabase(join(stateDirectory, "state.db"));
  const controlPlane = new ControlPlane(
    database,
    join(stateDirectory, "artifacts"),
  );
  return {
    target,
    database,
    controlPlane,
    handler: createControlPlaneMcpHandler({
      controlPlane,
      actor: "host:test-codex",
      allowedRoles: ["implementer"],
      allowedExecutionTargets: ["codex"],
      workspaceRoot: options.workspaceRoot ?? target,
      rolePolicies: {
        implementer: {
          allow: ["workspace.write_file"],
          approvalRequired: ["workspace.write_file"],
          workspaceRoots: ["."],
          maxIterations: 4,
        },
      },
    }),
  };
}

async function asyncToolCall(
  handler: ControlPlaneMcpHandler,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  const response = await handler.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.ok(response);
  return response;
}

function toolCall(
  handler: ControlPlaneMcpHandler,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): JsonRpcResponse {
  const response = handler.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.ok(response);
  return response;
}

function toolEnvelope(response: JsonRpcResponse): Record<string, unknown> {
  assert.equal(response.error, undefined);
  assert.ok(response.result && typeof response.result === "object");
  const result = response.result as {
    structuredContent?: Record<string, unknown>;
  };
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

async function approvedWorkspaceChange(
  context: ReturnType<typeof fixture>,
  prefix: string,
  changes: Array<{ path: string; content: string; beforeSha256: string | null }>,
) {
  const requested = context.controlPlane.intake({
    title: `Approved workspace change ${prefix}`,
    summary: "Exercise the governed workspace execution boundary.",
    actor: "human:test",
    idempotencyKey: `${prefix}:intake`,
  });
  const ready = context.controlPlane.triage({
    id: requested.id,
    ownerRole: "implementer",
    executionTarget: "codex",
    expectedVersion: requested.version,
    actor: "human:test",
    idempotencyKey: `${prefix}:triage`,
  });
  const firstClaimResult = toolEnvelope(toolCall(
    context.handler,
    100,
    "chartermesh_work_claim",
    { id: ready.id, expectedVersion: ready.version, idempotencyKey: `${prefix}:claim:1` },
  )).data as {
    runId: string;
    attemptId: string;
    leaseId: string;
    generation: number;
  };
  const firstClaim = {
    runId: firstClaimResult.runId,
    attemptId: firstClaimResult.attemptId,
    leaseId: firstClaimResult.leaseId,
    generation: firstClaimResult.generation,
  };
  const proposal = toolEnvelope(await asyncToolCall(
    context.handler,
    101,
    "chartermesh_workspace_changes_request",
    {
      id: ready.id,
      ...firstClaim,
      changes,
      idempotencyKey: `${prefix}:request`,
    },
  ));
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  const callHash = (proposal.data as { pending: { callHash: string } }).pending.callHash;
  const packet = context.controlPlane.decisionPacket(ready.id)!;
  context.controlPlane.approveToolCall({
    id: ready.id,
    callHash,
    toolName: "workspace.write_file",
    packetHash: packet.binding.packetHash,
    actor: "human:test",
    note: "Approve exact change set for boundary testing.",
    idempotencyKey: `${prefix}:approve`,
  });
  const approved = context.controlPlane.get(ready.id);
  const claimResult = toolEnvelope(toolCall(
    context.handler,
    102,
    "chartermesh_work_claim",
    { id: ready.id, expectedVersion: approved.version, idempotencyKey: `${prefix}:claim:2` },
  )).data as typeof firstClaim;
  const claim = {
    runId: claimResult.runId,
    attemptId: claimResult.attemptId,
    leaseId: claimResult.leaseId,
    generation: claimResult.generation,
  };
  return { id: ready.id, callHash, claim };
}

test("MCP initialization and tool discovery expose no human authority", () => {
  const context = fixture();
  try {
    const initialized = context.handler.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );
    assert.ok(initialized?.result);
    assert.equal(
      (initialized.result as { serverInfo: { name: string } }).serverInfo.name,
      "chartermesh-control-plane",
    );
    assert.equal(
      (initialized.result as { sessionActor: string }).sessionActor,
      context.handler.sessionActor,
    );
    assert.match(
      context.handler.sessionActor,
      /^runner:host-test-codex-[a-f0-9]{24}$/u,
    );

    const listed = context.handler.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.ok(listed?.result);
    const names = (
      listed.result as { tools: Array<{ name: string }> }
    ).tools.map(({ name }) => name);
    assert.deepEqual(
      names,
      CONTROL_PLANE_MCP_TOOLS.map(({ name }) => name),
    );
    assert.equal(names.some((name) => /approve|resolve|organization/u.test(name)), false);
    assert.equal(names.includes("chartermesh_artifact_submit"), true);
    assert.equal(names.includes("chartermesh_work_claim"), true);
    assert.equal(names.includes("chartermesh_workspace_write_request"), true);
    assert.equal(names.includes("chartermesh_workspace_changes_request"), true);
    assert.equal(names.includes("chartermesh_workspace_write_execute"), true);

    const unauthorized = toolEnvelope(
      toolCall(context.handler, 3, "chartermesh_approval_resolve", {}),
    );
    assert.equal(unauthorized.sessionActor, context.handler.sessionActor);
    assert.equal(unauthorized.ok, false);
    assert.match(
      String((unauthorized.error as { message: string }).message),
      /Unknown or unauthorized tool/u,
    );
  } finally {
    context.database.close();
  }
});

test("MCP claim routing is bound to the configured role and execution target", () => {
  const context = fixture();
  try {
    const create = (
      suffix: string,
      ownerRole: string,
      executionTarget: string,
      priority: number,
    ) => {
      const requested = context.controlPlane.intake({
        title: `Route ${suffix}`,
        summary: "Only the bound host queue may claim this work.",
        priority,
        actor: "human:test",
        idempotencyKey: `route:${suffix}:intake`,
      });
      return context.controlPlane.triage({
        id: requested.id,
        ownerRole,
        executionTarget,
        expectedVersion: requested.version,
        actor: "human:test",
        idempotencyKey: `route:${suffix}:triage`,
      });
    };
    const forbidden = create("forbidden", "reviewer", "claude", 100);
    const allowed = create("allowed", "implementer", "codex", 10);
    const next = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_next"),
    );
    assert.equal(
      (next.data as { workItem: { id: string } }).workItem.id,
      allowed.id,
    );
    const denied = toolEnvelope(
      toolCall(context.handler, 2, "chartermesh_work_claim", {
        id: forbidden.id,
        expectedVersion: forbidden.version,
        idempotencyKey: "route:forbidden:claim",
      }),
    );
    assert.equal(denied.ok, false);
    assert.match(
      String((denied.error as { code: string }).code),
      /MCP_ROUTE_DENIED/u,
    );
    const listed = toolEnvelope(
      toolCall(context.handler, 21, "chartermesh_work_list", {
        includeCompleted: true,
      }),
    );
    const listedIds = (listed.data as { items: Array<{ id: string }> }).items
      .map(({ id }) => id);
    assert.ok(listedIds.includes(allowed.id));
    assert.equal(listedIds.includes(forbidden.id), false);
    for (const [index, name] of [
      "chartermesh_work_show",
      "chartermesh_decision_show",
      "chartermesh_artifact_show",
    ].entries()) {
      const readDenied = toolEnvelope(
        toolCall(context.handler, 22 + index, name, { id: forbidden.id }),
      );
      assert.equal(readDenied.ok, false, name);
      assert.match(
        String((readDenied.error as { code: string }).code),
        /MCP_ROUTE_DENIED/u,
      );
    }
    const reviewerHandler = createControlPlaneMcpHandler({
      controlPlane: context.controlPlane,
      actor: "host:reviewer",
      allowedRoles: ["reviewer"],
      allowedExecutionTargets: ["claude"],
    });
    const reviewerClaim = toolEnvelope(
      toolCall(reviewerHandler, 30, "chartermesh_work_claim", {
        id: forbidden.id,
        expectedVersion: forbidden.version,
        idempotencyKey: "route:forbidden:reviewer-claim",
      }),
    ).data as { runId: string };
    const runDenied = toolEnvelope(
      toolCall(context.handler, 31, "chartermesh_run_show", {
        runId: reviewerClaim.runId,
      }),
    );
    assert.equal(runDenied.ok, false);
    assert.match(
      String((runDenied.error as { code: string }).code),
      /MCP_ROUTE_DENIED/u,
    );
    const unbound = createControlPlaneMcpHandler({
      controlPlane: context.controlPlane,
      actor: "host:unbound",
    });
    assert.equal(
      (toolEnvelope(toolCall(unbound, 3, "chartermesh_work_next"))).data,
      null,
    );
  } finally {
    context.database.close();
  }
});

test("MCP bridge runs a fenced claim, progress, heartbeat, and artifact submission", () => {
  const context = fixture();
  try {
    const requested = context.controlPlane.intake({
      title: "Prepare an implementation note",
      summary: "Produce a bounded result with explicit evidence claims.",
      actor: "human:test",
      idempotencyKey: "test:intake",
      acceptanceCriteria: [
        {
          id: "result",
          text: "The result is concise and reviewable.",
          critical: true,
          evidenceRequirements: [],
        },
      ],
    });
    const ready = context.controlPlane.triage({
      id: requested.id,
      ownerRole: "implementer",
      executionTarget: "codex",
      actor: "human:test",
      idempotencyKey: "test:triage",
      expectedVersion: requested.version,
    });

    const next = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_next"),
    );
    assert.equal(
      ((next.data as { workItem: { id: string } }).workItem).id,
      ready.id,
    );

    const claimEnvelope = toolEnvelope(
      toolCall(context.handler, 2, "chartermesh_work_claim", {
        id: ready.id,
        expectedVersion: ready.version,
        leaseMinutes: 5,
        idempotencyKey: "mcp:claim:1",
      }),
    );
    assert.equal(claimEnvelope.ok, true);
    const claim = claimEnvelope.data as {
      workItem: { status: string; version: number };
      runId: string;
      attemptId: string;
      leaseId: string;
      generation: number;
    };
    assert.equal(claim.workItem.status, "in_progress");
    assert.equal(claim.generation, 1);

    const run = toolEnvelope(
      toolCall(context.handler, 20, "chartermesh_run_show", {
        runId: claim.runId,
      }),
    );
    assert.equal((run.data as { cancellationRequested: boolean }).cancellationRequested, false);
    assert.equal((run.data as { attempts: unknown[] }).attempts.length, 1);

    const replay = toolEnvelope(
      toolCall(context.handler, 3, "chartermesh_work_claim", {
        id: ready.id,
        expectedVersion: ready.version,
        leaseMinutes: 5,
        idempotencyKey: "mcp:claim:1",
      }),
    );
    assert.deepEqual(replay.data, claim);

    const heartbeat = toolEnvelope(
      toolCall(context.handler, 4, "chartermesh_run_heartbeat", {
        id: ready.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        idempotencyKey: "mcp:heartbeat:1",
      }),
    );
    assert.equal(heartbeat.ok, true);

    const progress = toolEnvelope(
      toolCall(context.handler, 5, "chartermesh_work_progress", {
        id: ready.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        expectedVersion: claim.workItem.version,
        generation: claim.generation,
        summary: "Drafted the bounded result.",
        nextAction: "Submit the immutable artifact.",
        idempotencyKey: "mcp:progress:1",
      }),
    );
    assert.equal(
      (progress.data as { nextAction: string }).nextAction,
      "Submit the immutable artifact.",
    );

    const submitted = toolEnvelope(
      toolCall(context.handler, 6, "chartermesh_artifact_submit", {
        id: ready.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        content: "A concise implementation note backed only by recorded evidence.",
        mediaType: "text/plain",
        producerReport: {
          summary: "A bounded implementation note.",
          deliverable: "The requested note is ready for human review.",
          reportedChecks: [],
          reportedRisks: ["No executable validation was requested."],
          nextActions: ["Human reviews the exact artifact hash."],
          confidence: "medium",
        },
        idempotencyKey: "mcp:artifact:1",
      }),
    );
    assert.equal(submitted.ok, true);
    assert.match(
      String((submitted.data as { sha256: string }).sha256),
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(context.controlPlane.get(ready.id).status, "review_pending");
    assert.equal(
      context.controlPlane.latestArtifact(ready.id)?.producerReport?.source,
      "model_reported",
    );

    const decision = toolEnvelope(
      toolCall(context.handler, 7, "chartermesh_decision_show", {
        id: ready.id,
      }),
    );
    assert.equal(
      (decision.data as { requestedDecision: { actor: string } })
        .requestedDecision.actor,
      "human",
    );

    const shown = toolEnvelope(
      toolCall(context.handler, 8, "chartermesh_artifact_show", {
        id: ready.id,
        maxContentBytes: 1,
      }),
    );
    assert.equal((shown.data as { content: string | null }).content, null);
    assert.equal((shown.data as { contentOmitted: boolean }).contentOmitted, true);
  } finally {
    context.database.close();
  }
});

test("MCP workspace change sets apply multiple files with one exact human approval", async () => {
  const context = fixture();
  try {
    const requested = context.controlPlane.intake({
      title: "Create a governed file",
      summary: "Write one exact UTF-8 file only after human approval.",
      actor: "human:test",
      idempotencyKey: "write:intake",
      requiredTools: ["workspace.write_file"],
    });
    const ready = context.controlPlane.triage({
      id: requested.id,
      ownerRole: "implementer",
      executionTarget: "codex",
      expectedVersion: requested.version,
      actor: "human:test",
      idempotencyKey: "write:triage",
    });
    const firstClaim = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_claim", {
        id: ready.id,
        expectedVersion: ready.version,
        idempotencyKey: "write:claim:1",
      }),
    ).data as {
      workItem: { version: number };
      runId: string;
      attemptId: string;
      leaseId: string;
      generation: number;
    };
    const exactPath = "generated/approved.txt";
    const secondPath = "generated/metadata.json";
    const exactContent = "human-approved content\n";
    const secondContent = '{"approved":true}\n';
    const firstFence = {
      id: ready.id,
      runId: firstClaim.runId,
      attemptId: firstClaim.attemptId,
      leaseId: firstClaim.leaseId,
      generation: firstClaim.generation,
    };
    const wrongRequestFence = toolEnvelope(await asyncToolCall(
      context.handler,
      21,
      "chartermesh_workspace_changes_request",
      {
        ...firstFence,
        generation: firstFence.generation + 1,
        changes: [{ path: exactPath, content: exactContent, beforeSha256: null }],
        idempotencyKey: "write:request:wrong-fence",
      },
    ));
    assert.equal(wrongRequestFence.ok, false);
    assert.match(
      String((wrongRequestFence.error as { code: string }).code),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
    const requestedWrite = toolEnvelope(
      await asyncToolCall(
        context.handler,
        2,
        "chartermesh_workspace_changes_request",
        {
          ...firstFence,
          changes: [
            { path: exactPath, content: exactContent, beforeSha256: null },
            { path: secondPath, content: secondContent, beforeSha256: null },
          ],
          idempotencyKey: "write:request",
        },
      ),
    );
    assert.equal(requestedWrite.ok, true, JSON.stringify(requestedWrite));
    const pending = (requestedWrite.data as {
      pending: { callHash: string; status: string };
      decisionPacketHash: string;
    }).pending;
    assert.match(pending.callHash, /^[a-f0-9]{64}$/u);
    assert.equal(pending.status, "approval_required");
    assert.equal(
      (requestedWrite.data as { pending: { summary: { changeCount: number } } })
        .pending.summary.changeCount,
      2,
    );
    const outputPath = join(context.target, "generated", "approved.txt");
    const secondOutputPath = join(context.target, "generated", "metadata.json");
    assert.equal(existsSync(outputPath), false);

    const requestReplay = toolEnvelope(
      await asyncToolCall(
        context.handler,
        20,
        "chartermesh_workspace_changes_request",
        {
          ...firstFence,
          changes: [
            { path: exactPath, content: exactContent, beforeSha256: null },
            { path: secondPath, content: secondContent, beforeSha256: null },
          ],
          idempotencyKey: "write:request",
        },
      ),
    );
    assert.equal(
      (requestReplay.data as { pending: { callHash: string } }).pending.callHash,
      pending.callHash,
    );

    const preapproval = toolEnvelope(
      await asyncToolCall(
        context.handler,
        3,
        "chartermesh_workspace_write_execute",
        {
          ...firstFence,
          callHash: pending.callHash,
          idempotencyKey: "write:execute:preapproval",
        },
      ),
    );
    assert.equal(preapproval.ok, false);
    assert.match(
      String((preapproval.error as { code: string }).code),
      /TOOL_APPROVAL_REQUIRED|RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );
    assert.equal(existsSync(outputPath), false);

    const packet = context.controlPlane.decisionPacket(ready.id);
    assert.ok(packet);
    assert.match(packet.question, /generated\/approved\.txt/u);
    assert.match(packet.question, /2 exact workspace file changes/u);
    context.controlPlane.approveToolCall({
      id: ready.id,
      callHash: pending.callHash,
      toolName: "workspace.write_file",
      packetHash: packet.binding.packetHash,
      actor: "human:test",
      note: "Approve this exact file and content.",
      idempotencyKey: "write:approve",
    });
    const approvedReady = context.controlPlane.get(ready.id);
    const secondClaim = toolEnvelope(
      toolCall(context.handler, 4, "chartermesh_work_claim", {
        id: ready.id,
        expectedVersion: approvedReady.version,
        idempotencyKey: "write:claim:2",
      }),
    ).data as typeof firstClaim;
    const secondFence = {
      id: ready.id,
      runId: secondClaim.runId,
      attemptId: secondClaim.attemptId,
      leaseId: secondClaim.leaseId,
      generation: secondClaim.generation,
    };

    const wrongExecuteFence = toolEnvelope(await asyncToolCall(
      context.handler,
      22,
      "chartermesh_workspace_write_execute",
      {
        ...secondFence,
        leaseId: "lease-bogus",
        callHash: pending.callHash,
        idempotencyKey: "write:execute:wrong-fence",
      },
    ));
    assert.equal(wrongExecuteFence.ok, false);
    assert.match(
      String((wrongExecuteFence.error as { code: string }).code),
      /RUN_OWNERSHIP_FENCE_MISMATCH/u,
    );

    const changedArguments = toolEnvelope(
      await asyncToolCall(
        context.handler,
        5,
        "chartermesh_workspace_write_execute",
        {
          ...secondFence,
          callHash: pending.callHash,
          path: exactPath,
          idempotencyKey: "write:execute:changed-args",
        },
      ),
    );
    assert.equal(changedArguments.ok, false);
    assert.match(
      String((changedArguments.error as { code: string }).code),
      /TOOL_CALL_REJECTED/u,
    );

    const executed = toolEnvelope(
      await asyncToolCall(
        context.handler,
        7,
        "chartermesh_workspace_write_execute",
        {
          ...secondFence,
          callHash: pending.callHash,
          idempotencyKey: "write:execute:approved",
        },
      ),
    );
    assert.equal(executed.ok, true);
    assert.equal(readFileSync(outputPath, "utf8"), exactContent);
    assert.equal(readFileSync(secondOutputPath, "utf8"), secondContent);
    assert.equal(
      (executed.data as { pendingStatus: string }).pendingStatus,
      "executed",
    );
    const evidence = context.controlPlane.listToolEvidence(ready.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.status, "succeeded");
    assert.equal(evidence[0]?.callHash, pending.callHash);
    assert.deepEqual(evidence[0]?.paths, [exactPath, secondPath]);
    assert.equal(
      context.controlPlane.listPendingToolCalls(ready.id)[0]?.status,
      "executed",
    );
    assert.equal(
      context.controlPlane.isPendingToolExecutionReserved({
        ...secondFence,
        callHash: pending.callHash,
        toolName: "workspace.write_file",
        actor: context.handler.sessionActor,
      }),
      false,
      "a settled human approval must not authorize the same side effect again",
    );
  } finally {
    context.database.close();
  }
});

test(
  "MCP governed writes normalize a Windows 8.3 workspace root",
  { skip: process.platform !== "win32" },
  async (testContext) => {
    const base = mkdtempSync(join(tmpdir(), "chartermesh-mcp-short-base-"));
    const workspace = join(base, "governed-workspace-long-name");
    mkdirSync(workspace);
    const shortWorkspace = join(base, "GOVERN~1");
    if (!existsSync(shortWorkspace)) {
      testContext.skip("NTFS 8.3 names are disabled for this volume.");
      return;
    }
    if (
      realpathSync(shortWorkspace) === realpathSync.native(shortWorkspace)
    ) {
      testContext.skip("The legacy resolver already expands this 8.3 root.");
      return;
    }
    const context = fixture({
      target: workspace,
      workspaceRoot: shortWorkspace,
    });
    try {
      const prepared = await approvedWorkspaceChange(
        context,
        "short-root",
        [{
          path: "generated.txt",
          content: "native canonical root\n",
          beforeSha256: null,
        }],
      );
      const executed = toolEnvelope(await asyncToolCall(
        context.handler,
        103,
        "chartermesh_workspace_write_execute",
        {
          id: prepared.id,
          ...prepared.claim,
          callHash: prepared.callHash,
          idempotencyKey: "short-root:execute",
        },
      ));
      assert.equal(executed.ok, true, JSON.stringify(executed));
      assert.equal(
        readFileSync(join(workspace, "generated.txt"), "utf8"),
        "native canonical root\n",
      );
    } finally {
      context.database.close();
    }
  },
);

test("MCP workspace write requests reject paths outside the governed roots", async () => {
  const context = fixture();
  try {
    const requested = context.controlPlane.intake({
      title: "Reject a path escape",
      summary: "The MCP bridge must not request or execute an escaping path.",
      actor: "human:test",
      idempotencyKey: "escape:intake",
    });
    const ready = context.controlPlane.triage({
      id: requested.id,
      ownerRole: "implementer",
      executionTarget: "codex",
      expectedVersion: requested.version,
      actor: "human:test",
      idempotencyKey: "escape:triage",
    });
    const claim = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_claim", {
        id: ready.id,
        expectedVersion: ready.version,
        idempotencyKey: "escape:claim",
      }),
    ).data as {
      runId: string;
      attemptId: string;
      leaseId: string;
      generation: number;
    };
    const escapedName = `${basename(context.target)}-escaped.txt`;
    const outside = join(context.target, "..", escapedName);
    const rejected = toolEnvelope(
      await asyncToolCall(
        context.handler,
        2,
        "chartermesh_workspace_write_request",
        {
          id: ready.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          path: `../${escapedName}`,
          content: "must not escape",
          beforeSha256: null,
          idempotencyKey: "escape:request",
        },
      ),
    );
    assert.equal(rejected.ok, false);
    assert.match(
      String((rejected.error as { code: string }).code),
      /WORKSPACE_PATH_DENIED/u,
    );
    assert.equal(existsSync(outside), false);
    assert.equal(context.controlPlane.listPendingToolCalls(ready.id).length, 0);
    assert.equal(context.controlPlane.get(ready.id).status, "in_progress");
    const protectedPaths = [
      ".chartermesh/runtime.json",
      ".git/config",
      ".codex/settings.json",
      ".claude/settings.json",
      "packages/plugin/.chartermesh/state.db",
      "packages/submodule/.git/config",
      "src/generated/.codex/settings.json",
      "src/generated/.claude/settings.json",
      "AGENTS.md",
      "nested/CLAUDE.md",
      "file.txt:secret",
      "CON",
      "aux.md",
      "trailing.",
      "trailing ",
    ];
    if (process.platform === "win32") {
      mkdirSync(join(context.target, "nested-short", ".git"), {
        recursive: true,
      });
      writeFileSync(
        join(context.target, "nested-short", ".git", "config"),
        "protected\n",
      );
      if (existsSync(join(context.target, "nested-short", "GIT~1"))) {
        protectedPaths.push("nested-short/GIT~1/config");
      }
      if (existsSync(join(context.target, "CHARTE~1"))) {
        protectedPaths.push("CHARTE~1/runtime.json");
      }
    }
    for (const [index, path] of protectedPaths.entries()) {
      const protectedResult = toolEnvelope(await asyncToolCall(
        context.handler,
        10 + index,
        "chartermesh_workspace_write_request",
        {
          id: ready.id,
          runId: claim.runId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          path,
          content: "denied",
          beforeSha256: null,
          idempotencyKey: `escape:protected:${index}`,
        },
      ));
      assert.equal(protectedResult.ok, false, path);
      assert.match(
        String((protectedResult.error as { code: string }).code),
        /WORKSPACE_(?:PATH|CONTROL_PATH)_DENIED/u,
      );
    }
    const oversizedContent = "x".repeat(1_048_577);
    writeFileSync(join(context.target, "oversized-existing.txt"), oversizedContent);
    const oversizedResult = toolEnvelope(await asyncToolCall(
      context.handler,
      30,
      "chartermesh_workspace_write_request",
      {
        id: ready.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        path: "oversized-existing.txt",
        content: "replacement",
        beforeSha256: createHash("sha256").update(oversizedContent).digest("hex"),
        idempotencyKey: "escape:oversized-prestate",
      },
    ));
    assert.equal(oversizedResult.ok, false);
    assert.match(
      String((oversizedResult.error as { code: string }).code),
      /WORKSPACE_PRESTATE_SIZE_LIMIT/u,
    );
    const linkedOutside = mkdtempSync(
      join(tmpdir(), "chartermesh-mcp-linked-prestate-"),
    );
    writeFileSync(join(linkedOutside, "secret.txt"), "outside secret\n");
    symlinkSync(
      linkedOutside,
      join(context.target, "linked-prestate"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedResult = toolEnvelope(await asyncToolCall(
      context.handler,
      31,
      "chartermesh_workspace_write_request",
      {
        id: ready.id,
        runId: claim.runId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        path: "linked-prestate/secret.txt",
        content: "must not replace outside content",
        beforeSha256: createHash("sha256")
          .update("outside secret\n")
          .digest("hex"),
        idempotencyKey: "escape:linked-prestate",
      },
    ));
    assert.equal(linkedResult.ok, false);
    assert.match(
      String((linkedResult.error as { code: string }).code),
      /WORKSPACE_PATH_DENIED|Symbolic-link/u,
    );
    assert.equal(
      readFileSync(join(linkedOutside, "secret.txt"), "utf8"),
      "outside secret\n",
    );
    assert.equal(context.controlPlane.listPendingToolCalls(ready.id).length, 0);
  } finally {
    context.database.close();
  }
});

test("one stale file blocks an approved change set before any file is written", async () => {
  const context = fixture();
  try {
    const requested = context.controlPlane.intake({
      title: "Reject a stale atomic batch",
      summary: "A stale precondition must block every file in the batch.",
      actor: "human:test",
      idempotencyKey: "stale:intake",
    });
    const ready = context.controlPlane.triage({
      id: requested.id,
      ownerRole: "implementer",
      executionTarget: "codex",
      expectedVersion: requested.version,
      actor: "human:test",
      idempotencyKey: "stale:triage",
    });
    const claim = (toolEnvelope(toolCall(
      context.handler,
      1,
      "chartermesh_work_claim",
      { id: ready.id, expectedVersion: ready.version, idempotencyKey: "stale:claim:1" },
    )).data) as {
      runId: string;
      attemptId: string;
      leaseId: string;
      generation: number;
    };
    const firstFence = {
      id: ready.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
    };
    const proposal = toolEnvelope(await asyncToolCall(
      context.handler,
      2,
      "chartermesh_workspace_changes_request",
      {
        ...firstFence,
        changes: [
          { path: "stale-a.txt", content: "approved a\n", beforeSha256: null },
          { path: "stale-b.txt", content: "approved b\n", beforeSha256: null },
        ],
        idempotencyKey: "stale:request",
      },
    ));
    assert.equal(proposal.ok, true);
    const callHash = (proposal.data as { pending: { callHash: string } }).pending.callHash;
    const packet = context.controlPlane.decisionPacket(ready.id)!;
    context.controlPlane.approveToolCall({
      id: ready.id,
      callHash,
      toolName: "workspace.write_file",
      packetHash: packet.binding.packetHash,
      actor: "human:test",
      note: "Approve the exact two-file batch.",
      idempotencyKey: "stale:approve",
    });
    const approved = context.controlPlane.get(ready.id);
    const executionClaimResult = (toolEnvelope(toolCall(
      context.handler,
      3,
      "chartermesh_work_claim",
      { id: ready.id, expectedVersion: approved.version, idempotencyKey: "stale:claim:2" },
    )).data) as typeof claim;
    const executionClaim = {
      runId: executionClaimResult.runId,
      attemptId: executionClaimResult.attemptId,
      leaseId: executionClaimResult.leaseId,
      generation: executionClaimResult.generation,
    };
    writeFileSync(join(context.target, "stale-a.txt"), "external change\n");
    const result = toolEnvelope(await asyncToolCall(
      context.handler,
      4,
      "chartermesh_workspace_write_execute",
      {
        id: ready.id,
        ...executionClaim,
        callHash,
        idempotencyKey: "stale:execute",
      },
    ));
    assert.equal(result.ok, false);
    assert.match(
      String((result.error as { code: string }).code),
      /TOOL_PRECONDITION_FAILED/u,
    );
    assert.equal(readFileSync(join(context.target, "stale-a.txt"), "utf8"), "external change\n");
    assert.equal(existsSync(join(context.target, "stale-b.txt")), false);
    assert.equal(
      context.controlPlane.listPendingToolCalls(ready.id)[0]?.status,
      "precondition_failed",
    );
  } finally {
    context.database.close();
  }
});

test("concurrent execute requests reserve one side effect and replay is read-only", async () => {
  const context = fixture();
  try {
    const prepared = await approvedWorkspaceChange(context, "race", [
      { path: "race.txt", content: "written once\n", beforeSha256: null },
    ]);
    const args = {
      id: prepared.id,
      ...prepared.claim,
      callHash: prepared.callHash,
    };
    const [left, right] = await Promise.all([
      asyncToolCall(context.handler, 200, "chartermesh_workspace_write_execute", {
        ...args,
        idempotencyKey: "race:execute:left",
      }),
      asyncToolCall(context.handler, 201, "chartermesh_workspace_write_execute", {
        ...args,
        idempotencyKey: "race:execute:right",
      }),
    ]).then((responses) => responses.map(toolEnvelope));
    assert.equal([left, right].filter(({ ok }) => ok === true).length, 1);
    const rejected = [left, right].find(({ ok }) => ok === false)!;
    assert.match(
      String((rejected.error as { code: string }).code),
      /TOOL_EXECUTION_ALREADY_RESERVED/u,
    );
    assert.equal(readFileSync(join(context.target, "race.txt"), "utf8"), "written once\n");

    const replay = toolEnvelope(await asyncToolCall(
      context.handler,
      202,
      "chartermesh_workspace_write_execute",
      { ...args, idempotencyKey: "race:execute:replay" },
    ));
    assert.equal(replay.ok, true);
    assert.equal((replay.data as { replayed: boolean }).replayed, true);
    assert.equal(context.controlPlane.listToolEvidence(prepared.id).length, 1);
  } finally {
    context.database.close();
  }
});

test("a crash before mutation safely re-reserves, while an unproven committed effect fails closed", async () => {
  const context = fixture();
  try {
    const recoverable = await approvedWorkspaceChange(context, "crash-before", [
      { path: "crash-before.txt", content: "safe retry\n", beforeSha256: null },
    ]);
    context.controlPlane.reservePendingToolExecution({
      id: recoverable.id,
      ...recoverable.claim,
      callHash: recoverable.callHash,
      actor: context.handler.sessionActor,
      idempotencyKey: "crash-before:reserve",
    });
    assert.equal(
      context.controlPlane.approvedPendingToolCall(recoverable.id)?.callHash,
      recoverable.callHash,
      "an approved executing call must remain discoverable after a reservation crash",
    );
    context.database
      .prepare("UPDATE leases SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", recoverable.claim.leaseId);
    context.controlPlane.recoverExpiredLeases();
    const retried = context.controlPlane.retry({
      id: recoverable.id,
      actor: "human:test",
      idempotencyKey: "crash-before:retry",
    });
    const recoveryClaimResult = toolEnvelope(toolCall(
      context.handler,
      300,
      "chartermesh_work_claim",
      {
        id: recoverable.id,
        expectedVersion: retried.version,
        idempotencyKey: "crash-before:claim:3",
      },
    )).data as typeof recoverable.claim;
    const recoveryClaim = {
      runId: recoveryClaimResult.runId,
      attemptId: recoveryClaimResult.attemptId,
      leaseId: recoveryClaimResult.leaseId,
      generation: recoveryClaimResult.generation,
    };
    const recovered = toolEnvelope(await asyncToolCall(
      context.handler,
      301,
      "chartermesh_workspace_write_execute",
      {
        id: recoverable.id,
        ...recoveryClaim,
        callHash: recoverable.callHash,
        idempotencyKey: "crash-before:execute",
      },
    ));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(readFileSync(join(context.target, "crash-before.txt"), "utf8"), "safe retry\n");

    const unknown = await approvedWorkspaceChange(context, "crash-after", [
      { path: "crash-after.txt", content: "committed without evidence\n", beforeSha256: null },
    ]);
    context.controlPlane.reservePendingToolExecution({
      id: unknown.id,
      ...unknown.claim,
      callHash: unknown.callHash,
      actor: context.handler.sessionActor,
      idempotencyKey: "crash-after:reserve",
    });
    const content = "committed without evidence\n";
    applyFileTransaction(context.target, "crash-after-fixture", [{
      path: join(context.target, "crash-after.txt"),
      content,
      beforeHash: null,
      afterHash: createHash("sha256").update(content).digest("hex"),
    }]);
    context.database
      .prepare("UPDATE leases SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", unknown.claim.leaseId);
    context.controlPlane.recoverExpiredLeases();
    const unknownRetry = context.controlPlane.retry({
      id: unknown.id,
      actor: "human:test",
      idempotencyKey: "crash-after:retry",
    });
    const unknownClaimResult = toolEnvelope(toolCall(
      context.handler,
      302,
      "chartermesh_work_claim",
      {
        id: unknown.id,
        expectedVersion: unknownRetry.version,
        idempotencyKey: "crash-after:claim:3",
      },
    )).data as typeof unknown.claim;
    const unknownClaim = {
      runId: unknownClaimResult.runId,
      attemptId: unknownClaimResult.attemptId,
      leaseId: unknownClaimResult.leaseId,
      generation: unknownClaimResult.generation,
    };
    const failedClosed = toolEnvelope(await asyncToolCall(
      context.handler,
      303,
      "chartermesh_workspace_write_execute",
      {
        id: unknown.id,
        ...unknownClaim,
        callHash: unknown.callHash,
        idempotencyKey: "crash-after:execute",
      },
    ));
    assert.equal(failedClosed.ok, false);
    assert.match(
      String((failedClosed.error as { code: string }).code),
      /TOOL_OUTCOME_UNKNOWN/u,
    );
    assert.equal(readFileSync(join(context.target, "crash-after.txt"), "utf8"), content);
    assert.equal(
      context.controlPlane.listPendingToolCalls(unknown.id)[0]?.status,
      "outcome_unknown",
    );
  } finally {
    context.database.close();
  }
});

test("MCP run mutations reject a different actor, mixed lineage, and a bogus attempt", () => {
  const context = fixture();
  try {
    const handlerB = createControlPlaneMcpHandler({
      controlPlane: context.controlPlane,
      actor: "host:test-claude",
      allowedRoles: ["implementer"],
      allowedExecutionTargets: ["codex"],
    });
    const sameBaseHandler = createControlPlaneMcpHandler({
      controlPlane: context.controlPlane,
      actor: "host:test-codex",
      allowedRoles: ["implementer"],
      allowedExecutionTargets: ["codex"],
    });
    assert.notEqual(
      sameBaseHandler.sessionActor,
      context.handler.sessionActor,
    );
    const prepare = (suffix: string) => {
      const requested = context.controlPlane.intake({
        title: `Fenced work ${suffix}`,
        summary: "Only the exact lease owner may mutate this run.",
        actor: "human:test",
        idempotencyKey: `fence:${suffix}:intake`,
      });
      return context.controlPlane.triage({
        id: requested.id,
        ownerRole: "implementer",
        executionTarget: "codex",
        actor: "human:test",
        idempotencyKey: `fence:${suffix}:triage`,
        expectedVersion: requested.version,
      });
    };
    const workA = prepare("a");
    const workB = prepare("b");
    const claimA = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_claim", {
        id: workA.id,
        expectedVersion: workA.version,
        idempotencyKey: "fence:a:claim",
      }),
    ).data as {
      workItem: { version: number };
      runId: string;
      attemptId: string;
      leaseId: string;
      generation: number;
    };
    const claimB = toolEnvelope(
      toolCall(handlerB, 2, "chartermesh_work_claim", {
        id: workB.id,
        expectedVersion: workB.version,
        idempotencyKey: "fence:b:claim",
      }),
    ).data as typeof claimA;

    const rejected = (response: JsonRpcResponse) => {
      const envelope = toolEnvelope(response);
      assert.equal(envelope.ok, false);
      assert.match(
        String((envelope.error as { message: string }).message),
        /RUN_OWNERSHIP_FENCE_MISMATCH/u,
      );
    };
    const exactA = {
      id: workA.id,
      runId: claimA.runId,
      attemptId: claimA.attemptId,
      leaseId: claimA.leaseId,
      generation: claimA.generation,
    };
    const mixedB = {
      id: workA.id,
      runId: claimB.runId,
      attemptId: claimB.attemptId,
      leaseId: claimB.leaseId,
      generation: claimB.generation,
    };

    rejected(toolCall(handlerB, 3, "chartermesh_run_heartbeat", {
      ...exactA,
      idempotencyKey: "fence:b:heartbeat-a",
    }));
    rejected(toolCall(sameBaseHandler, 30, "chartermesh_run_heartbeat", {
      ...exactA,
      idempotencyKey: "fence:same-base:heartbeat-a",
    }));
    rejected(toolCall(handlerB, 4, "chartermesh_work_progress", {
      ...mixedB,
      expectedVersion: claimA.workItem.version,
      summary: "Cross-run mutation.",
      nextAction: "This must not persist.",
      idempotencyKey: "fence:b:progress-a",
    }));
    rejected(toolCall(handlerB, 5, "chartermesh_work_block", {
      ...exactA,
      expectedVersion: claimA.workItem.version,
      type: "manual_resume",
      reason: "This actor does not own the lease.",
      idempotencyKey: "fence:b:block-a",
    }));
    rejected(toolCall(handlerB, 6, "chartermesh_artifact_submit", {
      ...exactA,
      content: "This artifact must not be accepted.",
      idempotencyKey: "fence:b:artifact-a",
    }));
    rejected(toolCall(context.handler, 7, "chartermesh_run_fail", {
      ...exactA,
      attemptId: "attempt-bogus",
      errorCode: "BOGUS_ATTEMPT",
      errorMessage: "A fabricated attempt cannot settle a real run.",
      idempotencyKey: "fence:a:bogus-fail",
    }));

    assert.equal(context.controlPlane.get(workA.id).status, "in_progress");
    assert.equal(context.controlPlane.get(workA.id).version, claimA.workItem.version);
    assert.equal(context.controlPlane.latestArtifact(workA.id), null);
    assert.equal(context.controlPlane.listAttempts(claimA.runId)[0]?.status, "running");
    assert.equal(context.controlPlane.isRunCancellationRequested(claimA.runId), false);
    assert.equal(
      context.controlPlane.auditRecords().find(
        ({ type, workItemId }) =>
          type === "work.claimed" && workItemId === workA.id,
      )?.actor,
      context.handler.sessionActor,
    );
  } finally {
    context.database.close();
  }
});

test("MCP mutation inputs are exact and the bridge actor cannot impersonate a human", () => {
  const context = fixture();
  try {
    const malformed = toolEnvelope(
      toolCall(context.handler, 1, "chartermesh_work_claim", {
        id: "work-000001",
        expectedVersion: 1,
        idempotencyKey: "mcp:claim:bad",
        actor: "human:attacker",
      }),
    );
    assert.equal(malformed.ok, false);
    assert.match(
      String((malformed.error as { message: string }).message),
      /Unknown argument field: actor/u,
    );
    assert.throws(
      () =>
        createControlPlaneMcpHandler({
          controlPlane: context.controlPlane,
          actor: "human:attacker",
        }),
      /actor has an invalid format|cannot hold human authority/u,
    );

    const parseError = context.handler.handleLine("{not-json");
    assert.equal(parseError?.error?.code, -32700);
    assert.equal(
      context.handler.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      null,
    );
  } finally {
    context.database.close();
  }
});

test("opening a local MCP bridge rejects uninitialized targets and opens an initialized target", () => {
  const uninitialized = mkdtempSync(join(tmpdir(), "chartermesh-mcp-empty-"));
  assert.throws(
    () =>
      openControlPlaneMcpBridge({
        target: uninitialized,
        actor: "host:test",
      }),
    /PROJECT_NOT_INITIALIZED/u,
  );

  const context = fixture();
  context.database.close();
  const bridge = openControlPlaneMcpBridge({
    target: context.target,
    actor: "host:test",
  });
  try {
    const response = toolEnvelope(
      toolCall(bridge.handler, 1, "chartermesh_status"),
    );
    assert.equal(response.ok, true);
    assert.equal(
      (response.data as { operationalState: { paused: boolean } })
        .operationalState.paused,
      false,
    );
  } finally {
    bridge.close();
  }
});

test("an existing MCP session rejects every mutation after organization changes but keeps queries available", async () => {
  const context = fixture();
  const requested = context.controlPlane.intake({
    title: "Work across a configuration change",
    summary: "The old session must not reuse cached organization authority.",
    actor: "human:test",
    idempotencyKey: "configuration-change:intake",
  });
  const ready = context.controlPlane.triage({
    id: requested.id,
    ownerRole: "implementation",
    executionTarget: "generic-local",
    expectedVersion: requested.version,
    actor: "human:test",
    idempotencyKey: "configuration-change:triage",
  });
  const options = {
    target: context.target,
    actor: "host:test",
    allowedRoles: ["implementation"],
    allowedExecutionTargets: ["generic-local"],
  };
  const bridge = openControlPlaneMcpBridge(options);
  let restarted: ReturnType<typeof openControlPlaneMcpBridge> | undefined;
  try {
    const organizationPath = join(context.target, ".chartermesh", "organization.json");
    const organization = JSON.parse(readFileSync(organizationPath, "utf8"));
    organization.metadata.revision += 1;
    const role = organization.spec.roles.find(({ id }: { id: string }) => id === "implementation");
    role.tools.allow = [];
    role.tools.approvalRequired = [];
    writeFileSync(organizationPath, `${JSON.stringify(organization, null, 2)}\n`);

    for (const [index, name] of [
      "chartermesh_work_claim",
      "chartermesh_run_heartbeat",
      "chartermesh_work_progress",
      "chartermesh_work_block",
      "chartermesh_workspace_changes_request",
      "chartermesh_workspace_write_request",
      "chartermesh_workspace_write_execute",
      "chartermesh_artifact_submit",
      "chartermesh_run_fail",
    ].entries()) {
      const rejected = toolEnvelope(await asyncToolCall(bridge.handler, index + 1, name));
      assert.equal(rejected.ok, false, name);
      assert.equal(
        (rejected.error as { code: string }).code,
        "PROJECT_CONFIGURATION_CHANGED_RESTART_REQUIRED",
        name,
      );
    }
    assert.throws(() => bridge.controlPlane.claim({
      id: ready.id,
      actor: bridge.handler.sessionActor,
      expectedVersion: ready.version,
      idempotencyKey: "configuration-change:direct-old-claim",
    }), /PROJECT_CONFIGURATION_CHANGED_RESTART_REQUIRED/u);
    assert.equal(context.controlPlane.get(ready.id).status, "ready");
    assert.equal(toolEnvelope(toolCall(bridge.handler, 20, "chartermesh_status")).ok, true);
    assert.equal(toolEnvelope(toolCall(bridge.handler, 21, "chartermesh_work_show", { id: ready.id })).ok, true);

    restarted = openControlPlaneMcpBridge(options);
    const claimed = toolEnvelope(toolCall(restarted.handler, 22, "chartermesh_work_claim", {
      id: ready.id,
      expectedVersion: ready.version,
      idempotencyKey: "configuration-change:new-claim",
    }));
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const claim = claimed.data as { runId: string; attemptId: string; leaseId: string; generation: number };
    const write = toolEnvelope(await asyncToolCall(restarted.handler, 23, "chartermesh_workspace_write_request", {
      id: ready.id,
      runId: claim.runId,
      attemptId: claim.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      path: "not-authorized.txt",
      content: "Must not be written under the old tool policy.",
      beforeSha256: null,
      idempotencyKey: "configuration-change:new-policy-write",
    }));
    assert.equal(write.ok, false);
    assert.match(String((write.error as { message: string }).message), /MCP_WORKSPACE_WRITE_DENIED/u);
    assert.equal(existsSync(join(context.target, "not-authorized.txt")), false);
  } finally {
    restarted?.close();
    bridge.close();
    context.database.close();
  }
});

test("MCP mutations survive preferences-only changes and respect active configuration maintenance", () => {
  const context = fixture();
  const requested = context.controlPlane.intake({
    title: "Preferences do not change authority",
    summary: "The organization file is unchanged.",
    actor: "human:test",
    idempotencyKey: "preferences-only:intake",
  });
  const ready = context.controlPlane.triage({
    id: requested.id,
    ownerRole: "implementation",
    executionTarget: "generic-local",
    expectedVersion: requested.version,
    actor: "human:test",
    idempotencyKey: "preferences-only:triage",
  });
  const bridge = openControlPlaneMcpBridge({
    target: context.target,
    actor: "host:test",
    allowedRoles: ["implementation"],
    allowedExecutionTargets: ["generic-local"],
  });
  let release: (() => void) | undefined;
  try {
    const stateDirectory = join(context.target, ".chartermesh");
    const organizationBefore = readFileSync(join(stateDirectory, "organization.json"));
    writeFileSync(join(stateDirectory, "preferences.json"), JSON.stringify({
      apiVersion: "chartermesh.dev/project-preferences/v1alpha1",
      language: "ko",
      approvalDetail: "technical",
      tone: "formal",
      projectInstructions: "Use Korean explanations.",
      roleInstructions: {},
    }));
    const claim = {
      id: ready.id,
      expectedVersion: ready.version,
      idempotencyKey: "preferences-only:claim",
    };
    release = acquireMaintenanceLock(stateDirectory, "configure-project");
    const blocked = toolEnvelope(toolCall(bridge.handler, 1, "chartermesh_work_claim", claim));
    assert.equal(blocked.ok, false);
    assert.equal((blocked.error as { code: string }).code, "CONTROL_PLANE_MAINTENANCE_ACTIVE");
    assert.equal(toolEnvelope(toolCall(bridge.handler, 2, "chartermesh_status")).ok, true);
    release();
    release = undefined;
    assert.deepEqual(readFileSync(join(stateDirectory, "organization.json")), organizationBefore);
    const claimed = toolEnvelope(toolCall(bridge.handler, 3, "chartermesh_work_claim", claim));
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
  } finally {
    release?.();
    bridge.close();
    context.database.close();
  }
});

test("MCP startup rejects oversized OrgSpec state and linked project ancestors", () => {
  const oversized = fixture();
  oversized.database.close();
  writeFileSync(
    join(oversized.target, ".chartermesh", "organization.json"),
    " ".repeat(2 * 1024 * 1024 + 1),
  );
  assert.throws(
    () => openControlPlaneMcpBridge({ target: oversized.target, actor: "host:test" }),
    /PROJECT_STATE_FILE_INVALID/u,
  );

  const linked = fixture();
  linked.database.close();
  const linkParent = mkdtempSync(join(tmpdir(), "chartermesh-mcp-link-"));
  const link = join(linkParent, "project-link");
  symlinkSync(linked.target, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => openControlPlaneMcpBridge({ target: link, actor: "host:test" }),
    /PROJECT_STATE_LINK_REJECTED/u,
  );
});
