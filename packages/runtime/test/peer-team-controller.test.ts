import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  HostRunRequest,
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../adapter-sdk/src/types.ts";
import { parseStructuredArtifact } from "../src/managed-runner.ts";
import {
  PEER_TEAM_CONCURRENCY_CAPABILITY,
  PeerTeamController,
  PeerTeamControllerError,
  type PeerTeamSetup,
} from "../src/peer-team-controller.ts";

const usage: InferenceResult["usage"] = {
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cost: 0,
  measurementStatus: "measured",
};

const request: HostRunRequest = {
  taskPacket: {
    objective: "Prepare a bounded launch recommendation.",
    context: "Use only synthetic evidence.",
    acceptanceCriteria: ["Surface unresolved risks."],
  },
  organizationRevision: 1,
  workItemId: "work-peer-1",
  runId: "run-peer-1",
  attemptId: "attempt-peer-1",
  generation: 1,
};

const team: PeerTeamSetup = {
  cLevelRole: "chief",
  roles: [
    {
      id: "chief",
      name: "Chief",
      class: "c_level",
      description: "Coordinates work and requests human review.",
    },
    {
      id: "researcher",
      name: "Researcher",
      class: "worker",
      description: "Produces read-only research evidence.",
    },
    {
      id: "analyst",
      name: "Analyst",
      class: "worker",
      description: "Analyzes an isolated artifact copy.",
    },
  ],
};

const artifact = {
  apiVersion: "chartermesh.dev/structured-artifact/v1alpha1" as const,
  summary: "Synthetic recommendation prepared.",
  deliverable: "Launch only after the named risk is checked.",
  checks: ["Worker evidence was returned to the coordinator."],
  risks: ["No external facts were inspected."],
  nextActions: ["A human should review the recommendation."],
  confidence: "medium" as const,
};

function result(
  inferenceRequest: InferenceRequest,
  text: string,
): InferenceResult {
  return {
    invocationId: inferenceRequest.invocationId,
    text,
    toolCalls: [],
    finishReason: "stop",
    usage,
  };
}

function scriptedEngine(
  profileId: string,
  generate: ModelEngine["generate"],
  options: {
    concurrency?: number;
    cancel?: (invocationId: string) => Promise<void>;
  } = {},
): ModelEngine {
  return {
    manifest: {
      kind: "model_engine",
      profileId,
      adapter: "scripted-test",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
        },
        ...(options.concurrency
          ? [
              {
                name: PEER_TEAM_CONCURRENCY_CAPABILITY,
                support: "native" as const,
                stability: "experimental" as const,
                constraints: { maxParallel: options.concurrency },
              },
            ]
          : []),
      ],
    },
    generate,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

