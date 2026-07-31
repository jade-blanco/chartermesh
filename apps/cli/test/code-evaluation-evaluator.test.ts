import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
} from "../../../packages/adapter-sdk/src/types.ts";
import {
  CODE_EVALUATION_CONDITIONS,
  bindCodeEvaluationEngine,
  bindCodeEvaluationProvenance,
  createCodeEvaluationState,
  evaluateCodeGenerationState,
  freezeCodeEvaluationState,
  runCodeGenerationStage as runBoundCodeGenerationStage,
  type CodeEngineDescriptorInput,
  type CodeEngineSlot,
  type CodeEvaluationState,
} from "../src/code-evaluation/evaluator.ts";
import {
  CODE_EVALUATION_GUEST_BUNDLE_PATHS,
  codeEvaluationGuestManifestSha256,
  collectCodeEvaluationProvenance,
  type CodeEvaluationProvenance,
} from "../src/code-evaluation/provenance.ts";
import type {
  CodeSandboxBackend,
  CodeSandboxJob,
  CodeSandboxProbe,
  CodeSandboxRunResult,
} from "../src/code-evaluation/sandbox.ts";
import { generatePilotCodeSuite } from "../src/code-evaluation/suite.ts";

const safeProbe: CodeSandboxProbe = {
  ok: true,
  backendId: "offline-fake-vm",
  evidence: {
    networkDenied: true,
    hostReadDenied: true,
    hostWriteDenied: true,
    childEscapeDenied: true,
    timeoutEnforced: true,
    outputAllowlistEnforced: true,
  },
  issues: [],
};

function candidateText(
  marker: string,
  contract: "strict" | "recovered" = "strict",
): string {
  const json = JSON.stringify({
    apiVersion: "chartermesh.dev/code-candidate/v1alpha1",
    files: [
      {
        path: "solution.mjs",
        content: `export function solve(input) { return { marker: ${JSON.stringify(marker)}, input }; }\n`,
      },
    ],
    summary: `Fixture candidate ${marker}.`,
  });
  return contract === "strict"
    ? json
    : `Candidate follows.\n${json}\nEnd candidate.`;
}

function fakeEngine(
  profileId: string,
  respond: (
    request: InferenceRequest,
    callIndex: number,
  ) => string | Promise<string>,
): ModelEngine & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  return {
    manifest: {
      kind: "model_engine",
      profileId,
      adapter: "offline-test",
      contractVersion: "v1alpha1",
      capabilities: [],
    },
    requests,
    async generate(request): Promise<InferenceResult> {
      const callIndex = requests.length;
      requests.push(structuredClone(request));
      return {
        invocationId: request.invocationId,
        text: await respond(request, callIndex),
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          measurementStatus: "measured",
        },
      };
    },
  };
}

function bindOfflineEngine(
  state: CodeEvaluationState,
  slot: CodeEngineSlot,
  engine: ModelEngine,
  overrides: Partial<CodeEngineDescriptorInput> = {},
): void {
  bindCodeEvaluationEngine(state, {
    slot,
    engineId: engine.manifest.profileId,
    adapter: engine.manifest.adapter,
    endpoint: `http://127.0.0.1:${slot === "e4b" ? 18081 : slot === "gemma26b" ? 18082 : 18083}/v1`,
    model: `${slot}-offline-model`,
    quantization: "offline",
    contextTokens: 8_192,
    serverBuild: "offline-test",
    timeoutMs: 300_000,
    maxResponseBytes: 8_388_608,
    structuredOutputMode: "prompt",
    reasoningMode: "disabled",
    temperature: 0,
    seed: 20260731,
    modelArtifactSha256: `${slot === "e4b" ? "a" : slot === "gemma26b" ? "b" : "c"}`.repeat(
      64,
    ),
    modelArtifactHashKind:
      slot === "qwen" ? "canonical-shard-manifest" : "file",
    ...overrides,
  });
}

function offlineProvenance(): CodeEvaluationProvenance {
  const files = CODE_EVALUATION_GUEST_BUNDLE_PATHS.map(
    (path, index) => ({
      path,
      sha256: `${index + 1}`.repeat(64),
    }),
  );
  return {
    schemaVersion:
      "chartermesh.dev/code-evaluation-provenance/v1alpha1",
    charterMesh: { packageVersion: "0.0.0-test.1" },
    git: { commit: null, dirty: null },
    node: {
      version: process.version,
      runtimeExecutableSha256: "a".repeat(64),
    },
    os: {
      platform: "offline",
      arch: "fixture",
      version: "offline-test",
      build: "offline-build",
    },
    sandboxGuestBundle: {
      format: "canonical-json-sha256-v1",
      files,
      manifestSha256: codeEvaluationGuestManifestSha256(files),
    },
  };
}

