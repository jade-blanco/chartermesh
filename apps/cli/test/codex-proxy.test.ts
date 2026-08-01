import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexCliFeedbackProvider,
  CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256,
  CODEX_PROXY_ENVIRONMENT_POLICY_VERSION,
  CodexProxyError,
  FIXED_SELF_REVIEW_FEEDBACK,
  FIXED_SELF_REVIEW_FEEDBACK_SHA256,
  FixedSelfReviewFeedbackProvider,
  NEUTRAL_REPEAT_FEEDBACK,
  NeutralRepeatFeedbackProvider,
  SIMULATED_USER_ACTOR_TYPE,
  SIMULATED_USER_FEEDBACK_REQUEST_API_VERSION,
  type CodexSpawnFunction,
  type SimulatedUserFeedbackRequest,
  type SpawnedCodexProcess,
} from "../src/workflow-evaluation/codex-proxy.ts";
import { adaptSimulatedUserFeedbackProvider } from "../src/workflow-evaluation/feedback-adapters.ts";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(): SimulatedUserFeedbackRequest {
  return {
    apiVersion: SIMULATED_USER_FEEDBACK_REQUEST_API_VERSION,
    evaluationId: "evaluation-1",
    taskId: "task-1",
    iteration: 1,
    publicObjective: "Make the visible result understandable to an ordinary user.",
    publicImplementationRequest: "Prepare a small public deliverable.",
    publicArtifacts: [
      {
        name: "result.txt",
        mediaType: "text/plain",
        content: "Visible result",
      },
    ],
    publicChecks: [
      {
        name: "public-smoke",
        status: "passed",
        summary: "The public smoke check completed.",
      },
    ],
  };
}

interface SpawnObservation {
  executablePath?: string;
  args?: readonly string[];
  cwd?: string;
  prompt?: string;
  schema?: unknown;
  environment?: NodeJS.ProcessEnv;
  killSignals: Array<NodeJS.Signals | undefined>;
}

function scriptedSpawn(
  output: unknown,
  observation: SpawnObservation,
  options: {
    stderr?: string;
    exitCode?: number;
    mutateExecutable?: string;
    stdout?: string;
    neverClose?: boolean;
    ignoreKill?: boolean;
    errorOnKill?: boolean;
    stdinFailureOnEnd?: boolean;
  } = {},
): CodexSpawnFunction {
  return (executablePath, args, spawnOptions) => {
    observation.executablePath = executablePath;
    observation.args = [...args];
    observation.cwd = String(spawnOptions.cwd);
    observation.environment = { ...spawnOptions.env };
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childInput = options.stdinFailureOnEnd
      ? {
          on: stdin.on.bind(stdin),
          end(): never {
            queueMicrotask(() =>
              stdin.emit("error", new Error("stdin failed asynchronously")),
            );
            throw new Error("stdin failed synchronously");
          },
        }
      : stdin;
    const child = {
      stdin: childInput,
      stdout,
      stderr,
      on: events.on.bind(events),
      once: events.once.bind(events),
      kill(signal?: NodeJS.Signals): boolean {
        observation.killSignals.push(signal);
        if (options.errorOnKill) {
          queueMicrotask(() =>
            events.emit("error", new Error("kill failed")),
          );
        }
        if (!options.ignoreKill) {
          queueMicrotask(() => events.emit("close", null, signal ?? "SIGTERM"));
        }
        return true;
      },
    } as unknown as SpawnedCodexProcess;
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.once("finish", () => {
      void (async () => {
        observation.prompt = Buffer.concat(chunks).toString("utf8");
        const schemaIndex = args.indexOf("--output-schema");
        const outputIndex = args.indexOf("--output-last-message");
        assert.notEqual(schemaIndex, -1);
        assert.notEqual(outputIndex, -1);
        const schemaPath = args[schemaIndex + 1];
        const outputPath = args[outputIndex + 1];
        assert.equal(typeof schemaPath, "string");
        assert.equal(typeof outputPath, "string");
        observation.schema = JSON.parse(
          await readFile(schemaPath!, "utf8"),
        ) as unknown;
        if (options.mutateExecutable !== undefined) {
          await writeFile(executablePath, options.mutateExecutable, "utf8");
        }
        await writeFile(outputPath!, JSON.stringify(output), "utf8");
        if (options.stdout) stdout.write(options.stdout);
        if (options.stderr) stderr.write(options.stderr);
        if (!options.neverClose) {
          events.emit("close", options.exitCode ?? 0, null);
        }
      })().catch((error: unknown) => events.emit("error", error));
    });
    return child;
  };
}

