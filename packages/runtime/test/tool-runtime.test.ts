import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  ToolIterationLimitError,
  createWorkspaceToolRuntime,
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
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-read",
    policy: {
      allow: ["workspace.read_file"],
      workspaceRoots: ["."],
      maxIterations: 3,
    },
  });
  const output = await runtime.run(engine, request());
  assert.equal(output.inference.text, "done");
  assert.equal(output.iterations, 2);
  assert.equal(output.inference.usage.inputTokens, 2);
  assert.equal(output.inference.usage.measurementStatus, "measured");
  assert.equal(output.evidence[0]?.status, "succeeded");
  assert.match(output.evidence[0]?.inputHash ?? "", /^[a-f0-9]{64}$/u);
  assert.match(output.evidence[0]?.outputHash ?? "", /^[a-f0-9]{64}$/u);
});

test("workspace writes require an exact human-approved call hash", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-tools-write-"));
  const call = {
    id: "call-write",
    name: "workspace.write_file",
    arguments: { path: "output.txt", content: "approved content\n" },
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
    arguments: { path: "replayed.txt", content: "durable replay\n" },
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
