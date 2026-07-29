import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleModelEngine,
  validateOpenAICompatibleConfig,
} from "../src/index.ts";

test("configuration keeps credentials in environment indirection", () => {
  const issues = validateOpenAICompatibleConfig(
    {
      id: "remote",
      endpoint: "https://models.example/v1",
      model: "example-model",
      apiKeyEnv: "EXAMPLE_MODEL_KEY",
    },
    {},
  );
  assert.deepEqual(issues, [
    "Environment variable 'EXAMPLE_MODEL_KEY' is not set.",
  ]);
});

test("adapter normalizes an OpenAI-compatible response", async () => {
  let authorization = "";
  let redirect: RequestRedirect | undefined;
  const engine = new OpenAICompatibleModelEngine(
    {
      id: "remote",
      endpoint: "https://models.example/v1",
      model: "example-model",
      apiKeyEnv: "EXAMPLE_MODEL_KEY",
    },
    { EXAMPLE_MODEL_KEY: "test-only-secret" },
    async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      redirect = init?.redirect;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "Synthetic provider response" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  const result = await engine.generate({
    invocationId: "invocation-test",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(authorization, "Bearer test-only-secret");
  assert.equal(redirect, "error");
  assert.equal(result.text, "Synthetic provider response");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 5);
});

test("adapter rejects an oversized response before JSON parsing", async () => {
  const engine = new OpenAICompatibleModelEngine(
    {
      id: "bounded",
      endpoint: "http://127.0.0.1:8080/v1",
      model: "local-model",
      maxResponseBytes: 1_024,
    },
    {},
    async () =>
      new Response("x".repeat(1_025), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    () =>
      engine.generate({
        invocationId: "oversized",
        messages: [{ role: "user", content: "Hello" }],
      }),
    /MODEL_RESPONSE_LIMIT_EXCEEDED/u,
  );
});

test("user-supplied token prices produce explicit estimated cost", async () => {
  const engine = new OpenAICompatibleModelEngine(
    {
      id: "priced",
      endpoint: "http://127.0.0.1:8080/v1",
      model: "local-model",
      pricing: {
        inputPerMillionTokensUsd: 2,
        outputPerMillionTokensUsd: 6,
      },
    },
    {},
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1_000, completion_tokens: 500 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const result = await engine.generate({
    invocationId: "priced-test",
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(result.usage.cost, 0.005);
  assert.equal(result.usage.measurementStatus, "estimated");
});

test("adapter transports JSON schema and tool calls without provider coupling", async () => {
  let requestBody: Record<string, unknown> = {};
  const engine = new OpenAICompatibleModelEngine(
    {
      id: "local",
      endpoint: "http://127.0.0.1:8080/v1",
      model: "local-model",
      structuredOutputMode: "json-schema",
      toolCalling: true,
      reasoningMode: "disabled",
    },
    {},
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    function: { name: "inspect", arguments: '{"path":"."}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  const result = await engine.generate({
    invocationId: "tool-test",
    messages: [
      { role: "user", content: "Inspect safely." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "previous-call",
            name: "inspect",
            arguments: { path: "." },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "previous-call",
        content: '{"entries":[]}',
      },
    ],
    tools: [
      {
        name: "inspect",
        description: "Read project metadata.",
        inputSchema: { type: "object" },
      },
    ],
    responseSchema: { type: "object" },
  });
  assert.equal(
    (requestBody.response_format as { type: string }).type,
    "json_schema",
  );
  assert.equal((requestBody.tools as unknown[]).length, 1);
  const transportedMessages = requestBody.messages as Array<
    Record<string, unknown>
  >;
  assert.equal(
    (
      transportedMessages[1]?.tool_calls as Array<
        Record<string, unknown>
      >
    )[0]?.id,
    "previous-call",
  );
  assert.equal(transportedMessages[2]?.tool_call_id, "previous-call");
  assert.equal(requestBody.reasoning_effort, "none");
  assert.deepEqual(requestBody.chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "." });
  assert.equal(result.finishReason, "tool_call");
});

test("adapter refuses credentials over non-loopback HTTP", () => {
  assert.deepEqual(
    validateOpenAICompatibleConfig(
      {
        id: "unsafe",
        endpoint: "http://models.example/v1",
        model: "example",
        apiKeyEnv: "MODEL_KEY",
      },
      { MODEL_KEY: "test-only" },
    ),
    ["Credentials cannot be sent to a non-loopback HTTP endpoint. Use HTTPS."],
  );
});
