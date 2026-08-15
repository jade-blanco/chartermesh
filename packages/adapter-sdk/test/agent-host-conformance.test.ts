import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentHost,
  AgentHostRunHandle,
  AgentHostRunOptions,
  HostCancelReason,
  HostResumeRequest,
  HostRunEvent,
  HostRunRequest,
  HostRunResult,
} from "../src/index.ts";

const request: HostRunRequest = {
  taskPacket: { objective: "Exercise the AgentHost contract." },
  organizationRevision: 1,
  workItemId: "work-1",
  runId: "run-1",
  attemptId: "attempt-1",
  generation: 1,
};

function usage(): HostRunResult["usage"] {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus: "unknown",
  };
}

interface FixtureRun {
  handle: AgentHostRunHandle;
  events: HostRunEvent[];
  terminal: HostRunResult | null;
  terminalPromise: Promise<HostRunResult>;
  resolveTerminal: (result: HostRunResult) => void;
  abortCleanup: () => void;
}

class ConformingFixtureHost implements AgentHost {
  readonly manifest = {
    kind: "agent_host" as const,
    profileId: "conformance",
    adapter: "in-memory",
    contractVersion: "v1alpha2" as const,
    permissionCeiling: "read_only" as const,
    engineBinding: "host_managed" as const,
    capabilities: [],
  };
  private readonly runs = new Map<string, FixtureRun>();
  private readonly completeImmediately: boolean;
  private sequence = 0;

  constructor(completeImmediately = true) {
    this.completeImmediately = completeImmediately;
  }

  async discover() {
    return {
      available: true,
      profileId: this.manifest.profileId,
      adapter: this.manifest.adapter,
      providerVersion: "fixture-1",
      protocolVersion: "fixture-v1",
      capabilities: [],
      diagnostics: [],
    };
  }

  start(
    input: HostRunRequest,
    options: AgentHostRunOptions = {},
  ): Promise<AgentHostRunHandle> {
    return this.begin(input, `session-${input.generation}`, options);
  }

  resume(
    input: HostResumeRequest,
    options: AgentHostRunOptions = {},
  ): Promise<AgentHostRunHandle> {
    return this.begin(input, input.hostSessionId, options);
  }

