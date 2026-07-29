import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelEngineManifest,
  ModelToolCall,
  ModelUsage,
} from "../../../../packages/adapter-sdk/src/types.ts";

const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const EXECUTABLE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface CommandProcessConfig {
  id: string;
  command: string;
  executableSha256: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
  environmentAllowlist?: string[];
  pricing?: {
    inputPerMillionTokensUsd: number;
    outputPerMillionTokensUsd: number;
  };
}

export function sha256Executable(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new Error("COMMAND_PROCESS_EXECUTABLE_NOT_FILE");
  }
  const descriptor = openSync(path, "r");
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

function nullableTokenCount(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`COMMAND_PROCESS_INVALID_RESPONSE: ${label}`);
  }
  return Number(value);
}

function usageOf(
  value: unknown,
  pricing?: CommandProcessConfig["pricing"],
): ModelUsage {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inputTokens = nullableTokenCount(
    record.inputTokens,
    "usage.inputTokens",
  );
  const outputTokens = nullableTokenCount(
    record.outputTokens,
    "usage.outputTokens",
  );
  const suppliedCost =
    typeof record.cost === "number" &&
    Number.isFinite(record.cost) &&
    record.cost >= 0
      ? record.cost
      : null;
  const estimatedCost =
    suppliedCost === null &&
    pricing &&
    inputTokens !== null &&
    outputTokens !== null
      ? (inputTokens * pricing.inputPerMillionTokensUsd +
          outputTokens * pricing.outputPerMillionTokensUsd) /
        1_000_000
      : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: nullableTokenCount(
      record.cacheReadTokens,
      "usage.cacheReadTokens",
    ),
    cacheWriteTokens: nullableTokenCount(
      record.cacheWriteTokens,
      "usage.cacheWriteTokens",
    ),
    cost: suppliedCost ?? estimatedCost,
    measurementStatus:
      suppliedCost !== null
        ? "measured"
        : estimatedCost !== null
          ? "estimated"
          : "unknown",
  };
}

function toolCallsOf(value: unknown): ModelToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: toolCalls");
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: toolCall");
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: toolCall.name");
    }
    return {
      id:
        typeof record.id === "string" && record.id
          ? record.id
          : `command-tool-${index + 1}`,
      name: record.name,
      arguments: record.arguments ?? {},
    };
  });
}

function normalizeResponse(
  request: InferenceRequest,
  value: unknown,
  pricing?: CommandProcessConfig["pricing"],
): InferenceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: JSON object required");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") {
    throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: text");
  }
  const finishReason = record.finishReason ?? "stop";
  if (
    !["stop", "tool_call", "length", "canceled", "error"].includes(
      String(finishReason),
    )
  ) {
    throw new Error("COMMAND_PROCESS_INVALID_RESPONSE: finishReason");
  }
  return {
    invocationId: request.invocationId,
    text: record.text,
    toolCalls: toolCallsOf(record.toolCalls),
    finishReason: finishReason as InferenceResult["finishReason"],
    usage: usageOf(record.usage, pricing),
  };
}

