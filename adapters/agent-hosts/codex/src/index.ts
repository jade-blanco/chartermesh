import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentHost,
  AgentHostDiscovery,
  AgentHostManifest,
  AgentHostRunHandle,
  HostApprovalKind,
  HostApprovalRequest,
  HostCancelReason,
  HostResumeRequest,
  HostRunError,
  HostRunEvent,
  HostRunRequest,
  HostRunResult,
} from "../../../../packages/adapter-sdk/src/types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 512 * 1024;
const DEFAULT_CANCEL_SETTLEMENT_MS = 5_000;
const DEFAULT_PROCESS_TERMINATION_MS = 2_000;
const DEFAULT_MAX_RETAINED_RUNS = 128;
const SUPPORTED_CODEX_VERSIONS = new Set(["0.145.0"]);
const MAX_BOOTSTRAP_ARGUMENTS = 32;
const MAX_BOOTSTRAP_ARGUMENT_LENGTH = 4_096;
const DEFAULT_ENVIRONMENT_NAMES = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "SHELL",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
];

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

export interface CodexAppServerConfig {
  id: string;
  command: string;
  args?: readonly string[];
  executableSha256: string;
  workingDirectory: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  discoveryTimeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
  cancelSettlementMs?: number;
  processTerminationMs?: number;
  maxRetainedRuns?: number;
  allowUnrestrictedRead?: boolean;
  environmentAllowlist?: readonly string[];
  approvalPolicy?: "never" | "untrusted" | "on_request";
  sandbox?: "read_only" | "workspace_write";
}

export interface CodexAppServerDependencies {
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & {
      stdio: ["pipe", "pipe", "pipe"];
    },
  ) => ChildProcessWithoutNullStreams;
  now?: () => Date;
}

export class CodexAppServerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

export function sha256CodexExecutable(path: string): string {
  const canonical = realpathSync(path);
  const stats = statSync(canonical);
  if (!stats.isFile()) {
    throw new CodexAppServerError(
      "CODEX_EXECUTABLE_NOT_FILE",
      "Codex executable path must identify a regular file.",
    );
  }
  const descriptor = openSync(canonical, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function validateBoundedInteger(
  issues: string[],
  value: number | undefined,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < minimum || value > maximum)
  ) {
    issues.push(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
}

export function validateCodexAppServerConfig(
  config: CodexAppServerConfig,
): string[] {
  const issues: string[] = [];
  if (!config.id.trim()) issues.push("Codex AgentHost id is required.");
  if (!isAbsolute(config.command)) {
    issues.push("Codex executable must use an absolute path.");
  }
  const bootstrapArguments = Array.isArray(config.args) ? config.args : [];
  if (config.args !== undefined && !Array.isArray(config.args)) {
    issues.push("Codex args must be an array of strings.");
  }
  if (bootstrapArguments.length > MAX_BOOTSTRAP_ARGUMENTS) {
    issues.push(
      `Codex args cannot contain more than ${MAX_BOOTSTRAP_ARGUMENTS} entries.`,
    );
  }
  for (const [index, argument] of bootstrapArguments.entries()) {
    if (typeof argument !== "string") {
      issues.push(`Codex args[${index}] must be a string.`);
      continue;
    }
    if (argument.includes("\0")) {
      issues.push(`Codex args[${index}] cannot contain a NUL character.`);
    }
    if (argument.length > MAX_BOOTSTRAP_ARGUMENT_LENGTH) {
      issues.push(
        `Codex args[${index}] cannot exceed ${MAX_BOOTSTRAP_ARGUMENT_LENGTH} characters.`,
      );
    }
  }
  if (!DIGEST_PATTERN.test(config.executableSha256)) {
    issues.push(
      "Codex executableSha256 must be a lowercase SHA-256 digest.",
    );
  }
  if (!isAbsolute(config.workingDirectory)) {
    issues.push("Codex workingDirectory must use an absolute path.");
  }
  validateBoundedInteger(
    issues,
    config.timeoutMs,
    "Codex run timeoutMs",
    1_000,
    3_600_000,
  );
  validateBoundedInteger(
    issues,
    config.discoveryTimeoutMs,
    "Codex discoveryTimeoutMs",
    1_000,
    120_000,
  );
  validateBoundedInteger(
    issues,
    config.maxOutputBytes,
    "Codex maxOutputBytes",
    16_384,
    16 * 1024 * 1024,
  );
  validateBoundedInteger(
    issues,
    config.maxInputBytes,
    "Codex maxInputBytes",
    1_024,
    4 * 1024 * 1024,
  );
  validateBoundedInteger(
    issues,
    config.cancelSettlementMs,
    "Codex cancelSettlementMs",
    100,
    30_000,
  );
  validateBoundedInteger(
    issues,
    config.processTerminationMs,
    "Codex processTerminationMs",
    100,
    30_000,
  );
  validateBoundedInteger(
    issues,
    config.maxRetainedRuns,
    "Codex maxRetainedRuns",
    1,
    1_000,
  );
  for (const name of config.environmentAllowlist ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      issues.push(`Invalid environment variable name '${name}'.`);
    }
  }
  if (
    config.approvalPolicy !== undefined &&
    !["never", "untrusted", "on_request"].includes(config.approvalPolicy)
  ) {
    issues.push("Codex approvalPolicy is unsupported.");
  }
  if (
    config.sandbox !== undefined &&
    !["read_only", "workspace_write"].includes(config.sandbox)
  ) {
    issues.push("Codex sandbox must be read_only or workspace_write.");
  }
  if (
    config.reasoningEffort !== undefined &&
    !["low", "medium", "high", "xhigh"].includes(config.reasoningEffort)
  ) {
    issues.push("Codex reasoningEffort is unsupported.");
  }
  if (
    config.allowUnrestrictedRead !== undefined &&
    typeof config.allowUnrestrictedRead !== "boolean"
  ) {
    issues.push("Codex allowUnrestrictedRead must be boolean.");
  }
  return issues;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(value: unknown, fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text.length > 1_000 ? `${text.slice(0, 997)}...` : text;
}

function providerVersionFromUserAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)?.[1] ?? null;
}

