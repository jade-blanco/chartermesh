import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import {
  ToolApprovalRequiredError,
  ToolEvidenceCommitError,
  ToolIterationLimitError,
  createWorkspaceToolRuntime,
  hashBoundedRegularFile,
  toolCallHash,
} from "../src/index.ts";

const manifest: ModelEngine["manifest"] = {
  kind: "model_engine",
  profileId: "tool-test-engine",
  adapter: "test",
  contractVersion: "v1alpha1",
  capabilities: [
    { name: "model.text.generate", support: "native", stability: "stable" },
    { name: "model.tool_calling", support: "native", stability: "stable" },
  ],
};

const usage: InferenceResult["usage"] = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cost: 0,
  measurementStatus: "measured",
};

function result(
  request: InferenceRequest,
  value: Partial<InferenceResult>,
): InferenceResult {
  return {
    invocationId: request.invocationId,
    text: "",
    toolCalls: [],
    finishReason: "stop",
    usage,
    ...value,
  };
}

function request(): InferenceRequest {
  return {
    invocationId: "invocation-1",
    messages: [{ role: "user", content: "Inspect the workspace." }],
  };
}

test("tool loop executes an allowed read and records hash-only evidence", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-read-"));
  writeFileSync(join(workspace, "note.txt"), "bounded evidence\n");
  let calls = 0;
  const engine: ModelEngine = {
    manifest,
    async generate(inferenceRequest) {
      calls += 1;
      if (calls === 1) {
        return result(inferenceRequest, {
          toolCalls: [
            {
              id: "call-read",
              name: "workspace.read_file",
              arguments: { path: "note.txt" },
            },
          ],
          finishReason: "tool_call",
        });
      }
      const toolMessage = inferenceRequest.messages.at(-1);
      assert.equal(toolMessage?.role, "tool");
      assert.match(toolMessage?.content ?? "", /bounded evidence/u);
      return result(inferenceRequest, { text: "done" });
    },
  };
  const provenanceEvents: string[] = [];
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-read",
    policy: {
      allow: ["workspace.read_file"],
      workspaceRoots: ["."],
      maxIterations: 3,
    },
    prepareEvidence(intent) {
      provenanceEvents.push(`prepare:${intent.callHash}:${intent.inputHash}`);
      return { id: "receipt-read", token: "a".repeat(64) };
    },
    onEvidence(evidence, receipt) {
      assert.equal(receipt?.id, "receipt-read");
      assert.equal(receipt?.token, "a".repeat(64));
      assert.equal(evidence.callHash, provenanceEvents[0]?.split(":")[1]);
      provenanceEvents.push(`record:${evidence.status}`);
    },
  });
  assert.equal(Reflect.get(runtime, "record"), undefined);
  assert.equal(Reflect.get(runtime, "evidence"), undefined);
  assert.equal(Reflect.get(runtime, "prepare"), undefined);
  const output = await runtime.run(engine, request());
  assert.equal(output.inference.text, "done");
  assert.equal(output.iterations, 2);
  assert.equal(output.inference.usage.inputTokens, 2);
  assert.equal(output.inference.usage.measurementStatus, "measured");
  assert.equal(output.evidence[0]?.status, "succeeded");
  assert.match(output.evidence[0]?.inputHash ?? "", /^[a-f0-9]{64}$/u);
  assert.match(output.evidence[0]?.outputHash ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    provenanceEvents.map((event) => event.split(":")[0]),
    ["prepare", "record"],
  );
});