function childEnvironment(
  allowlist: string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = new Set([
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    ...allowlist,
  ]);
  return Object.fromEntries(
    [...names].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

export function validateCommandProcessConfig(
  config: CommandProcessConfig,
): string[] {
  const issues: string[] = [];
  if (!config.id.trim()) issues.push("Command-process engine id is required.");
  if (!isAbsolute(config.command)) {
    issues.push("Command-process executable must use an absolute path.");
  }
  if (!EXECUTABLE_DIGEST_PATTERN.test(config.executableSha256)) {
    issues.push(
      "Command-process executableSha256 must be a lowercase SHA-256 digest.",
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 1_000 ||
      config.timeoutMs > 600_000)
  ) {
    issues.push("Command-process timeout must be between 1000 and 600000 ms.");
  }
  for (const name of config.environmentAllowlist ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      issues.push(`Invalid environment variable name '${name}'.`);
    }
  }
  if (
    config.pricing &&
    (!Number.isFinite(config.pricing.inputPerMillionTokensUsd) ||
      config.pricing.inputPerMillionTokensUsd < 0 ||
      !Number.isFinite(config.pricing.outputPerMillionTokensUsd) ||
      config.pricing.outputPerMillionTokensUsd < 0)
  ) {
    issues.push("Pricing values must be finite non-negative numbers.");
  }
  return issues;
}

export class CommandProcessModelEngine implements ModelEngine {
  readonly manifest: ModelEngineManifest;
  readonly config: CommandProcessConfig;
  private readonly workingDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    config: CommandProcessConfig,
    workingDirectory: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const issues = validateCommandProcessConfig(config);
    if (issues.length > 0) throw new Error(issues.join("\n"));
    if (sha256Executable(config.command) !== config.executableSha256) {
      throw new Error("COMMAND_PROCESS_EXECUTABLE_DIGEST_MISMATCH");
    }
    this.config = config;
    this.workingDirectory = resolve(workingDirectory);
    this.environment = environment;
    this.manifest = {
      kind: "model_engine",
      profileId: config.id,
      adapter: "command-process",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
          permissionBehavior: "unknown",
          workspaceIsolation: "none",
          costVisibility: config.pricing ? "estimated" : "unknown",
          constraints: {
            executableSha256: config.executableSha256,
            workingDirectory: "dedicated",
            operatingSystemSandbox: false,
          },
        },
        {
          name: "model.structured_output",
          support: "emulated",
          stability: "stable",
        },
        {
          name: "model.tool_calling",
          support: "native",
          stability: "beta",
        },
      ],
    };
  }

  generate(
    request: InferenceRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<InferenceResult> {
    return new Promise((resolveResult, rejectResult) => {
      try {
        if (
          sha256Executable(this.config.command) !==
          this.config.executableSha256
        ) {
          rejectResult(
            new Error("COMMAND_PROCESS_EXECUTABLE_DIGEST_MISMATCH"),
          );
          return;
        }
      } catch {
        rejectResult(
          new Error("COMMAND_PROCESS_EXECUTABLE_DIGEST_MISMATCH"),
        );
        return;
      }
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.workingDirectory,
        env: childEnvironment(
          this.config.environmentAllowlist ?? [],
          this.environment,
        ),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (
        error: Error | null,
        result?: InferenceResult,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (error) rejectResult(error);
        else resolveResult(result!);
      };
      const stopForOutput = (): void => {
        child.kill();
        finish(new Error("COMMAND_PROCESS_OUTPUT_LIMIT_EXCEEDED"));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
          stopForOutput();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) stopForOutput();
      });
      child.once("error", () => {
        finish(new Error("COMMAND_PROCESS_START_FAILED"));
      });
      child.once("close", (code) => {
        if (settled) return;
        try {
          if (
            sha256Executable(this.config.command) !==
            this.config.executableSha256
          ) {
            finish(
              new Error("COMMAND_PROCESS_EXECUTABLE_CHANGED_DURING_RUN"),
            );
            return;
          }
        } catch {
          finish(
            new Error("COMMAND_PROCESS_EXECUTABLE_CHANGED_DURING_RUN"),
          );
          return;
        }
        if (code !== 0) {
          finish(new Error(`COMMAND_PROCESS_EXITED_${code ?? "UNKNOWN"}`));
          return;
        }
        try {
          const parsed = JSON.parse(
            Buffer.concat(stdout).toString("utf8"),
          ) as unknown;
          finish(
            null,
            normalizeResponse(request, parsed, this.config.pricing),
          );
        } catch (error) {
          finish(
            error instanceof Error &&
              error.message.startsWith("COMMAND_PROCESS_")
              ? error
              : new Error("COMMAND_PROCESS_INVALID_JSON"),
          );
        }
      });
      const abort = (): void => {
        child.kill();
        finish(new Error("COMMAND_PROCESS_CANCELED"));
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("COMMAND_PROCESS_TIMED_OUT"));
      }, this.config.timeoutMs ?? 60_000);
      timeout.unref();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => {
        finish(new Error("COMMAND_PROCESS_STDIN_FAILED"));
      });
      child.stdin.end(
        JSON.stringify({
          apiVersion: "chartermesh.dev/command-process-request/v1alpha1",
          request,
        }),
      );
    });
  }
}