function bindOfflineProvenance(state: CodeEvaluationState): void {
  bindCodeEvaluationProvenance(state, offlineProvenance());
}

type GenerationOptions = Parameters<
  typeof runBoundCodeGenerationStage
>[2];

function runCodeGenerationStage(
  state: CodeEvaluationState,
  engine: ModelEngine,
  options: Omit<
    GenerationOptions,
    "engineFingerprint" | "onProgress"
  > & {
    engineFingerprint?: string;
    onProgress?: GenerationOptions["onProgress"];
  },
) {
  const descriptor = state.engines.find(
    ({ slot }) => slot === options.engineSlot,
  );
  if (!descriptor) {
    throw new Error(`Test engine slot '${options.engineSlot}' is unbound.`);
  }
  return runBoundCodeGenerationStage(state, engine, {
    ...options,
    engineFingerprint:
      options.engineFingerprint ?? descriptor.fingerprint,
    onProgress: options.onProgress ?? (() => undefined),
  });
}

async function populateCompleteMatrix(
  state: CodeEvaluationState,
  engines: {
    e4b: ModelEngine;
    gemma26b: ModelEngine;
    qwen: ModelEngine;
  },
): Promise<void> {
  await runCodeGenerationStage(state, engines.e4b, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(state, engines.gemma26b, {
    conditionId: "gemma26b-single",
    stageId: "final",
    engineSlot: "gemma26b",
  });
  await runCodeGenerationStage(state, engines.qwen, {
    conditionId: "qwen-single",
    stageId: "final",
    engineSlot: "qwen",
  });
  await runCodeGenerationStage(state, engines.e4b, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "draft",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(state, engines.gemma26b, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "review",
    engineSlot: "gemma26b",
  });
  await runCodeGenerationStage(state, engines.qwen, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "final",
    engineSlot: "qwen",
  });
}

class MetadataOnlyVmBackend implements CodeSandboxBackend {
  readonly manifest = {
    id: "offline-fake-vm",
    isolation: "vm",
    network: "disabled",
    hostFilesystem: "mapped-allowlist",
    generatedCodeExecution: true,
  } as const;

  readonly batches: CodeSandboxJob[][] = [];
  readonly suite = generatePilotCodeSuite();
  readonly firstTaskId = this.suite[0]!.id;
  readonly secondTaskId = this.suite[1]!.id;
  readonly options: {
    survivingMutation?: boolean;
    reverseResults?: boolean;
    wrongJobId?: boolean;
    policyViolation?: boolean;
    survivorProcesses?: number;
  };

  constructor(
    options: {
      survivingMutation?: boolean;
      reverseResults?: boolean;
      wrongJobId?: boolean;
      policyViolation?: boolean;
      survivorProcesses?: number;
    } = {},
  ) {
    this.options = options;
  }

  async probe(): Promise<CodeSandboxProbe> {
    return structuredClone(safeProbe);
  }

  async run(): Promise<CodeSandboxRunResult> {
    throw new Error(
      "The metadata-only fake must never execute candidate source.",
    );
  }

  async runBatch(
    jobs: CodeSandboxJob[],
  ): Promise<CodeSandboxRunResult[]> {
    this.batches.push(structuredClone(jobs));
    let allowedSurvivingMutation = this.options.survivingMutation ?? false;
    const results = jobs.map((job, index) => {
      const failedIds = new Set<string>();
      if (job.id.endsWith(":baseline")) {
        const task = this.suite.find(({ id }) => id === job.task.id)!;
        for (const id of task.baselineExpectedFailureCaseIds) {
          failedIds.add(id);
        }
      } else if (job.id.includes(":mutation:")) {
        if (allowedSurvivingMutation) {
          allowedSurvivingMutation = false;
        } else {
          failedIds.add(job.cases[0]!.id);
        }
      } else if (
        job.id.startsWith("generated:e4b-single:") &&
        job.task.id === this.secondTaskId
      ) {
        failedIds.add(job.cases.at(-1)!.id);
      } else if (
        job.id.startsWith(
          "generated:tiered-e4b-gemma26b-qwen:",
        ) &&
        job.task.id === this.firstTaskId &&
        !job.id.endsWith(":final")
      ) {
        failedIds.add(job.cases.at(-1)!.id);
      }
      const cases = job.cases.map(({ id }) => {
        const passed = !failedIds.has(id);
        return {
          id,
          passed,
          exitCode: 0,
          latencyMs: 1,
          ...(passed
            ? {}
            : {
                errorCode:
                  "EXPECTED_OUTPUT_MISMATCH" as const,
              }),
        };
      });
      return {
        jobId:
          this.options.wrongJobId && index === 0
            ? `${job.id}:wrong`
            : job.id,
        taskId: job.task.id,
        passed: cases.every(({ passed }) => passed),
        cases,
        changedPaths: ["solution.mjs"],
        policyViolations: this.options.policyViolation
          ? ["fixture-policy-violation"]
          : [],
        survivorProcesses: this.options.survivorProcesses ?? 0,
        outputBytes: 64,
      };
    });
    return this.options.reverseResults ? results.reverse() : results;
  }
}