test("workspace reads stream complete hashes while bounding file and directory materialization", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-bounded-read-"));
  const large = "x".repeat(2 * 1024 * 1024);
  writeFileSync(join(workspace, "large.txt"), large);
  const many = join(workspace, "many");
  mkdirSync(many);
  for (let index = 0; index < 250; index += 1) {
    writeFileSync(join(many, `${String(index).padStart(3, "0")}.txt`), "x");
  }
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-bounded-read",
    policy: {
      allow: ["workspace.read_file", "workspace.list_files"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
  });
  const read = await runtime.executeApprovedCall({
    id: "read-large",
    name: "workspace.read_file",
    arguments: { path: "large.txt", maxBytes: 64 },
  });
  const readOutput = JSON.parse(read.output) as {
    truncated: boolean;
    content: string;
    sha256: string;
  };
  assert.equal(readOutput.truncated, true);
  assert.equal(Buffer.byteLength(readOutput.content, "utf8"), 64);
  assert.equal(
    readOutput.sha256,
    createHash("sha256").update(large).digest("hex"),
  );
  const listed = await runtime.executeApprovedCall({
    id: "list-bounded",
    name: "workspace.list_files",
    arguments: { path: "many", maxEntries: 5 },
  });
  assert.equal(
    (JSON.parse(listed.output) as { entries: unknown[] }).entries.length,
    5,
  );
});

test("workspace reads reject symlink and junction ancestors", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-linked-read-"));
  const outside = mkdtempSync(join(tmpdir(), "chartermesh-tools-linked-outside-"));
  writeFileSync(join(outside, "secret.txt"), "must stay outside\n");
  const linked = join(workspace, "linked");
  symlinkSync(
    outside,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-linked-read",
    policy: {
      allow: ["workspace.read_file", "workspace.list_files"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
  });

  await assert.rejects(
    runtime.executeApprovedCall({
      id: "read-linked-file",
      name: "workspace.read_file",
      arguments: { path: "linked/secret.txt" },
    }),
    /outside OrgSpec workspaceRoots|Symbolic-link/u,
  );
  await assert.rejects(
    runtime.executeApprovedCall({
      id: "list-linked-directory",
      name: "workspace.list_files",
      arguments: { path: "linked" },
    }),
    /outside OrgSpec workspaceRoots|Symbolic-link/u,
  );
});

test("bounded descriptor hashing rejects oversized and replaced paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-hash-race-"));
  const outside = mkdtempSync(join(tmpdir(), "chartermesh-tools-hash-outside-"));
  const inside = join(workspace, "inside");
  mkdirSync(inside);
  const target = join(inside, "state.txt");
  writeFileSync(target, "approved prestate\n");
  const expectedCanonical = realpathSync.native(target);

  writeFileSync(target, "x".repeat(1_025));
  assert.throws(
    () => hashBoundedRegularFile(target, expectedCanonical, 1_024),
    /REGULAR_FILE_SIZE_LIMIT/u,
  );

  writeFileSync(join(outside, "state.txt"), "outside secret\n");
  renameSync(inside, join(workspace, "original-inside"));
  symlinkSync(
    outside,
    inside,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => hashBoundedRegularFile(target, expectedCanonical, 1_024),
    /WORKSPACE_PATH_RACE/u,
  );
});

