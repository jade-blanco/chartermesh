import { readFileSync } from "node:fs";
import {
  validateJsonSchemaDocument,
  type JsonSchemaIssue,
} from "../../orgspec/src/index.ts";
import {
  validateWebSearchConfig,
  type SearxngWebSearchConfig,
} from "./web-search.ts";

export interface ModelPricing {
  inputPerMillionTokensUsd: number;
  outputPerMillionTokensUsd: number;
}

export type RuntimeModelEngine =
  | {
      id: string;
      adapter: "fake";
    }
  | {
      id: string;
      adapter: "openai-compatible";
      endpoint: string;
      model: string;
      apiKeyEnv?: string;
      structuredOutputMode?: "prompt" | "json-schema";
      toolCalling?: boolean;
      reasoningMode?: "default" | "disabled";
      timeoutMs?: number;
      maxResponseBytes?: number;
      pricing?: ModelPricing;
    }
  | {
      id: string;
      adapter: "command-process";
      command: string;
      executableSha256: string;
      args?: string[];
      model?: string;
      environmentAllowlist?: string[];
      timeoutMs?: number;
      pricing?: ModelPricing;
    };

export interface RuntimeConfig {
  apiVersion: "chartermesh.dev/runtime/v1alpha1";
  modelEngines: RuntimeModelEngine[];
  managedRunners: Array<{
    id: string;
    adapter: "builtin-managed-runner";
    modelEngineRef: string;
  }>;
  webSearch?: SearxngWebSearchConfig;
}

let cachedRuntimeSchema: Record<string, unknown> | undefined;

function runtimeSchema(): Record<string, unknown> {
  cachedRuntimeSchema ??= JSON.parse(
    readFileSync(
      new URL(
        "../../../schemas/runtime-config-v1alpha1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return cachedRuntimeSchema;
}

export class RuntimeConfigParseError extends Error {
  readonly code = "RUNTIME_CONFIG_PARSE_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeConfigParseError";
  }
}

export function validateRuntimeConfigSchema(
  value: unknown,
): JsonSchemaIssue[] {
  return validateJsonSchemaDocument(runtimeSchema(), value);
}

export function parseRuntimeConfig(text: string): RuntimeConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeConfigParseError(
      "runtime.json must be valid JSON.",
      { cause },
    );
  }
  const issues = validateRuntimeConfigSchema(value);
  if (issues.length > 0) {
    const details = issues
      .slice(0, 8)
      .map(({ path, keyword, message }) => `${path} [${keyword}] ${message}`)
      .join("; ");
    const remaining =
      issues.length > 8 ? `; and ${issues.length - 8} more issue(s)` : "";
    throw new RuntimeConfigParseError(
      `Runtime configuration does not satisfy ` +
        `schemas/runtime-config-v1alpha1.schema.json: ${details}${remaining}`,
    );
  }
  const config = value as RuntimeConfig;
  const engineIds = config.modelEngines.map(({ id }) => id);
  if (new Set(engineIds).size !== engineIds.length) {
    throw new RuntimeConfigParseError(
      "Runtime configuration model engine ids must be unique.",
    );
  }
  const runnerIds = config.managedRunners.map(({ id }) => id);
  if (new Set(runnerIds).size !== runnerIds.length) {
    throw new RuntimeConfigParseError(
      "Runtime configuration managed runner ids must be unique.",
    );
  }
  for (const runner of config.managedRunners) {
    if (!engineIds.includes(runner.modelEngineRef)) {
      throw new RuntimeConfigParseError(
        `Managed runner '${runner.id}' references unknown model engine ` +
          `'${runner.modelEngineRef}'.`,
      );
    }
  }
  if (config.webSearch) {
    const webSearchIssues = validateWebSearchConfig(config.webSearch);
    if (webSearchIssues.length > 0) {
      throw new RuntimeConfigParseError(webSearchIssues.join("; "));
    }
  }
  return config;
}