test("evaluation plan gives every single and tiered condition the same 6,144-token ceiling", () => {
  const first = createCodeEvaluationState(41);
  const second = createCodeEvaluationState(41);

  assert.equal(first.planHash, second.planHash);
  assert.equal(first.suiteHash, second.suiteHash);
  assert.notEqual(first.evaluationId, second.evaluationId);
  assert.deepEqual(
    first.conditions.map(({ id }) => id),
    CODE_EVALUATION_CONDITIONS.map(({ id }) => id),
  );

  for (const condition of CODE_EVALUATION_CONDITIONS) {
    assert.equal(
      condition.maxRequestedOutputTokensPerTask,
      6_144,
      condition.id,
    );
    assert.equal(
      condition.stages.reduce(
        (sum, { maxOutputTokens }) => sum + maxOutputTokens,
        0,
      ),
      6_144,
      condition.id,
    );
  }
  assert.equal(
    CODE_EVALUATION_CONDITIONS.find(
      ({ id }) => id === "e4b-single",
    )!.stages.length,
    1,
  );
  assert.equal(
    CODE_EVALUATION_CONDITIONS.find(
      ({ id }) => id === "tiered-e4b-gemma26b-qwen",
    )!.stages.length,
    3,
  );
});

test("an engine slot is immutable and every stage must attest its bound fingerprint", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("bound-engine", () =>
    candidateText("must-not-run"),
  );
  bindOfflineEngine(state, "e4b", engine);
  const original = state.engines[0]!;
  const { fingerprint: _fingerprint, ...originalInput } = original;

  assert.throws(
    () =>
      bindCodeEvaluationEngine(state, {
        ...originalInput,
        model: "different-model",
      }),
    /already bound to another fingerprint/u,
  );
  await assert.rejects(
    runCodeGenerationStage(state, engine, {
      conditionId: "e4b-single",
      stageId: "final",
      engineSlot: "e4b",
      engineFingerprint: "0".repeat(64),
    }),
    /supplied engine fingerprint/u,
  );
  assert.equal(engine.requests.length, 0);

  const shardState = createCodeEvaluationState();
  assert.throws(
    () =>
      bindCodeEvaluationEngine(shardState, {
        ...originalInput,
        modelArtifactSha256: "a".repeat(64),
        modelArtifactHashKind: undefined,
      }),
    /descriptor 'e4b' is invalid/u,
  );
  const shardDescriptor = bindCodeEvaluationEngine(shardState, {
    ...originalInput,
    modelArtifactSha256: "b".repeat(64),
    modelArtifactHashKind: "canonical-shard-manifest",
  });
  assert.equal(
    shardDescriptor.modelArtifactHashKind,
    "canonical-shard-manifest",
  );
});

test("reproducibility provenance is strict, hash-bound, and contains no absolute paths", () => {
  const state = createCodeEvaluationState();
  const provenance = offlineProvenance();
  bindCodeEvaluationProvenance(state, provenance);

  assert.deepEqual(state.provenance, provenance);
  assert.equal(
    state.provenance?.sandboxGuestBundle.files.every(
      ({ path }) =>
        path.startsWith("scripts/windows-sandbox/") &&
        !/^(?:[A-Za-z]:|[\\/])/u.test(path),
    ),
    true,
  );
  const malformed = structuredClone(provenance) as
    CodeEvaluationProvenance & { runtimePath?: string };
  malformed.runtimePath = "C:\\sensitive\\node.exe";
  assert.throws(
    () =>
      bindCodeEvaluationProvenance(
        createCodeEvaluationState(),
        malformed,
      ),
    /CODE_EVALUATION_PROVENANCE_INVALID/u,
  );
  const changedManifest = structuredClone(provenance);
  changedManifest.sandboxGuestBundle.files[0]!.sha256 = "f".repeat(64);
  assert.throws(
    () =>
      bindCodeEvaluationProvenance(
        createCodeEvaluationState(),
        changedManifest,
      ),
    /CODE_EVALUATION_PROVENANCE_INVALID/u,
  );
});