test("workspace writes require an exact human-approved call hash", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-write-"));
  const call = {
    id: "call-write",
    name: "workspace.write_file",
    arguments: {
      path: "output.txt",
      content: "approved content\n",
      beforeSha256: null,
    },
  };
  const engine = (): ModelEngine => {
    let calls = 0;
    return {
      manifest,
      async generate(inferenceRequest) {
        calls += 1;
        return calls === 1
          ? result(inferenceRequest, {
              toolCalls: [call],
              finishReason: "tool_call",
            })
          : result(inferenceRequest, { text: "written" });
      },
    };
  };
  const policy = {
    allow: ["workspace.write_file"],
    approvalRequired: ["workspace.write_file"],
    workspaceRoots: ["."],
    maxIterations: 3,
  };
  const expectedHash = toolCallHash("work-write", call);
  const denied = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-write",
    policy,
  });
  let pendingError: ToolApprovalRequiredError | undefined;
  await assert.rejects(
    denied.run(engine(), request()),
    (error) => {
      if (!(error instanceof ToolApprovalRequiredError)) return false;
      pendingError = error;
      return error.callHash === expectedHash;
    },
  );
  assert.deepEqual(pendingError?.call.arguments, call.arguments);
  assert.deepEqual(pendingError?.summary, {
    title: "Workspace file creation",
    changeCount: 1,
    totalBytes: Buffer.byteLength("approved content\n", "utf8"),
    changes: [{
      path: "output.txt",
      beforeSha256: null,
      afterSha256: createHash("sha256")
        .update("approved content\n")
        .digest("hex"),
      byteSize: Buffer.byteLength("approved content\n", "utf8"),
    }],
  });
  assert.equal(existsSync(join(workspace, "output.txt")), false);

  const approved = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-write",
    policy,
    isApproved: (hash, toolName) =>
      hash === expectedHash && toolName === "workspace.write_file",
  });
  const output = await approved.run(engine(), request());
  assert.equal(output.evidence[0]?.status, "succeeded");
  assert.equal(
    readFileSync(join(workspace, "output.txt"), "utf8"),
    "approved content\n",
  );

  const replayCall = {
    ...call,
    arguments: {
      path: "replayed.txt",
      content: "durable replay\n",
      beforeSha256: null,
    },
  };
  const replayHash = toolCallHash("work-write", replayCall);
  const replay = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-write",
    policy,
    isApproved: (hash, toolName) =>
      hash === replayHash && toolName === "workspace.write_file",
  });
  const replayed = await replay.executeApprovedCall(replayCall);
  assert.equal(replayed.evidence.status, "succeeded");
  assert.deepEqual(replayed.evidence.paths, ["replayed.txt"]);
  assert.equal(
    readFileSync(join(workspace, "replayed.txt"), "utf8"),
    "durable replay\n",
  );
  assert.equal(
    readdirSync(join(workspace, ".chartermesh", ".transactions")).length,
    0,
  );
});

test("content writes bind prestate and reject coding-host control paths before approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-prestate-"));
  const policy = {
    allow: ["workspace.write_file"],
    approvalRequired: ["workspace.write_file"],
    workspaceRoots: ["."],
    maxIterations: 2,
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-prestate",
    policy,
    isApproved: () => true,
  });
  await assert.rejects(
    runtime.executeApprovedCall({
      id: "missing-prestate",
      name: "workspace.write_file",
      arguments: { path: "missing.txt", content: "unsafe\n" },
    }),
    /TOOL_ARGUMENTS_INVALID.*beforeSha256/u,
  );
  const protectedPaths = [
    "nested/.git/config",
    "nested/.chartermesh/state.db",
    "nested/.codex/settings.json",
    "nested/.claude/settings.json",
    "nested/AGENTS.md",
    "nested/file.txt:stream",
    "nested/CON.txt",
    "nested/trailing.",
  ];
  if (process.platform === "win32") {
    mkdirSync(join(workspace, "short", ".git"), { recursive: true });
    writeFileSync(join(workspace, "short", ".git", "config"), "protected\n");
    if (existsSync(join(workspace, "short", "GIT~1"))) {
      const aliasPath = "short/GIT~1/config";
      const gated = createWorkspaceToolRuntime({
        workspaceRoot: workspace,
        workItemId: "work-prestate-alias",
        policy,
      });
      await assert.rejects(
        gated.executeApprovedCall({
          id: "protected-alias-before-approval",
          name: "workspace.write_file",
          arguments: {
            path: aliasPath,
            content: "denied\n",
            beforeSha256: createHash("sha256")
              .update("protected\n")
              .digest("hex"),
          },
        }),
        /TOOL_PRECONDITION_FAILED.*WORKSPACE_CONTROL_PATH_DENIED/u,
      );
      protectedPaths.push(aliasPath);
    }
  }
  for (const [index, path] of protectedPaths.entries()) {
    await assert.rejects(
      runtime.executeApprovedCall({
        id: `protected-${index}`,
        name: "workspace.write_file",
        arguments: { path, content: "denied\n", beforeSha256: null },
      }),
      /(?:TOOL_ARGUMENTS_INVALID|TOOL_EXECUTION_FAILED).*WORKSPACE_(?:CONTROL_)?PATH_DENIED/u,
      path,
    );
  }

  const target = join(workspace, "existing.txt");
  writeFileSync(target, "before\n");
  const stale = "0".repeat(64);
  await assert.rejects(
    runtime.executeApprovedCall({
      id: "stale-content",
      name: "workspace.write_file",
      arguments: {
        path: "existing.txt",
        content: "after\n",
        beforeSha256: stale,
      },
    }),
    /TOOL_EXECUTION_FAILED.*Target changed after planning/u,
  );
  assert.equal(readFileSync(target, "utf8"), "before\n");

  const beforeSha256 = createHash("sha256").update("before\n").digest("hex");
  const applied = await runtime.executeApprovedCall({
    id: "exact-content",
    name: "workspace.write_file",
    arguments: {
      path: "existing.txt",
      content: "after\n",
      beforeSha256,
    },
  });
  assert.equal(applied.evidence.status, "succeeded");
  assert.equal(readFileSync(target, "utf8"), "after\n");
});