function unknownUsage(): HostRunResult["usage"] {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus: "unknown",
  };
}

function childEnvironment(
  allowlist: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = new Set([...DEFAULT_ENVIRONMENT_NAMES, ...allowlist]);
  return Object.fromEntries(
    [...names].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

function withinWorkspace(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function wireApprovalPolicy(
  policy: CodexAppServerConfig["approvalPolicy"],
): "never" | "untrusted" | "on-request" {
  return policy === "on_request" ? "on-request" : policy ?? "never";
}

function wireSandboxMode(
  sandbox: CodexAppServerConfig["sandbox"],
): "read-only" | "workspace-write" {
  return sandbox === "workspace_write" ? "workspace-write" : "read-only";
}

function wireSandboxPolicy(
  sandbox: CodexAppServerConfig["sandbox"],
  workspace: string,
): JsonRecord {
  return sandbox === "workspace_write"
    ? {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : { type: "readOnly", networkAccess: false };
}

function serializedTaskPacket(
  request: HostRunRequest,
  maximumBytes: number,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      apiVersion: "chartermesh.dev/agent-host-task/v1alpha1",
      organizationRevision: request.organizationRevision,
      workItemId: request.workItemId,
      runId: request.runId,
      attemptId: request.attemptId,
      generation: request.generation,
      taskPacket: request.taskPacket,
    });
  } catch {
    throw new CodexAppServerError(
      "CODEX_TASK_PACKET_NOT_SERIALIZABLE",
      "Host task packet must be JSON serializable.",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new CodexAppServerError(
      "CODEX_TASK_PACKET_TOO_LARGE",
      "Host task packet exceeds the configured byte limit.",
    );
  }
  return serialized;
}

class AsyncEventLog<T> {
  private readonly values: T[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.values.push(value);
    for (const wake of [...this.waiters]) wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of [...this.waiters]) wake();
  }

  async next(index: number, signal?: AbortSignal): Promise<IteratorResult<T>> {
    for (;;) {
      if (index < this.values.length) {
        return { value: this.values[index]!, done: false };
      }
      if (this.closed) return { value: undefined, done: true };
      if (signal?.aborted) throw signal.reason;
      await new Promise<void>((resolveWait, rejectWait) => {
        const wake = (): void => {
          cleanup();
          resolveWait();
        };
        const abort = (): void => {
          cleanup();
          rejectWait(signal?.reason);
        };
        const cleanup = (): void => {
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", abort);
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

class AppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maximumOutputBytes: number;
  private readonly processTerminationMs: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private outputBytes = 0;
  private lineBuffer = "";
  private closing = false;
  private failed = false;
  private terminationTimer: NodeJS.Timeout | null = null;
  onNotification: (method: string, params: unknown) => void = () => {};
  onServerRequest: (
    id: JsonRpcId,
    method: string,
    params: unknown,
  ) => void = () => {};
  onFatal: (error: CodexAppServerError) => void = () => {};

  constructor(
    child: ChildProcessWithoutNullStreams,
    maximumOutputBytes: number,
    processTerminationMs: number,
  ) {
    this.child = child;
    this.maximumOutputBytes = maximumOutputBytes;
    this.processTerminationMs = processTerminationMs;
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!this.countOutput(buffer.byteLength)) return;
      this.lineBuffer += this.decoder.write(buffer);
      if (Buffer.byteLength(this.lineBuffer, "utf8") > this.maximumOutputBytes) {
        this.fail(
          new CodexAppServerError(
            "CODEX_APP_SERVER_OUTPUT_LIMIT_EXCEEDED",
            "Codex app-server output exceeded the configured byte limit.",
          ),
        );
        return;
      }
      for (;;) {
        const newline = this.lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.lineBuffer.slice(0, newline).trimEnd();
        this.lineBuffer = this.lineBuffer.slice(newline + 1);
        if (line.trim()) this.receiveLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.countOutput(buffer.byteLength);
    });
    child.stdin.on("error", () => {
      this.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_STDIN_FAILED",
          "Codex app-server stdin failed.",
        ),
      );
    });
    child.once("error", () => {
      this.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_START_FAILED",
          "Codex app-server process could not be started.",
        ),
      );
    });
    child.once("close", (code) => {
      if (this.terminationTimer) clearTimeout(this.terminationTimer);
      if (this.closing || this.failed) return;
      this.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_EXITED",
          `Codex app-server exited before completion (${code ?? "unknown"}).`,
        ),
      );
    });
  }

  private countOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputBytes <= this.maximumOutputBytes) return true;
    this.fail(
      new CodexAppServerError(
        "CODEX_APP_SERVER_OUTPUT_LIMIT_EXCEEDED",
        "Codex app-server output exceeded the configured byte limit.",
      ),
    );
    return false;
  }

  private receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_INVALID_JSON",
          "Codex app-server emitted invalid JSONL.",
        ),
      );
      return;
    }
    if (!isRecord(message)) {
      this.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_INVALID_MESSAGE",
          "Codex app-server emitted a non-object message.",
        ),
      );
      return;
    }
    const id = message.id;
    if ((typeof id === "string" || typeof id === "number") && "method" in message) {
      if (typeof message.method !== "string") {
        this.fail(
          new CodexAppServerError(
            "CODEX_APP_SERVER_INVALID_MESSAGE",
            "Codex app-server request method must be a string.",
          ),
        );
        return;
      }
      this.onServerRequest(id, message.method, message.params);
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (isRecord(message.error)) {
        pending.reject(
          new CodexAppServerError(
            "CODEX_APP_SERVER_RPC_ERROR",
            `${pending.method}: ${boundedMessage(message.error.message, "request failed")}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.onNotification(message.method, message.params);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closing || this.failed) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_APP_SERVER_CLOSED",
          "Codex app-server connection is closed.",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (this.closing || this.failed) {
      throw new CodexAppServerError(
        "CODEX_APP_SERVER_CLOSED",
        "Codex app-server connection is closed.",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  shutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const request of this.pending.values()) {
      request.reject(
        new CodexAppServerError(
          "CODEX_APP_SERVER_CLOSED",
          "Codex app-server connection closed.",
        ),
      );
    }
    this.pending.clear();
    this.terminateProcess();
  }

  fail(error: CodexAppServerError): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.terminateProcess();
    this.onFatal(error);
  }

  private terminateProcess(): void {
    this.child.kill("SIGTERM");
    if (this.terminationTimer) return;
    this.terminationTimer = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, this.processTerminationMs);
    this.terminationTimer.unref();
  }
}

interface ActiveHostRun {
  requestKey: string;
  handle: AgentHostRunHandle;
  connection: AppServerConnection;
  events: AsyncEventLog<HostRunEvent>;
  sequence: number;
  outputText: string;
  streamedText: string;
  hasFinalAnswer: boolean;
  lastError: HostRunError | null;
  cancelReason: HostCancelReason | null;
  cancelPromise: Promise<void> | null;
  terminal: HostRunResult | null;
  resultPromise: Promise<HostRunResult>;
  resolveResult: (result: HostRunResult) => void;
  timeout: NodeJS.Timeout;
  cancelTimer: NodeJS.Timeout | null;
  abortCleanup: () => void;
}

function providerError(value: unknown): HostRunError {
  const record = isRecord(value) ? value : {};
  const rawInfo = record.codexErrorInfo;
  const info = isRecord(rawInfo) ? rawInfo : {};
  const providerCode =
    typeof rawInfo === "string"
      ? rawInfo
      : typeof info.type === "string"
      ? info.type
      : Object.keys(info)[0] ??
        (typeof record.code === "string" ? record.code : "CODEX_HOST_ERROR");
  return {
    code: providerCode,
    message: boundedMessage(record.message, "Codex host reported an error."),
    retryable: null,
  };
}

function approvalKind(method: string): HostApprovalKind {
  if (method === "item/commandExecution/requestApproval") {
    return "command_execution";
  }
  if (method === "item/fileChange/requestApproval") return "file_change";
  if (method === "item/permissions/requestApproval") return "permission";
  if (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput"
  ) {
    return "user_input";
  }
  return "unknown";
}

export class CodexAppServerAgentHost implements AgentHost {
  readonly manifest: AgentHostManifest;
  readonly config: CodexAppServerConfig;
  private readonly executablePath: string;
  private readonly workingDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: NonNullable<
    CodexAppServerDependencies["spawnProcess"]
  >;
  private readonly now: () => Date;
  private readonly runs = new Map<string, ActiveHostRun>();
  private readonly runKeys = new Map<string, string>();
  private readonly pendingStarts = new Map<string, Promise<AgentHostRunHandle>>();

  constructor(
    config: CodexAppServerConfig,
    environment: NodeJS.ProcessEnv = process.env,
    dependencies: CodexAppServerDependencies = {},
  ) {
    const issues = validateCodexAppServerConfig(config);
    if (issues.length > 0) throw new Error(issues.join("\n"));
    this.executablePath = realpathSync(config.command);
    this.workingDirectory = realpathSync(config.workingDirectory);
    if (!statSync(this.workingDirectory).isDirectory()) {
      throw new CodexAppServerError(
        "CODEX_WORKSPACE_NOT_DIRECTORY",
        "Codex workingDirectory must identify a directory.",
      );
    }
    if (sha256CodexExecutable(this.executablePath) !== config.executableSha256) {
      throw new CodexAppServerError(
        "CODEX_EXECUTABLE_DIGEST_MISMATCH",
        "Codex executable digest does not match the approved digest.",
      );
    }
    this.config = Object.freeze({
      ...config,
      ...(config.args ? { args: Object.freeze([...config.args]) } : {}),
      ...(config.environmentAllowlist
        ? {
            environmentAllowlist: Object.freeze([
              ...config.environmentAllowlist,
            ]),
          }
        : {}),
    });
    this.environment = Object.freeze({ ...environment });
    this.spawnProcess =
      dependencies.spawnProcess ??
      ((command, args, options) =>
        spawn(command, [...args], options) as ChildProcessWithoutNullStreams);
    this.now = dependencies.now ?? (() => new Date());
    this.manifest = {
      kind: "agent_host",
      profileId: config.id,
      adapter: "codex-app-server",
      contractVersion: "v1alpha2",
      permissionCeiling:
        config.sandbox === "workspace_write" ? "workspace_write" : "read_only",
      engineBinding: "host_managed",
      capabilities: [
        {
          name: "host.session.start",
          support: "native",
          stability: "experimental",
          permissionBehavior: "inherited",
          workspaceIsolation: "none",
          costVisibility: "unknown",
          constraints: {
            readIsolation: "host_user_scope",
            executablePathIntegrity: "best_effort_sha256",
            supportedCodexVersion: "0.145.0",
          },
        },
        {
          name: "host.session.resume",
          support: "native",
          stability: "experimental",
        },
        {
          name: "host.events.stream",
          support: "native",
          stability: "experimental",
        },
        {
          name: "host.cancel",
          support: "native",
          stability: "experimental",
        },
        {
          name: "host.approval.observe",
          support: "native",
          stability: "experimental",
          permissionBehavior: "unknown",
          constraints: { actionable: false, failClosed: true },
        },
        {
          name: "host.approval.resolve",
          support: "unsupported",
          stability: "experimental",
          permissionBehavior: "unknown",
        },
      ],
    };
  }

  private attestExecutable(): void {
    if (sha256CodexExecutable(this.executablePath) !== this.config.executableSha256) {
      throw new CodexAppServerError(
        "CODEX_EXECUTABLE_DIGEST_MISMATCH",
        "Codex executable changed after approval.",
      );
    }
  }

  private openConnection(): AppServerConnection {
    this.attestExecutable();
    const child = this.spawnProcess(
      this.executablePath,
      [
        ...(this.config.args ?? []),
        "app-server",
        "--listen",
        "stdio://",
      ],
      {
        cwd: this.workingDirectory,
        env: childEnvironment(
          this.config.environmentAllowlist ?? [],
          this.environment,
        ),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    try {
      this.attestExecutable();
    } catch (error) {
      child.kill();
      throw error;
    }
    return new AppServerConnection(
      child,
      this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      this.config.processTerminationMs ?? DEFAULT_PROCESS_TERMINATION_MS,
    );
  }

  private async initialize(
    connection: AppServerConnection,
  ): Promise<unknown> {
    const initialized = await connection.request("initialize", {
      clientInfo: {
        name: "chartermesh",
        title: "CharterMesh",
        version: "0.0.10-alpha.1",
      },
    });
    connection.notify("initialized", {});
    return initialized;
  }

  private timeoutConnection(
    connection: AppServerConnection,
    milliseconds: number,
    code: string,
  ): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      connection.fail(
        new CodexAppServerError(code, "Codex app-server operation timed out."),
      );
    }, milliseconds);
    timeout.unref();
    return timeout;
  }

  async discover(
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentHostDiscovery> {
    if (options.signal?.aborted) throw options.signal.reason;
    let connection: AppServerConnection | undefined;
    let abort = (): void => {};
    let timeout: NodeJS.Timeout | undefined;
    try {
      connection = this.openConnection();
      timeout = this.timeoutConnection(
        connection,
        this.config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
        "CODEX_APP_SERVER_DISCOVERY_TIMED_OUT",
      );
      abort = () =>
        connection?.fail(
          new CodexAppServerError(
            "CODEX_APP_SERVER_CANCELED",
            "Codex app-server discovery was canceled.",
          ),
        );
      options.signal?.addEventListener("abort", abort, { once: true });
      const initialized = await this.initialize(connection);
      const record = isRecord(initialized) ? initialized : {};
      const providerVersion = providerVersionFromUserAgent(record.userAgent);
      const versionSupported =
        providerVersion !== null && SUPPORTED_CODEX_VERSIONS.has(providerVersion);
      const readAcknowledged = this.config.allowUnrestrictedRead === true;
      const diagnostics: AgentHostDiscovery["diagnostics"] = [];
      if (!versionSupported) {
        diagnostics.push({
          code: "CODEX_APP_SERVER_SCHEMA_UNSUPPORTED",
          severity: "error",
          message:
            "This adapter currently supports the generated Codex 0.145.0 app-server schema only.",
        });
      }
      if (!readAcknowledged) {
        diagnostics.push({
          code: "CODEX_UNRESTRICTED_READ_NOT_ACKNOWLEDGED",
          severity: "error",
          message:
            "Codex read-only mode can still read outside the workspace; explicit acknowledgement or an external OS sandbox is required.",
        });
      }
      return {
        available: versionSupported && readAcknowledged,
        profileId: this.manifest.profileId,
        adapter: this.manifest.adapter,
        providerVersion,
        protocolVersion: providerVersion
          ? `codex-app-server/${providerVersion}`
          : null,
        capabilities: this.manifest.capabilities.map((item) => ({ ...item })),
        diagnostics,
      };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const normalized =
        error instanceof CodexAppServerError
          ? error
          : new CodexAppServerError(
              "CODEX_APP_SERVER_UNAVAILABLE",
              "Codex app-server discovery failed.",
            );
      return {
        available: false,
        profileId: this.manifest.profileId,
        adapter: this.manifest.adapter,
        providerVersion: null,
        protocolVersion: null,
        capabilities: this.manifest.capabilities.map((item) => ({ ...item })),
        diagnostics: [
          {
            code: normalized.code,
            severity: "error",
            message: normalized.message,
          },
        ],
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      connection?.shutdown();
    }
  }

  start(
    request: HostRunRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentHostRunHandle> {
    return this.idempotentBegin(request, undefined, options.signal);
  }

  resume(
    request: HostResumeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentHostRunHandle> {
    if (!request.hostSessionId.trim()) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_HOST_SESSION_REQUIRED",
          "A hostSessionId is required to resume a Codex thread.",
        ),
      );
    }
    return this.idempotentBegin(
      request,
      request.hostSessionId,
      options.signal,
    );
  }

  private requestKey(
    request: HostRunRequest,
    resumeSessionId: string | undefined,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          operation: resumeSessionId === undefined ? "start" : "resume",
          resumeSessionId: resumeSessionId ?? null,
          request,
        }),
      )
      .digest("hex");
  }

  private idempotentBegin(
    request: HostRunRequest,
    resumeSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<AgentHostRunHandle> {
    const key = this.requestKey(request, resumeSessionId);
    const existingRunId = this.runKeys.get(key);
    if (existingRunId) {
      const existing = this.runs.get(existingRunId);
      if (existing) return Promise.resolve({ ...existing.handle });
      this.runKeys.delete(key);
    }
    const pending = this.pendingStarts.get(key);
    if (pending) return pending;
    const started = this.begin(request, resumeSessionId, signal, key);
    this.pendingStarts.set(key, started);
    void started
      .finally(() => {
        if (this.pendingStarts.get(key) === started) {
          this.pendingStarts.delete(key);
        }
      })
      .catch(() => {});
    return started;
  }

  private async begin(
    request: HostRunRequest,
    resumeSessionId: string | undefined,
    signal?: AbortSignal,
    requestKey = this.requestKey(request, resumeSessionId),
  ): Promise<AgentHostRunHandle> {
    if (signal?.aborted) throw signal.reason;
    if (this.config.allowUnrestrictedRead !== true) {
      throw new CodexAppServerError(
        "CODEX_UNRESTRICTED_READ_NOT_ACKNOWLEDGED",
        "Codex read-only mode does not restrict reads to the workspace. Explicit acknowledgement or an external OS sandbox is required.",
      );
    }
    const requestedWorkspace = request.workspacePath
      ? realpathSync(resolve(request.workspacePath))
      : this.workingDirectory;
    if (!withinWorkspace(this.workingDirectory, requestedWorkspace)) {
      throw new CodexAppServerError(
        "CODEX_WORKSPACE_OUTSIDE_ROOT",
        "Requested workspace is outside the configured Codex root.",
      );
    }
    const prompt = serializedTaskPacket(
      request,
      this.config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    );
    const runTimeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = performance.now() + runTimeoutMs;
    const connection = this.openConnection();
    let record: ActiveHostRun | undefined;
    let fatalBeforeRecord: CodexAppServerError | undefined;
    const bufferedMessages: Array<
      | { kind: "notification"; method: string; params: unknown }
      | {
          kind: "request";
          id: JsonRpcId;
          method: string;
          params: unknown;
        }
    > = [];
    connection.onNotification = (method, params) => {
      if (record) this.handleNotification(record, method, params);
      else bufferedMessages.push({ kind: "notification", method, params });
    };
    connection.onServerRequest = (id, method, params) => {
      this.failClosedServerRequest(connection, id, method);
      if (record) this.handleApproval(record, id, method, params);
      else bufferedMessages.push({ kind: "request", id, method, params });
    };
    connection.onFatal = (error) => {
      if (record) this.finalize(record, "failed", error);
      else fatalBeforeRecord = error;
    };
    const startupTimeout = this.timeoutConnection(
      connection,
      runTimeoutMs,
      "CODEX_APP_SERVER_TIMED_OUT",
    );
    const abortDuringStart = (): void => {
      connection.fail(
        new CodexAppServerError(
          "CODEX_APP_SERVER_CANCELED",
          "Codex AgentHost start was canceled.",
        ),
      );
    };
    signal?.addEventListener("abort", abortDuringStart, { once: true });
    try {
      const initialized = await this.initialize(connection);
      const initializedRecord = isRecord(initialized) ? initialized : {};
      const providerVersion = providerVersionFromUserAgent(
        initializedRecord.userAgent,
      );
      if (!providerVersion || !SUPPORTED_CODEX_VERSIONS.has(providerVersion)) {
        throw new CodexAppServerError(
          "CODEX_APP_SERVER_SCHEMA_UNSUPPORTED",
          "Codex app-server version is outside the adapter's generated-schema compatibility profile.",
        );
      }
      const threadResult = await connection.request(
        resumeSessionId ? "thread/resume" : "thread/start",
        resumeSessionId
          ? {
              threadId: resumeSessionId,
              cwd: requestedWorkspace,
              ...(this.config.model ? { model: this.config.model } : {}),
              approvalPolicy: wireApprovalPolicy(this.config.approvalPolicy),
              sandbox: wireSandboxMode(this.config.sandbox),
            }
          : {
              cwd: requestedWorkspace,
              ...(this.config.model ? { model: this.config.model } : {}),
              approvalPolicy: wireApprovalPolicy(this.config.approvalPolicy),
              sandbox: wireSandboxMode(this.config.sandbox),
              serviceName: "chartermesh",
            },
      );
      const thread = isRecord(threadResult) && isRecord(threadResult.thread)
        ? threadResult.thread
        : {};
      const hostSessionId =
        typeof thread.id === "string" && thread.id
          ? thread.id
          : resumeSessionId;
      if (!hostSessionId) {
        throw new CodexAppServerError(
          "CODEX_APP_SERVER_INVALID_THREAD",
          "Codex app-server did not return a thread id.",
        );
      }
      const turnResult = await connection.request("turn/start", {
        threadId: hostSessionId,
        input: [{ type: "text", text: prompt }],
        cwd: requestedWorkspace,
        approvalPolicy: wireApprovalPolicy(this.config.approvalPolicy),
        sandboxPolicy: wireSandboxPolicy(
          this.config.sandbox,
          requestedWorkspace,
        ),
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.reasoningEffort
          ? { effort: this.config.reasoningEffort }
          : {}),
      });
      const turn = isRecord(turnResult) && isRecord(turnResult.turn)
        ? turnResult.turn
        : {};
      if (typeof turn.id !== "string" || !turn.id) {
        throw new CodexAppServerError(
          "CODEX_APP_SERVER_INVALID_TURN",
          "Codex app-server did not return a turn id.",
        );
      }
      if (signal?.aborted) throw signal.reason;
      clearTimeout(startupTimeout);
      signal?.removeEventListener("abort", abortDuringStart);
      let resolveResult = (_result: HostRunResult): void => {};
      const resultPromise = new Promise<HostRunResult>((resolveTerminal) => {
        resolveResult = resolveTerminal;
      });
      if (this.runs.has(turn.id)) {
        throw new CodexAppServerError(
          "CODEX_HOST_RUN_COLLISION",
          "Codex returned a duplicate active turn id.",
        );
      }
      const abortActive = (): void => {
        void this.cancel(turn.id, {
          code: "user_requested",
          message: "AbortSignal canceled the host run.",
        });
      };
      signal?.addEventListener("abort", abortActive, { once: true });
      const timeout = setTimeout(() => {
        void this.cancel(turn.id, {
          code: "timeout",
          message: "Codex host run exceeded its configured timeout.",
        });
      }, Math.max(1, Math.ceil(deadline - performance.now())));
      timeout.unref();
      record = {
        requestKey,
        handle: {
          hostRunId: turn.id,
          hostSessionId,
          status: "running",
        },
        connection,
        events: new AsyncEventLog<HostRunEvent>(),
        sequence: 0,
        outputText: "",
        streamedText: "",
        hasFinalAnswer: false,
        lastError: null,
        cancelReason: null,
        cancelPromise: null,
        terminal: null,
        resultPromise,
        resolveResult,
        timeout,
        cancelTimer: null,
        abortCleanup: () => signal?.removeEventListener("abort", abortActive),
      };
      this.runs.set(turn.id, record);
      this.runKeys.set(requestKey, turn.id);
      this.emit(record, { type: "status", status: "running" });
      for (const message of bufferedMessages) {
        if (message.kind === "notification") {
          this.handleNotification(record, message.method, message.params);
        } else {
          this.handleApproval(record, message.id, message.method, message.params);
        }
      }
      if (fatalBeforeRecord) {
        this.finalize(record, "failed", fatalBeforeRecord);
      }
      return { ...record.handle };
    } catch (error) {
      clearTimeout(startupTimeout);
      signal?.removeEventListener("abort", abortDuringStart);
      connection.shutdown();
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
  }

  private failClosedServerRequest(
    connection: AppServerConnection,
    id: JsonRpcId,
    method: string,
  ): void {
    try {
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        connection.respond(id, { decision: "cancel" });
      } else if (method === "item/permissions/requestApproval") {
        connection.respond(id, { permissions: {}, scope: "turn" });
      } else if (
        method === "item/tool/requestUserInput" ||
        method === "tool/requestUserInput"
      ) {
        connection.respond(id, { answers: {} });
      } else {
        connection.respondError(
          id,
          -32000,
          "CharterMesh does not resolve this server request automatically.",
        );
      }
    } catch {
      // The connection fatal path owns teardown when the peer has closed.
    }
  }

  private handleApproval(
    record: ActiveHostRun,
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): void {
    if (record.terminal) return;
    const parameters = isRecord(params) ? params : {};
    if (
      parameters.threadId !== record.handle.hostSessionId ||
      parameters.turnId !== record.handle.hostRunId
    ) {
      return;
    }
    const kind = approvalKind(method);
    this.emit(record, {
      type: "approval_required",
      approval: {
        requestId: String(id),
        kind,
        summary: boundedMessage(
          parameters.reason,
          `Codex requested ${kind.replaceAll("_", " ")} approval; the adapter canceled it without granting permission.`,
        ),
        actionable: false,
        ...(typeof parameters.itemId === "string"
          ? { itemId: parameters.itemId }
          : {}),
      },
    });
  }

  private handleNotification(
    record: ActiveHostRun,
    method: string,
    params: unknown,
  ): void {
    if (record.terminal) return;
    const parameters = isRecord(params) ? params : {};
    if (method === "item/agentMessage/delta") {
      if (
        parameters.threadId !== record.handle.hostSessionId ||
        parameters.turnId !== record.handle.hostRunId
      ) {
        return;
      }
      const delta = typeof parameters.delta === "string" ? parameters.delta : "";
      if (delta) {
        record.streamedText += delta;
        this.emit(record, { type: "output_delta", delta });
      }
      return;
    }
    if (method === "item/completed" && isRecord(parameters.item)) {
      if (
        parameters.threadId !== record.handle.hostSessionId ||
        parameters.turnId !== record.handle.hostRunId
      ) {
        return;
      }
      const item = parameters.item;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") {
          record.outputText = item.text;
          record.hasFinalAnswer = true;
        } else if (!record.hasFinalAnswer) {
          record.outputText = item.text;
        }
      }
      return;
    }
    if (method === "error") {
      if (
        parameters.threadId !== record.handle.hostSessionId ||
        parameters.turnId !== record.handle.hostRunId
      ) {
        return;
      }
      record.lastError = providerError(parameters.error);
      this.emit(record, { type: "warning", warning: record.lastError });
      return;
    }
    if (method === "warning" || method === "configWarning") {
      if (
        (typeof parameters.threadId === "string" &&
          parameters.threadId !== record.handle.hostSessionId) ||
        (typeof parameters.turnId === "string" &&
          parameters.turnId !== record.handle.hostRunId)
      ) {
        return;
      }
      const warning: HostRunError = {
        code: method === "configWarning" ? "CODEX_CONFIG_WARNING" : "CODEX_WARNING",
        message: boundedMessage(
          parameters.message ?? parameters.summary,
          "Codex host reported a warning.",
        ),
        retryable: null,
      };
      this.emit(record, { type: "warning", warning });
      return;
    }
    if (method !== "turn/completed" || !isRecord(parameters.turn)) return;
    const turn = parameters.turn;
    if (
      parameters.threadId !== record.handle.hostSessionId ||
      turn.id !== record.handle.hostRunId
    ) {
      return;
    }
    if (turn.status === "completed") {
      this.finalize(record, "completed", null);
    } else if (turn.status === "interrupted") {
      this.finalize(record, "canceled", null);
    } else {
      const error = isRecord(turn.error)
        ? providerError(turn.error)
        : record.lastError ?? {
            code: "CODEX_TURN_FAILED",
            message: "Codex turn failed.",
            retryable: null,
          };
      this.finalize(record, "failed", error);
    }
  }

  private emit(
    record: ActiveHostRun,
    event:
      | { type: "status"; status: AgentHostRunHandle["status"] }
      | { type: "output_delta"; delta: string }
      | {
          type: "approval_required";
          approval: HostApprovalRequest;
        }
      | { type: "warning"; warning: HostRunError }
      | { type: "terminal"; result: HostRunResult },
  ): void {
    record.sequence += 1;
    record.events.push({
      ...event,
      hostRunId: record.handle.hostRunId,
      hostSessionId: record.handle.hostSessionId,
      sequence: record.sequence,
      occurredAt: this.now().toISOString(),
    } as HostRunEvent);
  }

  private finalize(
    record: ActiveHostRun,
    status: HostRunResult["status"],
    error: CodexAppServerError | HostRunError | null,
  ): void {
    if (record.terminal) return;
    const normalizedError =
      error instanceof CodexAppServerError
        ? { code: error.code, message: error.message, retryable: null }
        : error;
    const result: HostRunResult = {
      hostRunId: record.handle.hostRunId,
      hostSessionId: record.handle.hostSessionId,
      status,
      outputText: record.outputText || record.streamedText,
      usage: unknownUsage(),
      error: status === "failed" ? normalizedError ?? record.lastError : null,
      cancelReason: status === "canceled"
        ? record.cancelReason ?? { code: "unknown" }
        : null,
    };
    record.terminal = result;
    clearTimeout(record.timeout);
    if (record.cancelTimer) clearTimeout(record.cancelTimer);
    record.abortCleanup();
    this.emit(record, { type: "terminal", result });
    record.events.close();
    record.resolveResult(result);
    record.connection.shutdown();
    this.pruneTerminalRuns();
  }

  private pruneTerminalRuns(): void {
    const maximum = this.config.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
    const terminal = [...this.runs.entries()].filter(
      ([, candidate]) => candidate.terminal !== null,
    );
    for (const [hostRunId, candidate] of terminal.slice(
      0,
      Math.max(0, terminal.length - maximum),
    )) {
      this.runs.delete(hostRunId);
      if (this.runKeys.get(candidate.requestKey) === hostRunId) {
        this.runKeys.delete(candidate.requestKey);
      }
    }
  }

  async *events(
    hostRunId: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<HostRunEvent> {
    const record = this.runs.get(hostRunId);
    if (!record) {
      throw new CodexAppServerError(
        "CODEX_HOST_RUN_NOT_FOUND",
        `Unknown Codex host run '${hostRunId}'.`,
      );
    }
    let index = 0;
    for (;;) {
      const next = await record.events.next(index, options.signal);
      if (next.done) return;
      index += 1;
      yield next.value;
    }
  }

  result(
    hostRunId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<HostRunResult> {
    const record = this.runs.get(hostRunId);
    if (!record) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_HOST_RUN_NOT_FOUND",
          `Unknown Codex host run '${hostRunId}'.`,
        ),
      );
    }
    if (!options.signal) return record.resultPromise;
    if (options.signal.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolveResult, rejectResult) => {
      const abort = (): void => rejectResult(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      record.resultPromise.then(
        (result) => {
          options.signal?.removeEventListener("abort", abort);
          resolveResult(result);
        },
        (error) => {
          options.signal?.removeEventListener("abort", abort);
          rejectResult(error);
        },
      );
    });
  }

  async cancel(
    hostRunId: string,
    reason: HostCancelReason = { code: "unknown" },
  ): Promise<void> {
    const record = this.runs.get(hostRunId);
    if (!record) {
      throw new CodexAppServerError(
        "CODEX_HOST_RUN_NOT_FOUND",
        `Unknown Codex host run '${hostRunId}'.`,
      );
    }
    if (record.terminal) return;
    if (record.cancelPromise) return record.cancelPromise;
    record.lastError = {
      code: `HOST_CANCEL_${reason.code.toUpperCase()}`,
      message: boundedMessage(reason.message, "Host run cancellation requested."),
      retryable: false,
    };
    record.cancelReason = { ...reason };
    if (!record.cancelTimer) {
      record.cancelTimer = setTimeout(() => {
        this.finalize(record, "canceled", null);
      }, this.config.cancelSettlementMs ?? DEFAULT_CANCEL_SETTLEMENT_MS);
      record.cancelTimer.unref();
    }
    record.cancelPromise = (async () => {
      try {
        await record.connection.request("turn/interrupt", {
          threadId: record.handle.hostSessionId,
          turnId: record.handle.hostRunId,
        });
      } catch {
        this.finalize(record, "canceled", null);
      }
    })();
    return record.cancelPromise;
  }
}