async function fixtureExecutable(): Promise<{
  directory: string;
  path: string;
  digest: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-test-"));
  const path = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  const bytes = "fixture codex executable\n";
  await writeFile(path, bytes, "utf8");
  return { directory, path, digest: sha256(bytes) };
}

async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("fixed providers are simulated actors and preserve the byte-exact self-review text", async () => {
  assert.equal(
    FIXED_SELF_REVIEW_FEEDBACK,
    "[최초 제시한 구현 스크립트] 가 구현되었는지 확인하고 피드백할 지점을 찾아서 개선해줘.",
  );
  assert.equal(
    FIXED_SELF_REVIEW_FEEDBACK_SHA256,
    sha256(Buffer.from(FIXED_SELF_REVIEW_FEEDBACK, "utf8")),
  );
  const fixed = await new FixedSelfReviewFeedbackProvider().provideFeedback(
    request(),
  );
  const neutral = await new NeutralRepeatFeedbackProvider().provideFeedback(
    request(),
  );
  assert.deepEqual(fixed, {
    apiVersion: "chartermesh.dev/simulated-user-feedback/v1alpha1",
    actorType: SIMULATED_USER_ACTOR_TYPE,
    mayResolveHumanApproval: false,
    providerId: "fixed-self-review",
    recommendation: "revise",
    feedback: [FIXED_SELF_REVIEW_FEEDBACK],
  });
  assert.equal(neutral.actorType, "simulated_user_proxy");
  assert.equal(neutral.mayResolveHumanApproval, false);
  assert.deepEqual(neutral.feedback, [NEUTRAL_REPEAT_FEEDBACK]);
  assert.match(CODEX_GENERALIST_FEEDBACK_PROTOCOL_SHA256, /^[a-f0-9]{64}$/u);
  const adapted = adaptSimulatedUserFeedbackProvider({
    evaluationId: "evaluation-1",
    policy: "fixed_self_review",
    provider: new FixedSelfReviewFeedbackProvider(),
    countsAsModelCall: false,
  });
  const adaptedResult = await adapted.provideFeedback({
    task: {
      id: "task-1",
      family: "code",
      difficulty: "easy",
      objective: "Objective",
      initialImplementationBrief: "Implement it.",
      publicContext: [],
      acceptanceCriteria: [],
      artifactKind: "text",
    },
    currentHumanView: "Visible result",
    submission: 1,
  });
  assert.equal(adaptedResult.directive, FIXED_SELF_REVIEW_FEEDBACK);
  const adaptedNeutral = adaptSimulatedUserFeedbackProvider({
    evaluationId: "evaluation-1",
    policy: "neutral_repeat",
    provider: new NeutralRepeatFeedbackProvider(),
    countsAsModelCall: false,
  });
  assert.equal(
    (await adaptedNeutral.provideFeedback({
      task: {
        id: "task-1",
        family: "code",
        difficulty: "easy",
        objective: "Objective",
        initialImplementationBrief: "Implement it.",
        publicContext: [],
        acceptanceCriteria: [],
        artifactKind: "text",
      },
      currentHumanView: "Visible result",
      submission: 1,
    })).directive,
    NEUTRAL_REPEAT_FEEDBACK,
  );
});

test("public-only request contract rejects hidden and internal input fields", async () => {
  const value = {
    ...request(),
    hiddenOracle: "do not expose",
  } as unknown as SimulatedUserFeedbackRequest;
  await assert.rejects(
    new NeutralRepeatFeedbackProvider().provideFeedback(value),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_REQUEST_INVALID",
  );
});