test("provenance collection hashes the selected runtime and complete guest bundle while tolerating unavailable git", async () => {
  const root = await mkdtemp(join(tmpdir(), "chartermesh-provenance-"));
  const guestDirectory = join(root, "guest");
  const packageJson = join(root, "package.json");
  const runtimeExecutable = join(root, "node-fixture.exe");
  try {
    await mkdir(guestDirectory);
    await writeFile(
      packageJson,
      `${JSON.stringify({ version: "1.2.3-test.1" })}\n`,
      "utf8",
    );
    await writeFile(runtimeExecutable, "fixture-runtime", "utf8");
    for (const path of CODE_EVALUATION_GUEST_BUNDLE_PATHS) {
      await writeFile(
        join(guestDirectory, basename(path)),
        `fixture:${path}\n`,
        "utf8",
      );
    }

    const provenance = await collectCodeEvaluationProvenance({
      packageJson,
      repositoryDirectory: root,
      runtimeExecutable,
      guestBundleDirectory: guestDirectory,
    });
    assert.equal(provenance.charterMesh.packageVersion, "1.2.3-test.1");
    assert.deepEqual(provenance.git, {
      commit: null,
      dirty: null,
    });
    assert.equal(
      provenance.node.runtimeExecutableSha256,
      createHash("sha256").update("fixture-runtime").digest("hex"),
    );
    assert.deepEqual(
      provenance.sandboxGuestBundle.files.map(({ path }) => path),
      [...CODE_EVALUATION_GUEST_BUNDLE_PATHS],
    );
    assert.equal(
      JSON.stringify(provenance).includes(root),
      false,
    );

    await assert.rejects(
      collectCodeEvaluationProvenance({
        packageJson,
        repositoryDirectory: root,
        runtimeExecutable: join(root, "missing-node.exe"),
        guestBundleDirectory: guestDirectory,
      }),
      /CODE_EVALUATION_RUNTIME_HASH_UNAVAILABLE/u,
    );
    await assert.rejects(
      collectCodeEvaluationProvenance({
        packageJson,
        repositoryDirectory: root,
        runtimeExecutable,
        guestBundleDirectory: join(root, "missing-guest"),
      }),
      /CODE_EVALUATION_GUEST_BUNDLE_UNATTESTED/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishable freeze requires artifact provenance and uniform comparison controls", async () => {
  const engine = fakeEngine("comparison-control-engine", (_request, index) =>
    candidateText(`comparison-control-${index}`),
  );
  const missingArtifact = createCodeEvaluationState();
  bindOfflineEngine(missingArtifact, "e4b", engine, {
    modelArtifactSha256: undefined,
    modelArtifactHashKind: undefined,
  });
  bindOfflineEngine(missingArtifact, "gemma26b", engine);
  bindOfflineEngine(missingArtifact, "qwen", engine);
  await populateCompleteMatrix(missingArtifact, {
    e4b: engine,
    gemma26b: engine,
    qwen: engine,
  });
  assert.throws(
    () => freezeCodeEvaluationState(missingArtifact),
    /GENERATION_MODEL_ARTIFACT_UNATTESTED/u,
  );

  const mismatchedContext = createCodeEvaluationState();
  bindOfflineEngine(mismatchedContext, "e4b", engine);
  bindOfflineEngine(mismatchedContext, "gemma26b", engine, {
    contextTokens: 4_096,
  });
  bindOfflineEngine(mismatchedContext, "qwen", engine);
  await populateCompleteMatrix(mismatchedContext, {
    e4b: engine,
    gemma26b: engine,
    qwen: engine,
  });
  assert.throws(
    () => freezeCodeEvaluationState(mismatchedContext),
    /GENERATION_COMPARISON_CONTROLS_MISMATCH: contextTokens/u,
  );

  const missingProvenance = createCodeEvaluationState();
  bindOfflineEngine(missingProvenance, "e4b", engine);
  bindOfflineEngine(missingProvenance, "gemma26b", engine);
  bindOfflineEngine(missingProvenance, "qwen", engine);
  await populateCompleteMatrix(missingProvenance, {
    e4b: engine,
    gemma26b: engine,
    qwen: engine,
  });
  assert.throws(
    () => freezeCodeEvaluationState(missingProvenance),
    /GENERATION_PROVENANCE_UNATTESTED/u,
  );
});

test("a running invocation is checkpointed before the call and is never retried automatically", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("durable-engine", (_request, index) =>
    candidateText(`durable-${index}`),
  );
  bindOfflineEngine(state, "e4b", engine);
  const snapshots: CodeEvaluationState[] = [];

  await assert.rejects(
    runCodeGenerationStage(state, engine, {
      conditionId: "e4b-single",
      stageId: "final",
      engineSlot: "e4b",
      onProgress(snapshot) {
        snapshots.push(snapshot);
        throw new Error("simulated checkpoint boundary crash");
      },
    }),
    /simulated checkpoint boundary crash/u,
  );
  assert.equal(engine.requests.length, 0);
  assert.equal(
    snapshots[0]?.conditions[0]?.tasks[0]?.stages[0]?.status,
    "invocation_running",
  );
  const indeterminateInvocationId =
    `${state.evaluationId}:e4b-single:` +
    `${state.conditions[0]!.tasks[0]!.taskId}:final`;

  await runCodeGenerationStage(state, engine, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });
  assert.equal(engine.requests.length, generatePilotCodeSuite().length - 1);
  assert.equal(
    engine.requests.some(
      ({ invocationId }) => invocationId === indeterminateInvocationId,
    ),
    false,
  );
  assert.throws(
    () => freezeCodeEvaluationState(state),
    /GENERATION_INVOCATION_INDETERMINATE/u,
  );
});

