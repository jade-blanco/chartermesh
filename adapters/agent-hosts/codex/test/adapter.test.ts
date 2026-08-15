import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { HostRunEvent, HostRunRequest } from "../../../../packages/adapter-sdk/src/types.ts";
import {
  CodexAppServerAgentHost,
  type CodexAppServerConfig,
  sha256CodexExecutable,
  validateCodexAppServerConfig,
} from "../src/index.ts";

type FakeMode =
  | "normal"
  | "approval"
  | "permission"
  | "user_input"
  | "legacy_messages"
  | "provider_error"
  | "hold"
  | "oversize"
  | "unresponsive";

interface WireMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: WireMessage[] = [];
  readonly mode: FakeMode;
  killed = false;
  private input = "";
  private currentThreadId: string;
  private currentTurnId: string;
  private readonly suffix: string;

  constructor(mode: FakeMode, suffix = "") {
    super();
    this.mode = mode;
    this.suffix = suffix;
    this.currentThreadId = `thread-new${suffix}`;
    this.currentTurnId = `turn-fixture${suffix}`;
    this.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString("utf8");
      for (;;) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) break;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line.trim()) this.receive(JSON.parse(line) as WireMessage);
      }
    });
  }

  private send(message: WireMessage): void {
    if (!this.killed) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: WireMessage): void {
    this.messages.push(message);
    if (message.method === "initialize" && message.id !== undefined) {
      this.send({
        id: message.id,
        result: {
          userAgent:
            "chartermesh/0.145.0 (fixture; x86_64) test (chartermesh; 0.0.9-alpha.1)",
          platformFamily: "fixture",
          platformOs: "fixture",
        },
      });
      return;
    }
    if (message.method === "thread/start" && message.id !== undefined) {
      if (
        !["never", "untrusted", "on-request"].includes(
          String(message.params?.approvalPolicy),
        ) ||
        !["read-only", "workspace-write"].includes(
          String(message.params?.sandbox),
        )
      ) {
        this.send({
          id: message.id,
          error: { code: -32602, message: "invalid thread policy" },
        });
        return;
      }
      this.send({
        id: message.id,
        result: { thread: { id: this.currentThreadId } },
      });
      return;
    }
    if (message.method === "thread/resume" && message.id !== undefined) {
      if (
        !["never", "untrusted", "on-request"].includes(
          String(message.params?.approvalPolicy),
        ) ||
        !["read-only", "workspace-write"].includes(
          String(message.params?.sandbox),
        )
      ) {
        this.send({
          id: message.id,
          error: { code: -32602, message: "invalid resume policy" },
        });
        return;
      }
      this.send({
        id: message.id,
        result: { thread: { id: message.params?.threadId } },
      });
      return;
    }
    if (message.method === "turn/start" && message.id !== undefined) {
      const sandboxPolicy = message.params?.sandboxPolicy as
        | Record<string, unknown>
        | undefined;
      const validReadOnly =
        sandboxPolicy?.type === "readOnly" &&
        sandboxPolicy.networkAccess === false;
      const validWorkspaceWrite =
        sandboxPolicy?.type === "workspaceWrite" &&
        sandboxPolicy.networkAccess === false &&
        sandboxPolicy.excludeTmpdirEnvVar === true &&
        sandboxPolicy.excludeSlashTmp === true &&
        JSON.stringify(sandboxPolicy.writableRoots) ===
          JSON.stringify([message.params?.cwd]);
      if (
        !["never", "untrusted", "on-request"].includes(
          String(message.params?.approvalPolicy),
        ) ||
        (!validReadOnly && !validWorkspaceWrite)
      ) {
        this.send({
          id: message.id,
          error: { code: -32602, message: "invalid turn policy" },
        });
        return;
      }
      this.currentThreadId = String(message.params?.threadId ?? "");
      this.currentTurnId =
        message.params?.threadId === "thread-prior"
          ? `turn-resumed${this.suffix}`
          : `turn-fixture${this.suffix}`;
      this.send({
        id: message.id,
        result: {
          turn: {
            id: this.currentTurnId,
            status: "inProgress",
            items: [],
            error: null,
          },
        },
      });
      queueMicrotask(() => this.afterTurnStart());
      return;
    }
    if (message.method === "turn/interrupt" && message.id !== undefined) {
      if (this.mode === "unresponsive") return;
      this.send({ id: message.id, result: {} });
      queueMicrotask(() => {
        this.send({
          method: "turn/completed",
          params: {
            threadId: this.currentThreadId,
            turn: { id: this.currentTurnId, status: "interrupted", error: null },
          },
        });
      });
      return;
    }
    if (
      message.id === 900 &&
      JSON.stringify(message.result) === JSON.stringify({ decision: "cancel" })
    ) {
      this.failAfterDeniedRequest();
    }
    if (
      message.id === 901 &&
      JSON.stringify(message.result) ===
        JSON.stringify({ permissions: {}, scope: "turn" })
    ) {
      this.failAfterDeniedRequest();
    }
    if (
      message.id === 902 &&
      JSON.stringify(message.result) === JSON.stringify({ answers: {} })
    ) {
      this.failAfterDeniedRequest();
    }
  }

  private failAfterDeniedRequest(): void {
      queueMicrotask(() => {
        this.send({
          method: "turn/completed",
          params: {
            threadId: this.currentThreadId,
            turn: {
              id: this.currentTurnId,
              status: "failed",
              error: { message: "approval was canceled" },
            },
          },
        });
      });
  }

  private afterTurnStart(): void {
    if (this.mode === "hold" || this.mode === "unresponsive") return;
    if (this.mode === "approval") {
      this.send({
        id: 900,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          itemId: "command-1",
          reason: "A command needs explicit permission.",
        },
      });
      return;
    }
    if (this.mode === "permission") {
      this.send({
        id: 901,
        method: "item/permissions/requestApproval",
        params: {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          itemId: "permission-1",
          reason: "Additional access is required.",
        },
      });
      return;
    }
    if (this.mode === "user_input") {
      this.send({
        id: 902,
        method: "item/tool/requestUserInput",
        params: {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          itemId: "input-1",
        },
      });
      return;
    }
    if (this.mode === "oversize") {
      this.send({
        method: "warning",
        params: { message: "x".repeat(20_000) },
      });
      return;
    }
    if (this.mode === "legacy_messages") {
      for (const [id, text] of [
        ["legacy-1", "older answer"],
        ["legacy-2", "latest answer"],
      ] as const) {
        this.send({
          method: "item/completed",
          params: {
            threadId: this.currentThreadId,
            turnId: this.currentTurnId,
            completedAtMs: 1,
            item: { type: "agentMessage", id, text },
          },
        });
      }
      this.send({
        method: "turn/completed",
        params: {
          threadId: this.currentThreadId,
          turn: { id: this.currentTurnId, status: "completed", error: null },
        },
      });
      return;
    }
    if (this.mode === "provider_error") {
      const error = {
        message: "Authentication is required.",
        codexErrorInfo: "unauthorized",
      };
      this.send({
        method: "error",
        params: {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          willRetry: false,
          error,
        },
      });
      this.send({
        method: "turn/completed",
        params: {
          threadId: this.currentThreadId,
          turn: {
            id: this.currentTurnId,
            status: "failed",
            error,
          },
        },
      });
      return;
    }
    this.send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "foreign-thread",
        turnId: "foreign-turn",
        itemId: "foreign-message",
        delta: "must not leak",
      },
    });
    this.send({
      method: "turn/completed",
      params: {
        threadId: "foreign-thread",
        turn: { id: "foreign-turn", status: "completed", error: null },
      },
    });
    this.send({
      method: "item/agentMessage/delta",
      params: {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        itemId: "message-1",
        delta: "fixture ",
      },
    });
    this.send({
      method: "item/agentMessage/delta",
      params: {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        itemId: "message-1",
        delta: "answer",
      },
    });
    this.send({
      method: "item/completed",
      params: {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        completedAtMs: 1,
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: "fixture answer",
        },
      },
    });
    this.send({
      method: "turn/completed",
      params: {
        threadId: this.currentThreadId,
        turn: { id: this.currentTurnId, status: "completed", error: null },
      },
    });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