test("Codex provider attests the executable and uses the isolated exact CLI shape", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    environment: {
      USERPROFILE: fixture.directory,
      PATH: "test-path",
    },
    spawn: scriptedSpawn(
      {
        recommendation: "revise",
        feedback: ["The visible result needs a clearer explanation."],
      },
      observation,
    ),
  });

  const result = await provider.provideFeedback(request());
  assert.equal(result.actorType, "simulated_user_proxy");
  assert.equal(result.mayResolveHumanApproval, false);
  assert.equal(result.providerId, "codex-cli-ordinary-user");
  assert.equal(observation.executablePath, fixture.path);
  assert.ok(observation.args);
  const args = observation.args!;
  assert.deepEqual(args.slice(0, 13), [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--disable",
    "multi_agent",
    "--disable",
    "apps",
    "--disable",
    "shell_tool",
  ]);
  assert.equal(args[13], "--model");
  assert.equal(args[14], "gpt-test");
  assert.equal(args.at(-3), "--color");
  assert.equal(args.at(-2), "never");
  assert.equal(args.at(-1), "-");
  assert.ok(observation.cwd);
  assert.equal(observation.environment?.HOME, fixture.directory);
  assert.equal(
    observation.environment?.CODEX_HOME,
    join(fixture.directory, ".codex"),
  );
  assert.equal(observation.environment?.PATH, "test-path");
  assert.equal(await absent(observation.cwd!), true);
  assert.match(observation.prompt ?? "", /simulated ordinary-user proxy/u);
  assert.match(observation.prompt ?? "", /cannot grant or resolve any human approval/u);
  assert.match(observation.prompt ?? "", /"publicObjective"/u);
  assert.equal(
    CODEX_PROXY_ENVIRONMENT_POLICY_VERSION,
    "chartermesh.dev/codex-proxy-environment/v1alpha2",
  );
  assert.deepEqual(observation.schema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["recommendation", "feedback"],
    properties: {
      recommendation: {
        type: "string",
        enum: ["approve", "revise"],
        description:
          "An experimental recommendation only; it never resolves human approval.",
      },
      feedback: {
        type: "array",
        maxItems: 3,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 2_000,
          description:
            "Ordinary-user feedback only. Do not include code, a patch, or an implementation answer.",
        },
      },
    },
  });
});

test("Codex provider fails closed when no absolute authentication home exists", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  assert.throws(
    () =>
      new CodexCliFeedbackProvider({
        executablePath: fixture.path,
        executableSha256: fixture.digest,
        model: "gpt-test",
        environment: {},
      }),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_HOME_UNAVAILABLE",
  );
});

test("Codex provider snapshots authentication homes at construction", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {
    USERPROFILE: fixture.directory,
  };
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    environment,
    spawn: scriptedSpawn(
      { recommendation: "approve", feedback: [] },
      observation,
    ),
  });
  environment.USERPROFILE = join(fixture.directory, "changed");
  environment.HOME = join(fixture.directory, "changed-home");
  environment.CODEX_HOME = join(fixture.directory, "changed-codex-home");

  await provider.provideFeedback(request());

  assert.equal(observation.environment?.HOME, fixture.directory);
  assert.equal(
    observation.environment?.CODEX_HOME,
    join(fixture.directory, ".codex"),
  );
});

test("Codex provider rejects drive-relative authentication homes on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path semantics only");
    return;
  }
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  assert.throws(
    () =>
      new CodexCliFeedbackProvider({
        executablePath: fixture.path,
        executableSha256: fixture.digest,
        model: "gpt-test",
        environment: { HOME: "/drive-ambiguous-home" },
      }),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_HOME_UNAVAILABLE",
  );
});

test("Codex provider rejects implementation-shaped and extensible output", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const invalidOutputs = [
    {
      recommendation: "revise",
      feedback: ["Please improve it."],
      implementation: "replacement answer",
    },
    {
      recommendation: "revise",
      feedback: ["one", "two", "three", "four"],
    },
    {
      recommendation: "revise",
      feedback: ["```ts\nexport const answer = true;\n```"],
    },
  ];
  for (const output of invalidOutputs) {
    const observation: SpawnObservation = { killSignals: [] };
    const provider = new CodexCliFeedbackProvider({
      executablePath: fixture.path,
      executableSha256: fixture.digest,
      model: "gpt-test",
      spawn: scriptedSpawn(output, observation),
    });
    await assert.rejects(
      provider.provideFeedback(request()),
      (error: unknown) =>
        error instanceof CodexProxyError &&
        error.code === "CODEX_PROXY_OUTPUT_INVALID",
    );
  }
});