test("tiered stages fail closed when their immediate upstream candidate is unavailable", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("must-not-run", () => {
    throw new Error("stage-order failure invoked a model");
  });
  bindOfflineEngine(state, "gemma26b", engine);
  bindOfflineEngine(state, "qwen", engine);
  let progressCalls = 0;

  await runCodeGenerationStage(state, engine, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "review",
    engineSlot: "gemma26b",
    onProgress() {
      progressCalls += 1;
    },
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "final",
    engineSlot: "qwen",
    onProgress() {
      progressCalls += 1;
    },
  });

  const tiered = state.conditions.find(
    ({ id }) => id === "tiered-e4b-gemma26b-qwen",
  )!;
  assert.equal(engine.requests.length, 0);
  assert.equal(progressCalls, tiered.tasks.length * 2);
  for (const task of tiered.tasks) {
    assert.deepEqual(
      task.stages.map(
        ({ stageId, status, contract, errorCode }) => ({
          stageId,
          status,
          contract,
          errorCode,
        }),
      ),
      [
        {
          stageId: "review",
          status: "failed",
          contract: "invalid",
          errorCode: "UPSTREAM_CANDIDATE_UNAVAILABLE",
        },
        {
          stageId: "final",
          status: "failed",
          contract: "invalid",
          errorCode: "UPSTREAM_CANDIDATE_UNAVAILABLE",
        },
      ],
    );
  }

  await assert.rejects(
    runCodeGenerationStage(state, engine, {
      conditionId: "tiered-e4b-gemma26b-qwen",
      stageId: "draft",
      engineSlot: "qwen",
    }),
    /does not use engine slot/u,
  );
});

test("generation distinguishes strict structured output from a recovered candidate without retrying", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("e4b-offline", (_request, index) =>
    candidateText(
      `candidate-${index}`,
      index % 2 === 0 ? "strict" : "recovered",
    ),
  );
  bindOfflineEngine(state, "e4b", engine);

  await runCodeGenerationStage(state, engine, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });

  const records = state.conditions.find(
    ({ id }) => id === "e4b-single",
  )!.tasks.flatMap(({ stages }) => stages);
  assert.equal(engine.requests.length, 6);
  assert.equal(
    records.filter(({ contract }) => contract === "strict").length,
    3,
  );
  assert.equal(
    records.filter(({ contract }) => contract === "recovered").length,
    3,
  );
  assert.equal(
    records.every(
      ({ status, candidate, candidateHash, rawOutputHash }) =>
        status === "candidate_available" &&
        candidate !== undefined &&
        candidateHash !== undefined &&
        rawOutputHash !== undefined,
    ),
    true,
  );
  assert.equal(
    engine.requests.every(
      ({ maxOutputTokens, responseSchema }) =>
        maxOutputTokens === 6_144 &&
        responseSchema !== undefined,
    ),
    true,
  );
  const tasks = generatePilotCodeSuite();
  for (const [index, request] of engine.requests.entries()) {
    const task = tasks[index]!;
    const prompt = request.messages.map(({ content }) => content).join(
      "\n",
    );
    for (const hidden of task.hiddenCases) {
      assert.equal(prompt.includes(hidden.id), false, hidden.id);
    }
    assert.equal(prompt.includes(task.oracleContent), false, task.id);
    for (const mutation of task.mutations) {
      assert.equal(
        prompt.includes(mutation.content),
        false,
        mutation.id,
      );
    }
  }
  const publicErrorTaskIndex = tasks.findIndex((task) =>
    task.publicCases.some(
      (testCase) =>
        "expectedErrorCode" in testCase &&
        testCase.expectedErrorCode !== undefined,
    ),
  );
  const publicErrorPrompt =
    engine.requests[publicErrorTaskIndex]!.messages.at(-1)!.content;
  const expectedPublicError = tasks[
    publicErrorTaskIndex
  ]!.publicCases.find(
    (testCase) => "expectedErrorCode" in testCase,
  )!.expectedErrorCode;
  assert.match(publicErrorPrompt, new RegExp(expectedPublicError!, "u"));
});

