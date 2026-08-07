import type { RuntimeTool } from "./tool-runtime.ts";

export interface SearxngWebSearchConfig {
  adapter: "searxng";
  endpoint: string;
  timeoutMs?: number;
  maxResults?: number;
  maxResponseBytes?: number;
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(lower)
  );
}

export function validateWebSearchConfig(
  config: SearxngWebSearchConfig,
): string[] {
  const issues: string[] = [];
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    return ["webSearch.endpoint must be an absolute URL."];
  }
  if (endpoint.username || endpoint.password) {
    issues.push("webSearch.endpoint cannot contain credentials.");
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))
  ) {
    issues.push(
      "webSearch.endpoint must use HTTPS or loopback HTTP.",
    );
  }
  if (endpoint.hash) {
    issues.push("webSearch.endpoint cannot contain a URL fragment.");
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 1_000 ||
      config.timeoutMs > 120_000)
  ) {
    issues.push("webSearch.timeoutMs must be an integer from 1000 through 120000.");
  }
  if (
    config.maxResults !== undefined &&
    (!Number.isInteger(config.maxResults) ||
      config.maxResults < 1 ||
      config.maxResults > 20)
  ) {
    issues.push("webSearch.maxResults must be an integer from 1 through 20.");
  }
  if (
    config.maxResponseBytes !== undefined &&
    (!Number.isInteger(config.maxResponseBytes) ||
      config.maxResponseBytes < 1_024 ||
      config.maxResponseBytes > 2_097_152)
  ) {
    issues.push(
      "webSearch.maxResponseBytes must be an integer from 1024 through 2097152.",
    );
  }
  return issues;
}

async function boundedResponseText(
  response: Response,
  maximum: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        throw new Error(
          `WEB_SEARCH_RESPONSE_TOO_LARGE: exceeded ${maximum} bytes.`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== "string" ||
    typeof record.title !== "string"
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return {
    title: record.title.slice(0, 500),
    url: url.toString(),
    snippet:
      typeof record.content === "string"
        ? record.content.slice(0, 2_000)
        : "",
    engine:
      typeof record.engine === "string"
        ? record.engine.slice(0, 100)
        : null,
  };
}

export function createWebSearchTools(
  config?: SearxngWebSearchConfig,
): RuntimeTool[] {
  if (!config) return [];
  const issues = validateWebSearchConfig(config);
  if (issues.length > 0) throw new Error(issues.join("\n"));
  const endpoint = new URL(config.endpoint);
  const maximumResults = config.maxResults ?? 8;
  const maximumBytes = config.maxResponseBytes ?? 1_048_576;
  const timeoutMs = config.timeoutMs ?? 20_000;
  return [
    {
      modelTool: {
        name: "web.search",
        description:
          "Search a reviewed SearXNG endpoint. The exact query leaves the local machine, redirects are refused, and result pages are not fetched.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 512 },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: maximumResults,
            },
          },
        },
      },
      permission: "external_side_effect",
      async execute(value, context) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Tool arguments must be a JSON object.");
        }
        const args = value as Record<string, unknown>;
        const query =
          typeof args.query === "string" ? args.query.trim() : "";
        if (!query || query.length > 512) {
          throw new Error(
            "Tool argument 'query' must be 1 through 512 characters.",
          );
        }
        const requested = Number(args.maxResults ?? maximumResults);
        if (
          !Number.isInteger(requested) ||
          requested < 1 ||
          requested > maximumResults
        ) {
          throw new Error(
            `Tool argument 'maxResults' must be 1 through ${maximumResults}.`,
          );
        }
        const controller = new AbortController();
        const abort = () => controller.abort(context.signal?.reason);
        if (context.signal?.aborted) controller.abort(context.signal.reason);
        else context.signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(
          () => controller.abort(new Error("WEB_SEARCH_TIMEOUT")),
          timeoutMs,
        );
        timeout.unref();
        try {
          const body = new URLSearchParams({
            q: query,
            format: "json",
          });
          const response = await fetch(endpoint, {
            method: "POST",
            redirect: "manual",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "CharterMesh/0.0.8-alpha.1",
            },
            body,
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            throw new Error("WEB_SEARCH_REDIRECT_REFUSED");
          }
          if (!response.ok) {
            throw new Error(`WEB_SEARCH_HTTP_${response.status}`);
          }
          if (
            !response.headers
              .get("content-type")
              ?.toLowerCase()
              .includes("application/json")
          ) {
            throw new Error("WEB_SEARCH_CONTENT_TYPE_INVALID");
          }
          const text = await boundedResponseText(response, maximumBytes);
          const payload = JSON.parse(text) as { results?: unknown[] };
          const candidates = Array.isArray(payload.results)
            ? payload.results
            : [];
          const results = candidates
            .map(safeResult)
            .filter((item) => item !== null)
            .slice(0, requested);
          return {
            output: JSON.stringify({
              query,
              resultCount: results.length,
              results,
            }),
          };
        } finally {
          clearTimeout(timeout);
          context.signal?.removeEventListener("abort", abort);
        }
      },
    },
  ];
}