test("C-level dispatch dynamically invokes the selected role engine and receives its handoff", async () => {
  let cLevelCalls = 0;
  let workerCalls = 0;
  let setupCalls = 0;
  let recordedHash = "";
  const worker = scriptedEngine("worker-engine", async (inferenceRequest) => {
    workerCalls += 1;
    const payload = JSON.parse(
      inferenceRequest.messages.find(({ role }) => role === "user")?.content ??
        "{}",
    ) as { command: unknown; envelopeHash: string };
    assert.equal(
      payload.envelopeHash,
      createHash("sha256").update(canonicalJson(payload.command)).digest("hex"),
    );
    return {
      ...result(inferenceRequest, "worker evidence: one unresolved risk"),
      usage: {
        ...usage,
        inputTokens: null,
        measurementStatus: "unknown",
      },
    };
  });
  const chief = scriptedEngine("chief-engine", async (inferenceRequest) => {
    cLevelCalls += 1;
    if (cLevelCalls === 1) {
      return result(
        inferenceRequest,
        JSON.stringify({
          action: "dispatch",
          reason: "Research is required.",
          recipients: [
            {
              role: "researcher",
              instruction: "Identify one unresolved risk.",
              artifactAccess: "read_only",
            },
          ],
        }),
      );
    }
    const prompt = inferenceRequest.messages.find(
      ({ role }) => role === "user",
    )?.content;
    assert.match(prompt ?? "", /worker evidence: one unresolved risk/u);
    return result(
      inferenceRequest,
      JSON.stringify({
        action: "request_review",
        reason: "The bounded artifact is ready for a person.",
        artifact,
      }),
    );
  });

  const output = await new PeerTeamController().run(request, {
    team,
    engine: chief,
    engineForRole: (role) => (role === "researcher" ? worker : chief),
    lifecycle: {
      setupTeam() {
        setupCalls += 1;
      },
      createHandoff({ envelopeHash }) {
        recordedHash = envelopeHash;
      },
    },
  });

  assert.equal(setupCalls, 1);
  assert.equal(cLevelCalls, 2);
  assert.equal(workerCalls, 1);
  assert.match(recordedHash, /^[a-f0-9]{64}$/u);
  assert.equal(output.handoffs[0]?.envelopeHash, recordedHash);
  assert.equal(output.metrics.internalCycles, 2);
  assert.equal(output.metrics.setupModelCalls, 0);
  assert.equal(output.metrics.cLevelCalls, 2);
  assert.equal(output.metrics.workerCalls, 1);
  assert.equal(output.metrics.usage.inputTokens, null);
  assert.equal(output.metrics.usage.measurementStatus, "unknown");
  assert.deepEqual(parseStructuredArtifact(output.inference.text), artifact);
});

test("same manifest is serialized unless it declares a native concurrency capability", async () => {
  let chiefCalls = 0;
  let active = 0;
  let maximumActive = 0;
  const chief = scriptedEngine("chief", async (inferenceRequest) => {
    chiefCalls += 1;
    return result(
      inferenceRequest,
      chiefCalls === 1
        ? JSON.stringify({
            action: "dispatch",
            reason: "Run three isolated analyses.",
            recipients: [
              {
                role: "researcher",
                instruction: "Analysis A",
                artifactAccess: "isolated",
              },
              {
                role: "analyst",
                instruction: "Analysis B",
                artifactAccess: "isolated",
              },
              {
                role: "researcher",
                instruction: "Analysis C",
                artifactAccess: "isolated",
              },
            ],
          })
        : JSON.stringify({
            action: "request_review",
            reason: "All analyses returned.",
            artifact,
          }),
    );
  });
  const sharedWorker = scriptedEngine(
    "shared-worker",
    async (inferenceRequest) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return result(inferenceRequest, "isolated analysis complete");
    },
  );

  const output = await new PeerTeamController({ maxParallel: 3 }).run(
    request,
    {
      team,
      engine: chief,
      engineForRole: (role) =>
        role === "chief" ? chief : sharedWorker,
    },
  );

  assert.equal(maximumActive, 1);
  assert.equal(output.metrics.effectiveMaxParallel, 1);
  assert.equal(output.metrics.maxObservedParallel, 1);
});

test("declared native engine concurrency is bounded by controller maxParallel", async () => {
  let chiefCalls = 0;
  let active = 0;
  let maximumActive = 0;
  const chief = scriptedEngine("chief", async (inferenceRequest) => {
    chiefCalls += 1;
    return result(
      inferenceRequest,
      chiefCalls === 1
        ? JSON.stringify({
            action: "dispatch",
            reason: "Run three safe reads.",
            recipients: [
              {
                role: "researcher",
                instruction: "Read A",
                artifactAccess: "read_only",
              },
              {
                role: "analyst",
                instruction: "Read B",
                artifactAccess: "read_only",
              },
              {
                role: "researcher",
                instruction: "Read C",
                artifactAccess: "read_only",
              },
            ],
          })
        : JSON.stringify({
            action: "request_review",
            reason: "Reads completed.",
            artifact,
          }),
    );
  });
  const concurrentWorker = scriptedEngine(
    "concurrent-worker",
    async (inferenceRequest) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return result(inferenceRequest, "read complete");
    },
    { concurrency: 2 },
  );

  const output = await new PeerTeamController({ maxParallel: 3 }).run(
    request,
    {
      team,
      engine: chief,
      engineForRole: (role) =>
        role === "chief" ? chief : concurrentWorker,
    },
  );

  assert.equal(maximumActive, 2);
  assert.equal(output.metrics.effectiveMaxParallel, 2);
  assert.equal(output.metrics.maxObservedParallel, 2);
});