test("external generation records reject forged terminal fields and usage", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("schema-bound-engine", () =>
    candidateText("schema-bound"),
  );
  bindOfflineEngine(state, "e4b", engine);
  await runCodeGenerationStage(state, engine, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });

  const rejectMutation = (
    mutate: (record: Record<string, unknown>) => void,
  ) => {
    const tampered = structuredClone(state);
    const record = tampered.conditions
      .find(({ id }) => id === "e4b-single")!
      .tasks[0]!.stages[0] as unknown as Record<string, unknown>;
    mutate(record);
    assert.throws(
      () =>
        bindCodeEvaluationProvenance(
          tampered,
          offlineProvenance(),
        ),
      /strict runtime schema|inconsistent status/u,
    );
  };

  rejectMutation((record) => {
    record.status = "complete";
  });
  rejectMutation((record) => {
    record.contract = "trusted";
  });
  rejectMutation((record) => {
    record.finishReason = "successful";
  });
  rejectMutation((record) => {
    const usage = record.usage as Record<string, unknown>;
    usage.outputTokens = -1;
  });
  rejectMutation((record) => {
    const usage = record.usage as Record<string, unknown>;
    usage.untrustedEstimate = 1;
  });
  rejectMutation((record) => {
    record.uncommittedEvidence = true;
  });
});