test("a post-execution evidence failure is outcome-unknown and never reclassified", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-receipt-"));
  const call = {
    id: "call-outcome-unknown",
    name: "workspace.write_file",
    arguments: {
      path: "result.txt",
      content: "written once\n",
      beforeSha256: null,
    },
  };
  let evidenceCallbacks = 0;
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-outcome-unknown",
    policy: {
      allow: ["workspace.write_file"],
      approvalRequired: ["workspace.write_file"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
    isApproved: () => true,
    prepareEvidence: () => ({ id: "receipt-unknown", token: "b".repeat(64) }),
    onEvidence(evidence) {
      evidenceCallbacks += 1;
      assert.equal(evidence.status, "succeeded");
      throw new Error("synthetic evidence sink failure");
    },
  });

  await assert.rejects(
    runtime.executeApprovedCall(call),
    (error) =>
      error instanceof ToolEvidenceCommitError &&
      error.code === "TOOL_OUTCOME_UNKNOWN",
  );
  assert.equal(evidenceCallbacks, 1);
  assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "written once\n");
});

test("runtime policy is an immutable snapshot", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-policy-"));
  const policy = {
    allow: ["workspace.read_file"],
    workspaceRoots: ["."],
    maxIterations: 2,
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-policy-snapshot",
    policy,
  });
  policy.allow.push("workspace.write_file");
  policy.workspaceRoots[0] = "..";

  assert.deepEqual(runtime.modelTools().map(({ name }) => name), [
    "workspace.read_file",
  ]);
  await assert.rejects(
    runtime.executeApprovedCall({
      id: "call-policy-drift",
      name: "workspace.write_file",
      arguments: { path: "drift.txt", content: "must not be written\n" },
    }),
    /TOOL_DENIED/u,
  );
  assert.equal(existsSync(join(workspace, "drift.txt")), false);
});