test("a worker cannot request human review", async () => {
  const chief = scriptedEngine("chief", async (inferenceRequest) =>
    result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Delegate bounded review preparation.",
        recipients: [
          {
            role: "researcher",
            instruction: "Prepare evidence.",
            artifactAccess: "read_only",
          },
        ],
      }),
    ),
  );
  const worker = scriptedEngine("worker", async (inferenceRequest) =>
    result(
      inferenceRequest,
      JSON.stringify({
        action: "request_review",
        reason: "A worker must not do this.",
        artifact,
      }),
    ),
  );

  await assert.rejects(
    new PeerTeamController().run(request, {
      team,
      engine: chief,
      engineForRole: (role) => (role === "chief" ? chief : worker),
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "C_LEVEL_ONLY_REVIEW",
  );
});

test("an unknown dispatch target fails closed before a worker call", async () => {
  let workerCalls = 0;
  const engine = scriptedEngine("engine", async (inferenceRequest) => {
    const user = inferenceRequest.messages.find(({ role }) => role === "user")
      ?.content;
    if (user?.includes("peer-handoff")) workerCalls += 1;
    return result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Try an undeclared target.",
        recipients: [
          {
            role: "ghost",
            instruction: "Do work.",
            artifactAccess: "read_only",
          },
        ],
      }),
    );
  });

  await assert.rejects(
    new PeerTeamController().run(request, { team, engine }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "INVALID_TARGET",
  );
  assert.equal(workerCalls, 0);
});

test("bounded internal cycles report a liveness error", async () => {
  const chief = scriptedEngine("chief", async (inferenceRequest) =>
    result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Repeat bounded work.",
        recipients: [
          {
            role: "researcher",
            instruction: "Repeat evidence.",
            artifactAccess: "read_only",
          },
        ],
      }),
    ),
  );
  const worker = scriptedEngine("worker", async (inferenceRequest) =>
    result(inferenceRequest, "evidence returned"),
  );

  await assert.rejects(
    new PeerTeamController({ maxInternalCycles: 2 }).run(request, {
      team,
      engine: chief,
      engineForRole: (role) => (role === "chief" ? chief : worker),
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "LIVENESS_EXHAUSTED",
  );
});