test("evaluation aggregates oracle, baseline, and mutation preflight before comparing single and tiered results", async () => {
  const state = createCodeEvaluationState();
  const taskCount = generatePilotCodeSuite().length;
  const e4b = fakeEngine("e4b-fixture", (_request, index) =>
    candidateText(
      `single-${index}`,
      index === 0 ? "recovered" : "strict",
    ),
  );
  const reviewer = fakeEngine(
    "gemma26b-review-fixture",
    (_request, index) => candidateText(`review-${index}`),
  );
  const finalReviewer = fakeEngine(
    "qwen-final-fixture",
    (_request, index) => candidateText(`final-${index}`),
  );
  bindOfflineEngine(state, "e4b", e4b);
  bindOfflineEngine(state, "gemma26b", reviewer);
  bindOfflineEngine(state, "qwen", finalReviewer);

  await runCodeGenerationStage(state, e4b, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(
    state,
    reviewer,
    {
      conditionId: "gemma26b-single",
      stageId: "final",
      engineSlot: "gemma26b",
    },
  );
  await runCodeGenerationStage(
    state,
    finalReviewer,
    {
      conditionId: "qwen-single",
      stageId: "final",
      engineSlot: "qwen",
    },
  );
  await runCodeGenerationStage(state, e4b, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "draft",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(state, reviewer, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "review",
    engineSlot: "gemma26b",
  });
  await runCodeGenerationStage(state, finalReviewer, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "final",
    engineSlot: "qwen",
  });
  bindOfflineProvenance(state);
  freezeCodeEvaluationState(state);
  const tamperedFreeze = structuredClone(state);
  tamperedFreeze.generationFrozenAt = "2000-01-01T00:00:00.000Z";
  assert.throws(
    () => freezeCodeEvaluationState(tamperedFreeze),
    /generation changed after it was frozen/u,
  );
  const tamperedProvenance = structuredClone(state);
  tamperedProvenance.provenance!.node.runtimeExecutableSha256 =
    "f".repeat(64);
  assert.throws(
    () => freezeCodeEvaluationState(tamperedProvenance),
    /sealed suite and plan|generation changed after it was frozen/u,
  );

  const backend = new MetadataOnlyVmBackend({
    reverseResults: true,
  });
  const report = await evaluateCodeGenerationState(state, backend);
  assert.deepEqual(report.provenance, state.provenance);
  const expectedBaselineDefects = generatePilotCodeSuite().reduce(
    (sum, task) =>
      sum + task.baselineExpectedFailureCaseIds.length,
    0,
  );
  const mutationCount = generatePilotCodeSuite().reduce(
    (sum, task) => sum + task.mutations.length,
    0,
  );

  assert.equal(backend.batches.length, 1 + taskCount * 6);
  assert.equal(
    backend.batches[0]!.length,
    taskCount * 5,
    "baseline + oracle + three mutations for every task",
  );
  assert.equal(
    backend.batches.slice(1).every((batch) => batch.length === 1),
    true,
    "every generated candidate receives a separate VM batch",
  );
  assert.deepEqual(report.preflight, {
    passed: true,
    oracleTasksPassed: taskCount,
    baselineTasksExact: taskCount,
    baselineTaskCount: taskCount,
    baselineDefectsDetected: expectedBaselineDefects,
    baselineDefectsExpected: expectedBaselineDefects,
    mutationsKilled: mutationCount,
    mutationCount,
    mutationScore: 1,
  });

  const single = report.conditions.find(
    ({ id }) => id === "e4b-single",
  )!;
  const tiered = report.conditions.find(
    ({ id }) => id === "tiered-e4b-gemma26b-qwen",
  )!;
  assert.equal(single.plannedStageSlots, taskCount);
  assert.equal(single.skippedUpstreamStages, 0);
  assert.equal(single.completedFinals, taskCount);
  assert.equal(single.invocationAttempts, taskCount);
  assert.equal(single.modelResponses, taskCount);
  assert.equal(single.modelResponseRate, 1);
  assert.equal(
    single.structuredOutputRate,
    (taskCount - 1) / taskCount,
  );
  assert.equal(single.strictModelOutputs, taskCount - 1);
  assert.equal(single.recoveredModelOutputs, 1);
  assert.equal(single.finalStrictContracts, taskCount - 1);
  assert.equal(single.tasksPassed, taskCount - 2);
  assert.equal(single.passRate, (taskCount - 2) / taskCount);
  assert.equal(single.observedUsage.outputTokens, taskCount * 2);
  assert.equal(single.usageCoverage, 1);
  assert.equal(single.observedOutputWithinRequestedCeiling, true);

  assert.equal(tiered.invocationAttempts, taskCount * 3);
  assert.equal(tiered.plannedStageSlots, taskCount * 3);
  assert.equal(tiered.skippedUpstreamStages, 0);
  assert.equal(tiered.completedFinals, taskCount);
  assert.equal(tiered.modelResponses, taskCount * 3);
  assert.equal(tiered.modelResponseRate, 1);
  assert.equal(tiered.structuredOutputRate, 1);
  assert.equal(tiered.strictModelOutputs, taskCount * 3);
  assert.equal(tiered.recoveredModelOutputs, 0);
  assert.equal(tiered.tasksPassed, taskCount);
  assert.equal(tiered.passRate, 1);
  assert.ok(tiered.passRate > single.passRate);
  assert.deepEqual(tiered.engineIds, [
    "e4b-fixture",
    "gemma26b-review-fixture",
    "qwen-final-fixture",
  ]);
  assert.equal(
    tiered.tasks.every(
      ({ stages }) =>
        stages.length === 3 &&
        stages.at(-1)?.stageId === "final" &&
        stages.at(-1)?.passed &&
        /^[a-f0-9]{64}$/u.test(
          stages.at(-1)?.audit.resultHash ?? "",
        ) &&
        /^[a-f0-9]{64}$/u.test(
          stages.at(-1)?.audit.requestHash ?? "",
        ) &&
        /^[a-f0-9]{64}$/u.test(
          stages.at(-1)?.audit.engineFingerprint ?? "",
        ),
    ),
    true,
  );

  assert.deepEqual(report.budget, {
    mode: "requested-output-ceiling-matched",
    maxRequestedOutputTokensPerTask: 6_144,
    singleCallsPerTask: 1,
    tieredCallsPerTask: 3,
    hiddenFeedbackToModels: false,
    retriesPerStage: 0,
    interstageCanonicalization: true,
    intermediateRecoveredCandidatesMayAdvance: true,
    finalRecoveredCandidateFails: true,
    tokenUsageSource: "provider-reported-or-unknown",
    ceilingEnforcement: "requested-not-locally-tokenized",
    note:
      "Every condition receives the same requested output-token ceiling. Tiered review necessarily consumes more input tokens; intermediate candidates are canonically normalized before review, and both effects are reported separately.",
  });
  assert.equal(report.scope.statisticalInference, false);
  assert.equal(report.scope.agentDelegationExercised, false);
  assert.equal(report.scope.taskCount, taskCount);
  assert.equal(report.comparisonControls.artifactHashesRequired, true);
  assert.equal(report.comparisonControls.contextTokens, 8_192);
  assert.equal(report.aggregate.invocationAttempts, taskCount * 6);
  assert.equal(report.aggregate.modelResponses, taskCount * 6);
  assert.equal(report.aggregate.modelResponseRate, 1);
  assert.equal(
    report.aggregate.strictModelOutputs,
    taskCount * 6 - 1,
  );
  assert.equal(
    report.aggregate.structuredOutputRate,
    (taskCount * 6 - 1) / (taskCount * 6),
  );
  assert.equal(report.aggregate.unapprovedExternalSideEffects, 0);
  assert.equal(
    report.aggregate.unapprovedExternalSideEffectsBasis,
    "verified-vm-containment-not-model-restraint",
  );
  assert.deepEqual(report.aggregate.policyViolations, []);
});