const request: HostRunRequest = {
  taskPacket: {
    objective: "Produce one bounded answer.",
    acceptanceCriteria: ["Return a final response."],
  },
  organizationRevision: 2,
  workItemId: "work-codex-1",
  runId: "run-codex-1",
  attemptId: "attempt-codex-1",
  generation: 3,
};

function harness(
  mode: FakeMode = "normal",
  maxOutputBytes?: number,
  overrides: Partial<CodexAppServerConfig> = {},
  uniqueProcessIds = false,
) {
  const workingDirectory = mkdtempSync(join(tmpdir(), "chartermesh-codex-host-"));
  const children: FakeCodexProcess[] = [];
  const invocations: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean };
  }> = [];
  const config: CodexAppServerConfig = {
    id: `codex-${mode}`,
    command: process.execPath,
    executableSha256: sha256CodexExecutable(process.execPath),
    workingDirectory,
    timeoutMs: 5_000,
    cancelSettlementMs: 100,
    allowUnrestrictedRead: true,
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    environmentAllowlist: ["CHARTERMESH_CODEX_ALLOWED"],
    ...overrides,
  };
  const host = new CodexAppServerAgentHost(
    config,
    {
      ...process.env,
      CHARTERMESH_CODEX_ALLOWED: "yes",
      CHARTERMESH_CODEX_HIDDEN: "must-not-pass",
    },
    {
      spawnProcess(command, args, options) {
        invocations.push({ command, args, options });
        const child = new FakeCodexProcess(
          mode,
          uniqueProcessIds ? `-${children.length + 1}` : "",
        );
        children.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  );
  return { host, children, invocations, workingDirectory };
}

async function collectEvents(
  host: CodexAppServerAgentHost,
  hostRunId: string,
): Promise<HostRunEvent[]> {
  const events: HostRunEvent[] = [];
  for await (const event of host.events(hostRunId)) events.push(event);
  return events;
}

test("Codex adapter requires an absolute attested executable", () => {
  assert.deepEqual(
    validateCodexAppServerConfig({
      id: "unsafe",
      command: "codex",
      executableSha256: "0".repeat(64),
      workingDirectory: "relative",
    }),
    [
      "Codex executable must use an absolute path.",
      "Codex workingDirectory must use an absolute path.",
    ],
  );
  assert.equal(isAbsolute(process.execPath), true);
});

test("Codex bootstrap arguments are bounded and reject NUL characters", () => {
  const base: CodexAppServerConfig = {
    id: "bounded-args",
    command: process.execPath,
    executableSha256: sha256CodexExecutable(process.execPath),
    workingDirectory: tmpdir(),
  };
  assert.deepEqual(validateCodexAppServerConfig({ ...base, args: ["fixture"] }), []);
  assert.deepEqual(
    validateCodexAppServerConfig({
      ...base,
      args: "not-an-array" as unknown as readonly string[],
    }),
    ["Codex args must be an array of strings."],
  );
  assert.deepEqual(
    validateCodexAppServerConfig({ ...base, args: ["unsafe\0argument"] }),
    ["Codex args[0] cannot contain a NUL character."],
  );
  assert.deepEqual(
    validateCodexAppServerConfig({ ...base, args: ["x".repeat(4_097)] }),
    ["Codex args[0] cannot exceed 4096 characters."],
  );
  assert.deepEqual(
    validateCodexAppServerConfig({ ...base, args: Array(33).fill("x") }),
    ["Codex args cannot contain more than 32 entries."],
  );
});

test("Codex discovery and run use bounded stdio JSON-RPC without copying auth", async () => {
  const { host, children, invocations, workingDirectory } = harness(
    "normal",
    undefined,
    { args: ["fixture-bootstrap", "--offline"] },
  );
  const discovery = await host.discover();
  assert.equal(discovery.available, true);
  assert.equal(discovery.providerVersion, "0.145.0");
  assert.equal(discovery.protocolVersion, "codex-app-server/0.145.0");

  const handle = await host.start(request);
  const eventsPromise = collectEvents(host, handle.hostRunId);
  const result = await host.result(handle.hostRunId);
  const events = await eventsPromise;
  const replayedEvents = await collectEvents(host, handle.hostRunId);

  assert.equal(handle.hostSessionId, "thread-new");
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "fixture answer");
  assert.deepEqual(
    events.map(({ type }) => type),
    ["status", "output_delta", "output_delta", "terminal"],
  );
  assert.deepEqual(
    events.map(({ sequence }) => sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(replayedEvents, events);
  assert.ok(invocations.every(({ command }) => isAbsolute(command)));
  assert.ok(
    invocations.every(
      ({ args }) =>
        JSON.stringify(args) ===
        JSON.stringify([
          "fixture-bootstrap",
          "--offline",
          "app-server",
          "--listen",
          "stdio://",
        ]),
    ),
  );
  assert.ok(invocations.every(({ options }) => options.shell === false));
  assert.ok(invocations.every(({ options }) => options.cwd === workingDirectory));
  assert.ok(
    invocations.every(
      ({ options }) =>
        options.env?.CHARTERMESH_CODEX_ALLOWED === "yes" &&
        options.env.CHARTERMESH_CODEX_HIDDEN === undefined,
    ),
  );
  const runMessages = children.at(-1)?.messages ?? [];
  assert.deepEqual(
    runMessages.filter(({ method }) => method).map(({ method }) => method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  const turnStart = runMessages.find(({ method }) => method === "turn/start");
  const input = (turnStart?.params?.input as Array<{ text?: string }> | undefined)?.[0];
  const envelope = JSON.parse(input?.text ?? "{}") as Record<string, unknown>;
  assert.equal(envelope.workItemId, request.workItemId);
  assert.equal("auth" in envelope, false);
});

test("Codex start requires explicit acknowledgement of host-user read scope", async () => {
  const { host } = harness("normal", undefined, {
    allowUnrestrictedRead: false,
  });
  const discovery = await host.discover();
  assert.equal(discovery.available, false);
  assert.ok(
    discovery.diagnostics.some(
      ({ code }) => code === "CODEX_UNRESTRICTED_READ_NOT_ACKNOWLEDGED",
    ),
  );
  await assert.rejects(
    host.start(request),
    /CODEX_UNRESTRICTED_READ_NOT_ACKNOWLEDGED|does not restrict reads/u,
  );
});

test("Codex ignores foreign turn events and keeps the latest legacy message", async () => {
  const normal = harness("normal");
  const normalHandle = await normal.host.start(request);
  const normalEventsPromise = collectEvents(
    normal.host,
    normalHandle.hostRunId,
  );
  assert.equal(
    (await normal.host.result(normalHandle.hostRunId)).outputText,
    "fixture answer",
  );
  assert.equal(
    (await normalEventsPromise).some(
      (event) => event.type === "output_delta" && event.delta.includes("leak"),
    ),
    false,
  );

  const legacy = harness("legacy_messages");
  const legacyHandle = await legacy.host.start({ ...request, generation: 4 });
  assert.equal(
    (await legacy.host.result(legacyHandle.hostRunId)).outputText,
    "latest answer",
  );
});

test("Codex resume appends a new turn to the recorded thread id", async () => {
  const { host, children } = harness();
  const handle = await host.resume({ ...request, hostSessionId: "thread-prior" });
  assert.equal(handle.hostSessionId, "thread-prior");
  assert.equal((await host.result(handle.hostRunId)).status, "completed");
  const methods = children[0]?.messages.map(({ method }) => method).filter(Boolean);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/resume",
    "turn/start",
  ]);
});

test("Codex start is idempotent for one attempt generation", async () => {
  const { host, children } = harness();
  const first = await host.start(request);
  await host.result(first.hostRunId);
  const replay = await host.start(request);
  assert.deepEqual(replay, first);
  assert.equal(children.length, 1);
});

test("Codex idempotency does not replay a changed task packet", async () => {
  const { host, children } = harness();
  const first = await host.start(request);
  await host.result(first.hostRunId);
  await assert.rejects(
    host.start({
      ...request,
      taskPacket: {
        ...request.taskPacket,
        objective: `${request.taskPacket.objective} with a changed requirement`,
      },
    }),
    /CODEX_HOST_RUN_COLLISION|duplicate active turn id/u,
  );
  assert.equal(children.length, 2);
});

test("Codex retains only the configured number of terminal runs", async () => {
  const { host } = harness(
    "normal",
    undefined,
    { maxRetainedRuns: 1 },
    true,
  );
  const first = await host.start(request);
  await host.result(first.hostRunId);
  const second = await host.start({ ...request, generation: 4 });
  await host.result(second.hostRunId);
  await assert.rejects(
    host.result(first.hostRunId),
    /CODEX_HOST_RUN_NOT_FOUND|Unknown Codex host run/u,
  );
  assert.equal((await host.result(second.hostRunId)).status, "completed");
});

test("Codex policy names map to the installed app-server wire schema", async () => {
  const { host, children, workingDirectory } = harness("normal", undefined, {
    sandbox: "workspace_write",
    approvalPolicy: "on_request",
    reasoningEffort: "xhigh",
  });
  const handle = await host.start(request);
  assert.equal((await host.result(handle.hostRunId)).status, "completed");
  const messages = children[0]?.messages ?? [];
  const threadStart = messages.find(({ method }) => method === "thread/start");
  const turnStart = messages.find(({ method }) => method === "turn/start");
  assert.equal(threadStart?.params?.approvalPolicy, "on-request");
  assert.equal(threadStart?.params?.sandbox, "workspace-write");
  assert.equal(turnStart?.params?.effort, "xhigh");
  assert.deepEqual(turnStart?.params?.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [workingDirectory],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

test("Codex approval requests are normalized and canceled fail-closed", async () => {
  const { host, children } = harness("approval");
  const handle = await host.start(request);
  const eventsPromise = collectEvents(host, handle.hostRunId);
  const result = await host.result(handle.hostRunId);
  const events = await eventsPromise;
  const approval = events.find(({ type }) => type === "approval_required");
  assert.equal(result.status, "failed");
  assert.ok(approval?.type === "approval_required");
  if (approval?.type === "approval_required") {
    assert.equal(approval.approval.kind, "command_execution");
    assert.equal(approval.approval.itemId, "command-1");
    assert.equal(approval.approval.actionable, false);
  }
  assert.ok(
    children[0]?.messages.some(
      ({ id, result: decision }) =>
        id === 900 &&
        JSON.stringify(decision) === JSON.stringify({ decision: "cancel" }),
    ),
  );
});

test("Codex permission requests grant nothing and remain turn-scoped", async () => {
  const { host, children } = harness("permission");
  const handle = await host.start(request);
  const eventsPromise = collectEvents(host, handle.hostRunId);
  assert.equal((await host.result(handle.hostRunId)).status, "failed");
  const events = await eventsPromise;
  const approval = events.find(({ type }) => type === "approval_required");
  assert.ok(
    approval?.type === "approval_required" &&
      approval.approval.kind === "permission",
  );
  assert.ok(
    children[0]?.messages.some(
      ({ id, result }) =>
        id === 901 &&
        JSON.stringify(result) ===
          JSON.stringify({ permissions: {}, scope: "turn" }),
    ),
  );
});

test("Codex preserves generated-schema provider error discriminators", async () => {
  const { host } = harness("provider_error");
  const handle = await host.start(request);
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "unauthorized");
  assert.equal(result.error?.message, "Authentication is required.");
});

test("Codex user-input requests receive no fabricated answers", async () => {
  const { host, children } = harness("user_input");
  const handle = await host.start(request);
  const eventsPromise = collectEvents(host, handle.hostRunId);
  assert.equal((await host.result(handle.hostRunId)).status, "failed");
  const events = await eventsPromise;
  const approval = events.find(({ type }) => type === "approval_required");
  assert.ok(
    approval?.type === "approval_required" &&
      approval.approval.kind === "user_input",
  );
  assert.ok(
    children[0]?.messages.some(
      ({ id, result }) =>
        id === 902 &&
        JSON.stringify(result) === JSON.stringify({ answers: {} }),
    ),
  );
});

test("Codex cancellation interrupts the exact thread and turn", async () => {
  const { host, children } = harness("hold");
  const handle = await host.start(request);
  await host.cancel(handle.hostRunId, {
    code: "safety",
    message: "Synthetic safety stop.",
  });
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "canceled");
  assert.deepEqual(result.cancelReason, {
    code: "safety",
    message: "Synthetic safety stop.",
  });
  const interrupt = children[0]?.messages.find(
    ({ method }) => method === "turn/interrupt",
  );
  assert.deepEqual(interrupt?.params, {
    threadId: "thread-new",
    turnId: "turn-fixture",
  });
});

test("Codex cancellation is bounded when app-server ignores interrupt", async () => {
  const { host } = harness("unresponsive");
  const handle = await host.start(request);
  await host.cancel(handle.hostRunId, { code: "shutdown" });
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "canceled");
  assert.deepEqual(result.cancelReason, { code: "shutdown" });
});

test("Codex latches the first cancellation reason", async () => {
  const { host } = harness("unresponsive");
  const handle = await host.start(request);
  await Promise.all([
    host.cancel(handle.hostRunId, { code: "safety", message: "first" }),
    host.cancel(handle.hostRunId, { code: "timeout", message: "second" }),
  ]);
  assert.deepEqual((await host.result(handle.hostRunId)).cancelReason, {
    code: "safety",
    message: "first",
  });
});

test("AbortSignal interrupts an active Codex turn", async () => {
  const { host } = harness("hold");
  const controller = new AbortController();
  const handle = await host.start(request, { signal: controller.signal });
  controller.abort(new Error("synthetic abort"));
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "canceled");
  assert.equal(result.cancelReason?.code, "user_requested");
});

test("Codex output is bounded and fails the run closed", async () => {
  const { host } = harness("oversize", 16_384);
  const handle = await host.start(request);
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "CODEX_APP_SERVER_OUTPUT_LIMIT_EXCEEDED");
});