  private async begin(
    input: HostRunRequest,
    hostSessionId: string,
    options: AgentHostRunOptions,
  ): Promise<AgentHostRunHandle> {
    if (options.signal?.aborted) throw options.signal.reason;
    const hostRunId = `host-run-${++this.sequence}`;
    const handle: AgentHostRunHandle = {
      hostRunId,
      hostSessionId,
      status: "running",
    };
    let resolveTerminal = (_result: HostRunResult): void => {};
    const terminalPromise = new Promise<HostRunResult>((resolve) => {
      resolveTerminal = resolve;
    });
    const abort = (): void => {
      void this.cancel(hostRunId, {
        code: "user_requested",
        message: "The run-lifetime signal was aborted.",
      });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const run: FixtureRun = {
      handle,
      events: [
        {
          type: "status",
          hostRunId,
          hostSessionId,
          sequence: 1,
          occurredAt: "2026-01-01T00:00:00.000Z",
          status: "running",
        },
      ],
      terminal: null,
      terminalPromise,
      resolveTerminal,
      abortCleanup: () => options.signal?.removeEventListener("abort", abort),
    };
    this.runs.set(hostRunId, run);
    if (this.completeImmediately) this.finish(run, "completed", null);
    return { ...handle };
  }

  private finish(
    run: FixtureRun,
    status: HostRunResult["status"],
    cancelReason: HostCancelReason | null,
  ): void {
    if (run.terminal) return;
    const result: HostRunResult = {
      hostRunId: run.handle.hostRunId,
      hostSessionId: run.handle.hostSessionId,
      status,
      outputText: status === "completed" ? "bounded output" : "",
      usage: usage(),
      error: null,
      cancelReason,
    };
    run.terminal = result;
    run.events.push({
      type: "terminal",
      hostRunId: result.hostRunId,
      hostSessionId: result.hostSessionId,
      sequence: 2,
      occurredAt: "2026-01-01T00:00:01.000Z",
      result,
    });
    run.abortCleanup();
    run.resolveTerminal(result);
  }

  async *events(hostRunId: string): AsyncIterable<HostRunEvent> {
    const run = this.requireRun(hostRunId);
    await run.terminalPromise;
    yield* run.events;
  }

  result(hostRunId: string): Promise<HostRunResult> {
    return this.requireRun(hostRunId).terminalPromise;
  }

  async cancel(
    hostRunId: string,
    reason: HostCancelReason = { code: "unknown" },
  ): Promise<void> {
    this.finish(this.requireRun(hostRunId), "canceled", { ...reason });
  }

  private requireRun(hostRunId: string): FixtureRun {
    const run = this.runs.get(hostRunId);
    if (!run) throw new Error(`HOST_RUN_NOT_FOUND: ${hostRunId}`);
    return run;
  }
}

async function collect(
  host: AgentHost,
  hostRunId: string,
): Promise<HostRunEvent[]> {
  const events: HostRunEvent[] = [];
  for await (const event of host.events(hostRunId)) events.push(event);
  return events;
}

test("AgentHost start produces replayable, ordered, attributable terminal evidence", async () => {
  const host: AgentHost = new ConformingFixtureHost();
  assert.equal((await host.discover()).available, true);
  const handle = await host.start(request);
  assert.equal(handle.status, "running");
  assert.ok(handle.hostSessionId);
  const result = await host.result(handle.hostRunId);
  const first = await collect(host, handle.hostRunId);
  const replay = await collect(host, handle.hostRunId);

  assert.deepEqual(replay, first);
  assert.deepEqual(first.map(({ sequence }) => sequence), [1, 2]);
  assert.ok(
    first.every(
      ({ hostRunId, hostSessionId }) =>
        hostRunId === handle.hostRunId &&
        hostSessionId === handle.hostSessionId,
    ),
  );
  assert.deepEqual(first.at(-1), {
    type: "terminal",
    hostRunId: result.hostRunId,
    hostSessionId: result.hostSessionId,
    sequence: 2,
    occurredAt: "2026-01-01T00:00:01.000Z",
    result,
  });
});

test("AgentHost resume preserves the requested session id", async () => {
  const host: AgentHost = new ConformingFixtureHost();
  const handle = await host.resume({
    ...request,
    generation: 2,
    hostSessionId: "host-session-prior",
  });
  assert.equal(handle.hostSessionId, "host-session-prior");
  assert.equal((await host.result(handle.hostRunId)).status, "completed");
});

test("AgentHost run signal and duplicate cancellation preserve the first reason", async () => {
  const host: AgentHost = new ConformingFixtureHost(false);
  const controller = new AbortController();
  const handle = await host.start(request, { signal: controller.signal });
  controller.abort(new Error("fixture abort"));
  await host.cancel(handle.hostRunId, {
    code: "timeout",
    message: "This later reason must not replace the first one.",
  });
  const result = await host.result(handle.hostRunId);
  assert.equal(result.status, "canceled");
  assert.deepEqual(result.cancelReason, {
    code: "user_requested",
    message: "The run-lifetime signal was aborted.",
  });
});

test("AgentHost rejects unknown run ids consistently", async () => {
  const host: AgentHost = new ConformingFixtureHost();
  await assert.rejects(
    async () => host.result("missing"),
    /HOST_RUN_NOT_FOUND/u,
  );
  await assert.rejects(
    async () => host.cancel("missing"),
    /HOST_RUN_NOT_FOUND/u,
  );
  await assert.rejects(
    async () => {
      for await (const _event of host.events("missing")) {
        // No event may be produced for an unknown run.
      }
    },
    /HOST_RUN_NOT_FOUND/u,
  );
});