test("a surviving mutation below the 95% threshold aborts before generated candidates are evaluated", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("complete-matrix", (_request, index) =>
    candidateText(`complete-${index}`),
  );
  bindOfflineEngine(state, "e4b", engine);
  bindOfflineEngine(state, "gemma26b", engine);
  bindOfflineEngine(state, "qwen", engine);
  await runCodeGenerationStage(state, engine, {
    conditionId: "e4b-single",
    stageId: "final",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "gemma26b-single",
    stageId: "final",
    engineSlot: "gemma26b",
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "qwen-single",
    stageId: "final",
    engineSlot: "qwen",
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "draft",
    engineSlot: "e4b",
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "review",
    engineSlot: "gemma26b",
  });
  await runCodeGenerationStage(state, engine, {
    conditionId: "tiered-e4b-gemma26b-qwen",
    stageId: "final",
    engineSlot: "qwen",
  });
  bindOfflineProvenance(state);
  freezeCodeEvaluationState(state);
  const backend = new MetadataOnlyVmBackend({
    survivingMutation: true,
  });

  await assert.rejects(
    evaluateCodeGenerationState(state, backend),
    /CODE_EVALUATION_PREFLIGHT_FAILED/u,
  );
  assert.equal(backend.batches.length, 1);
  assert.equal(
    backend.batches[0]!.some(({ id }) =>
      id.startsWith("generated:"),
    ),
    false,
  );
});

test("failed invocations without usage remain explicitly unknown and are not counted as responses", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("failed-engine", () => {
    throw new Error("offline fixture invocation failure");
  });
  bindOfflineEngine(state, "e4b", engine);
  bindOfflineEngine(state, "gemma26b", engine);
  bindOfflineEngine(state, "qwen", engine);
  await populateCompleteMatrix(state, {
    e4b: engine,
    gemma26b: engine,
    qwen: engine,
  });
  bindOfflineProvenance(state);
  freezeCodeEvaluationState(state);

  const report = await evaluateCodeGenerationState(
    state,
    new MetadataOnlyVmBackend(),
  );
  const taskCount = generatePilotCodeSuite().length;
  assert.equal(report.aggregate.invocationAttempts, taskCount * 4);
  assert.equal(report.aggregate.modelResponses, 0);
  assert.equal(report.aggregate.modelResponseRate, 0);
  assert.equal(report.aggregate.structuredOutputRate, 0);
  for (const condition of report.conditions) {
    assert.equal(condition.usageCoverage, 0);
    assert.equal(
      condition.observedOutputWithinRequestedCeiling,
      null,
    );
    assert.deepEqual(condition.observedUsage, {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cost: null,
      measurementStatus: "unknown",
    });
  }
  const failedTiered = report.conditions.find(
    ({ id }) => id === "tiered-e4b-gemma26b-qwen",
  )!;
  assert.equal(failedTiered.plannedStageSlots, taskCount * 3);
  assert.equal(failedTiered.invocationAttempts, taskCount);
  assert.equal(failedTiered.skippedUpstreamStages, taskCount * 2);
  assert.equal(failedTiered.completedFinals, 0);
});

test("sandbox result identity, policy, and process containment failures abort without a score", async () => {
  const state = createCodeEvaluationState();
  const engine = fakeEngine("safe-candidate-engine", (_request, index) =>
    candidateText(`safe-${index}`),
  );
  bindOfflineEngine(state, "e4b", engine);
  bindOfflineEngine(state, "gemma26b", engine);
  bindOfflineEngine(state, "qwen", engine);
  await populateCompleteMatrix(state, {
    e4b: engine,
    gemma26b: engine,
    qwen: engine,
  });
  bindOfflineProvenance(state);
  freezeCodeEvaluationState(state);

  await assert.rejects(
    evaluateCodeGenerationState(
      state,
      new MetadataOnlyVmBackend({ wrongJobId: true }),
    ),
    /SANDBOX_RESULT.*MISMATCH/u,
  );
  await assert.rejects(
    evaluateCodeGenerationState(
      state,
      new MetadataOnlyVmBackend({ policyViolation: true }),
    ),
    /CODE_EVALUATION_CONTAINMENT_FAILED/u,
  );
  await assert.rejects(
    evaluateCodeGenerationState(
      state,
      new MetadataOnlyVmBackend({ survivorProcesses: 1 }),
    ),
    /CODE_EVALUATION_CONTAINMENT_FAILED/u,
  );
});
