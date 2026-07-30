import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelEngine } from "../../adapter-sdk/src/types.ts";
import {
  createWorkspaceToolRuntime,
  createWebSearchTools,
  ToolApprovalRequiredError,
  validateWebSearchConfig,
} from "../src/index.ts";

test("web search accepts HTTPS or loopback HTTP and rejects unsafe endpoints", () => {
  assert.deepEqual(
    validateWebSearchConfig({
      adapter: "searxng",
      endpoint: "https://search.example/search",
    }),
    [],
  );
  assert.deepEqual(
    validateWebSearchConfig({
      adapter: "searxng",
      endpoint: "http://127.0.0.1:8888/search",
    }),
    [],
  );
  assert.match(
    validateWebSearchConfig({
      adapter: "searxng",
      endpoint: "http://search.example/search",
    }).join(" "),
    /HTTPS or loopback HTTP/u,
  );
  assert.match(
    validateWebSearchConfig({
      adapter: "searxng",
      endpoint: "https://user:secret@search.example/search",
    }).join(" "),
    /cannot contain credentials/u,
  );
});

test("web search cannot send a query before exact Control Plane approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "chartermesh-web-approval-"));
  const engine: ModelEngine = {
    manifest: {
      kind: "model_engine",
      profileId: "tool-fixture",
      adapter: "fixture",
      contractVersion: "v1alpha1",
      capabilities: [
        {
          name: "model.tool_calling",
          support: "native",
          stability: "stable",
        },
      ],
    },
    async generate(request) {
      return {
        invocationId: request.invocationId,
        text: "",
        toolCalls: [
          {
            id: "search-1",
            name: "web.search",
            arguments: { query: "must be approved" },
          },
        ],
        finishReason: "tool_call",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          cost: null,
          measurementStatus: "unknown",
        },
      };
    },
  };
  const runtime = createWorkspaceToolRuntime({
    workspaceRoot: workspace,
    workItemId: "work-search",
    policy: {
      allow: ["web.search"],
      approvalRequired: ["web.search"],
      workspaceRoots: ["."],
      maxIterations: 2,
    },
    additionalTools: createWebSearchTools({
      adapter: "searxng",
      endpoint: "http://127.0.0.1:9/search",
    }),
  });
  await assert.rejects(
    () =>
      runtime.run(engine, {
        invocationId: "invocation-search",
        messages: [{ role: "user", content: "Search." }],
      }),
    ToolApprovalRequiredError,
  );
});

test("bounded SearXNG adapter returns normalized results without fetching pages", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Primary source",
              url: "https://example.test/source",
              content: "A bounded result snippet.",
              engine: "fixture",
            },
            {
              title: "Unsafe scheme",
              url: "file:///private/data",
              content: "Must be filtered.",
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const [tool] = createWebSearchTools({
      adapter: "searxng",
      endpoint: `http://127.0.0.1:${address.port}/search`,
      maxResults: 4,
    });
    assert.ok(tool);
    assert.equal(tool.permission, "external_side_effect");
    const result = await tool.execute(
      { query: "bounded local query", maxResults: 2 },
      { workspaceRoot: process.cwd() },
    );
    const output = JSON.parse(result.output);
    assert.equal(output.resultCount, 1);
    assert.equal(output.results[0].title, "Primary source");
    assert.equal(
      output.results[0].url,
      "https://example.test/source",
    );
    assert.match(receivedBody, /q=bounded\+local\+query/u);
    assert.match(receivedBody, /format=json/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
