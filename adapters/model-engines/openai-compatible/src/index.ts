import type {
  InferenceRequest,
  InferenceResult,
  ModelEngine,
  ModelEngineManifest,
  ModelUsage,
} from "../../../../packages/adapter-sdk/src/types.ts";

export interface OpenAICompatibleConfig {
  id: string;
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
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

function usageOf(value: unknown): ModelUsage {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    inputTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    measurementStatus:
      typeof usage.prompt_tokens === "number" ? "measured" : "unknown",
  };
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
          support: "emulated",
          stability: "stable",
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
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map(({ role, content }) => ({
            role,
            content,
          })),
          stream: false,
          ...(request.maxOutputTokens
            ? { max_tokens: request.maxOutputTokens }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(
          `Model endpoint returned ${response.status}: ${detail}`,
        );
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message =
        first?.message && typeof first.message === "object"
          ? (first.message as Record<string, unknown>)
          : {};
      return {
        invocationId: request.invocationId,
        text: typeof message.content === "string" ? message.content : "",
        toolCalls: [],
        finishReason:
          first?.finish_reason === "length" ? "length" : "stop",
        usage: usageOf(payload.usage),
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
    completionUrl(config.endpoint);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (!config.model.trim()) issues.push("Model id is required.");
  if (config.apiKeyEnv && !environment[config.apiKeyEnv]) {
    issues.push(`Environment variable '${config.apiKeyEnv}' is not set.`);
  }
  return issues;
}