test("stage-call budget stops a team before an extra model call starts", async () => {
  let calls = 0;
  const alwaysDispatch = scriptedEngine("call-budget", async (inferenceRequest) => {
    calls += 1;
    if (calls === 1) {
      return result(
        inferenceRequest,
        JSON.stringify({
          action: "dispatch",
          reason: "One worker check is required.",
          recipients: [
            {
              role: "researcher",
              instruction: "Return a bounded check.",
              artifactAccess: "read_only",
            },
          ],
        }),
      );
    }
    return result(inferenceRequest, "bounded worker result");
  });
  await assert.rejects(
    () =>
      new PeerTeamController({ maxStageCalls: 2 }).run(request, {
        team,
        engine: alwaysDispatch,
      }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "STAGE_CALL_LIMIT_EXCEEDED",
  );
  assert.equal(calls, 2);
});

test("a token cap prevents a peer stage that cannot fit before model execution", async () => {
  let calls = 0;
  const model = scriptedEngine("token-budget", async (inferenceRequest) => {
    calls += 1;
    return result(inferenceRequest, JSON.stringify({ action: "invalid" }));
  });
  await assert.rejects(
    new PeerTeamController({ maxTotalTokens: 100 }).run(request, {
      team,
      engine: model,
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "TOKEN_LIMIT_EXCEEDED",
  );
  assert.equal(calls, 0);
});

test("parallel workers reserve one shared token budget before either call starts", async () => {
  let chiefCalls = 0;
  let workerCalls = 0;
  const chief = scriptedEngine("chief", async (inferenceRequest) => {
    chiefCalls += 1;
    return result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Run two isolated checks.",
        recipients: [
          {
            role: "researcher",
            instruction: "Return check A.",
            artifactAccess: "isolated",
          },
          {
            role: "analyst",
            instruction: "Return check B.",
            artifactAccess: "isolated",
          },
        ],
      }),
    );
  });
  const worker = scriptedEngine(
    "parallel-worker",
    async (inferenceRequest) => {
      workerCalls += 1;
      return result(inferenceRequest, "bounded worker result");
    },
    { concurrency: 2 },
  );
  await assert.rejects(
    new PeerTeamController({
      maxParallel: 2,
      maxOutputTokensPerCall: 8_192,
      maxTotalTokens: 10_000,
    }).run(request, {
      team,
      engine: chief,
      engineForRole: (role) => (role === "chief" ? chief : worker),
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "TOKEN_LIMIT_EXCEEDED",
  );
  assert.equal(chiefCalls, 1);
  assert.ok(workerCalls < 2);
});

test("AbortSignal cancels an active routed worker and closes lifecycle as canceled", async () => {
  const abortController = new AbortController();
  let cancelCalls = 0;
  let rejectWorker: ((reason: unknown) => void) | undefined;
  const finishedStatuses: string[] = [];
  const chief = scriptedEngine("chief", async (inferenceRequest) =>
    result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Start cancellable work.",
        recipients: [
          {
            role: "researcher",
            instruction: "Wait for cancellation.",
            artifactAccess: "read_only",
          },
        ],
      }),
    ),
  );
  const worker = scriptedEngine(
    "worker",
    async () => {
      queueMicrotask(() => abortController.abort(new Error("test stop")));
      return await new Promise<InferenceResult>((_resolve, reject) => {
        rejectWorker = reject;
      });
    },
    {
      async cancel() {
        cancelCalls += 1;
        rejectWorker?.(new Error("worker canceled"));
      },
    },
  );

  await assert.rejects(
    new PeerTeamController().run(request, {
      team,
      engine: chief,
      engineForRole: (role) => (role === "chief" ? chief : worker),
      signal: abortController.signal,
      lifecycle: {
        finishStage({ kind, status }) {
          if (kind === "worker") finishedStatuses.push(status);
        },
      },
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError && error.code === "CANCELED",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
  assert.deepEqual(finishedStatuses, ["canceled"]);
});

test("an engine that ignores cancellation fails with an unsettled-call error", async () => {
  const abortController = new AbortController();
  const chief = scriptedEngine("chief", async (inferenceRequest) =>
    result(
      inferenceRequest,
      JSON.stringify({
        action: "dispatch",
        reason: "Start an uncooperative worker.",
        recipients: [
          {
            role: "researcher",
            instruction: "Wait forever.",
            artifactAccess: "read_only",
          },
        ],
      }),
    ),
  );
  const worker = scriptedEngine("worker", async () => {
    queueMicrotask(() => abortController.abort(new Error("test stop")));
    return await new Promise<InferenceResult>(() => {});
  });
  await assert.rejects(
    new PeerTeamController({ abortSettlementMs: 20 }).run(request, {
      team,
      engine: chief,
      engineForRole: (role) => (role === "chief" ? chief : worker),
      signal: abortController.signal,
    }),
    (error: unknown) =>
      error instanceof PeerTeamControllerError &&
      error.code === "CANCELLATION_UNSETTLED",
  );
});