test("Codex provider detects executable replacement after the child exits", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    spawn: scriptedSpawn(
      { recommendation: "approve", feedback: [] },
      observation,
      { mutateExecutable: "changed executable\n" },
    ),
  });
  await assert.rejects(
    provider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_EXECUTABLE_HASH_MISMATCH",
  );
});

test("Codex provider enforces process output, timeout, and abort bounds", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const outputObservation: SpawnObservation = { killSignals: [] };
  const outputProvider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    maxOutputBytes: 16,
    spawn: scriptedSpawn(
      { recommendation: "approve", feedback: [] },
      outputObservation,
      { stdout: "x".repeat(17) },
    ),
  });
  await assert.rejects(
    outputProvider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_OUTPUT_LIMIT_EXCEEDED",
  );
  assert.deepEqual(outputObservation.killSignals, ["SIGTERM"]);

  const timeoutObservation: SpawnObservation = { killSignals: [] };
  const timeoutProvider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    timeoutMs: 5,
    spawn: scriptedSpawn(
      { recommendation: "approve", feedback: [] },
      timeoutObservation,
      { neverClose: true },
    ),
  });
  await assert.rejects(
    timeoutProvider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError && error.code === "CODEX_PROXY_TIMEOUT",
  );
  assert.deepEqual(timeoutObservation.killSignals, ["SIGTERM"]);

  const controller = new AbortController();
  controller.abort();
  let spawnCalls = 0;
  const abortedProvider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    spawn: (..._args) => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    abortedProvider.provideFeedback(request(), {
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof CodexProxyError && error.code === "CODEX_PROXY_ABORTED",
  );
  assert.equal(spawnCalls, 0);
});

test("an uncooperative Codex child is fatal only after SIGTERM and SIGKILL remain unsettled", async (t) => {
  const fixture = await fixtureExecutable();
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "codex-proxy-unsettled-test-"),
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    timeoutMs: 1,
    temporaryRoot,
    spawn: scriptedSpawn(
      { recommendation: "revise", feedback: ["Never returned."] },
      observation,
      { neverClose: true, ignoreKill: true, errorOnKill: true },
    ),
  });
  await assert.rejects(
    provider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_TERMINATION_UNSETTLED",
  );
  assert.deepEqual(observation.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal((await readdir(temporaryRoot)).length, 1);
});

test("stdin failure reports its typed error only after the child closes", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    timeoutMs: 10_000,
    spawn: scriptedSpawn(
      { recommendation: "revise", feedback: ["Never returned."] },
      observation,
      { neverClose: true, stdinFailureOnEnd: true },
    ),
  });
  await assert.rejects(
    provider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_STDIN_FAILED",
  );
  assert.deepEqual(observation.killSignals, ["SIGTERM"]);
});

test("stdin failure also requires the Codex child to close", async (t) => {
  const fixture = await fixtureExecutable();
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "codex-proxy-stdin-unsettled-test-"),
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    timeoutMs: 10_000,
    temporaryRoot,
    spawn: scriptedSpawn(
      { recommendation: "revise", feedback: ["Never returned."] },
      observation,
      {
        neverClose: true,
        ignoreKill: true,
        stdinFailureOnEnd: true,
      },
    ),
  });
  await assert.rejects(
    provider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_TERMINATION_UNSETTLED",
  );
  assert.deepEqual(observation.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal((await readdir(temporaryRoot)).length, 1);
});

test("unsupported required Codex flags fail explicitly", async (t) => {
  const fixture = await fixtureExecutable();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const observation: SpawnObservation = { killSignals: [] };
  const provider = new CodexCliFeedbackProvider({
    executablePath: fixture.path,
    executableSha256: fixture.digest,
    model: "gpt-test",
    spawn: scriptedSpawn(
      { recommendation: "approve", feedback: [] },
      observation,
      {
        exitCode: 2,
        stderr: "error: unexpected argument '--ignore-rules'",
      },
    ),
  });
  await assert.rejects(
    provider.provideFeedback(request()),
    (error: unknown) =>
      error instanceof CodexProxyError &&
      error.code === "CODEX_PROXY_UNSUPPORTED_FLAGS",
  );
});