test("SHA-bound replacement writes are exact, bounded, and race-safe", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-replace-"));
  const target = join(workspace, "service.mjs");
  const initial = "const port = 3000;\nconst mode = \"draft\";\n";
  writeFileSync(target, initial);
  const expectedSha256 = createHash("sha256").update(initial).digest("hex");
  const call = {
    id: "call-replace",
    name: "workspace.write_file",
    arguments: {
      path: "service.mjs",
      expectedSha256,
      replacements: [
        {
          oldText: "const port = 3000;",
          newText: "const port = 4173;",
          expectedOccurrences: 1,
        },
        {
          oldText: "\"draft\"",
          newText: "\"ready\"",
          expectedOccurrences: 1,
        },
      ],
    },
  };
  const policy = {
    allow: ["workspace.write_file"],
    approvalRequired: ["workspace.write_file"],
    workspaceRoots: ["."],
    maxIterations: 3,
  };
  const callHash = toolCallHash("work-replace", call);
  const pending = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-replace",
    policy,
  });
  await assert.rejects(
    pending.executeApprovedCall(call),
    (error) =>
      error instanceof ToolApprovalRequiredError &&
      error.callHash === callHash,
  );
  assert.equal(readFileSync(target, "utf8"), initial);

  const approved = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-replace",
    policy,
    isApproved: (hash) => hash === callHash,
  });
  const result = await approved.executeApprovedCall(call);
  assert.equal(result.evidence.status, "succeeded");
  assert.equal(
    readFileSync(target, "utf8"),
    "const port = 4173;\nconst mode = \"ready\";\n",
  );
  assert.match(result.output, /"mode":"replacements"/u);

  const staleCall = {
    ...call,
    id: "call-stale-replace",
    arguments: {
      ...call.arguments,
      replacements: [
        {
          oldText: "const port = 4173;",
          newText: "const port = 8080;",
          expectedOccurrences: 1,
        },
      ],
    },
  };
  const staleHash = toolCallHash("work-replace", staleCall);
  const stale = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-replace",
    policy,
    isApproved: (hash) => hash === staleHash,
  });
  await assert.rejects(
    stale.executeApprovedCall(staleCall),
    /Replacement target 'service.mjs' changed/u,
  );
});

test("path escapes fail without touching files outside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-path-"));
  let calls = 0;
  const engine: ModelEngine = {
    manifest,
    async generate(inferenceRequest) {
      calls += 1;
      if (calls === 1) {
        return result(inferenceRequest, {
          toolCalls: [
            {
              id: "call-escape",
              name: "workspace.read_file",
              arguments: { path: "../outside.txt" },
            },
          ],
          finishReason: "tool_call",
        });
      }
      assert.match(
        inferenceRequest.messages.at(-1)?.content ?? "",
        /escapes the workspace/u,
      );
      return result(inferenceRequest, { text: "contained" });
    },
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-path",
    policy: {
      allow: ["workspace.read_file"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
  });
  const output = await runtime.run(engine, request());
  assert.equal(output.inference.text, "contained");
  assert.equal(output.evidence[0]?.status, "failed");
});

test("truncated tool JSON is rejected before human approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-json-"));
  let calls = 0;
  const engine: ModelEngine = {
    manifest,
    async generate(inferenceRequest) {
      calls += 1;
      if (calls === 1) {
        return result(inferenceRequest, {
          toolCalls: [
            {
              id: "call-truncated",
              name: "workspace.write_file",
              arguments: { unparsed: "{\"path\":\"output.txt\"" },
            },
          ],
          finishReason: "tool_call",
        });
      }
      assert.match(
        inferenceRequest.messages.at(-1)?.content ?? "",
        /TOOL_ARGUMENTS_INVALID/u,
      );
      return result(inferenceRequest, { text: "repair required" });
    },
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-invalid-json",
    policy: {
      allow: ["workspace.write_file"],
      approvalRequired: ["workspace.write_file"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
  });
  const output = await runtime.run(engine, request());
  assert.equal(output.inference.text, "repair required");
  assert.equal(output.evidence[0]?.status, "failed");
  assert.equal(existsSync(join(workspace, "output.txt")), false);
});

test("OrgSpec maxIterations bounds repeated tool calls", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-limit-"));
  const engine: ModelEngine = {
    manifest,
    async generate(inferenceRequest) {
      return result(inferenceRequest, {
        toolCalls: [
          {
            id: `call-${inferenceRequest.invocationId}`,
            name: "workspace.list_files",
            arguments: { path: "." },
          },
        ],
        finishReason: "tool_call",
      });
    },
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-limit",
    policy: {
      allow: ["workspace.list_files"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
  });
  await assert.rejects(
    runtime.run(engine, request()),
    ToolIterationLimitError,
  );
});
