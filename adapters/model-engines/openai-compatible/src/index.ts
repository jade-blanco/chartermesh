import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelEngineManifest,
  ModelUsage,
} from "../../../../packages/adapter-sdk/src/types.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const MAX_CONFIGURABLE_RESPONSE_BYTES = 67_108_864;

export interface OpenAICompatibleConfig {
  id: string;
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  structuredOutputMode?: "prompt" | "json-schema";
  toolCalling?: boolean;
  reasoningMode?: "default" | "disabled";
  pricing?: {
    inputPerMillionTokensUsd: number;
    outputPerMillionTokensUsd: number;
  };
}

async function boundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await response.body?.cancel();
    throw new Error("MODEL_RESPONSE_LIMIT_EXCEEDED");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("MODEL_RESPONSE_LIMIT_EXCEEDED");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("MODEL_RESPONSE_INVALID_JSON");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "MODEL_RESPONSE_INVALID_JSON"
    ) {
      throw error;
    }
    throw new Error("MODEL_RESPONSE_INVALID_JSON");
  }
}

function completionUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Model endpoint must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials must not be embedded in the endpoint URL.");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path || "/v1"}/chat/completions`;
  }
  return url;
}

function usageOf(
  value: unknown,
  pricing?: OpenAICompatibleConfig["pricing"],
): ModelUsage {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const inputTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : null;
  const estimatedCost =
    pricing && inputTokens !== null && outputTokens !== null
      ? (inputTokens * pricing.inputPerMillionTokensUsd +
          outputTokens * pricing.outputPerMillionTokensUsd) /
        1_000_000
      : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: estimatedCost,
    measurementStatus:
      estimatedCost !== null ? "estimated" : "unknown",
  };
}

function toolCallsOf(message: Record<string, unknown>) {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : {};
    if (typeof fn.name !== "string") return [];
    let argumentsValue: unknown = fn.arguments;
    if (typeof argumentsValue === "string") {
      try {
        argumentsValue = JSON.parse(argumentsValue);
      } catch {
        argumentsValue = { unparsed: argumentsValue };
      }
    }
    return [
      {
        id:
          typeof record.id === "string"
            ? record.id
            : `tool-call-${index + 1}`,
        name: fn.name,
        arguments: argumentsValue,
      },
    ];
  });
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(
    hostname.toLowerCase(),
  );
}

export class OpenAICompatibleModelEngine implements ModelEngine {
  readonly manifest: ModelEngineManifest;
  readonly config: OpenAICompatibleConfig;
  private readonly url: URL;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    config: OpenAICompatibleConfig,
    environment: NodeJS.ProcessEnv = process.env,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.config = config;
    this.environment = environment;
    this.fetchImplementation = fetchImplementation;
    this.url = completionUrl(config.endpoint);
    this.manifest = {
      kind: "model_engine",
      profileId: config.id,
      adapter: "openai-compatible",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.text.generate",
          support: "native",
          stability: "stable",
        },
        {
          name: "model.structured_output",
          support:
            config.structuredOutputMode === "json-schema"
              ? "native"
              : "emulated",
          stability: "stable",
        },
        {
          name: "model.tool_calling",
          support: config.toolCalling ? "native" : "unsupported",
          stability: "beta",
        },
      ],
    };
  }

  async generate(
    request: InferenceRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InferenceResult> {
    const key = this.config.apiKeyEnv
      ? this.environment[this.config.apiKeyEnv]
      : undefined;
    if (this.config.apiKeyEnv && !key) {
      throw new Error(
        `Required environment variable '${this.config.apiKeyEnv}' is not set.`,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Model request timed out.")),
      this.config.timeoutMs ?? 60_000,
    );
    const abort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImplementation(this.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map(
            ({ role, content, toolCallId, toolCalls }) => ({
              role,
              content,
              ...(toolCallId ? { tool_call_id: toolCallId } : {}),
              ...(toolCalls?.length
                ? {
                    tool_calls: toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments),
                      },
                    })),
                  }
                : {}),
            }),
          ),
          stream: false,
          ...(this.config.toolCalling && request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          ...(request.responseSchema &&
          this.config.structuredOutputMode === "json-schema"
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "chartermesh_artifact",
                    strict: true,
                    schema: request.responseSchema,
                  },
                },
              }
            : {}),
          ...(request.maxOutputTokens
            ? { max_tokens: request.maxOutputTokens }
            : {}),
          ...(this.config.reasoningMode === "disabled"
            ? {
                reasoning_effort: "none",
                chat_template_kwargs: { enable_thinking: false },
              }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Model endpoint returned HTTP ${response.status}.`);
      }
      const payload = await boundedJsonResponse(
        response,
        this.config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message =
        first?.message && typeof first.message === "object"
          ? (first.message as Record<string, unknown>)
          : {};
      const toolCalls = toolCallsOf(message);
      return {
        invocationId: request.invocationId,
        text: typeof message.content === "string" ? message.content : "",
        toolCalls,
        finishReason:
          toolCalls.length > 0 || first?.finish_reason === "tool_calls"
            ? "tool_call"
            : first?.finish_reason === "length"
              ? "length"
              : "stop",
        usage: usageOf(payload.usage, this.config.pricing),
      };
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
    }
  }
}

export function validateOpenAICompatibleConfig(
  config: OpenAICompatibleConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues: string[] = [];
  try {
    const url = completionUrl(config.endpoint);
    if (
      config.apiKeyEnv &&
      url.protocol === "http:" &&
      !isLoopback(url.hostname)
    ) {
      issues.push(
        "Credentials cannot be sent to a non-loopback HTTP endpoint. Use HTTPS.",
      );
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (!config.model.trim()) issues.push("Model id is required.");
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 1_000 ||
      config.timeoutMs > 600_000)
  ) {
    issues.push("Model timeout must be between 1000 and 600000 ms.");
  }
  if (
    config.maxResponseBytes !== undefined &&
    (!Number.isInteger(config.maxResponseBytes) ||
      config.maxResponseBytes < 1_024 ||
      config.maxResponseBytes > MAX_CONFIGURABLE_RESPONSE_BYTES)
  ) {
    issues.push(
      "Model maxResponseBytes must be between 1024 and 67108864 bytes.",
    );
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
  if (config.apiKeyEnv && !environment[config.apiKeyEnv]) {
    issues.push(`Environment variable '${config.apiKeyEnv}' is not set.`);
  }
  return issues;
}
